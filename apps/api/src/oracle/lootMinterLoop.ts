/**
 * The free-run loot minter's timer.
 *
 * Same shape as `IndexerLoop`, deliberately: a second scheduling idiom in one
 * process would be a second set of shutdown bugs. Separated from the minter
 * itself for the same reason too — the ceremony stays a plain object with a
 * `runOnce()` a test can await, rather than something that only ever happens on
 * a schedule.
 *
 * WHY THIS ONE CANNOT HANG OFF A READ. `services/onDemand.ts` drives the spawner
 * and the indexer from request traffic, and says in as many words that no
 * payment, attestation, or on-chain settlement may be scheduled that way. This is
 * an on-chain settlement: it broadcasts oracle-signed transactions that mint an
 * NFT a player has already been shown. A drop that only advances while somebody
 * happens to be reading `/map` is a drop that never arrives for the player who
 * earned it and then closed the tab. So on a serverless host this loop is inert
 * and the pass must be driven by a scheduled invocation instead.
 *
 * A failed pass is logged and swallowed. `runOnce()` already absorbs a failure on
 * one run, so a rejection here means something above the batch broke — and an
 * unhandled rejection in a timer would take the process down, which mints nothing
 * for anybody.
 */

import { randomUUID } from 'node:crypto';
import type { FreeRunLootMinter, LootMintReport } from './freeRunLootMinter.js';
import { LOOT_MINT_JOB, type JobLeaseStore } from '../repos/jobLeases.js';

export interface LootMinterLoopConfig {
  readonly tickIntervalMs: number;
  /**
   * How long a claimed pass stays claimed against other instances.
   *
   * This is an assertion about the maximum duration of a pass, and it is wrong in
   * only one direction that matters: too short, and a slow pass loses its lease
   * while still broadcasting, which is the exact race the lease exists to stop.
   * Too long merely delays recovery after a crash by up to this much.
   *
   * Two minutes against a pass that is bounded far below it — the serverless
   * host caps a request at 30s (`.vc-config.json`), and a pass is `batchSize`
   * runs of one chain read plus at most one broadcast each.
   */
  readonly leaseTtlSeconds: number;
}

/**
 * One minute, and a two-minute lease.
 *
 * The floor is what the ceremony can actually use: each pass advances a run only
 * once its previous transaction has been *mined*, so ticking faster than blocks
 * arrive just spends Hiro reads to be told "still pending". The ceiling is the
 * player's wait — four steps at one step per pass, so a minute here is a drop in
 * their wallet within a few minutes of the fight. Cheap either way, because a
 * pass with nothing owed is a single indexed query and no chain traffic at all.
 *
 * The lease outlives the tick interval on purpose. It is released at the end of
 * every pass, so it is never actually held for two minutes in the normal case —
 * the TTL only governs how long a *crashed* instance blocks the job, and being
 * generous there costs one skipped pass while being stingy costs the guarantee.
 */
export const DEFAULT_LOOT_MINTER_LOOP_CONFIG: LootMinterLoopConfig = {
  tickIntervalMs: 60 * 1000,
  leaseTtlSeconds: 120,
};

export class LootMinterLoop {
  private readonly config: LootMinterLoopConfig;
  private timer: NodeJS.Timeout | null = null;
  /** Guards against a slow pass overlapping the next tick. */
  private running = false;
  /**
   * This process's claim on the shared lease.
   *
   * Per instance rather than per pass: it identifies who holds the lease, and a
   * fresh id per pass would work equally well while making a stuck lease
   * impossible to attribute to anything in a log.
   */
  private readonly holder = randomUUID();

  constructor(
    private readonly minter: FreeRunLootMinter,
    config: Partial<LootMinterLoopConfig> = {},
    private readonly log?: (message: string, detail?: Record<string, unknown>) => void,
    /**
     * Cross-instance guard. Optional, and null means the in-process flag is the
     * only protection — correct for a test with one loop object, and not correct
     * for any deployment that can run more than one instance.
     */
    private readonly leases: JobLeaseStore | null = null,
  ) {
    this.config = { ...DEFAULT_LOOT_MINTER_LOOP_CONFIG, ...config };
  }

  /**
   * One pass, skipped if another is already going.
   *
   * Returns null for a skip — an ordinary outcome, and `/jobs/loot-mint` answers it
   * 200 so a cron dashboard does not read the guard working as the job breaking.
   *
   * Rejects only if the store underneath it is broken: `runOnce()` absorbs a
   * failure on an individual run, so a rejection from there means the batch query
   * failed, and a rejection from `acquire()` means the lease table is unreachable.
   * Both are deliberately loud. Failing the pass turns them into a red cron run,
   * whereas skipping quietly would stop every drop while reporting success — and
   * running anyway, without the lease, is the double-broadcast this exists to stop.
   */
  async tick(): Promise<LootMintReport | null> {
    if (this.running) {
      // Not a quota concern like the indexer's equivalent — this one is the
      // double-mint guard. Two overlapping passes would both read a run whose
      // step is recorded but not yet written back, and both broadcast it.
      this.log?.('free-run loot mint pass skipped; previous pass still running');
      return null;
    }
    this.running = true;
    try {
      // The same guard again, one level out, because the flag above covers this
      // process and the job now has two HTTP drivers pointed at a fleet. Checked
      // second because it costs a round trip and the local flag does not.
      if (this.leases && !(await this.leases.acquire(
        LOOT_MINT_JOB, this.config.leaseTtlSeconds, this.holder,
      ))) {
        this.log?.('free-run loot mint pass skipped; another instance holds the lease');
        return null;
      }

      try {
        const report = await this.minter.runOnce();
        // Silent when there is nothing owed. This runs every minute forever, and a
        // line per pass would bury the ones that say a drop was minted or parked.
        if (report.considered > 0) {
          this.log?.('free-run loot mint pass complete', {
            ...report,
            errors: report.errors.length,
          });
        }
        return report;
      } finally {
        // Best-effort, and safe to lose: an unreleased lease expires on its own.
        // Letting this throw would turn a tidy-up failure into a failed pass —
        // and, through `/jobs/loot-mint`, into a red run in a cron dashboard for
        // work that actually succeeded.
        if (this.leases) {
          await this.leases.release(LOOT_MINT_JOB, this.holder).catch((err: unknown) => {
            this.log?.('free-run loot mint lease release failed; it will expire', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;

    const run = () => {
      this.tick().catch((err: unknown) => {
        this.log?.('free-run loot mint pass failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    // One pass immediately: a restart is exactly when a backlog exists, because
    // any ceremony interrupted mid-flight is still sitting at its recorded step.
    run();
    this.timer = setInterval(run, this.config.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

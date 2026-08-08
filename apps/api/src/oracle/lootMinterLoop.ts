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

import type { FreeRunLootMinter, LootMintReport } from './freeRunLootMinter.js';

export interface LootMinterLoopConfig {
  readonly tickIntervalMs: number;
}

/**
 * One minute.
 *
 * The floor is what the ceremony can actually use: each pass advances a run only
 * once its previous transaction has been *mined*, so ticking faster than blocks
 * arrive just spends Hiro reads to be told "still pending". The ceiling is the
 * player's wait — four steps at one step per pass, so a minute here is a drop in
 * their wallet within a few minutes of the fight. Cheap either way, because a
 * pass with nothing owed is a single indexed query and no chain traffic at all.
 */
export const DEFAULT_LOOT_MINTER_LOOP_CONFIG: LootMinterLoopConfig = {
  tickIntervalMs: 60 * 1000,
};

export class LootMinterLoop {
  private readonly config: LootMinterLoopConfig;
  private timer: NodeJS.Timeout | null = null;
  /** Guards against a slow pass overlapping the next tick. */
  private running = false;

  constructor(
    private readonly minter: FreeRunLootMinter,
    config: Partial<LootMinterLoopConfig> = {},
    private readonly log?: (message: string, detail?: Record<string, unknown>) => void,
  ) {
    this.config = { ...DEFAULT_LOOT_MINTER_LOOP_CONFIG, ...config };
  }

  /** One pass, skipped if the previous one is still going. Never throws. */
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

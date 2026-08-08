/**
 * Mints the loot a free run drew (docs/09 B7).
 *
 * WHY THIS IS A BACKGROUND WORKER AND NOT PART OF RESOLVE
 *
 * A free run's fight is settled off-chain, by oracle signature, and finishes in
 * milliseconds. Its loot drop cannot be: `character-loot-nft.mint` only accepts
 * `contract-caller`s in its authorized-minters set, which in practice means
 * `game-core`, and game-core only mints inside `reveal-and-resolve`, which only
 * settles a run it already knows about. So the NFT is reachable only at the end
 * of a three-transaction ceremony — `enter-dungeon` → `commit-seed` →
 * `reveal-and-resolve` — and each step must *confirm* before the next is legal,
 * because the contract's own state machine (pending → committed → resolved)
 * refuses out-of-order calls. Three confirmations is minutes. Making a player
 * wait for that at the end of a fight would be making the free path slower than
 * the paid one.
 *
 * A single-transaction `mint-loot-for-free-run` entrypoint would collapse the
 * whole ceremony, and is the right shape — but Clarity contracts are immutable,
 * so adding one means redeploying game-core and migrating the runs it holds.
 * That was considered and declined; this works against the deployed contract.
 *
 * WHAT THE CHAIN RUN IS AND IS NOT
 *
 * It is a mint vehicle. It is NOT a fairness record, and nothing should ever be
 * read back out of it as one. The fight it stands for was already fought,
 * already attested, and already shown to the player; this run exists so that a
 * mint has somewhere legal to happen. It commits the free run's own
 * already-revealed seed — safe because the run is over and only the oracle can
 * commit or reveal, and better than a fresh secret because the drop stays
 * recomputable from the one seed the player was given.
 *
 * ONE STEP PER PASS, AND WHY IT NEVER DOUBLE-MINTS
 *
 * Each pass advances a run by at most one step, and only after reading the
 * previous step's transaction back as `success`. That read is the guard: a step
 * whose txid is recorded but not yet confirmed is never re-broadcast, so there
 * is no pass at which two `reveal-and-resolve` calls for the same drop can be in
 * flight. If the process dies mid-ceremony, the recorded txids say exactly which
 * step it was on and the next pass resumes there.
 *
 * A step that confirms as aborted parks the run with `failedReason` rather than
 * retrying. Retrying an abort forever spends oracle STX on fees every pass to
 * fail in the same place; an operator should see it instead.
 */

import type { RunRecord, RunStore } from '../repos/runs.js';
import { PaidOracleError, type PaidRunOracle } from './paidRunOracle.js';
import type { ChainClient } from '../lib/hiro.js';

export interface FreeRunLootMinterDeps {
  readonly runs: RunStore;
  readonly oracle: PaidRunOracle;
  readonly chain: ChainClient;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface FreeRunLootMinterConfig {
  /**
   * Runs considered per pass.
   *
   * Small on purpose. Every run advanced in a pass costs one broadcast, and they
   * all come from one oracle account whose nonce is sequential — a large batch
   * would queue transactions behind each other in the mempool without minting
   * anything sooner. The backlog drains at one step per run per pass either way.
   */
  readonly batchSize: number;
}

export const DEFAULT_LOOT_MINTER_CONFIG: FreeRunLootMinterConfig = {
  batchSize: 5,
};

/** What one pass did. Every field is a count of runs, not of transactions. */
export interface LootMintReport {
  readonly considered: number;
  readonly advanced: number;
  readonly minted: number;
  readonly waiting: number;
  readonly failed: number;
  readonly errors: readonly string[];
}

export class FreeRunLootMinter {
  private readonly config: FreeRunLootMinterConfig;

  constructor(
    private readonly deps: FreeRunLootMinterDeps,
    config: Partial<FreeRunLootMinterConfig> = {},
  ) {
    this.config = { ...DEFAULT_LOOT_MINTER_CONFIG, ...config };
  }

  /**
   * One pass over the runs owed a drop.
   *
   * Never throws: a failure on one run is recorded and the rest of the batch is
   * still attempted. A run that throws unexpectedly is left exactly as it was,
   * so the next pass retries the same step rather than skipping it.
   */
  async runOnce(): Promise<LootMintReport> {
    const owed = await this.deps.runs.listFreeRunsAwaitingLootMint(this.config.batchSize);

    let advanced = 0;
    let minted = 0;
    let waiting = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const run of owed) {
      try {
        const step = await this.advance(run);
        if (step === 'minted') {
          minted++;
          advanced++;
        } else if (step === 'advanced') {
          advanced++;
        } else if (step === 'failed') {
          failed++;
        } else {
          waiting++;
        }
      } catch (err) {
        // Left untouched deliberately — an unexpected error is not evidence the
        // ceremony failed on chain, and parking the run on a transient Hiro blip
        // would need an operator to un-park it.
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`run ${run.id}: ${message}`);
        this.deps.log?.('free-run loot mint pass errored on a run', {
          runId: run.id,
          error: message,
        });
      }
    }

    return { considered: owed.length, advanced, minted, waiting, failed, errors };
  }

  /**
   * Advance one run by at most one step.
   *
   * The step to take is derived from what has been recorded, not from a status
   * column: the txids *are* the state machine. `waiting` means the last step is
   * still in the mempool and this pass does nothing for that run.
   */
  private async advance(
    run: RunRecord,
  ): Promise<'advanced' | 'minted' | 'waiting' | 'failed'> {
    const mint = run.lootMint;

    // The seed the free run already revealed. Committed again on chain rather
    // than a fresh secret, so the drop stays recomputable from what the player
    // was shown. A resolved run with no revealed seed is a corrupt row.
    const seed = run.seedReveal;
    if (!seed) {
      await this.fail(run, 'run resolved with no revealed seed');
      return 'failed';
    }

    // Step 1 — enter, to get a run id the contract will accept.
    if (!mint?.enterTxId) {
      const enterTxId = await this.deps.oracle.enterFreeDungeon({ player: run.createdBy });
      await this.deps.runs.updateLootMint(run.id, { enterTxId });
      return 'advanced';
    }

    // Step 1b — read the assigned run id once the entry confirms. Recorded
    // separately from the txid because it only exists after confirmation, and a
    // restart between the two must not re-enter and strand the first run.
    if (!mint.chainRunId) {
      const chainRunId = await this.readEnteredRunId(run, mint.enterTxId);
      if (chainRunId === null) return 'waiting';
      if (chainRunId === FAILED) return 'failed';
      await this.deps.runs.updateLootMint(run.id, { chainRunId });
      return 'advanced';
    }

    // Step 2 — commit the seed.
    if (!mint.commitTxId) {
      const commitTxId = await this.deps.oracle.commitSeed({
        runId: mint.chainRunId,
        seedHash: hashOf(run),
      });
      await this.deps.runs.updateLootMint(run.id, { commitTxId });
      return 'advanced';
    }

    const commitStatus = await this.confirmed(run, mint.commitTxId, 'commit-seed');
    if (commitStatus === 'pending') return 'waiting';
    if (commitStatus === 'failed') return 'failed';

    // Step 3 — resolve, which is the call that actually mints.
    const { resolveTxId } = await this.deps.oracle.resolveFreeLootRun({
      chainRunId: mint.chainRunId,
      seed,
    });
    await this.deps.runs.updateLootMint(run.id, { resolveTxId });
    this.deps.log?.('free-run loot mint broadcast', {
      runId: run.id,
      chainRunId: mint.chainRunId,
      resolveTxId,
    });
    return 'minted';
  }

  /** Sentinel for "this step confirmed as aborted and the run has been parked". */
  private async readEnteredRunId(
    run: RunRecord,
    enterTxId: string,
  ): Promise<string | null | typeof FAILED> {
    try {
      return await this.deps.oracle.readEnteredRunId(enterTxId);
    } catch (err) {
      if (err instanceof PaidOracleError) {
        await this.fail(run, `${err.code}: ${err.message}`);
        return FAILED;
      }
      throw err;
    }
  }

  /**
   * Whether a broadcast step has confirmed.
   *
   * A txid the node has never heard of reads as pending rather than as an error:
   * a just-broadcast transaction can briefly 404, and treating that as a failure
   * would park a ceremony that is about to work.
   */
  private async confirmed(
    run: RunRecord,
    txId: string,
    label: string,
  ): Promise<'ok' | 'pending' | 'failed'> {
    const tx = await this.deps.chain.getTransaction(txId);
    if (!tx || tx.txStatus === 'pending') return 'pending';
    if (tx.txStatus === 'success') return 'ok';

    await this.fail(run, `${label} confirmed as ${tx.txStatus}`);
    return 'failed';
  }

  private async fail(run: RunRecord, reason: string): Promise<void> {
    await this.deps.runs.updateLootMint(run.id, { failedReason: reason });
    // Logged loudly: a parked ceremony is a player owed an NFT they can see in
    // their reward screen and do not have in their wallet.
    this.deps.log?.('FREE-RUN LOOT MINT FAILED — a drawn drop was not minted', {
      runId: run.id,
      reason,
      action: 'inspect the ceremony transactions, then clear loot_mint_failed_reason to requeue',
    });
  }
}

const FAILED = Symbol('loot-mint-failed');

/**
 * The seed hash to commit on chain.
 *
 * Taken from the run's stored `seedHash` — the same commitment the player was
 * shown at entry — rather than recomputed from the reveal. If those two ever
 * disagreed, recomputing would paper over it, and `reveal-and-resolve` checking
 * `sha256(seed)` against this is the whole reason the ceremony is verifiable at
 * all.
 */
function hashOf(run: RunRecord): string {
  if (!run.seedHash) {
    throw new Error(`run ${run.id} resolved with no seed commitment`);
  }
  return run.seedHash;
}

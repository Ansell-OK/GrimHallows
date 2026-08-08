/**
 * The chain-event indexer — 06-mvp-roadmap Phase 7.
 *
 * WHAT THIS IS FOR. 01-game-design.md#8 requires the leaderboard to be "a
 * verifiable index over chain history, not a trusted database claim". That
 * sentence is a constraint on where numbers come from, and this module is where
 * it is honoured: every rank input is either read back off a confirmed
 * transaction, or derived from a run this backend settled and signed for. No
 * counter is incremented by a request handler, and nothing here believes a
 * client.
 *
 * FIVE JOBS, IN ORDER, AND WHY THAT ORDER
 *
 *   1. `syncRecipes`  — mirror the on-chain recipe ladder into `forge_recipes`.
 *   2. `syncForges`   — walk `forge`'s chain history into `forge_history`.
 *   3. `backfillLoot` — read each mint transaction's `loot-minted` print and
 *                       fill in the token id the reward row is missing.
 *   4. `verifySettlements` — read each settling transaction's *status* back, and
 *                       flag the ones the chain refused.
 *
 * Both of those last two read a paid run's own `reveal-and-resolve` and, since
 * docs/09 B7, a free run's separate loot-mint ceremony resolve. Each says in its
 * own doc comment why the two shapes cannot be collapsed.
 *   5. `recomputeStats` — derive `player_stats` from the rows above.
 *
 * Recipes come before forges because a forge names a *recipe id* and the tier it
 * produced is looked up through it; forges and loot come before the recompute
 * because the recompute reads what they wrote. Running them out of order is not
 * a corruption — each is idempotent and the next pass converges — but it costs a
 * cycle of staleness for no reason.
 *
 * EVERY JOB IS IDEMPOTENT AND EVERY PASS RE-READS. There is no stored cursor.
 * `syncForges` walks backwards from the newest transaction and stops at the
 * first txid `forge_history` already has, which puts the restart position inside
 * the data rather than in a marker that can drift from it; the unique index on
 * `forge_history.tx_id` makes a re-walk a no-op rather than a duplicate. That
 * matters more than it sounds: `highest_forge_tier` climbing because the indexer
 * ran twice would be a rank nobody earned.
 *
 * THIS MODULE SIGNS NOTHING AND MOVES NOTHING. It holds no key, calls no
 * `broadcastRawTx`, and reads no balance. It is not part of `src/oracle/` and
 * must not become part of it: the oracle can move sponsor-pool funds, and a
 * scheduled background job is the last place that capability belongs. The only
 * writes it makes are to cache tables that are rebuildable from chain.
 *
 * That rule is also the shape of `verifySettlements`, which finds settlements the
 * chain rejected and deliberately does not re-settle them: re-resolving means
 * signing. It flags and logs; a human decides.
 *
 * FAILURE IS PER-JOB, NOT PER-PASS. Hiro goes down, rate-limits, and lags. A job
 * that throws is caught, recorded in the returned report and logged; the
 * remaining jobs still run. The alternative — one 429 stopping the recompute —
 * would freeze the leaderboard on an unrelated outage.
 */

import {
  contractId as buildContractId,
  leaderboardScore,
  type NetworkConfig,
} from '@grimhallow/shared';
import type { ChainClient, ChainTransaction } from '../lib/hiro.js';
import type { ForgeEvent, ForgeHistoryStore } from '../repos/forgeHistory.js';
import type { PlayerStatsRow, PlayerStatsStore } from '../repos/playerStats.js';
import type { RunStore } from '../repos/runs.js';
import type { ForgeService } from '../services/forgeService.js';
import {
  eventName,
  principalField,
  printEvents,
  smallUintField,
  uintField,
  uintListField,
} from './events.js';

export interface IndexerDeps {
  readonly chain: ChainClient;
  readonly stacks: NetworkConfig;
  readonly runs: RunStore;
  readonly forgeHistory: ForgeHistoryStore;
  readonly playerStats: PlayerStatsStore;
  /** Reused rather than re-implemented — recipes are read one way in this codebase. */
  readonly forge: ForgeService;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Injectable so a test can assert the exact `updated_at` written. */
  readonly now?: () => Date;
}

/** What one pass did, per job. Returned rather than logged so a test can assert it. */
export interface IndexerReport {
  readonly recipesMirrored: number;
  readonly forgesRecorded: number;
  readonly lootTokenIdsFilled: number;
  /** Settlements the chain confirmed this pass. */
  readonly settlementsVerified: number;
  /** Of those, the ones the chain refused. Non-zero is an incident, not a metric. */
  readonly settlementsAborted: number;
  readonly playersRanked: number;
  /** One entry per job that threw. Empty on a clean pass. */
  readonly errors: readonly { readonly job: string; readonly message: string }[];
}

/**
 * How far back a single pass walks `forge`'s history.
 *
 * Only reached on a cold start, where `forge_history` is empty and there is no
 * watermark to stop at. A warm pass stops at the first known txid, which is
 * normally within the first page.
 */
const FORGE_WALK_LIMIT = 500;

/** Resolve transactions re-read per pass for a missing loot token id. */
const LOOT_BACKFILL_LIMIT = 50;

/** Settlements checked against the chain per pass. */
const SETTLEMENT_VERIFY_LIMIT = 50;

/**
 * How long a settlement may stay unconfirmed before it is worth reporting.
 *
 * A transaction sits in the mempool for a block or two on a good day and much
 * longer when fees spike, so "not confirmed yet" is normal and not a finding.
 * This is only the threshold for *saying something* — nothing is ever marked
 * failed on a timeout, because a slow transaction and a dead one look identical
 * until the chain decides.
 */
const SETTLEMENT_STALE_MS = 60 * 60 * 1000;

export class Indexer {
  constructor(private readonly deps: IndexerDeps) {}

  private get forgeContractId(): string {
    return buildContractId(this.deps.stacks, 'forge');
  }

  private get gameCoreId(): string {
    return buildContractId(this.deps.stacks, 'gameCore');
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Run every job once, in dependency order.
   *
   * Never throws. A job's failure is data in the report, because the caller is a
   * scheduler and an unhandled rejection in a timer is an outage with no
   * message attached.
   */
  async runOnce(): Promise<IndexerReport> {
    const errors: { job: string; message: string }[] = [];

    const attempt = async <T>(job: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ job, message });
        this.deps.log?.(`indexer job failed: ${job}`, { error: message });
        return fallback;
      }
    };

    const recipesMirrored = await attempt('syncRecipes', () => this.syncRecipes(), 0);
    const forgesRecorded = await attempt('syncForges', () => this.syncForges(), 0);
    const lootTokenIdsFilled = await attempt('backfillLoot', () => this.backfillLoot(), 0);
    const settlements = await attempt(
      'verifySettlements',
      () => this.verifySettlements(),
      { verified: 0, aborted: 0 },
    );
    const playersRanked = await attempt('recomputeStats', () => this.recomputeStats(), 0);

    return {
      recipesMirrored,
      forgesRecorded,
      lootTokenIdsFilled,
      settlementsVerified: settlements.verified,
      settlementsAborted: settlements.aborted,
      playersRanked,
      errors,
    };
  }

  // -------------------------------------------------------------------------
  // 1. Recipes
  // -------------------------------------------------------------------------

  /**
   * Mirror the on-chain recipe ladder.
   *
   * Goes through `ForgeService` rather than reading `get-recipe` again here, so
   * there is exactly one piece of code in this repo that knows how a recipe
   * tuple is shaped. A second reader would be a second chance to map a tier
   * differently from the first, and the tier is what `highestForgeTier` scores.
   *
   * The mirror exists only because a forge transaction names a recipe *id*: the
   * tier it produced has to be looked up, and doing that on chain per row would
   * be thousands of identical calls for a value the contract makes immutable at
   * creation. Player-facing reads still go to chain every time
   * (`services/forgeService.ts`), so this cache can never become what a player
   * is shown.
   */
  async syncRecipes(): Promise<number> {
    const recipes = await this.deps.forge.listRecipes();
    if (recipes.length === 0) return 0;
    await this.deps.forgeHistory.putRecipes(recipes);
    return recipes.length;
  }

  // -------------------------------------------------------------------------
  // 2. Forges
  // -------------------------------------------------------------------------

  /**
   * Walk `forge`'s transaction history and record what it finds.
   *
   * This is the job that makes `highestForgeTier` allowed on the leaderboard at
   * all. A forge is a user-signed transaction — the player gets an unsigned
   * payload from `POST /forge`, signs it in their own wallet and broadcasts it
   * themselves — so this backend never observes the burn. Reading it back off
   * chain is the difference between an indexed fact and a self-reported one.
   *
   * Only successful transactions count. An `abort_by_post_condition` forge burnt
   * nothing and minted nothing; crediting it would be crediting an attempt.
   */
  async syncForges(): Promise<number> {
    // The watermark. A generous slice rather than a single txid because two
    // forges can share a block and arrive in either order, so "the newest one I
    // have" is not reliably the boundary — "any one I have" is.
    const known = new Set(await this.deps.forgeHistory.recentTxIds(200));

    const transactions = await this.deps.chain.listContractCalls({
      contractId: this.forgeContractId,
      functionName: 'forge',
      limit: FORGE_WALK_LIMIT,
      stopAtTxIds: known,
    });

    const events: ForgeEvent[] = [];
    for (const tx of transactions) {
      if (tx.txStatus !== 'success') continue;
      if (known.has(tx.txId)) continue;

      // List responses may omit events (Hiro paginates them separately), so the
      // transaction is re-read for its print. One extra call per *new* forge —
      // not per pass — because the watermark keeps this loop short.
      const full = (await this.deps.chain.getTransaction(tx.txId)) ?? tx;
      const parsed = this.parseForge(full);
      if (!parsed) {
        this.deps.log?.('skipping unreadable forge transaction', { txId: tx.txId });
        continue;
      }
      events.push(parsed);
    }

    return this.deps.forgeHistory.record(events);
  }

  /** A confirmed `forge` transaction → the event, or null if its print is unreadable. */
  private parseForge(tx: ChainTransaction): ForgeEvent | null {
    for (const tuple of printEvents(tx, this.forgeContractId)) {
      if (eventName(tuple) !== 'forged') continue;

      const forger = principalField(tuple, 'forger');
      const recipeId = smallUintField(tuple, 'recipe-id');
      const mintedTokenId = uintField(tuple, 'token-id');
      const burned = uintListField(tuple, 'burned');
      // All four or nothing. A partially-read forge would put a row in history
      // whose address or tier is a guess, and both are scored.
      if (forger === null || recipeId === null || mintedTokenId === null || burned === null) {
        return null;
      }

      return {
        address: forger,
        recipeId,
        burnedTokenIds: burned,
        mintedTokenId,
        txId: tx.txId,
        // Hiro's transaction shape does not carry a block time in the narrow
        // `ChainTransaction` this codebase reads, so the row is stamped at index
        // time. It bounds a window slightly late, never early — a forge cannot
        // be indexed before it happened — and no score depends on the instant,
        // only on which side of a 7d/30d boundary it falls.
        at: this.now(),
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 3. Loot token ids
  // -------------------------------------------------------------------------

  /**
   * Fill in the loot token id each resolved loot draw is missing.
   *
   * `RunRewardRecord.lootTokenId` is null at resolve time by design: the id is
   * assigned by `character-loot-nft` inside the resolve transaction, so the code
   * that recorded the reward had not read it and recording a guess would put an
   * id in the row that no NFT necessarily has. The `loot-minted` print carries
   * it, and the resolve txid is already on the run — no new chain surface is
   * needed, only a second look at a transaction this backend broadcast.
   *
   * TWO SHAPES SINCE docs/09 B7. A paid run mints inside its own resolve, and the
   * print names the same run id the row has. A free run's drop is minted later,
   * by the loot minter's ceremony, under a *chain* run id that has nothing to do
   * with the database id — so both the transaction to read and the id to match
   * against come off `lootMint`. Matching a free run on `run.id` would compare
   * two unrelated counters and reject every print, which is a token id that never
   * arrives rather than a wrong one.
   *
   * Scores nothing. This is the reward screen's "your loot" link becoming real,
   * not a rank input — `leaderboardScore` counts jackpots, and a loot draw is
   * already counted as the completed dungeon it was.
   */
  async backfillLoot(): Promise<number> {
    const pending = await this.deps.runs.listAwaitingLootTokenId(LOOT_BACKFILL_LIMIT);
    let filled = 0;

    for (const run of pending) {
      // A free run has no `resolveTxId` of its own: its fight was settled by
      // signature, off chain. The ceremony's resolve is the only transaction that
      // minted anything for it.
      const mintTxId = run.resolveTxId ?? run.lootMint?.resolveTxId ?? null;
      const mintedUnderRunId = run.resolveTxId ? run.id : run.lootMint?.chainRunId ?? null;
      if (!mintTxId || !mintedUnderRunId) continue;

      const tx = await this.deps.chain.getTransaction(mintTxId);
      // A resolve that has fallen out of the node's view, or has not confirmed,
      // is not an error — the next pass looks again.
      if (!tx || tx.txStatus !== 'success') continue;

      for (const tuple of printEvents(tx, this.gameCoreId)) {
        if (eventName(tuple) !== 'loot-minted') continue;
        // The transaction is looked up *by* this run's resolve txid, so its
        // events belong to this run. The check is still worth making: a resolve
        // that printed a different run's id would mean the txid on the row is
        // wrong, and silently attaching the token would hide that.
        if (uintField(tuple, 'run-id') !== mintedUnderRunId) continue;

        const tokenId = uintField(tuple, 'token-id');
        if (tokenId === null) continue;
        if (await this.deps.runs.setLootTokenId(run.id, tokenId)) filled++;
        break;
      }
    }

    return filled;
  }

  // -------------------------------------------------------------------------
  // 4. Settlements
  // -------------------------------------------------------------------------

  /**
   * Check that the chain agreed with each settlement this backend recorded.
   *
   * THE GAP THIS CLOSES. `resolve()` writes a run as `resolved` the moment
   * `broadcastTransaction` returns a txid — and a txid means the node accepted a
   * well-formed, funded transaction, nothing more. A failed `asserts!` inside
   * `reveal-and-resolve` aborts it *afterwards*, on chain, and no code path
   * looked again. So a row reading `reward_kind = 'loot'` and an NFT that was
   * never minted were indistinguishable, and the explorer was the only place the
   * difference showed.
   *
   * That is not a hypothetical failure mode. On mainnet the contract's `oracle`
   * var still named the deployer while the backend signed as its own key, so six
   * consecutive oracle transactions aborted with `(err u201)` — three paid
   * entries charged a gate fee and recorded as settled. `PaidRunOracle` now
   * refuses to broadcast into that mismatch, but a refusal only covers the cause
   * we have already seen: a post-condition that fires, a pool drained between the
   * read and the mine, a contract upgrade that tightens an assert. This pass is
   * what notices the next one.
   *
   * IT DOES NOT RE-SETTLE, and must not. Re-resolving means signing, and this
   * module holds no key by design (see the module header) — the oracle can move
   * sponsor-pool funds and a scheduled background job is the last place that
   * capability belongs. Detection is the whole job: flag the row, log it loudly,
   * and leave the decision to an operator who can see what actually happened.
   *
   * A pending transaction is left alone rather than guessed at. Nothing is ever
   * marked failed on a timeout, because a slow settlement and a dead one look
   * identical until the chain decides — the only cost of waiting is that the
   * report says so.
   *
   * TWO TRANSACTIONS SINCE docs/09 B7. A paid run's reward rides on its own
   * `reveal-and-resolve` and is checked here on `resolveTxId`. A free run has no
   * such transaction — it settles by signature — but a free run that drew loot
   * has a mint ceremony, and that ceremony's resolve is what actually creates the
   * NFT. `FreeRunLootMinter` records the txid the instant the node accepts it and
   * then stops considering the run, so if nothing read it back, an aborted
   * ceremony would leave exactly the state this pass exists to catch: a row
   * promising a drop, and no token.
   */
  async verifySettlements(): Promise<{ verified: number; aborted: number }> {
    const pending = await this.deps.runs.listUnverifiedSettlements(SETTLEMENT_VERIFY_LIMIT);
    const at = this.now();
    let verified = 0;
    let aborted = 0;

    for (const run of pending) {
      // Whichever transaction carries this run's reward. A run has one or the
      // other, never both, so the order only decides which null is skipped.
      const settleTxId = run.resolveTxId ?? run.lootMint?.resolveTxId ?? null;
      if (!settleTxId) continue;
      const tx = await this.deps.chain.getTransaction(settleTxId);

      // Not mined yet, or the node has never heard of it. Both are "ask again
      // next pass" — a transaction the mempool dropped will simply never confirm,
      // and the staleness note below is how that becomes visible.
      if (!tx || tx.txStatus === 'pending') {
        const age = at.getTime() - (run.resolvedAt?.getTime() ?? at.getTime());
        if (age > SETTLEMENT_STALE_MS) {
          this.deps.log?.('settlement still unconfirmed long after broadcast', {
            runId: run.id,
            resolveTxId: settleTxId,
            ageMinutes: Math.round(age / 60_000),
            known: tx !== null,
          });
        }
        continue;
      }

      if (tx.txStatus === 'success') {
        if (await this.deps.runs.markSettlementVerified(run.id, null, at)) verified++;
        continue;
      }

      // The chain refused it. The run says it paid out; the chain says nothing
      // happened. Logged at the top of its voice because every one of these is a
      // player who was shown a reward they do not have.
      this.deps.log?.('SETTLEMENT ABORTED ON CHAIN — the recorded reward does not exist', {
        runId: run.id,
        resolveTxId: settleTxId,
        // Which of the two paths this was. A free run's abort means the mint
        // ceremony failed, not the fight, and the operator's next move differs.
        dungeonType: run.dungeonType,
        txStatus: tx.txStatus,
        // The Clarity error, e.g. `(err u201)`, which names the assert that
        // failed. The single most useful field for working out why.
        result: tx.resultRepr,
        rewardKind: run.reward?.kind ?? null,
        rewardAmountUstx: run.reward?.amountUstx ?? null,
        createdBy: run.createdBy,
      });
      // `tx_status` verbatim rather than a local vocabulary, so an operator can
      // search for the same string the explorer shows them.
      if (await this.deps.runs.markSettlementVerified(run.id, tx.txStatus, at)) {
        verified++;
        aborted++;
      }
    }

    return { verified, aborted };
  }

  // -------------------------------------------------------------------------
  // 5. Ranks
  // -------------------------------------------------------------------------

  /**
   * Recompute `player_stats` from the source tables.
   *
   * The score is `leaderboardScore()` from `@grimhallow/shared` — the same
   * function the API publishes counts alongside, so a player holding a
   * `GET /leaderboard` response can call it on those counts and get this number
   * back. Computing it in a SQL expression instead would make the rank a claim
   * only this server can evaluate, which 01-game-design.md#8 rules out.
   *
   * Always over all of history. The windowed views (`?window=7d`) are derived
   * live at request time from the same `aggregate()` with a date bound, so there
   * is exactly one definition of a completed dungeon and the windows cannot
   * drift from the all-time table.
   */
  async recomputeStats(): Promise<number> {
    const counts = await this.deps.playerStats.aggregate(null);
    const at = this.now();
    const rows: PlayerStatsRow[] = counts.map((c) => ({
      ...c,
      score: leaderboardScore(c),
      updatedAt: at,
    }));
    await this.deps.playerStats.replaceAll(rows);
    return rows.length;
  }
}

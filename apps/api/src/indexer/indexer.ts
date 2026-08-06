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
 * FOUR JOBS, IN ORDER, AND WHY THAT ORDER
 *
 *   1. `syncRecipes`  — mirror the on-chain recipe ladder into `forge_recipes`.
 *   2. `syncForges`   — walk `forge`'s chain history into `forge_history`.
 *   3. `backfillLoot` — read each resolve transaction's `loot-minted` print and
 *                       fill in the token id the reward row is missing.
 *   4. `recomputeStats` — derive `player_stats` from the rows above.
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
    const playersRanked = await attempt('recomputeStats', () => this.recomputeStats(), 0);

    return { recipesMirrored, forgesRecorded, lootTokenIdsFilled, playersRanked, errors };
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
   * Scores nothing. This is the reward screen's "your loot" link becoming real,
   * not a rank input — `leaderboardScore` counts jackpots, and a loot draw is
   * already counted as the completed dungeon it was.
   */
  async backfillLoot(): Promise<number> {
    const pending = await this.deps.runs.listAwaitingLootTokenId(LOOT_BACKFILL_LIMIT);
    let filled = 0;

    for (const run of pending) {
      if (!run.resolveTxId) continue;
      const tx = await this.deps.chain.getTransaction(run.resolveTxId);
      // A resolve that has fallen out of the node's view, or has not confirmed,
      // is not an error — the next pass looks again.
      if (!tx || tx.txStatus !== 'success') continue;

      for (const tuple of printEvents(tx, this.gameCoreId)) {
        if (eventName(tuple) !== 'loot-minted') continue;
        // The transaction is looked up *by* this run's resolve txid, so its
        // events belong to this run. The check is still worth making: a resolve
        // that printed a different run's id would mean the txid on the row is
        // wrong, and silently attaching the token would hide that.
        if (uintField(tuple, 'run-id') !== run.id) continue;

        const tokenId = uintField(tuple, 'token-id');
        if (tokenId === null) continue;
        if (await this.deps.runs.setLootTokenId(run.id, tokenId)) filled++;
        break;
      }
    }

    return filled;
  }

  // -------------------------------------------------------------------------
  // 4. Ranks
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

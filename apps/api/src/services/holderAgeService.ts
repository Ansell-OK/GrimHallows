/**
 * Holder-age service — how long the CURRENT holder has held each token.
 *
 * The input to rarity (01-game-design.md#4b), and the one part of character
 * derivation that is not pure: it depends on chain history and on who is asking.
 *
 * THREE PATHS, in order of preference:
 *
 *   1. `holdings_block_height` — Hiro's holdings response already carries the
 *      block at which this wallet received this token, so the common case costs
 *      one block→timestamp lookup that is shared across every token in the same
 *      block and cached permanently. No extra per-token request at all.
 *   2. `history_fallback` — some collections come back without that field. Walk
 *      the token's transfer history and take the MOST RECENT event where this
 *      wallet was the recipient. Most recent, not earliest: a wallet that sold
 *      and re-bought gave up its tenure when it sold.
 *   3. `fallback_pending` — everything failed. Return holdDays 0 and say so.
 *
 * NEVER BLOCKS. Every failure mode above lands on path 3, which is a successful
 * response with an honest label. 02-architecture.md#4 is explicit that a flaky
 * Hiro call must cost a player some rarity for a few minutes, never a
 * character-select screen — so nothing here throws, and nothing here retries in
 * line. The pending row is the retry queue.
 *
 * The bounded underestimate is the right direction to fail in: a lookup failure
 * makes a character weaker than it should be, never stronger. Failing the other
 * way would make an outage a way to farm rarity.
 */

import type { HolderAge, HolderAgeSource } from '@grimhallow/shared';
import { holdDaysSince } from '@grimhallow/shared';
import type { ChainClient, NftHolding } from '../lib/hiro.js';
import type { HolderAgeRepo } from '../repos/holderAge.js';

/** Bound on concurrent history/block lookups, to stay friendly to Hiro's limits. */
const LOOKUP_CONCURRENCY = 6;

/** Served whenever we do not know, which is always a bounded underestimate. */
export const UNKNOWN_HOLDER_AGE: HolderAge = { holdDays: 0, source: 'fallback_pending' };

/** Cache key for the per-request map. Not persisted; the DB key is the tuple. */
export function holdingKey(contractId: string, tokenId: string): string {
  return `${contractId.toLowerCase()}::${tokenId}`;
}

export interface HolderAgeServiceDeps {
  readonly chain: ChainClient;
  readonly repo: HolderAgeRepo;
}

export class HolderAgeService {
  /**
   * Block-timestamp lookups currently in flight, keyed by height.
   *
   * The repo cache alone does not dedupe a concurrent wave: `forHoldings` runs
   * six lookups at once, and six tokens bought in the same transaction all miss
   * the cache together, then all fetch the same block, before any of them writes
   * the answer back. Coalescing on the promise closes that window, which is the
   * common case rather than an edge one — batch buys are how people acquire
   * NFTs. Entries are deleted on settle, so this holds at most one entry per
   * in-flight height and never grows into a leak.
   */
  private readonly inFlightBlocks = new Map<number, Promise<number | null>>();

  constructor(private readonly deps: HolderAgeServiceDeps) {}

  /**
   * Hold durations for every holding, keyed by `holdingKey`.
   *
   * Batched rather than per-token so the block-timestamp lookups dedupe: a
   * wallet that bought twelve tokens in one transaction resolves them all from
   * one block fetch.
   */
  async forHoldings(
    ownerAddress: string,
    holdings: readonly NftHolding[],
    now: number = Date.now(),
  ): Promise<Map<string, HolderAge>> {
    const ages = new Map<string, HolderAge>();

    for (let i = 0; i < holdings.length; i += LOOKUP_CONCURRENCY) {
      const batch = holdings.slice(i, i + LOOKUP_CONCURRENCY);
      const resolved = await Promise.all(
        batch.map(async (holding) => {
          try {
            return [holding, await this.forHolding(ownerAddress, holding, now)] as const;
          } catch {
            // Belt and braces: forHolding already swallows its own failures.
            return [holding, UNKNOWN_HOLDER_AGE] as const;
          }
        }),
      );
      for (const [holding, age] of resolved) {
        ages.set(holdingKey(holding.contractId, holding.tokenId), age);
      }
    }

    return ages;
  }

  /**
   * Hold duration for a single token whose holding entry we do not have.
   *
   * The combat path's entry point: a run carries a `(contractId, tokenId)` and
   * an owner, not a Hiro holdings row. Combat has to ask, because a character's
   * stats in a fight must be the stats on its card — deriving combat stats at
   * holdDays 0 while the character screen shows Epic would be the two
   * implementations this codebase is built to avoid, just spread across two
   * request paths instead of two files.
   *
   * Cheap in the ordinary case: the character-select request that preceded this
   * one has already warmed the cache for every token in the wallet, so this is a
   * single indexed read. Only a cold cache pays for the holdings fetch.
   */
  async forToken(
    ownerAddress: string,
    contractId: string,
    tokenId: string,
    now: number = Date.now(),
  ): Promise<HolderAge> {
    const cached = await this.deps.repo.get(ownerAddress, contractId, tokenId).catch(() => null);
    if (cached) {
      if (cached.acquiredAtMs === null) return { holdDays: 0, source: cached.source };
      return { holdDays: holdDaysSince(cached.acquiredAtMs, now), source: cached.source };
    }

    // Cold: find the holding so the normal path has an acquisition block and an
    // asset identifier to fall back on. A wallet that no longer holds the token
    // yields nothing, which degrades rather than throwing — ownership gates live
    // in the contracts, not here.
    const holdings = await this.deps.chain.getNftHoldings(ownerAddress).catch(() => []);
    const holding = holdings.find(
      (h) => h.contractId.toLowerCase() === contractId.toLowerCase() && h.tokenId === tokenId,
    );
    if (!holding) return UNKNOWN_HOLDER_AGE;

    return this.forHolding(ownerAddress, holding, now);
  }

  async forHolding(
    ownerAddress: string,
    holding: NftHolding,
    now: number = Date.now(),
  ): Promise<HolderAge> {
    const cached = await this.deps.repo
      .get(ownerAddress, holding.contractId, holding.tokenId)
      .catch(() => null);
    if (cached) {
      if (cached.acquiredAtMs === null) return { holdDays: 0, source: cached.source };
      return {
        holdDays: holdDaysSince(cached.acquiredAtMs, now),
        source: cached.source,
      };
    }

    const resolved = await this.resolve(ownerAddress, holding);

    await this.deps.repo
      .put({
        ownerAddress,
        contractId: holding.contractId,
        tokenId: holding.tokenId,
        acquiredBlockHeight: resolved.blockHeight,
        acquiredAtMs: resolved.acquiredAtMs,
        source: resolved.source,
      })
      .catch(() => {});

    if (resolved.acquiredAtMs === null) return { holdDays: 0, source: resolved.source };
    return { holdDays: holdDaysSince(resolved.acquiredAtMs, now), source: resolved.source };
  }

  /** The three paths. Returns rather than throws on every branch. */
  private async resolve(
    ownerAddress: string,
    holding: NftHolding,
  ): Promise<{
    blockHeight: number | null;
    acquiredAtMs: number | null;
    source: HolderAgeSource;
  }> {
    let source: HolderAgeSource = 'holdings_block_height';
    let blockHeight = holding.blockHeight;

    if (blockHeight === null) {
      source = 'history_fallback';
      blockHeight = await this.deps.chain
        .getNftAcquisitionBlock({
          assetIdentifier: holding.assetIdentifier,
          tokenId: holding.tokenId,
          owner: ownerAddress,
        })
        .catch(() => null);
    }

    if (blockHeight === null) {
      return { blockHeight: null, acquiredAtMs: null, source: 'fallback_pending' };
    }

    const seconds = await this.blockTimestamp(blockHeight);
    if (seconds === null) {
      // The block height is a real answer even when its timestamp isn't yet, so
      // keep it: the retry then only needs the cheap half.
      return { blockHeight, acquiredAtMs: null, source: 'fallback_pending' };
    }

    return { blockHeight, acquiredAtMs: seconds * 1000, source };
  }

  /** Permanent cache in front of the chain. A mined block's time never moves. */
  private async blockTimestamp(blockHeight: number): Promise<number | null> {
    const cached = await this.deps.repo.getBlockTimestamp(blockHeight).catch(() => null);
    if (cached !== null) return cached;

    const inFlight = this.inFlightBlocks.get(blockHeight);
    if (inFlight) return inFlight;

    const pending = this.fetchBlockTimestamp(blockHeight).finally(() => {
      this.inFlightBlocks.delete(blockHeight);
    });
    this.inFlightBlocks.set(blockHeight, pending);
    return pending;
  }

  private async fetchBlockTimestamp(blockHeight: number): Promise<number | null> {
    const fetched = await this.deps.chain.getBlockTimestamp(blockHeight).catch(() => null);
    if (fetched === null) return null;

    await this.deps.repo.putBlockTimestamp(blockHeight, fetched).catch(() => {});
    return fetched;
  }
}

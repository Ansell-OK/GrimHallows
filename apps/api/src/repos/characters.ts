/**
 * Character identity cache (`character_stats_cache`).
 *
 * Caches the HOLDER-INDEPENDENT half of a character's derivation: display name,
 * image, and class. Those are a pure function of (contractId, tokenId, metadata,
 * algoVersion) — the same for every wallet, forever.
 *
 * WHAT IT DELIBERATELY DOES NOT CACHE, and why it matters more than what it
 * does: under stats-v3 rarity comes from the *current holder's* tenure and
 * resets on transfer (01-game-design.md#4b). This table's key has no owner
 * column, so a rarity written here would outlive the ownership that produced it
 * and a buyer would be shown the seller's tier. Rarity, holdDays and stats are
 * therefore recomputed per request from `deriveCharacter`, and holder age has
 * its own owner-scoped cache in `holderAge.ts`.
 *
 * That costs nothing worth counting. The expensive thing was always the Hiro
 * metadata round trip — hundreds of milliseconds — not the arithmetic, which is
 * microseconds. This still caches the round trip.
 *
 * It also does not cache ownership: which characters a wallet holds is re-read
 * from chain every request. A cache that remembered ownership would eventually
 * show someone a character they had already sold.
 *
 * Keyed by algo_version, which is also how superseded rows retire: a v1 row's
 * payload had a different shape, and a v2 row's identity may carry a class this
 * build no longer recognises — the hashed fallback the curated-collection delta
 * removed. Neither is read again, so neither has to be migrated.
 */

import type { CharacterIdentity, NftMetadata } from '@grimhallow/shared';
import { query } from '../db.js';

/** Metadata can change under a token, so entries are not kept indefinitely. */
export const CHARACTER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * What one row holds: the identity, plus the metadata it was derived from.
 *
 * The metadata is stored rather than re-fetched because it is the expensive
 * input AND a stat input — it contributes the bounded per-stat bonus
 * (01-game-design.md#4c). Caching the identity alone would mean a cache hit
 * produced slightly different stats from a cache miss for the same token, which
 * is exactly the kind of "correct on Tuesday" derivation the shared-package rule
 * exists to prevent. Both halves are holder-independent, so both are safe here.
 */
export interface CharacterCacheEntry {
  readonly identity: CharacterIdentity;
  readonly metadata: NftMetadata | null;
}

export interface CharacterCache {
  get(
    contractId: string,
    tokenId: string,
    algoVersion: string,
  ): Promise<CharacterCacheEntry | null>;
  put(entry: CharacterCacheEntry): Promise<void>;
}

export class PostgresCharacterCache implements CharacterCache {
  async get(
    contractId: string,
    tokenId: string,
    algoVersion: string,
  ): Promise<CharacterCacheEntry | null> {
    const { rows } = await query<{ stats_json: CharacterCacheEntry; computed_at: Date }>(
      `select stats_json, computed_at
         from character_stats_cache
        where nft_contract_id = $1 and nft_token_id = $2 and algo_version = $3`,
      [contractId, tokenId, algoVersion],
    );
    const row = rows[0];
    if (!row) return null;
    if (Date.now() - row.computed_at.getTime() > CHARACTER_CACHE_TTL_MS) return null;

    // A v1-shaped row under a v2 key should be impossible, but a payload with no
    // class is unusable either way and a miss is always safe. Cheaper to check
    // than to debug a character rendering as `undefined`.
    if (!row.stats_json?.identity?.classId) return null;
    return row.stats_json;
  }

  async put(entry: CharacterCacheEntry): Promise<void> {
    await query(
      `insert into character_stats_cache
         (nft_contract_id, nft_token_id, algo_version, stats_json, computed_at)
       values ($1, $2, $3, $4, now())
       on conflict (nft_contract_id, nft_token_id, algo_version)
       do update set stats_json = excluded.stats_json, computed_at = now()`,
      [
        entry.identity.contractId,
        entry.identity.tokenId,
        entry.identity.algoVersion,
        JSON.stringify(entry),
      ],
    );
  }
}

/** No-op cache: correct behaviour, zero storage. Used when Postgres is absent. */
export class NullCharacterCache implements CharacterCache {
  async get(): Promise<CharacterCacheEntry | null> {
    return null;
  }
  async put(): Promise<void> {}
}

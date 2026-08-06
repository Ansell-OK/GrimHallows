/**
 * Holder-age cache (`nft_holder_age_cache`) and block-timestamp cache
 * (`block_timestamps`).
 *
 * Two caches with deliberately different lifetimes, per 02-architecture.md#4:
 *
 *   - `block_timestamps` is PERMANENT. A mined block's timestamp never changes,
 *     and every token acquired in that block shares it, so this is a pure win
 *     that grows sublinearly with traffic.
 *   - `nft_holder_age_cache` is OWNER-SCOPED and short-lived. The owner address
 *     is part of the primary key, which is the entire mechanism by which rarity
 *     resets on transfer: the new owner has no row, so they get a fresh lookup
 *     and a fresh clock. There is no invalidation step to forget, because there
 *     is nothing to invalidate — the stale row simply becomes unreachable.
 *
 * A row with `source = 'fallback_pending'` records a failed lookup being served
 * as freshly acquired. It is kept rather than discarded so the background retry
 * has a work list, and so a wallet with a flaky collection doesn't re-hammer
 * Hiro on every character-select render.
 */

import type { HolderAgeSource } from '@grimhallow/shared';
import { query } from '../db.js';

/**
 * How long a successful acquisition lookup is trusted.
 *
 * Long, because the answer barely moves: an acquisition block is a historical
 * fact, and the only thing that can change it is a transfer — which changes the
 * *key*, not the value. This TTL exists to eventually correct a reorg-era or
 * mid-index answer, not to track ownership.
 */
export const HOLDER_AGE_TTL_MS = 24 * 60 * 60 * 1000;

/** Short, because a pending row is a failure we want to stop repeating soon. */
export const HOLDER_AGE_PENDING_TTL_MS = 10 * 60 * 1000;

export interface HolderAgeEntry {
  readonly ownerAddress: string;
  readonly contractId: string;
  readonly tokenId: string;
  readonly acquiredBlockHeight: number | null;
  /** Unix milliseconds. Null when the lookup has not succeeded yet. */
  readonly acquiredAtMs: number | null;
  readonly source: HolderAgeSource;
}

export interface HolderAgeRepo {
  get(ownerAddress: string, contractId: string, tokenId: string): Promise<HolderAgeEntry | null>;
  put(entry: HolderAgeEntry): Promise<void>;
  getBlockTimestamp(blockHeight: number): Promise<number | null>;
  putBlockTimestamp(blockHeight: number, unixSeconds: number): Promise<void>;
}

interface HolderAgeRow {
  owner_address: string;
  nft_contract_id: string;
  nft_token_id: string;
  acquired_block_height: string | number | null;
  acquired_at: Date | null;
  source: HolderAgeSource;
  checked_at: Date;
}

function ttlFor(source: HolderAgeSource): number {
  return source === 'fallback_pending' ? HOLDER_AGE_PENDING_TTL_MS : HOLDER_AGE_TTL_MS;
}

export class PostgresHolderAgeRepo implements HolderAgeRepo {
  async get(
    ownerAddress: string,
    contractId: string,
    tokenId: string,
  ): Promise<HolderAgeEntry | null> {
    const { rows } = await query<HolderAgeRow>(
      `select owner_address, nft_contract_id, nft_token_id,
              acquired_block_height, acquired_at, source, checked_at
         from nft_holder_age_cache
        where owner_address = $1 and nft_contract_id = $2 and nft_token_id = $3`,
      [ownerAddress, contractId, tokenId],
    );
    const row = rows[0];
    if (!row) return null;
    if (Date.now() - row.checked_at.getTime() > ttlFor(row.source)) return null;

    return {
      ownerAddress: row.owner_address,
      contractId: row.nft_contract_id,
      tokenId: row.nft_token_id,
      acquiredBlockHeight:
        row.acquired_block_height === null ? null : Number(row.acquired_block_height),
      acquiredAtMs: row.acquired_at?.getTime() ?? null,
      source: row.source,
    };
  }

  async put(entry: HolderAgeEntry): Promise<void> {
    await query(
      `insert into nft_holder_age_cache
         (owner_address, nft_contract_id, nft_token_id,
          acquired_block_height, acquired_at, source, checked_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (owner_address, nft_contract_id, nft_token_id)
       do update set acquired_block_height = excluded.acquired_block_height,
                     acquired_at           = excluded.acquired_at,
                     source                = excluded.source,
                     checked_at            = now()`,
      [
        entry.ownerAddress,
        entry.contractId,
        entry.tokenId,
        entry.acquiredBlockHeight,
        entry.acquiredAtMs === null ? null : new Date(entry.acquiredAtMs),
        entry.source,
      ],
    );
  }

  /** Unix seconds, or null if this height has never been fetched. Never expires. */
  async getBlockTimestamp(blockHeight: number): Promise<number | null> {
    const { rows } = await query<{ burn_block_time: Date }>(
      `select burn_block_time from block_timestamps where block_height = $1`,
      [blockHeight],
    );
    const row = rows[0];
    return row ? Math.floor(row.burn_block_time.getTime() / 1000) : null;
  }

  async putBlockTimestamp(blockHeight: number, unixSeconds: number): Promise<void> {
    await query(
      `insert into block_timestamps (block_height, burn_block_time)
       values ($1, $2)
       on conflict (block_height) do nothing`,
      [blockHeight, new Date(unixSeconds * 1000)],
    );
  }
}

/** No-op repo: correct behaviour, zero storage. Used when Postgres is absent. */
export class NullHolderAgeRepo implements HolderAgeRepo {
  async get(): Promise<HolderAgeEntry | null> {
    return null;
  }
  async put(): Promise<void> {}
  async getBlockTimestamp(): Promise<number | null> {
    return null;
  }
  async putBlockTimestamp(): Promise<void> {}
}

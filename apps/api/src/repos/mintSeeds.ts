/**
 * Mint-seed cache (`nft_mint_seeds`).
 *
 * PERMANENT, like `block_timestamps` and for the same reason: the block that
 * minted a token is a historical fact that no later transaction can change. Once
 * a row is here it is never re-fetched and never expires.
 *
 * That permanence is load-bearing, not just an optimisation. The seed decides a
 * token's rarity floor (`packages/shared/src/rarity.ts`, `mintFloorFromSeed`), so
 * a seed that could be re-resolved to a different value would be a floor that
 * changed under a player who had already been shown it. Writing it once and
 * reading it forever is what makes the floor stable in practice as well as in
 * theory.
 *
 * NOTHING IS STORED FOR A FAILED LOOKUP, which is the one place this differs from
 * `nft_holder_age_cache`. A pending row there earns its keep because a failed
 * holder-age lookup is common (any of eight collections, every wallet) and needs a
 * retry worklist. A mint seed resolves for our own collection only, and it fails
 * for exactly one transient reason — the mint is not yet confirmed — which fixes
 * itself within a block or two. A negative row would need its own TTL and its own
 * sweeper to express "ask again shortly", and the absence of a row already says it.
 */

import { query } from '../db.js';

export interface MintSeedEntry {
  readonly contractId: string;
  readonly tokenId: string;
  readonly mintBlockHeight: number;
  /** The block hash the floor is rolled from. Stored as Hiro served it. */
  readonly mintSeed: string;
}

export interface MintSeedRepo {
  get(contractId: string, tokenId: string): Promise<MintSeedEntry | null>;
  put(entry: MintSeedEntry): Promise<void>;
}

interface MintSeedRow {
  nft_contract_id: string;
  nft_token_id: string;
  mint_block_height: string | number;
  mint_seed: string;
}

export class PostgresMintSeedRepo implements MintSeedRepo {
  async get(contractId: string, tokenId: string): Promise<MintSeedEntry | null> {
    const { rows } = await query<MintSeedRow>(
      `select nft_contract_id, nft_token_id, mint_block_height, mint_seed
         from nft_mint_seeds
        where nft_contract_id = $1 and nft_token_id = $2`,
      [contractId, tokenId],
    );
    const row = rows[0];
    if (!row) return null;

    return {
      contractId: row.nft_contract_id,
      tokenId: row.nft_token_id,
      mintBlockHeight: Number(row.mint_block_height),
      mintSeed: row.mint_seed,
    };
  }

  /**
   * `do nothing` on conflict, deliberately.
   *
   * The row is immutable by definition, so a second writer for the same token is
   * either racing the first with the same answer or wrong. Overwriting would let
   * the wrong one win and silently re-roll a published floor; keeping the first
   * makes the seed write-once in the database as well as in the design.
   */
  async put(entry: MintSeedEntry): Promise<void> {
    await query(
      `insert into nft_mint_seeds
         (nft_contract_id, nft_token_id, mint_block_height, mint_seed, resolved_at)
       values ($1, $2, $3, $4, now())
       on conflict (nft_contract_id, nft_token_id) do nothing`,
      [entry.contractId, entry.tokenId, entry.mintBlockHeight, entry.mintSeed],
    );
  }
}

/** No-op repo: correct behaviour, zero storage. Used when Postgres is absent. */
export class NullMintSeedRepo implements MintSeedRepo {
  async get(): Promise<MintSeedEntry | null> {
    return null;
  }
  async put(): Promise<void> {}
}

/** In-memory, for tests that want the cache-hit path without Postgres. */
export class MemoryMintSeedRepo implements MintSeedRepo {
  private readonly rows = new Map<string, MintSeedEntry>();

  async get(contractId: string, tokenId: string): Promise<MintSeedEntry | null> {
    return this.rows.get(`${contractId}::${tokenId}`) ?? null;
  }

  async put(entry: MintSeedEntry): Promise<void> {
    const key = `${entry.contractId}::${entry.tokenId}`;
    // Write-once, matching the Postgres repo's `do nothing`.
    if (!this.rows.has(key)) this.rows.set(key, entry);
  }
}

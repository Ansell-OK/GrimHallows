/**
 * Forge history (`forge_history`, `forge_recipes`).
 *
 * NOTHING IN THIS TABLE IS SELF-REPORTED. A forge is a user-signed transaction:
 * the player asks `POST /forge` for an unsigned payload, signs it in their own
 * wallet and broadcasts it themselves, so this backend is not in the loop and
 * never observes the burn. Every row here is therefore written by the indexer
 * from a confirmed `forge` transaction read back off chain — never by a request
 * handler on the strength of a client saying it forged something.
 *
 * That distinction is the whole reason `highestForgeTier` is allowed on the
 * leaderboard at all. 01-game-design.md#8 requires the rank table to be "a
 * verifiable index over chain history, not a trusted database claim", and a
 * number a player could POST to themselves would be exactly the latter.
 *
 * `forge_recipes` is a mirror of the on-chain recipe map, kept here for one
 * reason: a forge transaction names a *recipe id*, and turning that into the
 * tier it produced needs the recipe. Reading the ladder from chain per row would
 * be thousands of identical calls; reading it once per pass and joining is the
 * same answer. `services/forgeService.ts` remains the only reader that players
 * see, and it still goes to chain every time.
 */

import type { ForgeRecipe } from '@grimhallow/shared';
import { query } from '../db.js';

/** One confirmed forge, as read off its transaction. */
export interface ForgeEvent {
  readonly address: string;
  readonly recipeId: number;
  readonly burnedTokenIds: readonly string[];
  readonly mintedTokenId: string;
  readonly txId: string;
  /** Block time, so a windowed leaderboard can place it. */
  readonly at: Date;
}

/** A recorded forge joined to the tier its recipe produced. */
export interface ForgeHistoryRecord extends ForgeEvent {
  /** Null when the recipe has not been mirrored yet — the join, not the forge, is missing. */
  readonly outputTier: number | null;
}

export interface ForgeHistoryStore {
  /**
   * Mirror the on-chain recipe ladder.
   *
   * Idempotent by recipe id. Recipes are immutable on chain once created, so a
   * re-mirror is a no-op rather than a correction.
   */
  putRecipes(recipes: readonly ForgeRecipe[]): Promise<void>;

  /**
   * Record confirmed forges. Idempotent by txid — the indexer re-walks recent
   * history every pass and must not double-count a forge it already has.
   *
   * Returns how many rows were genuinely new.
   */
  record(events: readonly ForgeEvent[]): Promise<number>;

  /**
   * The most recently indexed txids, newest first.
   *
   * The indexer's watermark: it walks the contract's history backwards and stops
   * at the first transaction already in here. A *set* rather than a single
   * marker because two forges can share a block and arrive in either order.
   */
  recentTxIds(limit: number): Promise<string[]>;

  /** Every recorded forge, with its output tier resolved. Newest first. */
  list(since: Date | null): Promise<ForgeHistoryRecord[]>;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface ForgeRow {
  address: string;
  recipe_id: number | null;
  burned_token_ids: string[] | null;
  minted_token_id: string;
  tx_id: string;
  created_at: Date;
  output_tier: number | null;
}

function fromRow(row: ForgeRow): ForgeHistoryRecord {
  return {
    address: row.address,
    recipeId: row.recipe_id ?? 0,
    burnedTokenIds: (row.burned_token_ids ?? []).map(String),
    mintedTokenId: String(row.minted_token_id),
    txId: row.tx_id,
    at: row.created_at,
    outputTier: row.output_tier,
  };
}

export class PostgresForgeHistoryStore implements ForgeHistoryStore {
  async putRecipes(recipes: readonly ForgeRecipe[]): Promise<void> {
    if (recipes.length === 0) return;
    const values: unknown[] = [];
    const tuples = recipes.map((r) => {
      const base = values.length;
      values.push(r.id, r.inputTier, r.inputCount, r.outputTier);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    });
    await query(
      `insert into forge_recipes (id, input_tier, input_count, output_tier)
       values ${tuples.join(',')}
       on conflict (id) do update
          set input_tier = excluded.input_tier,
              input_count = excluded.input_count,
              output_tier = excluded.output_tier`,
      values,
    );
  }

  async record(events: readonly ForgeEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const values: unknown[] = [];
    const tuples = events.map((e) => {
      const base = values.length;
      values.push(
        e.address,
        e.recipeId,
        // bigint[] — pg serializes a JS array to a Postgres array literal.
        e.burnedTokenIds.map(String),
        e.mintedTokenId,
        e.txId,
        e.at,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}::bigint[], $${base + 4}, $${base + 5}, $${base + 6})`;
    });

    const { rowCount } = await query(
      `insert into forge_history
         (address, recipe_id, burned_token_ids, minted_token_id, tx_id, created_at)
       values ${tuples.join(',')}
       on conflict (tx_id) do nothing`,
      values,
    );
    return rowCount ?? 0;
  }

  async recentTxIds(limit: number): Promise<string[]> {
    const { rows } = await query<{ tx_id: string }>(
      `select tx_id from forge_history order by created_at desc limit $1`,
      [limit],
    );
    return rows.map((r) => r.tx_id);
  }

  async list(since: Date | null): Promise<ForgeHistoryRecord[]> {
    // Left join, not inner: a forge whose recipe has not been mirrored yet is
    // still a forge that happened. Dropping it would make the row vanish from
    // history because of a gap in a cache, which is the wrong failure — the
    // caller sees a null tier and can decide, rather than seeing nothing.
    const { rows } = await query<ForgeRow>(
      `select h.address, h.recipe_id, h.burned_token_ids, h.minted_token_id,
              h.tx_id, h.created_at, r.output_tier
         from forge_history h
         left join forge_recipes r on r.id = h.recipe_id
        where $1::timestamptz is null or h.created_at >= $1
        order by h.created_at desc`,
      [since],
    );
    return rows.map(fromRow);
  }
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

export class MemoryForgeHistoryStore implements ForgeHistoryStore {
  private readonly recipes = new Map<number, ForgeRecipe>();
  private readonly events = new Map<string, ForgeEvent>();

  async putRecipes(recipes: readonly ForgeRecipe[]): Promise<void> {
    for (const r of recipes) this.recipes.set(r.id, r);
  }

  async record(events: readonly ForgeEvent[]): Promise<number> {
    let added = 0;
    for (const e of events) {
      if (this.events.has(e.txId)) continue;
      this.events.set(e.txId, e);
      added++;
    }
    return added;
  }

  async recentTxIds(limit: number): Promise<string[]> {
    return this.sorted()
      .slice(0, limit)
      .map((e) => e.txId);
  }

  async list(since: Date | null): Promise<ForgeHistoryRecord[]> {
    return this.sorted()
      .filter((e) => !since || e.at >= since)
      .map((e) => ({
        ...e,
        outputTier: this.recipes.get(e.recipeId)?.outputTier ?? null,
      }));
  }

  private sorted(): ForgeEvent[] {
    return [...this.events.values()].sort((a, b) => b.at.getTime() - a.at.getTime());
  }
}

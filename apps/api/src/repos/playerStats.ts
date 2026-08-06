/**
 * Player stats (`player_stats`) — the leaderboard's materialized view.
 *
 * 05-data-model.md says of this table's score column: "a derived/denormalized
 * column recomputable from the other tables at any time — treat it as a
 * materialized view in spirit". This module takes that literally for the whole
 * row, not just the score. Nothing here is ever written by a request handler,
 * nothing accumulates, and no counter is incremented: `aggregate()` derives
 * every number from `runs` and `forge_history` from scratch, and `replaceAll()`
 * overwrites the table with the result.
 *
 * WHY DERIVE RATHER THAN INCREMENT. An incrementing counter is a number you can
 * only ever check by trusting the history of writes that produced it. If a
 * resolve were processed twice, or a run were later found not to match its
 * on-chain event, an incremented `player_stats` would carry that error forever
 * with nothing to compare against. A derived one is wrong only for as long as
 * the source rows are, and it is *recomputable by anyone holding the same source
 * rows* — which is what makes 01-game-design.md#8's "verifiable index, not a
 * trusted database claim" true rather than aspirational.
 *
 * TWO MONEY COLUMNS ARE VISIBLE FROM HERE AND NEITHER IS READ. `runs` carries
 * `fee_paid_ustx` (operator revenue) and `reward_amount_ustx` (a sponsor-pool
 * payout). No query in this file selects either one. A leaderboard that scored
 * by STX would be summing across two flows the whole architecture keeps apart —
 * see `leaderboardScore` in @grimhallow/shared for the rule and the reasoning.
 */

import type { LeaderboardCounts, LeaderboardSource } from '@grimhallow/shared';
import { query } from '../db.js';
import type { ForgeHistoryStore } from './forgeHistory.js';
import type { RunRecord } from './runs.js';

/** One player's derived counts. Exactly the inputs `leaderboardScore` consumes. */
export interface PlayerAggregate extends LeaderboardCounts {
  readonly address: string;
}

/** A stored row: the counts, plus the score they produced and when. */
export interface PlayerStatsRow extends PlayerAggregate {
  readonly score: number;
  readonly updatedAt: Date;
}

export interface PlayerStatsStore {
  /**
   * Derive every player's counts from the source tables.
   *
   * `since` null means all of history. A windowed call is the same derivation
   * with a date bound rather than a different one, so `?window=7d` cannot
   * disagree with `?window=all` about what a completed dungeon is.
   */
  aggregate(since: Date | null): Promise<PlayerAggregate[]>;

  /**
   * The events behind these addresses' numbers, newest first, capped per
   * address.
   *
   * Fetched only for the page being served rather than for every player, which
   * is what keeps citation affordable: this is evidence a reader can follow, not
   * a full audit log.
   */
  sourcesFor(
    addresses: readonly string[],
    since: Date | null,
    perAddress: number,
  ): Promise<Map<string, LeaderboardSource[]>>;

  /**
   * Overwrite `player_stats` with a freshly derived set.
   *
   * Replaces rather than merges, including dropping addresses that are no longer
   * present. A stats row that outlived the runs behind it would be a rank
   * standing on nothing.
   */
  replaceAll(rows: readonly PlayerStatsRow[]): Promise<void>;

  /** The materialized table, best score first. */
  readTop(limit: number): Promise<PlayerStatsRow[]>;

  /** When the view was last recomputed, or null when it never has been. */
  lastComputedAt(): Promise<Date | null>;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/**
 * The derivation, as one statement.
 *
 * Deliberately a `full outer join` of two independent aggregates rather than a
 * join through `runs`: a player who has only forged and never won, and a player
 * who has only won and never forged, both belong on the table. An inner join
 * would silently drop each of them.
 *
 * `combat_outcome = 'win'` is the completion rule (see `leaderboardScore`), and
 * `reward_kind = 'jackpot'` counts only jackpots actually paid — a degraded one
 * is stored as `loot`, because that is what the player received.
 */
const AGGREGATE_SQL = `
  with won as (
    select created_by as address,
           count(*) filter (where dungeon_type = 'free') as free_c,
           count(*) filter (where dungeon_type = 'paid') as paid_c,
           count(*) filter (where reward_kind = 'jackpot') as jackpots
      from runs
     where state = 'resolved'
       and combat_outcome = 'win'
       and ($1::timestamptz is null or resolved_at >= $1)
     group by created_by
  ),
  forged as (
    select h.address, max(r.output_tier) as top_tier
      from forge_history h
      join forge_recipes r on r.id = h.recipe_id
     where $1::timestamptz is null or h.created_at >= $1
     group by h.address
  )
  select coalesce(w.address, f.address) as address,
         coalesce(w.free_c, 0) as free_c,
         coalesce(w.paid_c, 0) as paid_c,
         coalesce(w.jackpots, 0) as jackpots,
         coalesce(f.top_tier, 0) as top_tier
    from won w
    full outer join forged f on f.address = w.address
`;

interface AggregateRow {
  address: string;
  free_c: string;
  paid_c: string;
  jackpots: string;
  top_tier: string;
}

export class PostgresPlayerStatsStore implements PlayerStatsStore {
  async aggregate(since: Date | null): Promise<PlayerAggregate[]> {
    const { rows } = await query<AggregateRow>(AGGREGATE_SQL, [since]);
    return rows.map((r) => ({
      address: r.address,
      // `count()` comes back from pg as a string. These are small integers and
      // they are counts, not money, so Number is safe and intended here.
      freeDungeonsCompleted: Number(r.free_c),
      paidDungeonsCompleted: Number(r.paid_c),
      jackpotsWon: Number(r.jackpots),
      highestForgeTier: Number(r.top_tier),
    }));
  }

  async sourcesFor(
    addresses: readonly string[],
    since: Date | null,
    perAddress: number,
  ): Promise<Map<string, LeaderboardSource[]>> {
    const out = new Map<string, LeaderboardSource[]>();
    if (addresses.length === 0) return out;

    interface SourceRow {
      address: string;
      kind: LeaderboardSource['kind'];
      run_id: string | null;
      tx_id: string | null;
      at: Date;
    }

    // One union, then one window function, so the per-address cap is applied by
    // the database rather than by fetching everything and slicing in JS.
    const { rows } = await query<SourceRow>(
      `with events as (
         select created_by as address,
                case when dungeon_type = 'paid' then 'paid_dungeon' else 'free_dungeon' end as kind,
                id::text as run_id,
                resolve_tx_id as tx_id,
                resolved_at as at
           from runs
          where state = 'resolved' and combat_outcome = 'win'
            and created_by = any($1::text[])
            and ($2::timestamptz is null or resolved_at >= $2)
         union all
         select address, 'forge' as kind, null as run_id, tx_id, created_at as at
           from forge_history
          where address = any($1::text[])
            and ($2::timestamptz is null or created_at >= $2)
       ),
       ranked as (
         select *, row_number() over (partition by address order by at desc) as rn
           from events
       )
       select address, kind, run_id, tx_id, at from ranked
        where rn <= $3
        order by address, at desc`,
      [[...addresses], since, perAddress],
    );

    for (const row of rows) {
      const list = out.get(row.address) ?? [];
      list.push({
        kind: row.kind,
        runId: row.run_id,
        txId: row.tx_id,
        at: row.at.toISOString(),
      });
      out.set(row.address, list);
    }
    return out;
  }

  async replaceAll(rows: readonly PlayerStatsRow[]): Promise<void> {
    if (rows.length === 0) {
      await query(`delete from player_stats`);
      return;
    }

    const values: unknown[] = [];
    const tuples = rows.map((r) => {
      const base = values.length;
      values.push(
        r.address,
        r.freeDungeonsCompleted + r.paidDungeonsCompleted,
        r.freeDungeonsCompleted,
        r.paidDungeonsCompleted,
        r.jackpotsWon,
        r.highestForgeTier,
        r.score,
        r.updatedAt,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    });

    // Upsert and prune in one statement, so a reader never catches the table
    // between "new numbers written" and "stale rows removed".
    await query(
      `with incoming (address, dungeons_completed, free_dungeons_completed,
                      paid_dungeons_completed, jackpots_won, highest_forge_tier,
                      score, updated_at) as (
         values ${tuples.join(',')}
       ),
       typed as (
         select address::text, dungeons_completed::int, free_dungeons_completed::int,
                paid_dungeons_completed::int, jackpots_won::int, highest_forge_tier::int,
                score::numeric, updated_at::timestamptz
           from incoming
       ),
       upserted as (
         insert into player_stats (address, dungeons_completed, free_dungeons_completed,
                                   paid_dungeons_completed, jackpots_won,
                                   highest_forge_tier, score, updated_at)
         select * from typed
         on conflict (address) do update
            set dungeons_completed = excluded.dungeons_completed,
                free_dungeons_completed = excluded.free_dungeons_completed,
                paid_dungeons_completed = excluded.paid_dungeons_completed,
                jackpots_won = excluded.jackpots_won,
                highest_forge_tier = excluded.highest_forge_tier,
                score = excluded.score,
                updated_at = excluded.updated_at
         returning address
       )
       delete from player_stats
        where address not in (select address from typed)`,
      values,
    );
  }

  async readTop(limit: number): Promise<PlayerStatsRow[]> {
    interface StatsRow {
      address: string;
      free_dungeons_completed: number;
      paid_dungeons_completed: number;
      jackpots_won: number;
      highest_forge_tier: number;
      score: string;
      updated_at: Date;
    }
    const { rows } = await query<StatsRow>(
      `select address, free_dungeons_completed, paid_dungeons_completed,
              jackpots_won, highest_forge_tier, score, updated_at
         from player_stats
        order by score desc, address asc
        limit $1`,
      [limit],
    );
    return rows.map((r) => ({
      address: r.address,
      freeDungeonsCompleted: r.free_dungeons_completed,
      paidDungeonsCompleted: r.paid_dungeons_completed,
      jackpotsWon: r.jackpots_won,
      highestForgeTier: r.highest_forge_tier,
      // `numeric` arrives as a string. It is a score, not money, so it is safe
      // to make a number of — and it must be one, because the client checks it
      // against `leaderboardScore()`.
      score: Number(r.score),
      updatedAt: r.updated_at,
    }));
  }

  async lastComputedAt(): Promise<Date | null> {
    const { rows } = await query<{ at: Date | null }>(
      `select max(updated_at) as at from player_stats`,
    );
    return rows[0]?.at ?? null;
  }
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

/**
 * In-memory equivalent, derived from the same two sources.
 *
 * Takes suppliers rather than stores so it can read the memory run store's
 * `all()` — which is deliberately not on the `RunStore` interface, because
 * "hand me every run" is a test and indexer affordance, not something a route
 * should be able to reach for.
 */
export class MemoryPlayerStatsStore implements PlayerStatsStore {
  private stored: PlayerStatsRow[] = [];

  constructor(
    private readonly runs: () => readonly RunRecord[],
    private readonly forge: ForgeHistoryStore,
  ) {}

  async aggregate(since: Date | null): Promise<PlayerAggregate[]> {
    const byAddress = new Map<string, {
      free: number;
      paid: number;
      jackpots: number;
      tier: number;
    }>();
    const bucket = (address: string) => {
      const existing = byAddress.get(address);
      if (existing) return existing;
      const created = { free: 0, paid: 0, jackpots: 0, tier: 0 };
      byAddress.set(address, created);
      return created;
    };

    for (const run of this.runs()) {
      if (run.state !== 'resolved' || run.combatOutcome !== 'win') continue;
      if (since && (!run.resolvedAt || run.resolvedAt < since)) continue;
      const entry = bucket(run.createdBy);
      if (run.dungeonType === 'paid') entry.paid++;
      else entry.free++;
      if (run.reward?.kind === 'jackpot') entry.jackpots++;
    }

    for (const forge of await this.forge.list(since)) {
      // A forge whose recipe has not been mirrored contributes no tier, exactly
      // as the SQL's inner join does. It is a missing lookup, not a missing forge.
      if (forge.outputTier === null) continue;
      const entry = bucket(forge.address);
      entry.tier = Math.max(entry.tier, forge.outputTier);
    }

    return [...byAddress].map(([address, e]) => ({
      address,
      freeDungeonsCompleted: e.free,
      paidDungeonsCompleted: e.paid,
      jackpotsWon: e.jackpots,
      highestForgeTier: e.tier,
    }));
  }

  async sourcesFor(
    addresses: readonly string[],
    since: Date | null,
    perAddress: number,
  ): Promise<Map<string, LeaderboardSource[]>> {
    const wanted = new Set(addresses);
    const events = new Map<string, LeaderboardSource[]>();
    const push = (address: string, source: LeaderboardSource) => {
      if (!wanted.has(address)) return;
      const list = events.get(address) ?? [];
      list.push(source);
      events.set(address, list);
    };

    for (const run of this.runs()) {
      if (run.state !== 'resolved' || run.combatOutcome !== 'win') continue;
      if (since && (!run.resolvedAt || run.resolvedAt < since)) continue;
      push(run.createdBy, {
        kind: run.dungeonType === 'paid' ? 'paid_dungeon' : 'free_dungeon',
        runId: run.id,
        txId: run.resolveTxId,
        at: (run.resolvedAt ?? run.createdAt).toISOString(),
      });
    }

    for (const forge of await this.forge.list(since)) {
      push(forge.address, {
        kind: 'forge',
        runId: null,
        txId: forge.txId,
        at: forge.at.toISOString(),
      });
    }

    for (const [address, list] of events) {
      list.sort((a, b) => b.at.localeCompare(a.at));
      events.set(address, list.slice(0, perAddress));
    }
    return events;
  }

  async replaceAll(rows: readonly PlayerStatsRow[]): Promise<void> {
    this.stored = [...rows];
  }

  async readTop(limit: number): Promise<PlayerStatsRow[]> {
    return [...this.stored]
      .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
      .slice(0, limit);
  }

  async lastComputedAt(): Promise<Date | null> {
    if (this.stored.length === 0) return null;
    return this.stored.reduce<Date>(
      (newest, row) => (row.updatedAt > newest ? row.updatedAt : newest),
      this.stored[0].updatedAt,
    );
  }
}

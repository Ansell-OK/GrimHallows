/**
 * Leaderboard route — 04-backend-api-spec.md#8.
 *
 *   GET /leaderboard?window=all|30d|7d
 *
 * Unauthenticated, and it should be: every fact in the response is already
 * public. Ranks are keyed by wallet address (01-game-design.md#8 — "keyed by
 * wallet address, not per-NFT"), the runs behind them settled on a public chain
 * or under a published oracle signature, and there is nothing here a player
 * could learn about another player that an explorer would not also tell them.
 *
 * THE RESPONSE IS BUILT TO BE DOUBTED. The spec asks for "enough (e.g. a source
 * tx id per contributing event) that a skeptical player could spot-check an
 * entry", and that shapes three things:
 *
 *   - Every count that fed a score is published beside the score. `score` is
 *     `leaderboardScore(counts)` from `@grimhallow/shared`, which the frontend
 *     already imports — so a reader recomputes it rather than trusting it.
 *   - Each entry carries `sources`: the individual events behind it, each with
 *     the transaction to look up. A free dungeon has no transaction (07-glossary
 *     #2), so it cites its run id instead, checkable against `GET /runs/:id`'s
 *     oracle signature. Naming what kind of evidence each is beats a flat list
 *     of txids that would have to omit free runs or invent ids for them.
 *   - `computedAt` is published, because the all-time table is materialized. A
 *     player who just finished a run and does not see it yet is looking at a
 *     staleness figure, not at a lost run.
 *
 * WHERE EACH WINDOW'S NUMBERS COME FROM. `all` reads the materialized
 * `player_stats` — the common case, one indexed query. `7d` and `30d` are
 * derived live from the same `aggregate()` the indexer uses, with a date bound.
 * One derivation, two callers: a window cannot disagree with the all-time table
 * about what a completed dungeon is, because there is no second definition to
 * disagree with.
 *
 * NO MONEY APPEARS IN THIS RESPONSE. Not a gate fee, not a reward amount, not a
 * pool balance. `jackpotsWon` is a count of jackpots paid, never a sum of STX —
 * see `leaderboardScore` for why scoring by payout would put the two separate
 * money flows within reach of one expression.
 */

import {
  LEADERBOARD_ALGO_VERSION,
  dungeonsCompleted,
  leaderboardScore,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type LeaderboardWindow,
} from '@grimhallow/shared';
import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors.js';
import type { PlayerStatsStore } from '../repos/playerStats.js';

export interface LeaderboardRouteDeps {
  readonly playerStats: PlayerStatsStore;
  readonly now?: () => Date;
}

/** Rows returned. Deep enough to find yourself on; short enough to stay one page. */
const PAGE_SIZE = 100;

/**
 * Cited events per entry.
 *
 * A cap, not a total: an entry with 400 wins cites its 20 most recent. The point
 * is that a doubted number can be pulled on, and twenty threads is enough to
 * pull — publishing every source for every player would turn one page load into
 * a full audit log nobody asked for.
 */
const SOURCES_PER_ENTRY = 20;

const WINDOW_DAYS: Record<Exclude<LeaderboardWindow, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
};

function parseWindow(raw: unknown): LeaderboardWindow {
  if (raw === undefined || raw === null || raw === '') return 'all';
  if (raw === 'all' || raw === '7d' || raw === '30d') return raw;
  throw badRequest('INVALID_WINDOW', `window must be one of all, 30d, 7d; got "${String(raw)}"`);
}

export async function registerLeaderboardRoutes(
  app: FastifyInstance,
  deps: LeaderboardRouteDeps,
): Promise<void> {
  const now = () => deps.now?.() ?? new Date();

  app.get('/leaderboard', async (request): Promise<LeaderboardResponse> => {
    const window = parseWindow((request.query as { window?: unknown } | undefined)?.window);

    const since =
      window === 'all'
        ? null
        : new Date(now().getTime() - WINDOW_DAYS[window] * 24 * 60 * 60 * 1000);

    // `all` reads the materialized table; a window derives live. Both end in the
    // same shape, and both score through the same shared function — the stored
    // `score` column is not read back, so a stale or hand-edited row cannot
    // publish a number that disagrees with its own counts.
    const ranked =
      window === 'all'
        ? await deps.playerStats.readTop(PAGE_SIZE)
        : (await deps.playerStats.aggregate(since))
            .map((counts) => ({ ...counts, score: leaderboardScore(counts) }))
            .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
            .slice(0, PAGE_SIZE);

    const sources = await deps.playerStats.sourcesFor(
      ranked.map((r) => r.address),
      since,
      SOURCES_PER_ENTRY,
    );

    const entries: LeaderboardEntry[] = ranked.map((row) => ({
      address: row.address,
      dungeonsCompleted: dungeonsCompleted(row),
      freeDungeonsCompleted: row.freeDungeonsCompleted,
      paidDungeonsCompleted: row.paidDungeonsCompleted,
      jackpotsWon: row.jackpotsWon,
      highestForgeTier: row.highestForgeTier,
      // Recomputed from the published counts rather than passed through, so the
      // number in the response is provably the one those counts produce.
      score: leaderboardScore(row),
      sources: sources.get(row.address) ?? [],
    }));

    // The all-time table's staleness is the indexer's last pass. A live window
    // has none — it was derived from source rows just now — so it reports the
    // instant it was computed, which is the truth in both cases.
    const computedAt =
      window === 'all' ? ((await deps.playerStats.lastComputedAt()) ?? now()) : now();

    return {
      window,
      entries,
      algoVersion: LEADERBOARD_ALGO_VERSION,
      computedAt: computedAt.toISOString(),
    };
  });
}

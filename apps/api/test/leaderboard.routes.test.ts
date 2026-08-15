/**
 * GET /leaderboard route tests.
 *
 * 01-game-design.md#8 asks for "a verifiable index over chain history, not a
 * trusted database claim", and 04-backend-api-spec.md#8 says the response should
 * carry "enough (e.g. a source tx id per contributing event) that a skeptical
 * player could spot-check an entry". Those two sentences are the whole test
 * plan here:
 *
 *   - the published `score` must be recomputable from the published counts, even
 *     when the stored score column says otherwise
 *   - every entry must cite the events behind it, each one followable
 *   - no money may appear anywhere in the response — not a gate fee, not a
 *     reward, not a pool balance
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  LEADERBOARD_ALGO_VERSION,
  SCORE_WEIGHTS,
  getNetworkConfig,
  leaderboardScore,
  type LeaderboardResponse,
} from '@grimhallow/shared';
import { buildServer } from '../src/server.js';
import { Indexer } from '../src/indexer/indexer.js';
import { MemoryForgeHistoryStore } from '../src/repos/forgeHistory.js';
import { MemoryPlayerStatsStore } from '../src/repos/playerStats.js';
import { MemoryRunStore } from '../src/repos/runs.js';
import type { ForgeService } from '../src/services/forgeService.js';
import { TEST_ORACLE_KEY, stubChain, testOracleSigner } from './helpers/oracle.js';

const ALICE = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const BOB = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';

const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS);

function txId(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

/** The forge ladder, as `ForgeService` would report it off chain. */
const RECIPES = [
  {
    id: 1,
    inputTier: 1,
    inputTierName: 'rare',
    inputCount: 3,
    outputTier: 2,
    outputTierName: 'epic',
    outputUri: 'ipfs://2',
    stxFeeUstx: '500000',
  },
];

const FORGE_SERVICE = { listRecipes: async () => [...RECIPES] } as unknown as ForgeService;

describe('GET /leaderboard', () => {
  let app: FastifyInstance;
  let runs: MemoryRunStore;
  let forgeHistory: MemoryForgeHistoryStore;
  let playerStats: MemoryPlayerStatsStore;

  /** Materialize `player_stats` the way the background loop would. */
  async function reindex(): Promise<void> {
    await new Indexer({
      chain: stubChain(),
      stacks: getNetworkConfig('devnet'),
      runs,
      forgeHistory,
      playerStats,
      forge: FORGE_SERVICE,
    }).recomputeStats();
  }

  async function get(query = ''): Promise<{ status: number; body: LeaderboardResponse }> {
    const res = await app.inject({ method: 'GET', url: `/leaderboard${query}` });
    return { status: res.statusCode, body: res.json() as LeaderboardResponse };
  }

  /** A resolved run, dated, exactly as the oracle would have written it. */
  async function win(params: {
    address: string;
    type: 'free' | 'paid';
    at: Date;
    jackpot?: boolean;
    outcome?: 'win' | 'loss';
  }): Promise<string> {
    const character = { contractId: 'ST000000000000000000002AMW42H.nft', tokenId: '1' };
    const n = runs.all().length;
    const run =
      params.type === 'free'
        ? await runs.createFreeRun({
            spawnId: 'spawn-1',
            partyId: null,
            createdBy: params.address,
            character,
          })
        : await runs.ingestPaidRun({
            id: String(700 + n),
            dungeonId: 1,
            createdBy: params.address,
            character,
            feePaidUstx: '1000000',
            enterTxId: txId(900 + n),
          });

    await runs.commit(run.id, {
      seedHash: 'hash',
      seed: 'seed',
      // A real, minimal setup rather than a stub: `commit` normalizes what it is
      // given so the store holds both readings of it, and nothing here replays.
      setup: { monsterTableId: 'forsaken-crypt', party: [] },
      commitSignature: null,
      oracleAddress: null,
      committedAt: params.at,
    });

    await runs.resolve(run.id, {
      seedReveal: 'seed',
      combatOutcome: params.outcome ?? 'win',
      resolveSignature: null,
      reward:
        params.type === 'paid'
          ? {
              kind: params.jackpot ? 'jackpot' : 'none',
              amountUstx: params.jackpot ? '10000000' : null,
              lootTokenId: null,
              degraded: false,
            }
          : null,
      resolveTxId: params.type === 'paid' ? txId(500 + n) : null,
      resolvedAt: params.at,
    });

    return run.id;
  }

  beforeEach(async () => {
    runs = new MemoryRunStore();
    forgeHistory = new MemoryForgeHistoryStore();
    playerStats = new MemoryPlayerStatsStore(() => runs.all(), forgeHistory);
    app = await buildServer({
      chain: stubChain(),
      runStore: runs,
      forgeHistoryStore: forgeHistory,
      playerStatsStore: playerStats,
      oracleSigner: testOracleSigner(),
      oraclePrivateKey: TEST_ORACLE_KEY,
      jwtSecret: 'test-jwt-secret',
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves an empty table before anyone has played', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.window).toBe('all');
    expect(body.entries).toEqual([]);
    expect(body.algoVersion).toBe(LEADERBOARD_ALGO_VERSION);
    // Still stamped: an empty leaderboard and a leaderboard that has never been
    // computed look the same to a player otherwise.
    expect(Number.isNaN(Date.parse(body.computedAt))).toBe(false);
  });

  it('needs no session — the facts in it are already public', async () => {
    const res = await app.inject({ method: 'GET', url: '/leaderboard' });
    expect(res.statusCode).toBe(200);
  });

  it('publishes each count that fed the score', async () => {
    await win({ address: ALICE, type: 'free', at: ago(1) });
    await win({ address: ALICE, type: 'paid', at: ago(1), jackpot: true });
    await reindex();

    const { body } = await get();
    const [entry] = body.entries;
    expect(entry.address).toBe(ALICE);
    expect(entry.freeDungeonsCompleted).toBe(1);
    expect(entry.paidDungeonsCompleted).toBe(1);
    expect(entry.dungeonsCompleted).toBe(2);
    expect(entry.jackpotsWon).toBe(1);
    expect(entry.highestForgeTier).toBe(0);
  });

  /**
   * The property that makes "verifiable" mean something: a client can call
   * `leaderboardScore()` on the counts it was handed and get the score it was
   * handed. Asserted here the way a client would do it.
   */
  it('publishes a score that recomputes from the counts it published', async () => {
    await win({ address: ALICE, type: 'free', at: ago(1) });
    await win({ address: BOB, type: 'paid', at: ago(1), jackpot: true });
    await reindex();

    const { body } = await get();
    for (const entry of body.entries) {
      expect(entry.score).toBe(leaderboardScore(entry));
    }
  });

  /**
   * And the reason it recomputes rather than passes through. `player_stats` is a
   * cache; a stale row, a bad migration or a hand-edit could put a score in it
   * that its own counts do not produce. The route must publish the honest number.
   */
  it('ignores a stored score that disagrees with its own counts', async () => {
    await win({ address: ALICE, type: 'free', at: ago(1) });
    await reindex();

    const [row] = await playerStats.readTop(1);
    await playerStats.replaceAll([{ ...row, score: 999_999 }]);

    const { body } = await get();
    expect(body.entries[0].score).toBe(SCORE_WEIGHTS.freeDungeon);
  });

  it('ranks best score first', async () => {
    await win({ address: ALICE, type: 'free', at: ago(1) });
    await win({ address: BOB, type: 'paid', at: ago(1), jackpot: true });
    await reindex();

    const { body } = await get();
    expect(body.entries.map((e) => e.address)).toEqual([BOB, ALICE]);
  });

  it('does not list a player whose only run was a loss', async () => {
    await win({ address: ALICE, type: 'paid', at: ago(1), outcome: 'loss' });
    await reindex();

    const { body } = await get();
    expect(body.entries).toEqual([]);
  });

  describe('sources', () => {
    it('cites a paid win by the transaction that settled it', async () => {
      await win({ address: ALICE, type: 'paid', at: ago(1) });
      await reindex();

      const { body } = await get();
      const [source] = body.entries[0].sources;
      expect(source.kind).toBe('paid_dungeon');
      expect(source.txId).toBe(txId(500));
      expect(source.runId).not.toBeNull();
    });

    /**
     * A free run has no transaction (07-glossary #2), so it cites its run id
     * instead — checkable against `GET /runs/:id`'s oracle signature. Inventing
     * a txid for it, or omitting free runs from the citations, would both leave
     * a scored fact unfollowable.
     */
    it('cites a free win by its run id, with no transaction to point at', async () => {
      const runId = await win({ address: ALICE, type: 'free', at: ago(1) });
      await reindex();

      const { body } = await get();
      const [source] = body.entries[0].sources;
      expect(source.kind).toBe('free_dungeon');
      expect(source.runId).toBe(runId);
      expect(source.txId).toBeNull();
    });

    it('cites a forge by its transaction', async () => {
      const at = ago(1);
      await forgeHistory.putRecipes(RECIPES);
      await forgeHistory.record([
        {
          address: ALICE,
          recipeId: 1,
          burnedTokenIds: ['1', '2', '3'],
          mintedTokenId: '9',
          txId: txId(42),
          at,
        },
      ]);
      await reindex();

      const { body } = await get();
      const [entry] = body.entries;
      expect(entry.highestForgeTier).toBe(2);
      expect(entry.sources).toEqual([
        { kind: 'forge', runId: null, txId: txId(42), at: at.toISOString() },
      ]);
    });

    it('caps citations per entry rather than dumping an audit log', async () => {
      for (let i = 0; i < 25; i += 1) {
        await win({ address: ALICE, type: 'free', at: ago(1) });
      }
      await reindex();

      const { body } = await get();
      expect(body.entries[0].freeDungeonsCompleted).toBe(25);
      // Capped, and the count above still tells the reader how many were left out.
      expect(body.entries[0].sources).toHaveLength(20);
    });
  });

  describe('windows', () => {
    it('excludes a run that fell outside the window', async () => {
      await win({ address: ALICE, type: 'free', at: ago(40) });
      await win({ address: ALICE, type: 'free', at: ago(2) });
      await reindex();

      expect((await get('?window=all')).body.entries[0].freeDungeonsCompleted).toBe(2);
      expect((await get('?window=30d')).body.entries[0].freeDungeonsCompleted).toBe(1);
      expect((await get('?window=7d')).body.entries[0].freeDungeonsCompleted).toBe(1);
    });

    it('drops a player entirely when nothing of theirs is in the window', async () => {
      await win({ address: ALICE, type: 'free', at: ago(40) });
      await reindex();

      expect((await get('?window=all')).body.entries).toHaveLength(1);
      expect((await get('?window=7d')).body.entries).toEqual([]);
    });

    /**
     * A window is derived live from the same `aggregate()` the indexer uses, so
     * it must be right even when nothing has materialized the all-time table.
     */
    it('serves a window before the indexer has ever run', async () => {
      await win({ address: ALICE, type: 'free', at: ago(1) });

      expect((await get('?window=all')).body.entries).toEqual([]);
      expect((await get('?window=7d')).body.entries).toHaveLength(1);
    });

    it('echoes the window it answered', async () => {
      expect((await get('?window=30d')).body.window).toBe('30d');
    });

    it('rejects a window it does not know rather than quietly serving all-time', async () => {
      const res = await app.inject({ method: 'GET', url: '/leaderboard?window=1y' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'INVALID_WINDOW' } });
    });
  });

  /**
   * The economic invariant, checked at the response boundary. Entry fees are
   * operator revenue and jackpots come from the sponsor pool; the two never meet
   * (02-architecture.md#3). A leaderboard that published either would put them
   * one addition apart, so it publishes neither.
   */
  it('contains no money at all', async () => {
    await win({ address: ALICE, type: 'paid', at: ago(1), jackpot: true });
    await reindex();

    const { body } = await get();
    expect(body.entries).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/ustx|fee|amount|pool|balance/i);
  });
});

/**
 * Read-triggered background jobs, through the real routes.
 *
 * `onDemand.test.ts` covers the throttle in isolation. This file covers the part
 * that can't be unit-tested and is the part most likely to break silently: that
 * the hook is actually attached to the routes it names. It matches on
 * `request.routeOptions.url`, so a renamed or re-prefixed route would leave the
 * matcher intact, every test in `onDemand.test.ts` green, and the deployed map
 * quietly empty as spawns expired with nothing replacing them.
 *
 * That failure has no error path — it looks exactly like a quiet server — which
 * is why it is asserted here rather than assumed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Cl, type ClarityValue } from '@stacks/transactions';
import { buildServer } from '../src/server.js';
import { MemorySpawnStore } from '../src/repos/spawns.js';
import type { ChainClient, ChainTransaction } from '../src/lib/hiro.js';
import { TEST_ORACLE_KEY, testOracleSigner } from './helpers/oracle.js';
import { unresolvedMintBlock, unsupportedChainWrites } from './helpers/chain.js';

/**
 * Answers the map's two reads and fails everything else.
 *
 * The indexer's chain walk is deliberately left unsupported: a pass fired from
 * `GET /leaderboard` will throw, which is precisely the case the fire-and-forget
 * path has to survive without touching the response.
 */
class FakeChain implements ChainClient {
  calls: string[] = [];

  async getNftHoldings(): Promise<never[]> {
    return [];
  }
  async getTokenMetadata(): Promise<null> {
    return null;
  }
  async getBlockTimestamp(): Promise<number | null> {
    return null;
  }
  async getNftAcquisitionBlock(): Promise<number | null> {
    return null;
  }

  async callReadOnly(params: { functionName: string }): Promise<ClarityValue> {
    this.calls.push(params.functionName);
    if (params.functionName === 'get-sponsor-pool') return Cl.uint(0n);
    if (params.functionName === 'get-dungeon') return Cl.none();
    throw new Error(`unexpected read-only call: ${params.functionName}`);
  }

  getTransaction: (txId: string) => Promise<ChainTransaction | null> =
    unsupportedChainWrites().getTransaction;
  broadcastRawTx: (rawTxHex: string) => Promise<string> = unsupportedChainWrites().broadcastRawTx;
  listContractCalls: ChainClient['listContractCalls'] = unsupportedChainWrites().listContractCalls;
  getNftMintBlock: ChainClient['getNftMintBlock'] = unresolvedMintBlock().getNftMintBlock;
}

async function build(onDemand: boolean, spawns: MemorySpawnStore): Promise<FastifyInstance> {
  return buildServer({
    chain: new FakeChain(),
    spawnStore: spawns,
    oracleSigner: testOracleSigner(),
    oraclePrivateKey: TEST_ORACLE_KEY,
    jwtSecret: 'test-jwt-secret',
    logger: false,
    onDemand,
  });
}

describe('on-demand background jobs', () => {
  let app: FastifyInstance;
  let spawns: MemorySpawnStore;

  beforeEach(() => {
    spawns = new MemorySpawnStore();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('tops up spawns before serving GET /map', async () => {
    app = await build(true, spawns);

    // Nothing has spawned yet: no timer ran, and the store started empty.
    expect(await spawns.listActive(new Date())).toHaveLength(0);

    const res = await app.inject({ method: 'GET', url: '/map' });

    expect(res.statusCode).toBe(200);
    // Awaited, not fire-and-forget — the caller who triggered the top-up is the
    // one who must see it, so the rows have to be in this very response.
    expect(res.json().spawns.length).toBeGreaterThan(0);
  });

  it('leaves the map empty when on-demand is off, proving the hook is what fills it', async () => {
    app = await build(false, spawns);

    const res = await app.inject({ method: 'GET', url: '/map' });

    expect(res.statusCode).toBe(200);
    expect(res.json().spawns).toHaveLength(0);
  });

  it('does not re-tick on a second read inside the interval', async () => {
    app = await build(true, spawns);

    const first = (await app.inject({ method: 'GET', url: '/map' })).json().spawns.length;
    const second = (await app.inject({ method: 'GET', url: '/map' })).json().spawns.length;

    // The spawner caps creations per tick, so an unthrottled second pass would
    // visibly add more rather than return the same set.
    expect(second).toBe(first);
  });

  it('serves GET /leaderboard even though the indexer pass fails', async () => {
    app = await build(true, spawns);

    const res = await app.inject({ method: 'GET', url: '/leaderboard' });

    // The pass throws (the fake chain refuses the indexer's calls) and is
    // dropped. A leaderboard that 500s because a cache refresh failed would be
    // strictly worse than one that serves openly-stale ranks.
    expect(res.statusCode).toBe(200);
  });

  it('does not run background jobs on unrelated routes', async () => {
    app = await build(true, spawns);

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(await spawns.listActive(new Date())).toHaveLength(0);
  });
});

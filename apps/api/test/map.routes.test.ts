/**
 * GET /map route tests.
 *
 * The load-bearing assertion in this file is about one number. `sponsorPoolUstx`
 * is the owner-funded prize budget read from `get-sponsor-pool` — it is NOT fee
 * revenue, the two are separate money flows, and nothing may ever add them
 * (03-smart-contracts-spec.md#2, 02-architecture.md#3). The map screen is where
 * a player forms their impression of "what's up for grabs", so a wrong number
 * here is a wrong number in the only place it really counts.
 *
 * The rest guards honesty about the other direction: an unreadable chain must
 * never render as a pool of zero, and it must not take the free half of the map
 * down with it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  Cl,
  type ClarityValue,
} from '@stacks/transactions';
import { PAID_DUNGEON_ID, PAID_DUNGEON_NAME } from '@grimhallow/shared';
import { buildServer } from '../src/server.js';
import { MemorySpawnStore } from '../src/repos/spawns.js';
import type { ChainClient, ChainTransaction } from '../src/lib/hiro.js';
import { TEST_ORACLE_KEY, testOracleSigner } from './helpers/oracle.js';
import { unsupportedChainWrites } from './helpers/chain.js';

const GATE_FEE = 1_000_000n; // 1 STX
const POOL = 42_350_000n; // 42.35 STX

class FakeChain implements ChainClient {
  dungeon: ClarityValue = Cl.some(
    Cl.tuple({ 'gate-fee': Cl.uint(GATE_FEE), 'is-paid': Cl.bool(true), active: Cl.bool(true) }),
  );
  pool: ClarityValue = Cl.uint(POOL);
  error: Error | null = null;
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
    if (this.error) throw this.error;
    if (params.functionName === 'get-sponsor-pool') return this.pool;
    if (params.functionName === 'get-dungeon') return this.dungeon;
    throw new Error(`unexpected read-only call: ${params.functionName}`);
  }

  getTransaction: (txId: string) => Promise<ChainTransaction | null> =
    unsupportedChainWrites().getTransaction;
  broadcastRawTx: (rawTxHex: string) => Promise<string> = unsupportedChainWrites().broadcastRawTx;
  listContractCalls: ChainClient['listContractCalls'] = unsupportedChainWrites().listContractCalls;
}

const inFuture = (ms: number) => new Date(Date.now() + ms);

describe('GET /map', () => {
  let app: FastifyInstance;
  let chain: FakeChain;
  let spawns: MemorySpawnStore;

  beforeEach(async () => {
    chain = new FakeChain();
    spawns = new MemorySpawnStore();
    app = await buildServer({
      chain,
      spawnStore: spawns,
      oracleSigner: testOracleSigner(),
      oraclePrivateKey: TEST_ORACLE_KEY,
      jwtSecret: 'test-jwt-secret',
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const get = () => app.inject({ method: 'GET', url: '/map' });

  describe('the sponsor pool', () => {
    it('reports the live pool balance from get-sponsor-pool, in microSTX', async () => {
      const body = (await get()).json();
      expect(body.paidDungeon.sponsorPoolUstx).toBe('42350000');
      expect(chain.calls).toContain('get-sponsor-pool');
    });

    it('keeps the pool and the gate fee as separate, unmixed figures', async () => {
      // Entry fees are operator revenue and never credit the pool. If anything
      // ever starts folding one into the other, it shows up right here.
      const body = (await get()).json();
      expect(body.paidDungeon.gateFeeUstx).toBe('1000000');
      expect(body.paidDungeon.sponsorPoolUstx).toBe('42350000');
      expect(body.paidDungeon.sponsorPoolUstx).not.toBe(String(POOL + GATE_FEE));
    });

    it('tracks the pool down as well as up', async () => {
      // A jackpot payout debits the pool; the map must show the drop, since it
      // is also the operator's signal to top it up.
      chain.pool = Cl.uint(0n);
      const body = (await get()).json();
      expect(body.paidDungeon.sponsorPoolUstx).toBe('0');
    });

    it('re-reads the pool on every request rather than caching it', async () => {
      await get();
      chain.pool = Cl.uint(7_000_000n);
      const body = (await get()).json();
      expect(body.paidDungeon.sponsorPoolUstx).toBe('7000000');
    });
  });

  describe('the paid dungeon', () => {
    it('returns its identity alongside the live numbers', async () => {
      const body = (await get()).json();
      expect(body.paidDungeon.dungeonId).toBe(PAID_DUNGEON_ID);
      expect(body.paidDungeon.name).toBe(PAID_DUNGEON_NAME);
      expect(body.paidDungeon.location).toEqual({ x: 50, y: 40 });
    });

    it('is null — never zero — when the chain cannot be read', async () => {
      chain.error = new Error('Stacks API unreachable');
      const body = (await get()).json();
      expect(body.paidDungeon).toBeNull();
    });

    it('is null when the dungeon has not been seeded yet', async () => {
      chain.dungeon = Cl.none();
      expect((await get()).json().paidDungeon).toBeNull();
    });

    it('is null when the owner has deactivated it', async () => {
      chain.dungeon = Cl.some(
        Cl.tuple({
          'gate-fee': Cl.uint(GATE_FEE),
          'is-paid': Cl.bool(true),
          active: Cl.bool(false),
        }),
      );
      expect((await get()).json().paidDungeon).toBeNull();
    });
  });

  describe('free dungeon spawns', () => {
    it('lists live spawns with their location, table and expiry', async () => {
      const expiresAt = inFuture(600_000);
      await spawns.create({ x: 30, y: 70, monsterTableId: 'forsaken-crypt', expiresAt });

      const body = (await get()).json();
      expect(body.spawns).toHaveLength(1);
      expect(body.spawns[0]).toEqual({
        id: expect.any(String),
        location: { x: 30, y: 70 },
        monsterTableId: 'forsaken-crypt',
        expiresAt: expiresAt.toISOString(),
      });
    });

    it('excludes expired spawns', async () => {
      await spawns.create({
        x: 1,
        y: 1,
        monsterTableId: 'forsaken-crypt',
        expiresAt: new Date(Date.now() - 1000),
      });
      await spawns.create({
        x: 2,
        y: 2,
        monsterTableId: 'echoing-cavern',
        expiresAt: inFuture(60_000),
      });

      const body = (await get()).json();
      expect(body.spawns).toHaveLength(1);
      expect(body.spawns[0].monsterTableId).toBe('echoing-cavern');
    });

    it('orders them soonest-to-expire first', async () => {
      await spawns.create({ x: 1, y: 1, monsterTableId: 'a', expiresAt: inFuture(900_000) });
      await spawns.create({ x: 2, y: 2, monsterTableId: 'b', expiresAt: inFuture(60_000) });

      const body = (await get()).json();
      expect(body.spawns.map((s: { monsterTableId: string }) => s.monsterTableId)).toEqual([
        'b',
        'a',
      ]);
    });

    it('still returns spawns when the chain is unreachable', async () => {
      // Free dungeons involve no money and no contract, so a chain outage has
      // no business emptying the map.
      chain.error = new Error('Stacks API unreachable');
      await spawns.create({
        x: 5,
        y: 5,
        monsterTableId: 'forsaken-crypt',
        expiresAt: inFuture(60_000),
      });

      const res = await get();
      expect(res.statusCode).toBe(200);
      expect(res.json().spawns).toHaveLength(1);
      expect(res.json().paidDungeon).toBeNull();
    });
  });

  it('is readable without a session', async () => {
    // Everything on the map is public: off-chain content or a chain fact.
    const res = await get();
    expect(res.statusCode).toBe(200);
  });
});

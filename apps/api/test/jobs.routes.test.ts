/**
 * `GET|POST /jobs/loot-mint` tests (docs/09 B7).
 *
 * This endpoint is the only way a free run's drop reaches a wallet on a host
 * where `setInterval` never fires twice, and it is the only route in the API that
 * authenticates something other than a wallet. So the cases below are about the
 * two ways that combination goes wrong.
 *
 * IT IS OFF WHEN UNCONFIGURED, NEVER OPEN. An unset `CRON_SECRET` has to mean
 * "this surface is disabled", exactly as an unset `OWNER_ADDRESS` means the admin
 * surface is disabled. The other reading — no secret configured, so no secret
 * required — would leave a public endpoint that spends the oracle account's STX.
 *
 * IT REALLY RUNS THE CEREMONY. The endpoint exists because the timer is inert on
 * serverless, so a route that returned a plausible report without advancing
 * anything would reproduce the bug it was written to fix, and reproduce it
 * invisibly. Hence a real `MemoryRunStore` and a real `FreeRunLootMinter` behind
 * a fake oracle: what is asserted is the txid written to the store, not the
 * response body.
 *
 * The oracle double records broadcasts rather than making them. Everything else
 * in the stack — the store, the minter, the loop's overlap guard, `buildServer`'s
 * wiring of all three — is the real thing, because the wiring is the part most
 * likely to be wrong and a fake loop would hide it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolveFreeRunReward, type EncounterSetup, type RewardResult } from '@grimhallow/shared';
import { buildServer } from '../src/server.js';
import { issueToken } from '../src/lib/jwt.js';
import { MemoryRunStore } from '../src/repos/runs.js';
import type { PaidRunOracle } from '../src/oracle/paidRunOracle.js';
import { TEST_ORACLE_KEY, stubChain, testOracleSigner } from './helpers/oracle.js';
import { characterRef } from './helpers/collections.js';

const JWT_SECRET = 'test-jwt-secret';
const CRON_SECRET = 'a-long-enough-cron-secret';
const PLAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const SEED = 'a'.repeat(64);
const SEED_HASH = 'b'.repeat(64);
const SPAWN = '0f1e2d3c-4b5a-4967-8899-aabbccddeeff';

const SETUP: EncounterSetup = {
  monsterTableId: 'forsaken-crypt',
  party: [
    {
      id: 'p0',
      address: PLAYER,
      name: 'Character #7',
      charClass: 'warrior',
      stats: { hp: 30, str: 14, agi: 11, int: 8, vit: 12 },
      powerUpItems: [],
    },
  ],
};

/**
 * The ceremony's chain calls, recorded instead of broadcast.
 *
 * `hold()` freezes the first broadcast of a pass so a test can observe what a
 * second request does while the first is genuinely still in flight. `arrived`
 * rather than a bare promise because the two requests are dispatched through the
 * same Fastify instance and nothing orders them — waiting on the signal is what
 * makes "the first pass is inside the gate" a fact rather than a hope.
 */
class FakeOracle {
  readonly broadcasts: string[] = [];
  /** Resolves once a pass has reached the held broadcast. */
  arrived: Promise<void> = Promise.resolve();
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private announce: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.arrived = new Promise<void>((resolve) => {
      this.announce = resolve;
    });
  }

  /** Let the held pass continue, and stop holding later ones. */
  free(): void {
    const release = this.release;
    this.gate = null;
    this.release = null;
    release?.();
  }

  async enterFreeDungeon(params: { readonly player: string }): Promise<string> {
    if (this.gate) {
      this.announce?.();
      await this.gate;
    }
    this.broadcasts.push('enter-dungeon');
    return `0xenter-${params.player.slice(-4)}`;
  }

  async readEnteredRunId(): Promise<string | null> {
    return null;
  }

  async commitSeed(): Promise<string> {
    this.broadcasts.push('commit-seed');
    return '0xcommit';
  }

  async resolveFreeLootRun(params: {
    readonly chainRunId: string;
    readonly seed: string;
  }): Promise<{ readonly resolveTxId: string; readonly reward: RewardResult }> {
    this.broadcasts.push('reveal-and-resolve');
    return {
      resolveTxId: '0xresolve',
      reward: resolveFreeRunReward({ seed: params.seed, combatOutcome: 'win' }),
    };
  }
}

describe('/jobs/loot-mint', () => {
  let app: FastifyInstance;
  let runs: MemoryRunStore;
  let oracle: FakeOracle;

  async function start(cronSecret: string | null = CRON_SECRET): Promise<void> {
    runs = new MemoryRunStore();
    oracle = new FakeOracle();
    app = await buildServer({
      chain: stubChain(),
      oracleSigner: testOracleSigner(),
      oraclePrivateKey: TEST_ORACLE_KEY,
      paidOracle: oracle as unknown as PaidRunOracle,
      runStore: runs,
      jwtSecret: JWT_SECRET,
      cronSecret,
      logger: false,
    });
  }

  afterEach(async () => {
    await app.close();
  });

  /** A resolved free run that drew loot — the state the ceremony picks up. */
  async function runOwedLoot(): Promise<string> {
    const run = await runs.createFreeRun({
      spawnId: SPAWN,
      partyId: null,
      createdBy: PLAYER,
      character: characterRef('7'),
    });
    await runs.commit(run.id, {
      seedHash: SEED_HASH,
      seed: SEED,
      setup: SETUP,
      commitSignature: 'sig-commit',
      oracleAddress: 'ST2ORACLE',
      committedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await runs.resolve(run.id, {
      seedReveal: SEED,
      combatOutcome: 'win',
      resolveSignature: 'sig-resolve',
      resolvedAt: new Date('2026-01-01T00:05:00.000Z'),
      reward: { kind: 'loot', amountUstx: null, lootTokenId: null, degraded: false },
    });
    return run.id;
  }

  const call = (
    opts: { secret?: string | null; method?: 'GET' | 'POST' } = {},
  ) =>
    app.inject({
      method: opts.method ?? 'GET',
      url: '/jobs/loot-mint',
      headers:
        opts.secret === null
          ? {}
          : { authorization: `Bearer ${opts.secret ?? CRON_SECRET}` },
    });

  describe('access', () => {
    it('is off — not open — when no secret is configured', async () => {
      // Fail closed. The other reading of an unset CRON_SECRET is a public
      // endpoint that broadcasts oracle-signed transactions.
      await start(null);

      const res = await call();
      expect(res.statusCode).toBe(501);
      expect(res.json().error.code).toBe('CRON_NOT_CONFIGURED');
    });

    it('refuses an anonymous caller', async () => {
      await start();
      const res = await call({ secret: null });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('CRON_AUTH_FAILED');
    });

    it('answers a wrong secret exactly as it answers a missing one', async () => {
      // One response for both, so a caller working through guesses learns nothing
      // from which refusal they got — the rule `requireSession` already follows.
      await start();
      const missing = await call({ secret: null });
      const wrong = await call({ secret: 'not-the-cron-secret' });

      expect(wrong.statusCode).toBe(missing.statusCode);
      expect(wrong.json()).toEqual(missing.json());
    });

    it('does not accept a session token in place of the secret', async () => {
      // Every other guarded route in this API takes one, and a player holds one.
      // A session proves control of a wallet, which is not what this gate asks.
      await start();
      const session = issueToken({ address: PLAYER, secret: JWT_SECRET, ttlSeconds: 3600 }).token;

      const res = await call({ secret: session });
      expect(res.statusCode).toBe(401);
    });

    it('never echoes the secret back', async () => {
      await start();
      for (const res of [await call(), await call({ secret: 'wrong' })]) {
        expect(res.body).not.toContain(CRON_SECRET);
      }
    });

    it('rejects a secret that only shares a prefix', async () => {
      // The compare is over SHA-256 digests, so a near-miss is as wrong as
      // anything else. A truncating or prefix compare would make the secret
      // guessable a character at a time.
      await start();
      const res = await call({ secret: CRON_SECRET.slice(0, -1) });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('the pass', () => {
    it('advances a run that is owed a drop, and says what it did', async () => {
      await start();
      const runId = await runOwedLoot();

      const res = await call();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ran: true, considered: 1, advanced: 1 });

      // The assertion that matters is the store, not the body: a route that
      // returned this report without broadcasting anything would look identical
      // and would leave every free drop unminted forever.
      expect(oracle.broadcasts).toEqual(['enter-dungeon']);
      expect((await runs.findById(runId))?.lootMint?.enterTxId).toBeTruthy();
    });

    it('reports an empty pass rather than failing it', async () => {
      // The common case by far — this runs every minute and most minutes owe
      // nothing. A non-2xx would show up in the platform's cron history as a
      // failing job, and a real failure would then be invisible among them.
      await start();
      const res = await call();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ran: true, considered: 0, errors: [] });
      expect(oracle.broadcasts).toEqual([]);
    });

    it('answers POST as well as GET', async () => {
      // GET is what Vercel Cron issues and the only reason a state-changing GET
      // is registered at all. POST is for every caller that has a choice.
      await start();
      await runOwedLoot();

      const res = await call({ method: 'POST' });
      expect(res.statusCode).toBe(200);
      expect(res.json().advanced).toBe(1);
    });

    it('takes one step per call, not the whole ceremony', async () => {
      // Each step is only legal once the previous one has confirmed on chain, so
      // a second call while the entry is still pending must broadcast nothing.
      // Hammering the endpoint cannot hurry a drop, and must not spend fees
      // trying to.
      await start();
      await runOwedLoot();

      await call();
      await call();

      expect(oracle.broadcasts).toEqual(['enter-dungeon']);
    });

    it('does not start a second pass on top of one still in flight', async () => {
      // Two overlapping passes read the same run at the same step before either
      // writes back, and both broadcast it — at the resolve step that is two NFTs
      // for one drop. What this pins is that the route goes through `tick()`
      // rather than reaching past it to `runOnce()`; which of the two guards
      // inside `tick()` fires is not this file's business, and each is pinned
      // on its own in lootMinterLoop.test.ts.
      await start();
      await runOwedLoot();

      oracle.hold();
      const first = call();
      await oracle.arrived;

      const second = await call();
      expect(second.statusCode).toBe(200);
      expect(second.json().ran).toBe(false);

      oracle.free();
      expect((await first).json().advanced).toBe(1);
      expect(oracle.broadcasts).toEqual(['enter-dungeon']);
    });

    it('lifts the guard once the pass finishes, rather than latching it', async () => {
      // A guard that stuck would drain no backlog ever again, and would do it
      // silently: every later call returns a healthy 200 saying it skipped.
      await start();
      await runOwedLoot();

      oracle.hold();
      const first = call();
      await oracle.arrived;
      await call();
      oracle.free();
      await first;

      expect((await call()).json().ran).toBe(true);
    });

    it('is not cacheable', async () => {
      // A GET that is not a read. A 200 cached anywhere in front of this would be
      // a cron reporting success every minute while the ceremony never advances.
      await start();
      const res = await call();
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });
});

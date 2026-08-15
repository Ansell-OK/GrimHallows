/**
 * POST /admin/fund-pool tests.
 *
 * `fund-pool` is the only function in the system that increases `sponsor-pool`
 * (03-smart-contracts-spec.md#2). Everything below is about keeping the two
 * things that guard it intact:
 *
 *   1. Only the operator can reach the route, and an unconfigured owner address
 *      means "off", never "everyone".
 *   2. The route quotes; it does not sign. Nothing here can move operator funds
 *      by itself, so a stolen owner session yields a transaction the thief has
 *      no key for.
 *
 * The amount parsing tests look fussy for a reason: this is the one endpoint
 * where a rounding error is silently the operator's own money.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { issueToken } from '../src/lib/jwt.js';
import { TEST_ORACLE_KEY, stubChain, testOracleSigner } from './helpers/oracle.js';
import { FakeGameCore } from './helpers/chain.js';
import {
  deserializePostCondition,
  type StxPostCondition,
} from './helpers/postConditions.js';

const JWT_SECRET = 'test-jwt-secret';
const OWNER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const PLAYER = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';

describe('POST /admin/fund-pool', () => {
  let app: FastifyInstance;
  let gameCore: FakeGameCore;
  let ownerSession: string;
  let playerSession: string;

  async function start(ownerAddress: string | null = OWNER): Promise<void> {
    gameCore = new FakeGameCore();
    app = await buildServer({
      chain: stubChain({ callReadOnly: (params) => gameCore.callReadOnly(params) }),
      oracleSigner: testOracleSigner(),
      oraclePrivateKey: TEST_ORACLE_KEY,
      jwtSecret: JWT_SECRET,
      ownerAddress,
      logger: false,
      rateLimit: false,
    });
  }

  beforeEach(async () => {
    await start();
    ownerSession = issueToken({ address: OWNER, secret: JWT_SECRET, ttlSeconds: 3600 }).token;
    playerSession = issueToken({ address: PLAYER, secret: JWT_SECRET, ttlSeconds: 3600 }).token;
  });

  afterEach(async () => {
    await app.close();
  });

  const fund = (opts: { token?: string | null; body?: unknown } = {}) =>
    app.inject({
      method: 'POST',
      url: '/admin/fund-pool',
      headers: opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? ownerSession}` },
      payload: opts.body ?? { amountUstx: '5000000' },
    });

  describe('access', () => {
    it('serves the owner', async () => {
      const res = await fund();
      expect(res.statusCode).toBe(200);
      expect(res.json().tx.functionName).toBe('fund-pool');
    });

    it('refuses a player session', async () => {
      const res = await fund({ token: playerSession });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('NOT_OWNER');
    });

    it('refuses an anonymous caller', async () => {
      const res = await fund({ token: null });
      expect(res.statusCode).toBe(401);
    });

    it('is off — not open — when no owner address is configured', async () => {
      // Fail closed. An unset OWNER_ADDRESS must never read as "no owner check".
      await app.close();
      await start(null);

      const res = await fund();
      expect(res.statusCode).toBe(501);
      expect(res.json().error.code).toBe('ADMIN_NOT_CONFIGURED');
    });

    it('leaks nothing about the owner to a non-owner', async () => {
      const res = await fund({ token: playerSession });
      expect(res.body).not.toContain(OWNER);
    });
  });

  describe('the payload', () => {
    it('is unsigned — the owner signs it in their own wallet', async () => {
      const raw = (await fund()).body;
      for (const forbidden of ['signature', 'privateKey', 'senderKey', 'signedTx', 'rawTx']) {
        expect(raw).not.toContain(forbidden);
      }
    });

    it('pins the owner sending exactly the requested amount, in deny mode', async () => {
      const body = (await fund({ body: { amountUstx: '12345678' } })).json();

      expect(body.amountUstx).toBe('12345678');
      expect(body.tx.postConditionMode).toBe('deny');
      expect(body.tx.postConditions).toHaveLength(1);

      const pc = deserializePostCondition(body.tx.postConditions[0]) as StxPostCondition;
      expect(pc.address).toBe(OWNER);
      expect(pc.condition).toBe('eq');
      expect(pc.amount).toBe('12345678');
    });

    it('reports the pool balance it read, unmodified', async () => {
      gameCore.sponsorPoolUstx = 7_000_000n;
      const body = (await fund({ body: { amountUstx: '3000000' } })).json();

      // A quote is not a credit: the balance reported is the before-figure, not
      // an optimistic before+amount.
      expect(body.sponsorPoolUstx).toBe('7000000');
      expect(body.sponsorPoolUstx).not.toBe('10000000');
      expect(gameCore.sponsorPoolUstx).toBe(7_000_000n);
    });

    it('says plainly that this is the only way the pool grows', async () => {
      const body = (await fund()).json();
      expect(body.tx.summary).toMatch(/entry fees never credit it/i);
    });
  });

  describe('the amount', () => {
    it('accepts a decimal string of microSTX', async () => {
      const body = (await fund({ body: { amountUstx: '1' } })).json();
      expect(body.amountUstx).toBe('1');
    });

    it('accepts an amount past Number.MAX_SAFE_INTEGER as a string', async () => {
      // 10 billion STX would never be funded, but the parser must not silently
      // lose precision on a large figure either.
      const big = '90071992547409910';
      const body = (await fund({ body: { amountUstx: big } })).json();
      expect(body.amountUstx).toBe(big);
    });

    it('accepts a safe-integer JSON number', async () => {
      const body = (await fund({ body: { amountUstx: 2_500_000 } })).json();
      expect(body.amountUstx).toBe('2500000');
    });

    it('rejects a fractional number rather than rounding it', async () => {
      const res = await fund({ body: { amountUstx: 1000.5 } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_AMOUNT');
    });

    it('rejects zero, negatives and nonsense', async () => {
      for (const amountUstx of ['0', 0, '-1', -5, '1e6', '1_000', 'lots', '', null, undefined]) {
        const res = await fund({ body: { amountUstx } });
        expect(res.statusCode, `amountUstx=${String(amountUstx)}`).toBe(400);
        expect(res.json().error.code).toBe('INVALID_AMOUNT');
      }
    });
  });
});

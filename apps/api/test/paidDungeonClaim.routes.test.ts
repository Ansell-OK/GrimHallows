/**
 * POST /dungeons/:id/claim tests — Phase 5.
 *
 * The route that turns a confirmed `enter-dungeon` into a run the player can act
 * on. Two things matter here and the tests are grouped around them.
 *
 * First, authorisation: the session address is checked against the transaction's
 * sender, so a claim cannot be made against somebody else's payment. Without
 * that check the first caller to learn a txid would get the run, and txids are
 * public.
 *
 * Second, idempotency: the same payment arrives more than once — a player
 * retrying after a dropped response, and later a reconciliation pass. The second
 * claim must return the same run rather than a second one, because two runs
 * citing one payment is one run nobody paid for.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Cl, serializeCV } from '@stacks/transactions';
import {
  PAID_DUNGEON_ID,
  contractId as buildContractId,
  type NetworkConfig,
} from '@grimhallow/shared';
import { buildServer } from '../src/server.js';
import { MemoryRunStore } from '../src/repos/runs.js';
import { issueRunToken, issueToken, verifyRunToken, verifyToken } from '../src/lib/jwt.js';
import { TEST_ORACLE_KEY, stubChain, testOracleSigner } from './helpers/oracle.js';
import { characterRef } from './helpers/collections.js';
import type { PaidRunOracle } from '../src/oracle/paidRunOracle.js';
import type { ChainTransaction } from '../src/lib/hiro.js';

const JWT_SECRET = 'test-jwt-secret';
const PLAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const OTHER = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const TX_ID = '0x1111111111111111111111111111111111111111111111111111111111111111';
const COMMIT_TX_ID = '0x2222222222222222222222222222222222222222222222222222222222222222';
const GATE_FEE = '1000000';

/**
 * Pinned rather than read from env, so the contract id the service checks
 * against and the one the fixture claims are the same by construction.
 */
const STACKS: NetworkConfig = {
  network: 'devnet',
  deployer: 'ST3AM1A56AK2C1XAFJ4115ZSV26EB49BVQ10MGCS0',
  apiUrl: 'http://localhost:3999',
  explorerUrl: 'http://localhost:8000',
};

/** Where the gate fee lands. Owner revenue, never the sponsor pool. */
const OPERATOR = STACKS.deployer;
const GAME_CORE = buildContractId(STACKS, 'gameCore');

/** A listed collection, so the claim builds a playable run rather than a 400. */
const CHARACTER = characterRef('42');

function enterTx(overrides: Partial<ChainTransaction> = {}): ChainTransaction {
  return {
    txId: TX_ID,
    txStatus: 'success',
    txType: 'contract_call',
    senderAddress: PLAYER,
    contractId: GAME_CORE,
    functionName: 'enter-dungeon',
    functionArgsRepr: [`u${PAID_DUNGEON_ID}`, `(list ${PLAYER})`],
    resultRepr: '(ok u1)',
    events: [
      {
        eventType: 'smart_contract_log',
        contractId: GAME_CORE,
        valueHex: `0x${serializeCV(
          Cl.tuple({
            event: Cl.stringAscii('run-entered'),
            'run-id': Cl.uint(1),
            'gate-fee': Cl.uint(BigInt(GATE_FEE)),
          }),
        )}`,
        stxTransfer: null,
      },
      {
        eventType: 'stx_asset',
        contractId: null,
        valueHex: null,
        stxTransfer: {
          assetEventType: 'transfer',
          sender: PLAYER,
          recipient: OPERATOR,
          amountUstx: GATE_FEE,
        },
      },
    ],
    blockHeight: 12_345,
    ...overrides,
  };
}

/** Records commits instead of broadcasting — no node, no fee estimate. */
function fakePaidOracle() {
  const commits: { runId: string; seedHash: string }[] = [];
  return {
    commits,
    oracle: {
      async commitSeed(args: { runId: string; seedHash: string }) {
        commits.push({ ...args });
        return COMMIT_TX_ID;
      },
    } as unknown as PaidRunOracle,
  };
}

describe('POST /dungeons/:id/claim', () => {
  let app: FastifyInstance;
  let runs: MemoryRunStore;
  let session: string;
  let tx: ChainTransaction | null;
  let commits: { runId: string; seedHash: string }[];

  beforeEach(async () => {
    runs = new MemoryRunStore();
    const fake = fakePaidOracle();
    commits = fake.commits;
    tx = enterTx();

    app = await buildServer({
      chain: stubChain({
        async getTransaction() {
          return tx;
        },
      }),
      runStore: runs,
      stacks: STACKS,
      oracleSigner: testOracleSigner(),
      oraclePrivateKey: TEST_ORACLE_KEY,
      paidOracle: fake.oracle,
      jwtSecret: JWT_SECRET,
      logger: false,
    });
    session = issueToken({ address: PLAYER, secret: JWT_SECRET, ttlSeconds: 3600 }).token;
  });

  afterEach(async () => {
    await app.close();
  });

  function claim(body: unknown, token: string | null = session) {
    return app.inject({
      method: 'POST',
      url: `/dungeons/${PAID_DUNGEON_ID}/claim`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body as Record<string, unknown>,
    });
  }

  const validBody = { enterTxId: TX_ID, character: CHARACTER };

  describe('a successful claim', () => {
    it('returns a playable run for the payment', async () => {
      const res = await claim(validBody);
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.dungeonType).toBe('paid');
      expect(body.runId).toBe('1');
      expect(body.dungeonId).toBe(PAID_DUNGEON_ID);
      expect(body.feePaidUstx).toBe(GATE_FEE);
      expect(body.commitTxId).toBe(COMMIT_TX_ID);
      expect(body.seedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.encounter).toBeTruthy();
      expect(body.encounter.combatants.length).toBeGreaterThan(1);
    });

    it('commits the seed on chain exactly once', async () => {
      await claim(validBody);
      expect(commits).toHaveLength(1);
      expect(commits[0]?.runId).toBe('1');
    });

    it('never returns the seed', async () => {
      // The point of commit-reveal. A seed in the entry response is a run whose
      // outcome the player can compute before acting.
      const res = await claim(validBody);
      const raw = res.body;
      expect(raw).not.toContain('"seed"');
      expect(raw).not.toContain('seedReveal');
    });

    it('issues a run token scoped to this run, not a session', async () => {
      const res = await claim(validBody);
      const { runToken } = res.json();

      const claims = verifyRunToken(runToken, JWT_SECRET, '1');
      expect(claims?.run).toBe('1');
      expect(claims?.sub).toBe(PLAYER);
      // Scoped to *this* run: a token for run 1 replayed against another run is
      // refused by the verifier, not by a handler remembering to compare.
      expect(verifyRunToken(runToken, JWT_SECRET, '2')).toBeNull();
      // And a run token that passed as a session would turn one paid entry into
      // access to every session-guarded endpoint.
      expect(verifyToken(runToken, JWT_SECRET)).toBeNull();
    });
  });

  describe('idempotency', () => {
    it('returns the same run when the same payment is claimed twice', async () => {
      const first = await claim(validBody);
      const second = await claim(validBody);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().runId).toBe(first.json().runId);
      // Same seed hash means the same commitment — not a re-rolled fight.
      expect(second.json().seedHash).toBe(first.json().seedHash);
    });

    it('does not commit a second seed on a repeat claim', async () => {
      await claim(validBody);
      await claim(validBody);
      expect(commits).toHaveLength(1);
    });
  });

  describe('authorisation', () => {
    it('refuses an unauthenticated claim', async () => {
      const res = await claim(validBody, null);
      expect(res.statusCode).toBe(401);
    });

    it("refuses to hand a paid run to someone who did not pay for it", async () => {
      // txids are public. Without this check, whoever reads the mempool first
      // gets the run.
      const stranger = issueToken({
        address: OTHER,
        secret: JWT_SECRET,
        ttlSeconds: 3600,
      }).token;

      const res = await claim(validBody, stranger);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('NOT_YOUR_ENTRY');
    });

    it('refuses a run token in place of a session', async () => {
      // A genuine run token for this player. It authorises combat on one run and
      // must not stand in for the session this route requires — otherwise
      // playing any run would grant the ability to claim payments.
      const { token } = issueRunToken({
        address: PLAYER,
        runId: '1',
        secret: JWT_SECRET,
        ttlSeconds: 3600,
      });

      const res = await claim(validBody, token);
      expect(res.statusCode).toBe(401);
    });
  });

  describe('request validation', () => {
    it('requires a txid', async () => {
      const res = await claim({ character: CHARACTER });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('MISSING_TX_ID');
    });

    it('requires a character', async () => {
      const res = await claim({ enterTxId: TX_ID });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CHARACTER');
    });

    it('rejects a non-numeric dungeon id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/dungeons/abc/claim',
        headers: { authorization: `Bearer ${session}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_DUNGEON_ID');
    });

    it('rejects a dungeon that is not the paid one', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/dungeons/99/claim',
        headers: { authorization: `Bearer ${session}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('DUNGEON_NOT_FOUND');
    });
  });

  describe('unconfirmed payments are retryable, not failures', () => {
    it('reports an unknown transaction as not yet confirmed', async () => {
      tx = null;
      const res = await claim(validBody);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TX_NOT_CONFIRMED');
    });

    it('reports a mempool transaction as not yet confirmed', async () => {
      // A player who has already paid must not be told their entry died.
      tx = enterTx({ txStatus: 'pending' });
      const res = await claim(validBody);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TX_NOT_CONFIRMED');
    });

    it('writes no run for an unconfirmed payment', async () => {
      tx = null;
      await claim(validBody);
      expect(await runs.findById('1')).toBeNull();
    });
  });

  describe('refuses a payment it cannot verify', () => {
    it('refuses a failed transaction', async () => {
      tx = enterTx({ txStatus: 'abort_by_post_condition' });
      const res = await claim(validBody);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TX_NOT_SUCCESS');
    });

    it('refuses a transaction against a different contract', async () => {
      tx = enterTx({ contractId: `${STACKS.deployer}.something-else` });
      const res = await claim(validBody);
      expect(res.json().error.code).toBe('TX_WRONG_CONTRACT');
    });

    it('refuses a transaction that called a different function', async () => {
      tx = enterTx({ functionName: 'fund-pool' });
      const res = await claim(validBody);
      expect(res.json().error.code).toBe('TX_WRONG_FUNCTION');
    });
  });
});

/**
 * Auth route tests — the login flow end to end, against in-memory storage.
 *
 * The valuable cases here are the ones where a caller tries to log in as
 * someone they are not: unissued challenges, reused challenges, expired
 * challenges, and signatures that belong to a different key or message. A pass
 * on all of those is what makes "the session says you are ST1..." mean anything.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getAddressFromPrivateKey, signMessageHashRsv } from '@stacks/transactions';
import { buildServer } from '../src/server.js';
import { hashMessage } from '../src/lib/messageSignature.js';
import { verifyToken } from '../src/lib/jwt.js';
import { MemoryAuthStore } from '../src/repos/auth.js';
import type { ChainClient } from '../src/lib/hiro.js';
import { TEST_ORACLE_KEY, testOracleSigner } from './helpers/oracle.js';
import { unresolvedMintBlock, unsupportedChainWrites } from './helpers/chain.js';

const PRIVATE_KEY = '753b7cc01a1a2e86221266a154af739463fce51219d97e4f856cd7200c3bd2a601';
const OTHER_KEY = '7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801';
const ADDRESS = getAddressFromPrivateKey(PRIVATE_KEY, 'testnet');
const JWT_SECRET = 'test-jwt-secret';

/** Never called by these tests; present so the server can be constructed. */
const chainStub: ChainClient = {
  getNftHoldings: async () => [],
  getTokenMetadata: async () => null,
  getBlockTimestamp: async () => null,
  getNftAcquisitionBlock: async () => null,
  callReadOnly: async () => {
    throw new Error('not used');
  },
  ...unsupportedChainWrites(),
  ...unresolvedMintBlock(),
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sign(message: string, privateKey = PRIVATE_KEY): string {
  return signMessageHashRsv({ messageHash: toHex(hashMessage(message)), privateKey });
}

describe('auth routes', () => {
  let app: FastifyInstance;
  let store: MemoryAuthStore;

  beforeEach(async () => {
    store = new MemoryAuthStore();
    app = await buildServer({
      chain: chainStub,
      authStore: store,
      oracleSigner: testOracleSigner(),
      oraclePrivateKey: TEST_ORACLE_KEY,
      jwtSecret: JWT_SECRET,
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function getChallenge(): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/auth/challenge' });
    return res.json().challenge as string;
  }

  it('issues a distinct, high-entropy challenge each time', async () => {
    const a = await getChallenge();
    const b = await getChallenge();

    expect(a).not.toBe(b);
    // 32 random bytes as hex, behind a recognisable prefix.
    expect(a).toMatch(/^grimhallow-login-[0-9a-f]{64}$/);
  });

  it('issues a session token for a correctly signed challenge', async () => {
    const challenge = await getChallenge();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: ADDRESS, signature: sign(challenge), challenge },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.address).toBe(ADDRESS);

    const claims = verifyToken(body.token, JWT_SECRET);
    expect(claims?.sub).toBe(ADDRESS);
  });

  it('refuses a challenge it never issued', async () => {
    // Otherwise a caller could sign any string they like and call it a login.
    const challenge = 'grimhallow-login-' + 'ab'.repeat(32);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: ADDRESS, signature: sign(challenge), challenge },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('CHALLENGE_INVALID');
  });

  it('refuses to reuse a challenge that already logged someone in', async () => {
    const challenge = await getChallenge();
    const payload = { address: ADDRESS, signature: sign(challenge), challenge };

    expect((await app.inject({ method: 'POST', url: '/auth/verify', payload })).statusCode).toBe(200);

    // Replay of the exact same request — a captured signature is worth one login.
    const replay = await app.inject({ method: 'POST', url: '/auth/verify', payload });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('CHALLENGE_INVALID');
  });

  it('burns the challenge even when the signature turns out to be wrong', async () => {
    // Consume-then-verify: a failed attempt must not leave the challenge open
    // for an attacker to keep guessing against.
    const challenge = await getChallenge();

    const bad = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: ADDRESS, signature: sign('different-message'), challenge },
    });
    expect(bad.json().error.code).toBe('SIGNATURE_INVALID');

    const retry = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: ADDRESS, signature: sign(challenge), challenge },
    });
    expect(retry.statusCode).toBe(401);
    expect(retry.json().error.code).toBe('CHALLENGE_INVALID');
  });

  it('refuses an expired challenge', async () => {
    const challenge = 'grimhallow-login-' + 'cd'.repeat(32);
    await store.issueChallenge(challenge, new Date(Date.now() - 1000));

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: ADDRESS, signature: sign(challenge), challenge },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('CHALLENGE_INVALID');
  });

  it('refuses a signature made by a different key', async () => {
    const challenge = await getChallenge();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: ADDRESS, signature: sign(challenge, OTHER_KEY), challenge },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SIGNATURE_INVALID');
  });

  it('rejects a malformed address before touching the challenge', async () => {
    const challenge = await getChallenge();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: 'not-an-address', signature: sign(challenge), challenge },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_ADDRESS');

    // The challenge survived, so a typo doesn't cost the user a round trip.
    const retry = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: ADDRESS, signature: sign(challenge), challenge },
    });
    expect(retry.statusCode).toBe(200);
  });

  it('rejects requests missing fields', async () => {
    for (const payload of [
      {},
      { address: ADDRESS },
      { address: ADDRESS, signature: 'x' },
      { signature: 'x', challenge: 'y' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/auth/verify', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('MISSING_FIELDS');
    }
  });

  it('never echoes a signing key or the signature back to the caller', async () => {
    const challenge = await getChallenge();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: ADDRESS, signature: sign(challenge), challenge },
    });

    expect(res.body).not.toContain(PRIVATE_KEY);
    expect(res.body).not.toContain(sign(challenge));
  });
});

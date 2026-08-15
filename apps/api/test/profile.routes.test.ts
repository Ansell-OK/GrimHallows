import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueToken } from '../src/lib/jwt.js';
import { registerProfileRoutes } from '../src/routes/profile.js';
import type { PlayerStatsStore } from '../src/repos/playerStats.js';
import type { ChainClient } from '../src/lib/hiro.js';

const SECRET = 'profile-test-secret-at-least-32-bytes';
const ALICE = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const BOB = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';

describe('GET /profile', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    const playerStats = {
      aggregate: async () => [
        { address: BOB, freeDungeonsCompleted: 10, paidDungeonsCompleted: 2, jackpotsWon: 1, highestForgeTier: 3 },
        { address: ALICE, freeDungeonsCompleted: 2, paidDungeonsCompleted: 1, jackpotsWon: 0, highestForgeTier: 1 },
      ],
    } as unknown as PlayerStatsStore;
    const chain = { getStxBalance: async () => '1234567' } as unknown as ChainClient;
    await registerProfileRoutes(app, { chain, playerStats, jwtSecret: SECRET });
  });

  afterEach(async () => app.close());

  it('requires an authenticated wallet session', async () => {
    const response = await app.inject({ method: 'GET', url: '/profile' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the signed-in wallet balance and recomputed rank inputs', async () => {
    const { token } = issueToken({ address: ALICE, secret: SECRET, ttlSeconds: 60 });
    const response = await app.inject({
      method: 'GET',
      url: '/profile',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      address: ALICE,
      balanceUstx: '1234567',
      rank: 2,
      dungeonsCompleted: 3,
      freeDungeonsCompleted: 2,
      paidDungeonsCompleted: 1,
      jackpotsWon: 0,
      highestForgeTier: 1,
    });
  });
});

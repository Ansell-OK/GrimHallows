import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueToken } from '../src/lib/jwt.js';
import { MemoryPartyStore } from '../src/repos/parties.js';
import { registerPartyRoutes } from '../src/routes/parties.js';

const SECRET = 'party-test-secret-at-least-32-bytes';
const ALICE = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const BOB = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';

describe('party routes', () => {
  let app: FastifyInstance;
  let store: MemoryPartyStore;
  const auth = (address: string) => ({ authorization: `Bearer ${issueToken({ address, secret: SECRET, ttlSeconds: 60 }).token}` });

  beforeEach(async () => {
    app = Fastify();
    store = new MemoryPartyStore();
    await registerPartyRoutes(app, { parties: store, jwtSecret: SECRET });
  });
  afterEach(async () => app.close());

  it('rejects anonymous access', async () => {
    expect((await app.inject({ method: 'POST', url: '/parties' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/parties/current' })).statusCode).toBe(401);
  });

  it('creates a party with the creator as its unready leader', async () => {
    const response = await app.inject({ method: 'POST', url: '/parties', headers: auth(ALICE) });
    expect(response.statusCode).toBe(201);
    expect(response.json().party).toMatchObject({ createdBy: ALICE, members: [{ address: ALICE, role: 'leader', ready: false }] });
    expect(response.json().party.inviteCode).toHaveLength(12);
  });

  it('allows only one active party per address', async () => {
    await app.inject({ method: 'POST', url: '/parties', headers: auth(ALICE) });
    const response = await app.inject({ method: 'POST', url: '/parties', headers: auth(ALICE) });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('Leave your current party before creating another.');
  });

  it('returns only the authenticated wallet current party', async () => {
    await app.inject({ method: 'POST', url: '/parties', headers: auth(ALICE) });
    expect((await app.inject({ method: 'GET', url: '/parties/current', headers: auth(ALICE) })).json().party.createdBy).toBe(ALICE);
    expect((await app.inject({ method: 'GET', url: '/parties/current', headers: auth(BOB) })).json()).toEqual({ party: null });
  });

  it('disbands when the leader leaves and hides membership from other wallets', async () => {
    const created = await app.inject({ method: 'POST', url: '/parties', headers: auth(ALICE) });
    const id = created.json().party.id;
    expect((await app.inject({ method: 'POST', url: `/parties/${id}/leave`, headers: auth(BOB) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/parties/${id}/leave`, headers: auth(ALICE) })).json()).toEqual({ outcome: 'disbanded' });
    expect(await store.current(ALICE)).toBeNull();
  });
});

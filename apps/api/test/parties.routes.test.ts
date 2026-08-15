import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueToken } from '../src/lib/jwt.js';
import { MemoryPartyStore } from '../src/repos/parties.js';
import { registerPartyRoutes } from '../src/routes/parties.js';
import { MemoryNotificationStore } from '../src/repos/notifications.js';

const SECRET = 'party-test-secret-at-least-32-bytes';
const ALICE = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const BOB = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';

describe('party routes', () => {
  let app: FastifyInstance;
  let store: MemoryPartyStore;
  let notifications: MemoryNotificationStore;
  const auth = (address: string) => ({ authorization: `Bearer ${issueToken({ address, secret: SECRET, ttlSeconds: 60 }).token}` });

  beforeEach(async () => {
    app = Fastify();
    store = new MemoryPartyStore();
    notifications = new MemoryNotificationStore();
    await registerPartyRoutes(app, { parties: store, notifications, jwtSecret: SECRET });
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

  it('creates one pending invite and notifies the invitee idempotently', async () => {
    const created = await app.inject({ method: 'POST', url: '/parties', headers: auth(ALICE) });
    const id = created.json().party.id;
    const first = await app.inject({ method: 'POST', url: `/parties/${id}/invites`, headers: auth(ALICE), payload: { address: BOB } });
    const second = await app.inject({ method: 'POST', url: `/parties/${id}/invites`, headers: auth(ALICE), payload: { address: BOB } });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().invite.id).toBe(first.json().invite.id);
    expect(await notifications.unreadCount(BOB)).toBe(1);
  });

  it('allows only the invitee to accept and adds them as an unready member', async () => {
    const created = await app.inject({ method: 'POST', url: '/parties', headers: auth(ALICE) });
    const partyId = created.json().party.id;
    const invited = await app.inject({ method: 'POST', url: `/parties/${partyId}/invites`, headers: auth(ALICE), payload: { address: BOB } });
    const inviteId = invited.json().invite.id;
    expect((await app.inject({ method: 'POST', url: `/party-invites/${inviteId}/respond`, headers: auth(ALICE), payload: { accept: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/party-invites/${inviteId}/respond`, headers: auth(BOB), payload: { accept: true } })).json()).toEqual({ outcome: 'accepted' });
    expect((await store.current(BOB))?.members).toEqual(expect.arrayContaining([expect.objectContaining({ address: BOB, role: 'member', ready: false })]));
    expect(await notifications.unreadCount(ALICE)).toBe(1);
  });

  it('declines without joining the party', async () => {
    const created = await app.inject({ method: 'POST', url: '/parties', headers: auth(ALICE) });
    const invited = await app.inject({ method: 'POST', url: `/parties/${created.json().party.id}/invites`, headers: auth(ALICE), payload: { address: BOB } });
    const response = await app.inject({ method: 'POST', url: `/party-invites/${invited.json().invite.id}/respond`, headers: auth(BOB), payload: { accept: false } });
    expect(response.json()).toEqual({ outcome: 'declined' });
    expect(await store.current(BOB)).toBeNull();
  });
});

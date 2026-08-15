import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueToken } from '../src/lib/jwt.js';
import { MemoryPartyStore } from '../src/repos/parties.js';
import { registerPartyRoutes } from '../src/routes/parties.js';
import { MemoryNotificationStore } from '../src/repos/notifications.js';
import type { CharacterService } from '../src/services/characterService.js';
import type { IdentityService } from '../src/services/identityService.js';

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
    const characters = { listForAddress: async (address: string) => address === ALICE ? [{ contractId: 'SPTEST.character', tokenId: '7' }] : [] } as unknown as CharacterService;
    const identity = { resolve: async (address: string) => ({ address, displayName: address === ALICE ? 'alice.btc' : 'bob.btc', bnsName: address === ALICE ? 'alice.btc' : 'bob.btc' }) } as unknown as IdentityService;
    await registerPartyRoutes(app, { parties: store, notifications, characters, identity, jwtSecret: SECRET });
  });
  afterEach(async () => app.close());

  it('rejects anonymous access', async () => {
    expect((await app.inject({ method: 'POST', url: '/parties' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/parties/current' })).statusCode).toBe(401);
  });

  it('creates a party with the creator as its unready leader', async () => {
    const response = await app.inject({ method: 'POST', url: '/parties', headers: auth(ALICE) });
    expect(response.statusCode).toBe(201);
    expect(response.json().party).toMatchObject({ createdBy: ALICE, members: [{ address: ALICE, role: 'leader', ready: false, identity: { displayName: 'alice.btc' } }] });
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

  it('supports readiness and leader-only removal', async () => {
    const created = await app.inject({ method: 'POST', url: '/parties', headers: auth(ALICE) });
    const partyId = created.json().party.id;
    const invite = await app.inject({ method: 'POST', url: `/parties/${partyId}/invites`, headers: auth(ALICE), payload: { address: BOB } });
    await app.inject({ method: 'POST', url: `/party-invites/${invite.json().invite.id}/respond`, headers: auth(BOB), payload: { accept: true } });
    expect((await app.inject({ method: 'POST', url: `/parties/${partyId}/ready`, headers: auth(BOB), payload: { ready: true } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/parties/${partyId}/kick`, headers: auth(BOB), payload: { address: ALICE } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/parties/${partyId}/kick`, headers: auth(ALICE), payload: { address: BOB } })).json()).toEqual({ kicked: BOB });
    expect((await notifications.list(BOB, 10)).some((row) => row.type === 'party_kicked')).toBe(true);
  });

  it('binds a held character to the member and clears readiness on selection', async () => {
    const created = await app.inject({ method: 'POST', url: '/parties', headers: auth(ALICE) });
    const partyId = created.json().party.id;
    await app.inject({ method: 'POST', url: `/parties/${partyId}/ready`, headers: auth(ALICE), payload: { ready: true } });
    const selected = await app.inject({ method: 'POST', url: `/parties/${partyId}/character`, headers: auth(ALICE), payload: { contractId: 'SPTEST.character', tokenId: 7 } });
    expect(selected.json()).toEqual({ character: { contractId: 'SPTEST.character', tokenId: '7' }, ready: false });
    expect((await store.current(ALICE))?.members[0]).toMatchObject({ nftContractId: 'SPTEST.character', nftTokenId: '7', ready: false });
    expect((await app.inject({ method: 'POST', url: `/parties/${partyId}/character`, headers: auth(ALICE), payload: { contractId: 'SPTEST.character', tokenId: 8 } })).statusCode).toBe(400);
  });

  it('refuses readiness until the member has selected a character', async () => {
    const created = await app.inject({ method: 'POST', url: '/parties', headers: auth(ALICE) });
    const response = await app.inject({ method: 'POST', url: `/parties/${created.json().party.id}/ready`, headers: auth(ALICE), payload: { ready: true } });
    expect(response.statusCode).toBe(409);
    expect((await store.current(ALICE))?.members[0].ready).toBe(false);
  });
});

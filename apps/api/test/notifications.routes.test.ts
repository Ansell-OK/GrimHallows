import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { issueToken } from '../src/lib/jwt.js';
import { MemoryNotificationStore } from '../src/repos/notifications.js';
import { registerNotificationRoutes } from '../src/routes/notifications.js';

const SECRET = 'notification-test-secret-at-least-32';
const ALICE = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const BOB = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';

describe('notification routes', () => {
  const store = new MemoryNotificationStore();
  let app: ReturnType<typeof Fastify>;
  let token: string;
  beforeEach(async () => { app = Fastify(); token = issueToken({ address: ALICE, secret: SECRET, ttlSeconds: 60 }).token; await registerNotificationRoutes(app, { notifications: store, jwtSecret: SECRET }); });

  it('lists only the authenticated address and reports unread count', async () => {
    await store.create(ALICE, 'party_invite', { partyId: 'p1' });
    await store.create(BOB, 'party_invite', { partyId: 'p2' });
    const headers = { authorization: `Bearer ${token}` };
    const list = await app.inject({ method: 'GET', url: '/notifications', headers });
    expect(list.json().notifications).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/notifications/unread-count', headers })).json().unreadCount).toBe(1);
  });

  it('cannot mark another address notification read', async () => {
    const other = await store.create(BOB, 'party_invite');
    const response = await app.inject({ method: 'PATCH', url: `/notifications/${other.id}/read`, headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(404);
  });
});

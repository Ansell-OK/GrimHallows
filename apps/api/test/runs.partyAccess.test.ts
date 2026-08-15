import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { issueToken } from '../src/lib/jwt.js';
import { registerRunRoutes } from '../src/routes/runs.js';
import type { RunStore } from '../src/repos/runs.js';
import type { CombatService } from '../src/services/combatService.js';

const SECRET = 'party-run-access-secret-at-least-32';
const LEADER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const MEMBER = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const STRANGER = 'ST3AM1A56AK2C1XAFJ4115ZSV26EB49BVQ10MGCS0';

describe('party run access', () => {
  it('admits current members and denies other sessions', async () => {
    const submitAction = vi.fn(async () => ({ ok: true }));
    const app = Fastify();
    const run = { id: '42', createdBy: LEADER, partyId: 'party-1' };
    await registerRunRoutes(app, {
      runs: { findById: async () => run } as unknown as RunStore,
      combat: { submitAction, get: async () => ({ runId: '42' }) } as unknown as CombatService,
      partyAccess: async (_partyId, address) => address === MEMBER,
      jwtSecret: SECRET,
    });
    const token = (address: string) => ({ authorization: `Bearer ${issueToken({ address, secret: SECRET, ttlSeconds: 60 }).token}` });
    expect((await app.inject({ method: 'GET', url: '/runs/42', headers: token(MEMBER) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/runs/42', headers: token(STRANGER) })).statusCode).toBe(401);
    await app.inject({ method: 'POST', url: '/runs/42/actions', headers: token(MEMBER), payload: { powerId: 'strike' } });
    expect(submitAction).toHaveBeenCalledWith('42', MEMBER, { powerId: 'strike', targetId: null });
    await app.close();
  });
});

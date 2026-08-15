import type { FastifyInstance } from 'fastify';
import { requireSession } from '../lib/authGuard.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { PartyStore } from '../repos/parties.js';
import type { NotificationStore } from '../repos/notifications.js';

export async function registerPartyRoutes(app: FastifyInstance, deps: { parties: PartyStore; notifications: NotificationStore; jwtSecret: string }) {
  app.post('/parties', async (request, reply) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    const result = await deps.parties.create(sub);
    if (result.kind === 'already_member') throw conflict('PARTY_ALREADY_MEMBER', 'Leave your current party before creating another.');
    return reply.status(201).send({ party: result.party });
  });

  app.get('/parties/current', async (request) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    return { party: await deps.parties.current(sub) };
  });

  app.post('/parties/:id/leave', async (request) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    const { id } = request.params as { id: string };
    const outcome = await deps.parties.leave(id, sub);
    if (outcome === 'not_member') throw notFound('PARTY_NOT_FOUND', 'Party not found.');
    return { outcome };
  });

  app.post('/parties/:id/invites', async (request, reply) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    const { id } = request.params as { id: string };
    const address = (request.body as { address?: unknown } | null)?.address;
    if (typeof address !== 'string' || !address.trim()) throw badRequest('INVITEE_REQUIRED', 'An invitee address is required.');
    const result = await deps.parties.invite(id, sub, address.trim());
    if (result.kind === 'not_leader') throw forbidden('PARTY_LEADER_REQUIRED', 'Only the party leader can invite members.');
    if (result.kind === 'already_member') throw conflict('INVITEE_ALREADY_IN_PARTY', 'That wallet is already in a party.');
    if (result.kind === 'self') throw badRequest('CANNOT_INVITE_SELF', 'You cannot invite yourself.');
    if (result.kind === 'party_full') throw conflict('PARTY_FULL', 'The party already has four members.');
    if (result.kind === 'created') await deps.notifications.create(address.trim(), 'party_invite', { partyId: id, inviteId: result.invite.id, inviterAddress: sub });
    return reply.status(result.kind === 'created' ? 201 : 200).send({ invite: result.invite });
  });

  app.get('/party-invites', async (request) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    return { invites: await deps.parties.pendingInvites(sub) };
  });

  app.post('/party-invites/:id/respond', async (request) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    const { id } = request.params as { id: string };
    const accept = (request.body as { accept?: unknown } | null)?.accept;
    if (typeof accept !== 'boolean') throw badRequest('INVITE_RESPONSE_REQUIRED', 'The accept field must be a boolean.');
    const invite = (await deps.parties.pendingInvites(sub)).find((candidate) => candidate.id === id);
    const outcome = await deps.parties.respondToInvite(id, sub, accept);
    if (outcome === 'not_found') throw notFound('PARTY_INVITE_NOT_FOUND', 'Party invite not found.');
    if (outcome === 'expired') throw conflict('PARTY_INVITE_EXPIRED', 'This party invite has expired.');
    if (outcome === 'party_full') throw conflict('PARTY_FULL', 'The party already has four members.');
    if (outcome === 'already_member') throw conflict('PARTY_ALREADY_MEMBER', 'Leave your current party before accepting another invite.');
    if (invite) await deps.notifications.create(invite.inviterAddress, accept ? 'party_invite_accepted' : 'party_invite_declined', { partyId: invite.partyId, inviteId: invite.id, address: sub });
    return { outcome };
  });
}

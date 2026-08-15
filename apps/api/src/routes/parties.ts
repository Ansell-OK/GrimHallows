import type { FastifyInstance } from 'fastify';
import { requireSession } from '../lib/authGuard.js';
import { conflict, notFound } from '../lib/errors.js';
import type { PartyStore } from '../repos/parties.js';

export async function registerPartyRoutes(app: FastifyInstance, deps: { parties: PartyStore; jwtSecret: string }) {
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
}

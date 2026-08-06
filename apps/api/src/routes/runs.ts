/**
 * Combat loop — 04-backend-api-spec.md#5.
 *
 *   POST /runs/:runId/actions   submit one action, get the dice back
 *   GET  /runs/:runId           state + the full turn-by-turn dice log
 *
 * Two endpoints from that section are deliberately absent:
 *
 *   - `POST /runs/:runId/commit` — the spec marks it oracle-only *internal*, and
 *     the seed is committed at entry instead (before the player can act, which
 *     is the whole point of a commitment). Exposing it as a route would let a
 *     caller ask for a fresh seed after seeing an unfavourable one.
 *   - `POST /runs/:runId/resolve` — likewise internal. Resolution happens the
 *     moment the encounter's outcome is decided, computed from a replay, not
 *     when someone asks for it. "Resolve this run as a win" must never be an
 *     input.
 *
 * Both live in `src/oracle/`, which no route imports.
 */

import type { FastifyInstance } from 'fastify';
import type { PlayerAction } from '@grimhallow/shared';
import { RunOracleError } from '../oracle/runOracle.js';
import { requireRunAccess } from '../lib/authGuard.js';
import { ApiError, badRequest, notFound } from '../lib/errors.js';
import type { CombatService } from '../services/combatService.js';
import type { RunStore } from '../repos/runs.js';

export interface RunRouteDeps {
  readonly combat: CombatService;
  readonly runs: RunStore;
  readonly jwtSecret: string;
}

/** Translate an oracle refusal into the spec's error envelope. */
function asApiError(err: unknown): unknown {
  if (err instanceof RunOracleError) {
    return new ApiError(err.status, err.code, err.message);
  }
  return err;
}

function parseAction(body: unknown): PlayerAction {
  const b = (body ?? {}) as Record<string, unknown>;

  if (typeof b.powerId !== 'string' || b.powerId.length === 0) {
    throw badRequest('MISSING_POWER_ID', 'powerId is required');
  }
  if (b.targetId !== undefined && b.targetId !== null && typeof b.targetId !== 'string') {
    throw badRequest('INVALID_TARGET_ID', 'targetId must be a combatant id or null');
  }

  // `turnNumber` and `action` are in the spec's request body but are not read:
  // the turn number follows from the actions already stored, and whether this is
  // an attack or a guard follows from the power. Trusting a client's `action`
  // field would let an edited client label an attack as a guard.
  return { powerId: b.powerId, targetId: (b.targetId as string | undefined) ?? null };
}

export async function registerRunRoutes(
  app: FastifyInstance,
  deps: RunRouteDeps,
): Promise<void> {
  app.post('/runs/:runId/actions', async (request) => {
    const { runId } = request.params as { runId: string };

    const run = await deps.runs.findById(runId);
    if (!run) throw notFound('RUN_NOT_FOUND', `No run with id ${runId}`);

    const claims = requireRunAccess(request, deps.jwtSecret, runId, run.createdBy);
    const action = parseAction(request.body);

    try {
      return await deps.combat.submitAction(runId, claims.sub, action);
    } catch (err) {
      throw asApiError(err);
    }
  });

  app.get('/runs/:runId', async (request) => {
    const { runId } = request.params as { runId: string };

    const run = await deps.runs.findById(runId);
    if (!run) throw notFound('RUN_NOT_FOUND', `No run with id ${runId}`);

    // Authenticated even though it is a read: before the seed is revealed, the
    // encounter view is privileged information — the monster roster and the
    // initiative order are both derived from a seed nobody else should see the
    // consequences of yet.
    requireRunAccess(request, deps.jwtSecret, runId, run.createdBy);

    try {
      const response = await deps.combat.get(runId);
      if (!response) throw notFound('RUN_NOT_FOUND', `No run with id ${runId}`);
      return response;
    } catch (err) {
      throw asApiError(err);
    }
  });
}

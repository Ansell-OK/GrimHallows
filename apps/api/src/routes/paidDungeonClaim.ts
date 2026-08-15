/**
 * Paid-dungeon claim — turn a confirmed `enter-dungeon` into an actionable run.
 *
 *   POST /dungeons/:id/claim   body: { enterTxId, character: { contractId, tokenId } }
 *
 * Not in 04-backend-api-spec.md, which names the unsigned-payload route
 * (`POST /dungeons/:id/enter`) and the generic run routes, but nothing in
 * between. This is that gap: the player has signed and broadcast, and needs the
 * run token that every combat endpoint is guarded by. Without it a paid entry is
 * a run on chain that nobody can act on.
 *
 * Adding it rather than stopping to ask is deliberate — 07-glossary-and-open-questions.md
 * does not list the claim surface as an open decision, and 05-data-model.md's
 * indexing note already fixes the mechanics: paid rows are reconciled from chain,
 * "not solely written by the backend's own request handlers". Every fact here is
 * read back from the transaction; the body's txid is a hint about *which*
 * transaction to read, and its character is checked against the party list.
 *
 * Idempotent, because the same payment arrives here more than once: a player
 * retrying after a dropped response, and later a reconciliation pass. Refusing
 * the second one would strand a paid entry.
 */

import type { FastifyInstance } from 'fastify';
import { PAID_DUNGEON_ID, type PaidRunReadyResponse } from '@grimhallow/shared';
import { requireSession } from '../lib/authGuard.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { issueRunToken } from '../lib/jwt.js';
import { resolveLoadout } from '../lib/loadout.js';
import type { CharacterRef } from '../repos/runs.js';
import type { RunOracle } from '../oracle/runOracle.js';
import type { PaidEntryService } from '../services/paidEntryService.js';
import type { PowerUpService } from '../services/powerUpService.js';
import { RUN_TOKEN_TTL_SECONDS } from './dungeons.js';

export interface PaidClaimRouteDeps {
  readonly paidEntry: PaidEntryService;
  /** Read-only here: used to replay the committed run into an `EncounterView`. */
  readonly oracle: RunOracle;
  /** Verifies the equipped loadout against chain and reads its tiers. */
  readonly powerUps: PowerUpService;
  readonly jwtSecret: string;
}

/**
 * Read the character being fielded.
 *
 * Same validation as the enter route's, and for the same reason: stats are
 * derived from `(contractId, tokenId)` and a run with no character is a fight we
 * cannot build. Note this is a *claim* about which NFT was fielded, not a
 * verified fact — `verifyAndIngest` checks the party list on chain names the
 * payer, but the chain records no NFT, so this binding is off-chain by design
 * (the on-chain party is principals, per `game-core.clar`).
 */
function parseCharacter(value: unknown): CharacterRef {
  const c = (value ?? {}) as Record<string, unknown>;
  const contractId = typeof c.contractId === 'string' ? c.contractId.trim() : '';
  const tokenId =
    typeof c.tokenId === 'string'
      ? c.tokenId.trim()
      : typeof c.tokenId === 'number'
        ? String(c.tokenId)
        : '';

  if (!contractId.includes('.')) {
    throw badRequest(
      'INVALID_CHARACTER',
      'character.contractId must be a fully-qualified contract id (SP….name)',
    );
  }
  if (!/^\d+$/.test(tokenId)) {
    throw badRequest('INVALID_CHARACTER', 'character.tokenId must be a non-negative integer');
  }
  return { contractId, tokenId };
}

export async function registerPaidClaimRoutes(
  app: FastifyInstance,
  deps: PaidClaimRouteDeps,
): Promise<void> {
  app.post('/dungeons/:id/claim', async (request) => {
    // A session, not a signature: the signing already happened on chain, and
    // this call spends nothing. The session address is what the transaction's
    // sender is checked against, so it is load-bearing — a claim cannot be made
    // for somebody else's payment.
    const session = requireSession(request, deps.jwtSecret);

    const { id } = request.params as { id: string };
    if (!/^\d+$/.test(id ?? '')) {
      throw badRequest('INVALID_DUNGEON_ID', 'A numeric on-chain dungeon id is required');
    }
    const dungeonId = Number(id);
    if (dungeonId !== PAID_DUNGEON_ID) {
      throw notFound('DUNGEON_NOT_FOUND', `No paid dungeon with id ${dungeonId}`);
    }

    const body = (request.body ?? {}) as {
      enterTxId?: unknown;
      character?: unknown;
      powerUpTokenIds?: unknown;
    };
    const enterTxId = typeof body.enterTxId === 'string' ? body.enterTxId.trim() : '';
    if (!enterTxId) {
      throw badRequest('MISSING_TX_ID', 'enterTxId is required');
    }
    const character = parseCharacter(body.character);

    // Resolved before the ingest so a bad loadout fails the request rather than
    // committing a run with a loadout the player did not choose. An already-paid
    // entry is not lost by this: the claim is idempotent, so correcting the
    // loadout and retrying reaches the same run.
    const powerUpItems = await resolveLoadout(
      deps.powerUps,
      session.sub,
      body.powerUpTokenIds,
    );

    // Verify from chain, ingest, and commit the seed. Every fact on the returned
    // run came from the transaction, not from the body above.
    const { run } = await deps.paidEntry.verifyAndIngest({
      enterTxId,
      claimedBy: session.sub,
      character,
      powerUpItems,
    });

    if (run.dungeonId !== dungeonId) {
      // The txid names a different dungeon than the path does. Refuse rather
      // than quietly honour one of them: the two disagree about what the player
      // paid for, and only the chain's answer counts.
      throw conflict(
        'DUNGEON_MISMATCH',
        `That transaction entered dungeon ${run.dungeonId}, not ${dungeonId}.`,
      );
    }

    // Replay the committed run into an opening encounter view. Same call the
    // free path makes, and it works unchanged here because the seed, setup and
    // action list are stored identically for both — the difference between a
    // paid and a free run is where the commitment is evidenced, not how the
    // fight is computed.
    const view = await deps.oracle.view(run.id);
    if (!view) {
      throw conflict('RUN_NOT_READY', 'The run could not be read back. Try again shortly.');
    }

    const { token, claims } = issueRunToken({
      address: session.sub,
      runId: run.id,
      secret: deps.jwtSecret,
      ttlSeconds: RUN_TOKEN_TTL_SECONDS,
    });

    const response: PaidRunReadyResponse = {
      dungeonType: 'paid',
      runId: run.id,
      dungeonId,
      monsterTableId: view.encounter.monsterTableId,
      runToken: token,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      seedHash: run.seedHash ?? '',
      feePaidUstx: run.feePaidUstx ?? '0',
      enterTxId: run.enterTxId ?? enterTxId,
      commitTxId: run.commitTxId,
      oracleAddress: run.oracleAddress,
      committedAt: (run.committedAt ?? new Date()).toISOString(),
      encounter: view.encounter,
    };
    return response;
  });
}

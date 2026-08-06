/**
 * Session guard for authenticated routes.
 *
 * What a session token is worth, precisely: proof that whoever holds it signed
 * a challenge with the private key for `claims.sub` at some point in the last
 * day. That is enough to attribute off-chain actions — joining a party,
 * starting a free run, submitting a turn — to an address.
 *
 * It is not, and must never become, authority over money. Every STX or NFT
 * movement is a transaction the player signs in their own wallet, so the worst
 * a stolen token can do is impersonate someone in the convenience layer
 * (lib/jwt.ts). No route may accept this token as a substitute for a signature.
 */

import type { FastifyRequest } from 'fastify';
import { unauthorized } from './errors.js';
import {
  bearerToken,
  verifyRunToken,
  verifyToken,
  type RunClaims,
  type SessionClaims,
} from './jwt.js';

/**
 * Require a valid session, or throw 401.
 *
 * One error for every failure mode (missing, malformed, expired, forged), so a
 * caller probing with guesses learns nothing from which one they got.
 */
export function requireSession(request: FastifyRequest, secret: string): SessionClaims {
  const token = bearerToken(request.headers.authorization);
  const claims = token ? verifyToken(token, secret) : null;

  if (!claims) {
    throw unauthorized(
      'SESSION_INVALID',
      'A valid session token is required. Connect your wallet and sign in again.',
    );
  }
  return claims;
}

/**
 * Require a run token issued for this specific run.
 *
 * A run token is narrower than a session: it is scoped to one run id, so it
 * cannot be replayed against a different run, and it cannot be used on the
 * routes that take a session. Combat routes accept it *or* a session for the
 * address that entered — the token is a convenience for a client mid-run, not a
 * second class of authority.
 *
 * Accepts the token from `Authorization: Bearer` or from an `X-Run-Token`
 * header, so a client can hold both a session and a run token at once without
 * one evicting the other.
 */
export function requireRunAccess(
  request: FastifyRequest,
  secret: string,
  runId: string,
  /** The address that entered this run. Only they may act on it. */
  runOwner: string,
): SessionClaims | RunClaims {
  const header = request.headers['x-run-token'];
  const runTokenHeader = Array.isArray(header) ? header[0] : header;
  const bearer = bearerToken(request.headers.authorization);

  for (const candidate of [runTokenHeader?.trim(), bearer]) {
    if (!candidate) continue;
    const runClaims = verifyRunToken(candidate, secret, runId);
    if (runClaims && runClaims.sub === runOwner) return runClaims;
  }

  const session = bearer ? verifyToken(bearer, secret) : null;
  if (session && session.sub === runOwner) return session;

  // Deliberately the same error whether the credential was absent, expired, for
  // another run, or for another address: a caller poking at run ids should not
  // be able to tell "this run exists but isn't yours" from "no such run".
  throw unauthorized(
    'RUN_ACCESS_DENIED',
    'A valid session or run token for this run is required.',
  );
}

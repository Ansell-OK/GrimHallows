/**
 * Wallet auth — 04-backend-api-spec.md#1.
 *
 *   POST /auth/challenge  -> { challenge }
 *   POST /auth/verify     -> { address, signature, challenge } -> { token }
 *
 * The resulting token authenticates non-money-moving calls only (see lib/jwt.ts).
 * Nothing here gives the backend any authority over the player's funds or NFTs:
 * a signature over a random string proves key possession, and that is all it is
 * ever used for. The backend does not receive, store, or derive a private key at
 * any point in this flow.
 */

import type { FastifyInstance } from 'fastify';
import { validateStacksAddress } from '@stacks/transactions';
import type { StacksNetworkName } from '@grimhallow/shared';
import { badRequest, unauthorized } from '../lib/errors.js';
import { issueToken } from '../lib/jwt.js';
import { verifyMessageSignature } from '../lib/messageSignature.js';
import { generateChallenge, type AuthStore } from '../repos/auth.js';

/** Long enough to sign in an unhurried wallet popup, short enough to matter. */
export const CHALLENGE_TTL_SECONDS = 5 * 60;
/** Session lifetime. Short: re-signing is cheap and free of transaction cost. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

export interface AuthRouteDeps {
  readonly store: AuthStore;
  readonly network: StacksNetworkName;
  readonly jwtSecret: string;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRouteDeps,
): Promise<void> {
  app.post('/auth/challenge', async () => {
    const challenge = generateChallenge();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
    await deps.store.issueChallenge(challenge, expiresAt);

    return { challenge, expiresAt: expiresAt.toISOString() };
  });

  app.post('/auth/verify', async (request) => {
    const body = (request.body ?? {}) as {
      address?: unknown;
      signature?: unknown;
      challenge?: unknown;
    };

    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
    const challenge = typeof body.challenge === 'string' ? body.challenge.trim() : '';

    if (!address || !signature || !challenge) {
      throw badRequest('MISSING_FIELDS', 'address, signature and challenge are all required');
    }
    if (!validateStacksAddress(address)) {
      throw badRequest('INVALID_ADDRESS', `Not a valid Stacks address: ${address}`);
    }

    // Consume FIRST. Verifying first and consuming after would leave a window
    // where two concurrent requests both pass verification on one challenge;
    // consuming first means at most one request can ever proceed past here.
    const consumed = await deps.store.consumeChallenge(challenge);
    if (!consumed) {
      throw unauthorized(
        'CHALLENGE_INVALID',
        'Challenge is unknown, already used, or expired. Request a new one.',
      );
    }

    // The public key is recovered from the signature, never taken from the
    // request body — see lib/messageSignature.ts.
    const valid = verifyMessageSignature({
      message: challenge,
      signature,
      address,
      network: deps.network,
    });
    if (!valid) {
      throw unauthorized(
        'SIGNATURE_INVALID',
        'Signature does not recover to the claimed address on this network.',
      );
    }

    const { token, claims } = issueToken({
      address,
      secret: deps.jwtSecret,
      ttlSeconds: SESSION_TTL_SECONDS,
    });
    await deps.store.recordSession(address, new Date(claims.exp * 1000));

    return { token, address, expiresAt: new Date(claims.exp * 1000).toISOString() };
  });
}

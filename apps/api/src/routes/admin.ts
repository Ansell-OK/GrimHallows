/**
 * Owner-only admin surface — 04-backend-api-spec.md#6.
 *
 *   POST /admin/fund-pool  body: { amountUstx }
 *
 * One route, one purpose: hand the owner an unsigned `fund-pool` transaction.
 * `fund-pool` is the ONLY function that increases `sponsor-pool`
 * (03-smart-contracts-spec.md#2, checklist line "fund-pool is owner-only and is
 * the only function that increases sponsor-pool"). That is why topping up the
 * prize pool is a deliberate, separately-signed act and not a side effect of
 * anybody playing.
 *
 * WHAT THIS ROUTE DOES NOT DO
 *
 * It does not sign. The owner key is not loaded here, is not imported here, and
 * is not reachable from here — `loadOwnerKey()` has no caller in the request
 * path at all. This returns a payload exactly the way a player's entry payload
 * is returned, and the owner signs it in their own wallet. An HTTP request that
 * could move operator funds by itself would make the API a custodian of the
 * prize pool, which is precisely the arrangement the architecture rules out.
 *
 * WHAT "OWNER-AUTHENTICATED" MEANS HERE
 *
 * A session token whose `sub` is the configured `OWNER_ADDRESS` — i.e. someone
 * who has proved control of the owner wallet by signing a login challenge. That
 * is only an access check on a read-and-quote endpoint; it is not authority over
 * money, because the payload still has to be signed by the same wallet before
 * anything moves. The worst a stolen owner session can do is generate a
 * transaction the thief cannot sign.
 */

import type { FastifyInstance } from 'fastify';
import type { FundPoolResponse, NetworkConfig } from '@grimhallow/shared';
import { requireSession } from '../lib/authGuard.js';
import { badRequest, forbidden, notImplemented } from '../lib/errors.js';
import { buildFundPoolTx } from '../lib/txBuilder.js';
import type { MapService } from '../services/mapService.js';

export interface AdminRouteDeps {
  /**
   * The operator's principal, or null when `OWNER_ADDRESS` is unset.
   *
   * Null disables the route rather than throwing at boot: a misconfigured admin
   * surface should not stop players from playing, and it must not fall back to
   * "any session will do".
   */
  readonly ownerAddress: string | null;
  /** Reads the live pool so the owner sees what they are topping up from. */
  readonly map: MapService;
  readonly stacks: NetworkConfig;
  readonly jwtSecret: string;
}

/**
 * Parse `amountUstx` as an exact integer number of microSTX.
 *
 * Strings only for the actual amount, and no floats: `0.1 + 0.2` money is how
 * an operator funds the pool with one microSTX less than they meant to. A
 * JSON number is accepted only when it is a safe integer, and rejected
 * otherwise rather than rounded.
 */
function parseAmountUstx(value: unknown): bigint {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) {
      throw badRequest('INVALID_AMOUNT', 'amountUstx must be a whole number of microSTX');
    }
    return assertPositive(BigInt(value.trim()));
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw badRequest(
        'INVALID_AMOUNT',
        'amountUstx must be a whole number of microSTX — send it as a string to avoid ' +
          'floating-point rounding.',
      );
    }
    return assertPositive(BigInt(value));
  }
  throw badRequest('INVALID_AMOUNT', 'amountUstx is required (a whole number of microSTX)');
}

function assertPositive(amount: bigint): bigint {
  if (amount <= 0n) {
    throw badRequest('INVALID_AMOUNT', 'amountUstx must be greater than zero');
  }
  return amount;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminRouteDeps,
): Promise<void> {
  app.post('/admin/fund-pool', async (request) => {
    const session = requireSession(request, deps.jwtSecret);

    if (!deps.ownerAddress) {
      // Fail closed. An unconfigured owner address must never mean "everyone is
      // the owner"; it means the admin surface is off.
      throw notImplemented(
        'ADMIN_NOT_CONFIGURED',
        'OWNER_ADDRESS is not configured, so the admin surface is disabled.',
      );
    }
    if (session.sub !== deps.ownerAddress) {
      throw forbidden('NOT_OWNER', 'This endpoint is restricted to the game operator.');
    }

    const body = (request.body ?? {}) as { amountUstx?: unknown };
    const amountUstx = parseAmountUstx(body.amountUstx);

    // Read the pool before quoting so the response can show the before-figure.
    // Purely informational — the transaction is valid regardless of what the
    // balance was when this was built, and the post-condition binds the amount.
    const dungeon = await deps.map.requirePaidDungeon();

    const tx = buildFundPoolTx({
      stacks: deps.stacks,
      ownerAddress: deps.ownerAddress,
      amountUstx,
    });

    const response: FundPoolResponse = {
      amountUstx: amountUstx.toString(),
      sponsorPoolUstx: dungeon.sponsorPoolUstx,
      tx,
    };
    return response;
  });
}

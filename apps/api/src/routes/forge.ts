/**
 * Forge routes — 04-backend-api-spec.md#7.
 *
 *   GET  /forge/recipes  -> the on-chain recipe ladder, mirrored for display
 *   POST /forge          -> unsigned `forge` tx payload for the client to sign
 *
 * The GET is unauthenticated, and deliberately so: recipes are public chain
 * state. Neither route signs anything, custodies anything, or moves STX itself
 * — the POST returns a *description* of a transaction (02-architecture.md
 * ground rule: money-moving actions are always user-signed). A caller who
 * fabricates a payload gains nothing: the forge validates ownership, tier and
 * count on chain, so a transaction built for tokens the signer does not own
 * simply aborts.
 *
 * THE POST NEEDS A SESSION, THE GET DOES NOT. Since forge-v2 the payload
 * carries an STX post-condition, which has to name the principal it binds —
 * and the only address we will accept for that is the one the caller
 * authenticated as. Taking it from the request body instead would let anyone
 * mint a payload naming anyone else; harmless in itself (the wallet signing it
 * would abort), but it would mean quoting a price to an address we have no
 * reason to believe in.
 */

import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors.js';
import { requireSession } from '../lib/authGuard.js';
import { FORGE_MAX_INPUTS, buildForgeTx } from '../lib/txBuilder.js';
import type { ForgeService } from '../services/forgeService.js';
import type { NetworkConfig } from '@grimhallow/shared';

export interface ForgeRouteDeps {
  readonly forge: ForgeService;
  readonly stacks: NetworkConfig;
  readonly jwtSecret: string;
}

/** Reject anything that is not a safe positive integer, however it arrived. */
function asTokenId(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

export async function registerForgeRoutes(
  app: FastifyInstance,
  deps: ForgeRouteDeps,
): Promise<void> {
  app.get('/forge/recipes', async () => ({ recipes: await deps.forge.listRecipes() }));

  app.post('/forge', async (request) => {
    const session = requireSession(request, deps.jwtSecret);
    const body = (request.body ?? {}) as { recipeId?: unknown; tokenIds?: unknown };

    const recipeId = asTokenId(body.recipeId);
    if (recipeId === null) {
      throw badRequest('INVALID_RECIPE_ID', 'recipeId must be a positive integer');
    }

    if (!Array.isArray(body.tokenIds) || body.tokenIds.length === 0) {
      throw badRequest('INVALID_TOKEN_IDS', 'tokenIds must be a non-empty array');
    }
    if (body.tokenIds.length > FORGE_MAX_INPUTS) {
      // Caught here rather than on chain: the contract's `(list 5 uint)` would
      // reject it too, but only after the player signed and paid a network fee.
      throw badRequest(
        'TOO_MANY_TOKENS',
        `A forge burns at most ${FORGE_MAX_INPUTS} tokens; got ${body.tokenIds.length}`,
      );
    }

    const tokenIds = body.tokenIds.map(asTokenId);
    if (tokenIds.some((id) => id === null)) {
      throw badRequest('INVALID_TOKEN_IDS', 'Every tokenId must be a positive integer');
    }
    const ids = tokenIds as number[];
    if (new Set(ids).size !== ids.length) {
      throw badRequest('DUPLICATE_TOKEN_IDS', 'A forge cannot burn the same token twice');
    }

    // The fee is read live from `get-recipe` on every build, for the same reason
    // the gate fee is: a fee the owner has changed on chain must not be quotable
    // at the old price, because the post-condition would then abort the player's
    // transaction and cost them a network fee for our stale copy. Throws 503
    // rather than defaulting — see `requireRecipe`.
    const recipe = await deps.forge.requireRecipe(recipeId);

    // The input count is still not pre-checked against the recipe. The contract
    // is the authority on whether these inputs satisfy it, and a backend that
    // also decided would be a second implementation of the same rule — free to
    // drift. The fee is different: it is ours to quote correctly or not at all.
    return {
      ...buildForgeTx({
        stacks: deps.stacks,
        senderAddress: session.sub,
        recipeId,
        tokenIds: ids,
        feeUstx: BigInt(recipe.stxFeeUstx),
      }),
      // Published alongside the payload so the UI can show a price without
      // decoding a post-condition. `tx.postConditions` is what actually binds.
      feeUstx: recipe.stxFeeUstx,
    };
  });
}

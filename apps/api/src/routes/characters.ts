/**
 * Characters — 04-backend-api-spec.md#2.
 *
 *   GET  /characters?address=SPxxxx  -> owned SIP-009 NFTs + derived base stats
 *   GET  /characters/mint            -> the shop: live price, pause state, classes
 *   POST /characters/mint            -> unsigned `mint-character` tx to sign
 *
 * The reads are public: they report what a wallet holds on chain and what stats
 * that implies. There is nothing to authorize, because there is nothing here a
 * player could not read from the chain themselves — this endpoint is a
 * convenience over public data, which is exactly the role the backend is meant
 * to play (04-backend-api-spec.md intro).
 *
 * `GET /characters/:contractId/:tokenId/power-ups` reports the power-up NFTs a
 * wallet holds, described against the character named in the path. The tier
 * that determines each bonus is read from chain, never from metadata — see
 * `PowerUpService` for why that distinction is load-bearing.
 *
 * The POST needs a session because it pins a post-condition to a principal, and
 * the only address worth pinning is the one the caller authenticated as. It
 * still signs nothing and custodies nothing — it returns a description of a
 * transaction for the player's wallet to sign (02-architecture.md ground rule).
 */

import type { FastifyInstance } from 'fastify';
import { validateStacksAddress } from '@stacks/transactions';
import {
  classCatalog,
  classPowerIds,
  contractId as buildContractId,
  deriveClass,
  isCharClass,
} from '@grimhallow/shared';
import { requireSession } from '../lib/authGuard.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { CHARACTER_URI_MAX_LENGTH, buildMintCharacterTx } from '../lib/txBuilder.js';
import type { CharacterMintService } from '../services/characterMintService.js';
import type { CharacterService } from '../services/characterService.js';
import type { PowerUpService } from '../services/powerUpService.js';
import type { NetworkConfig } from '@grimhallow/shared';

export interface CharacterRouteDeps {
  readonly characters: CharacterService;
  readonly powerUps: PowerUpService;
  readonly characterMint: CharacterMintService;
  readonly stacks: NetworkConfig;
  readonly jwtSecret: string;
}

/**
 * The metadata URI minted alongside a character.
 *
 * Flavour only, and per-class rather than per-token: nothing in this system
 * reads a stat, class, or tier from metadata (01-game-design.md#4a), so this
 * exists to give the token a name and picture in a wallet. The class the game
 * actually uses is the one written to the contract's own map by the same
 * transaction.
 *
 * Server-side rather than client-supplied, deliberately. A caller-chosen URI
 * would be harmless by that same argument — but "harmless" depends on the whole
 * no-metadata-in-the-power-path rule holding forever, and a URI a player picked
 * would be the first thing to make breaking it expensive.
 */
function metadataUriFor(classId: string): string {
  return `ipfs://grimhallow/character/${classId}.json`;
}

export async function registerCharacterRoutes(
  app: FastifyInstance,
  deps: CharacterRouteDeps,
): Promise<void> {
  app.get('/characters', async (request) => {
    const address = String(
      (request.query as { address?: unknown } | undefined)?.address ?? '',
    ).trim();

    if (!address) {
      throw badRequest('MISSING_ADDRESS', 'address query parameter is required');
    }
    if (!validateStacksAddress(address)) {
      throw badRequest('INVALID_ADDRESS', `Not a valid Stacks address: ${address}`);
    }

    const characters = await deps.characters.listForAddress(address);
    return { address, characters };
  });

  /**
   * The shop front: what a character costs, and whether sales are open.
   *
   * Unauthenticated — it is a price list. Both values come from chain on every
   * request rather than from `CHARACTER_MINT_PRICE_USTX`; see
   * `CharacterMintService` for why a constant here would eventually quote a
   * price the contract no longer charges.
   *
   * The class catalog is static: it is the same four classes the contract
   * accepts and the shared derivation uses, published so the picker does not
   * have to hardcode them a third time.
   */
  app.get('/characters/mint', async () => {
    const quote = await deps.characterMint.quote();
    return {
      priceUstx: quote.priceUstx,
      paused: quote.paused,
      classes: classCatalog(),
      disclosure:
        'Minting buys one character NFT of the class you pick, and the class is ' +
        'written on chain in the same transaction. This is a purchase, not a ' +
        'wager: the price is not refundable, it does not fund the prize pool, ' +
        'and it does not affect your odds in any dungeon.',
    };
  });

  /**
   * Build the unsigned `mint-character` transaction.
   *
   * The price is re-read here rather than trusted from whatever the client saw
   * on the shop screen — a client that quoted an old price would otherwise get a
   * post-condition matching its stale number, and the transaction would abort
   * after the player signed it.
   *
   * A paused mint is refused before the payload is built. The contract would
   * reject it too (`ERR-MINT-PAUSED`), but only after the player signed and paid
   * a network fee for a transaction that could never succeed.
   */
  app.post('/characters/mint', async (request) => {
    const session = requireSession(request, deps.jwtSecret);
    const body = (request.body ?? {}) as { classId?: unknown };

    const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
    if (!isCharClass(classId)) {
      // Checked against the same four ids the contract compares against. The
      // contract rejects an unknown id too; this is the half that costs nothing.
      throw badRequest(
        'INVALID_CLASS',
        `classId must be one of the four character classes; got ${JSON.stringify(body.classId)}`,
      );
    }

    const quote = await deps.characterMint.quote();
    if (quote.paused) {
      throw conflict(
        'MINT_PAUSED',
        'Character minting is currently paused on the contract. Nothing was charged.',
      );
    }

    const metadataUri = metadataUriFor(classId);
    /* c8 ignore next 4 -- a guard against a future edit to `metadataUriFor`,
       not a reachable branch: every current class id produces a short ASCII
       path. Cheaper to assert than to discover on chain. */
    if (metadataUri.length > CHARACTER_URI_MAX_LENGTH) {
      throw badRequest('URI_TOO_LONG', 'The generated metadata URI is too long to mint');
    }

    return {
      ...buildMintCharacterTx({
        stacks: deps.stacks,
        senderAddress: session.sub,
        classId,
        metadataUri,
        priceUstx: BigInt(quote.priceUstx),
      }),
      // For display. `tx.postConditions` is what actually binds.
      priceUstx: quote.priceUstx,
    };
  });

  /**
   * Power-ups the given wallet holds, described against this character.
   *
   * The character is in the path and the holder is in the query because they
   * are different questions: which power-ups exist in a wallet, and what they
   * would do if equipped on this particular NFT. The character's class fixes
   * its basic attack, which is the power the dice upgrade is rendered against
   * (a Rogue's `1d6->1d8` and a Warrior's `1d8->1d10` are the same tier).
   */
  app.get('/characters/:contractId/:tokenId/power-ups', async (request) => {
    const { contractId, tokenId } = request.params as {
      contractId: string;
      tokenId: string;
    };
    const address = String(
      (request.query as { address?: unknown } | undefined)?.address ?? '',
    ).trim();

    if (!address) {
      throw badRequest('MISSING_ADDRESS', 'address query parameter is required');
    }
    if (!validateStacksAddress(address)) {
      throw badRequest('INVALID_ADDRESS', `Not a valid Stacks address: ${address}`);
    }
    if (!contractId.includes('.')) {
      throw badRequest('INVALID_CONTRACT_ID', `Not a valid contract id: ${contractId}`);
    }
    if (!/^\d+$/.test(tokenId)) {
      throw badRequest('INVALID_TOKEN_ID', `Token id must be a non-negative integer: ${tokenId}`);
    }

    // Same derivation the character list uses, so the power a bonus is shown
    // against is the one that character will actually bring into a dungeon.
    //
    // Our own `character-nft` tokens carry their class on chain rather than in
    // the curated allowlist, so they need a read to resolve at all. Every other
    // collection answers from the table, and pays no chain call to find out.
    const mintedClassId =
      contractId === buildContractId(deps.stacks, 'characterNft')
        ? await deps.characterMint.mintedClass(tokenId).catch(() => null)
        : null;

    const derived = deriveClass(contractId, tokenId, mintedClassId);
    if (derived === null) {
      // Not a fallback's worth of information missing — this token has no class
      // because it is not a character. Saying so is more useful than describing
      // power-ups against an archetype we made up.
      throw notFound(
        'UNSUPPORTED_COLLECTION',
        `${contractId} is not a supported character collection, so ${contractId}::${tokenId} ` +
          'has no class to describe power-ups against.',
      );
    }

    const charClass = derived.classId;
    const basicAttackId = classPowerIds(charClass)[0] ?? null;

    return {
      address,
      character: { contractId, tokenId, charClass },
      powerUps: await deps.powerUps.listForAddress(address, basicAttackId),
    };
  });
}

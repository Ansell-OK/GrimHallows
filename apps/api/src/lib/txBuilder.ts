/**
 * Unsigned transaction payloads — 04-backend-api-spec.md#3 and #6.
 *
 * GROUND RULE (02-architecture.md, non-negotiable): money-moving actions are
 * always user-signed. This module builds *descriptions* of transactions for a
 * wallet to sign. It has no access to a private key, imports no signing
 * function, and returns no signature. The backend prepares; the wallet signs;
 * the wallet broadcasts. There is no code path here that could custody or move
 * a player's STX even if it were called with hostile input.
 *
 * The payload shape is `@stacks/connect`'s `stx_callContract` request, because
 * that is what `apps/web`'s wallet layer already speaks. Contract arguments are
 * serialized to hex here rather than assembled in the browser: the browser is
 * where a tampered argument would be cheapest to introduce, and a hex blob the
 * wallet decodes and displays is one the player can check against what we said.
 *
 * POST-CONDITIONS ARE THE POINT. Every payload that moves STX carries a
 * post-condition in `Deny` mode pinning the exact amount the signer sends. If
 * the contract tried to move one microSTX more than stated, the transaction
 * aborts on chain rather than succeeding quietly. This is the player's
 * protection against us, and it is not optional.
 *
 * WHAT A POST-CONDITION DOES NOT BIND: the recipient. A Stacks STX
 * post-condition constrains how much the named principal sends, not where it
 * goes — there is no recipient field in the wire format. So these pin "you send
 * exactly N uSTX and not a microSTX more"; they do not, and cannot, prove the
 * N landed with the contract owner rather than somewhere else. That guarantee
 * comes from the contract source, which is public and immutable, and from the
 * Clarinet suite's `expectRevenueNotPool`. Both halves are needed and neither
 * substitutes for the other.
 */

import {
  Cl,
  Pc,
  postConditionToHex,
  serializeCV,
  type ClarityValue,
  type PostCondition,
} from '@stacks/transactions';
import {
  MAX_PARTY_SIZE,
  contractId as buildContractId,
  isCharClass,
  type NetworkConfig,
} from '@grimhallow/shared';

/**
 * A transaction the client must sign, described exactly.
 *
 * `functionArgs` are hex-encoded Clarity values and `postConditions` are
 * hex-encoded post-conditions — the wire format `@stacks/connect` accepts
 * directly, so nothing has to be re-encoded (and therefore possibly re-encoded
 * differently) on the way to the wallet.
 */
export interface UnsignedContractCall {
  readonly contractAddress: string;
  readonly contractName: string;
  readonly functionName: string;
  readonly functionArgs: readonly string[];
  /** Always `Deny` for money-moving calls. See the module note. */
  readonly postConditionMode: 'deny' | 'allow';
  readonly postConditions: readonly string[];
  readonly network: string;
  /**
   * Human-readable statement of what signing this does, shown in our own UI
   * next to the wallet prompt. Not a substitute for the post-conditions — a
   * player should be able to ignore this text entirely and still be safe.
   */
  readonly summary: string;
}

/**
 * Clarity list bound on `forge`'s `token-ids` argument — `(list 5 uint)`.
 *
 * Not the same number as `FORGE_INPUT_COUNT` in shared, which is how many a
 * *recipe* burns (3). This is the widest list the contract signature accepts,
 * so a payload longer than this would be rejected on chain after signing.
 */
export const FORGE_MAX_INPUTS = 5;

function splitContractId(id: string): { address: string; name: string } {
  const [address, name] = id.split('.');
  if (!address || !name) throw new Error(`Malformed contract id: ${id}`);
  return { address, name };
}

function toHex(cv: ClarityValue): string {
  return serializeCV(cv);
}

function pcToHex(pc: PostCondition): string {
  return postConditionToHex(pc);
}

/**
 * `enter-dungeon` — pays the gate fee directly to the contract owner.
 *
 * The post-condition pins `sender sends exactly gateFeeUstx uSTX`. Note what it
 * does NOT permit: any second STX movement from the player, in any amount, to
 * anyone. A contract that tried to also take a "pool contribution" from the
 * entrant would abort here — which is the mechanical guarantee behind the claim
 * that an entry fee never funds the prize pool (03-smart-contracts-spec.md#2).
 *
 * No refund path exists and none is implied: once this is signed and mined, the
 * STX is spent regardless of how the run goes.
 */
export function buildEnterDungeonTx(params: {
  readonly stacks: NetworkConfig;
  readonly senderAddress: string;
  readonly dungeonId: number;
  readonly party: readonly string[];
  readonly gateFeeUstx: bigint;
}): UnsignedContractCall {
  const { stacks, senderAddress, dungeonId, party, gateFeeUstx } = params;

  if (!Number.isInteger(dungeonId) || dungeonId < 1) {
    throw new Error(`dungeonId must be a positive integer; got ${dungeonId}`);
  }
  if (party.length < 1 || party.length > MAX_PARTY_SIZE) {
    throw new Error(`Party must hold 1..${MAX_PARTY_SIZE} principals; got ${party.length}`);
  }
  if (gateFeeUstx <= 0n) {
    // A zero-fee paid entry would build a post-condition asserting the player
    // sends nothing, which would then pass while the contract took the real
    // fee. Refuse instead: a paid dungeon with no fee read from chain is a
    // failed read, not a free run.
    throw new Error(`Gate fee must be positive; got ${gateFeeUstx}`);
  }
  if (!party.includes(senderAddress)) {
    // The entrant pays, so the entrant should be in the party they paid for.
    throw new Error('The signing address must be a member of the party it enters with');
  }

  const { address, name } = splitContractId(buildContractId(stacks, 'gameCore'));

  return {
    contractAddress: address,
    contractName: name,
    functionName: 'enter-dungeon',
    functionArgs: [
      toHex(Cl.uint(dungeonId)),
      toHex(Cl.list(party.map((p) => Cl.principal(p)))),
    ],
    postConditionMode: 'deny',
    postConditions: [pcToHex(Pc.principal(senderAddress).willSendEq(gateFeeUstx).ustx())],
    network: stacks.network,
    summary:
      `Enter dungeon ${dungeonId}. Pays exactly ${gateFeeUstx} uSTX to the game operator ` +
      `as a non-refundable entry fee. This is an entry cost, not a wager: it does not ` +
      `fund the prize pool and does not affect your odds.`,
  };
}

/**
 * `forge` — pay the recipe's fee, burn N power-up NFTs, mint one of a higher tier.
 *
 * TARGETS `forge-v2`, NOT `forge`. The deployed v1 charges no fee and is not
 * authorized to mint, so a payload built against it would burn nothing and fail
 * — see the header of `contracts/contracts/forge-v2.clar` for why a fee needed a
 * second contract rather than an edit.
 *
 * The post-condition pins the forger sending exactly `feeUstx`. As on
 * `enter-dungeon`, this also forbids any *second* STX movement from the player
 * in the same transaction, which is the mechanical part of the claim that a
 * forge fee is revenue and never reaches the sponsor pool.
 *
 * `feeUstx` must be the value read from `get-recipe` for this recipe, on this
 * request. Not `FORGE_FEE_BY_OUTPUT_TIER`, which is what the owner seeded and
 * not necessarily what the chain now charges: a stale fee produces a
 * post-condition that aborts the player's transaction and costs them a network
 * fee for our out-of-date copy.
 *
 * The NFTs being burned are deliberately not pinned with post-conditions. A
 * forge burns tokens the contract itself selects by recipe, and enumerating
 * them here would duplicate on-chain validation that `forge-v2.clar` already
 * performs against the recipe — ownership, tier and count are all checked
 * on chain (03-smart-contracts-spec.md#4), so a mismatched input aborts the
 * transaction regardless of what this payload claims.
 *
 * `senderAddress` is needed only to name the principal the post-condition binds.
 * The forge itself acts on `tx-sender`, so the signing wallet is the forger by
 * construction; passing someone else's address here produces a post-condition
 * that does not match the signer and a transaction that aborts, which is the
 * correct outcome rather than a useful attack.
 */
export function buildForgeTx(params: {
  readonly stacks: NetworkConfig;
  readonly senderAddress: string;
  readonly recipeId: number;
  readonly tokenIds: readonly number[];
  readonly feeUstx: bigint;
}): UnsignedContractCall {
  const { stacks, senderAddress, recipeId, tokenIds, feeUstx } = params;

  if (!Number.isInteger(recipeId) || recipeId < 1) {
    throw new Error(`recipeId must be a positive integer; got ${recipeId}`);
  }
  if (tokenIds.length < 1 || tokenIds.length > FORGE_MAX_INPUTS) {
    // The Clarity signature is `(list 5 uint)`; a longer list would be rejected
    // on chain after the player had already signed.
    throw new Error(
      `A forge burns 1..${FORGE_MAX_INPUTS} tokens; got ${tokenIds.length}`,
    );
  }
  if (tokenIds.some((id) => !Number.isInteger(id) || id < 1)) {
    throw new Error('Every tokenId must be a positive integer');
  }
  if (new Set(tokenIds).size !== tokenIds.length) {
    // The contract catches this too — the second pass finds no owner, since the
    // first burned it — but it fails as a generic bad-input error after the
    // player has signed and paid a network fee. Catching it here is free.
    throw new Error('A forge cannot burn the same token twice');
  }
  if (feeUstx <= 0n) {
    // `forge-v2.create-recipe` rejects a zero fee, so a zero here is a failed
    // read rather than a free forge. Building the payload anyway would pin a
    // post-condition saying the player pays nothing while the contract charged
    // the real fee — the transaction would abort after they signed it.
    throw new Error(`Forge fee must be positive; got ${feeUstx}`);
  }

  const { address, name } = splitContractId(buildContractId(stacks, 'forgeV2'));

  return {
    contractAddress: address,
    contractName: name,
    functionName: 'forge',
    functionArgs: [
      toHex(Cl.uint(recipeId)),
      toHex(Cl.list(tokenIds.map((id) => Cl.uint(id)))),
    ],
    postConditionMode: 'deny',
    postConditions: [pcToHex(Pc.principal(senderAddress).willSendEq(feeUstx).ustx())],
    network: stacks.network,
    summary:
      `Forge recipe ${recipeId}: pays exactly ${feeUstx} uSTX to the game operator, ` +
      `then permanently burns ${tokenIds.length} power-up ` +
      `NFT${tokenIds.length === 1 ? '' : 's'} (${tokenIds.join(', ')}) and mints one of a ` +
      `higher tier. The fee is non-refundable and the burn cannot be undone.`,
  };
}

/**
 * Clarity bound on `character-nft.mint-character`'s `metadata-uri` argument —
 * `(string-ascii 256)`. A longer or non-ASCII URI is rejected by the node after
 * the player has signed, so it is checked here instead.
 */
export const CHARACTER_URI_MAX_LENGTH = 256;

/**
 * `mint-character` — buy a character NFT of a chosen class.
 *
 * The third revenue line, and the only one where the player is buying a thing
 * rather than an attempt at a thing: the token is minted in the same
 * transaction that pays for it, so there is no outcome to be disappointed by
 * and no pool involved at any point.
 *
 * THE CLASS IS THE PRODUCT. It is validated here against the same `CLASS_IDS`
 * the contract compares against, because a rejected class is a wasted network
 * fee and — far worse if it ever got through — a token whose on-chain class is
 * not the one the buyer paid for. The contract rejects unknown ids too
 * (`ERR-BAD-CLASS`); this is the cheap half of a check that exists twice on
 * purpose.
 *
 * `priceUstx` must be read from `get-mint-price` on this request. The price is a
 * data-var the owner can change, so a constant here would eventually pin a
 * post-condition at a price the contract no longer charges.
 *
 * The metadata URI is flavour only and the contract does not validate it
 * (nothing in this system reads a stat, class, or tier from metadata). It is
 * still bounded here so an over-long value fails before signing rather than
 * after.
 */
export function buildMintCharacterTx(params: {
  readonly stacks: NetworkConfig;
  readonly senderAddress: string;
  readonly classId: string;
  readonly metadataUri: string;
  readonly priceUstx: bigint;
}): UnsignedContractCall {
  const { stacks, senderAddress, classId, metadataUri, priceUstx } = params;

  if (!isCharClass(classId)) {
    throw new Error(`Unknown class id: ${JSON.stringify(classId)}`);
  }
  if (metadataUri.length === 0 || metadataUri.length > CHARACTER_URI_MAX_LENGTH) {
    throw new Error(
      `metadataUri must be 1..${CHARACTER_URI_MAX_LENGTH} characters; got ${metadataUri.length}`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(metadataUri)) {
    throw new Error('metadataUri must be ASCII — the Clarity argument is string-ascii');
  }
  if (priceUstx <= 0n) {
    // `set-mint-price` rejects zero, so a zero here is a failed read of the
    // price rather than a free mint. Same reasoning as the gate fee.
    throw new Error(`Mint price must be positive; got ${priceUstx}`);
  }

  const { address, name } = splitContractId(buildContractId(stacks, 'characterNft'));

  return {
    contractAddress: address,
    contractName: name,
    functionName: 'mint-character',
    functionArgs: [toHex(Cl.stringAscii(classId)), toHex(Cl.stringAscii(metadataUri))],
    postConditionMode: 'deny',
    postConditions: [pcToHex(Pc.principal(senderAddress).willSendEq(priceUstx).ustx())],
    network: stacks.network,
    summary:
      `Mint one ${classId} character NFT. Pays exactly ${priceUstx} uSTX to the game ` +
      `operator. The token is minted to your wallet in the same transaction, and its ` +
      `class is written on chain and cannot be changed afterwards.`,
  };
}

/**
 * `fund-pool` — the owner credits the sponsor pool.
 *
 * The only transaction in the system that increases `sponsor-pool`. Kept in the
 * same module as `enter-dungeon` deliberately: seeing them side by side makes it
 * obvious they are separate calls signed by different people, which is the
 * entire economic model in two functions.
 *
 * The post-condition pins the owner sending exactly `amountUstx`. It protects
 * the operator from a contract bug the same way the entry post-condition
 * protects the player.
 */
export function buildFundPoolTx(params: {
  readonly stacks: NetworkConfig;
  readonly ownerAddress: string;
  readonly amountUstx: bigint;
}): UnsignedContractCall {
  const { stacks, ownerAddress, amountUstx } = params;

  if (amountUstx <= 0n) {
    throw new Error(`Fund amount must be positive; got ${amountUstx}`);
  }

  const { address, name } = splitContractId(buildContractId(stacks, 'gameCore'));

  return {
    contractAddress: address,
    contractName: name,
    functionName: 'fund-pool',
    functionArgs: [toHex(Cl.uint(amountUstx))],
    postConditionMode: 'deny',
    postConditions: [pcToHex(Pc.principal(ownerAddress).willSendEq(amountUstx).ustx())],
    network: stacks.network,
    summary:
      `Top up the sponsor pool by ${amountUstx} uSTX from the owner wallet. ` +
      `This is the only way the prize pool grows — entry fees never credit it.`,
  };
}

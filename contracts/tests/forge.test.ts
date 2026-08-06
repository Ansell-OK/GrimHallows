import { Cl } from '@stacks/transactions';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * forge tests.
 *
 * Covers the docs/03-smart-contracts-spec.md §8 checklist item:
 *   - forge fails if any input token isn't owned by the caller or doesn't match
 *     the recipe tier
 *
 * plus the §4 invariant that forging is on-chain-validated rather than
 * frontend-validated, and that a failed forge burns nothing.
 *
 * Recipe shape follows the resolved open question: 3-for-1, guaranteed, 4 tiers.
 */

const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer')!; // CONTRACT-OWNER
const minter = accounts.get('wallet_1')!; // stands in for game-core as a mint source
const alice = accounts.get('wallet_2')!;
const bob = accounts.get('wallet_3')!;

const FORGE = 'forge';
const NFT = 'character-loot-nft';

const ERR_NOT_OWNER = Cl.uint(300);
const ERR_RECIPE_NOT_FOUND = Cl.uint(301);
const ERR_WRONG_INPUT_COUNT = Cl.uint(302);
const ERR_BAD_INPUT = Cl.uint(303);
const ERR_BAD_RECIPE = Cl.uint(304);

const T2_URI = 'ipfs://forged/tier-2.json';

// --- helpers ---

function authorizeMinter(who: string, allowed = true) {
  simnet.callPublicFn(
    NFT,
    'set-minter',
    [Cl.principal(who), Cl.bool(allowed)],
    deployer,
  );
}

function mintTo(recipient: string, tier: number) {
  const { result } = simnet.callPublicFn(
    NFT,
    'mint',
    [Cl.principal(recipient), Cl.stringAscii(`ipfs://loot/t${tier}.json`), Cl.uint(tier)],
    minter,
  );
  return Number((result as { value: { value: bigint } }).value.value);
}

function createRecipe(
  inputTier: number,
  inputCount: number,
  outputTier: number,
  uri = T2_URI,
  sender = deployer,
) {
  const { result } = simnet.callPublicFn(
    FORGE,
    'create-recipe',
    [
      Cl.uint(inputTier),
      Cl.uint(inputCount),
      Cl.uint(outputTier),
      Cl.stringAscii(uri),
    ],
    sender,
  );
  return result;
}

function forge(recipeId: number, tokenIds: number[], sender: string) {
  return simnet.callPublicFn(
    FORGE,
    'forge',
    [Cl.uint(recipeId), Cl.list(tokenIds.map(Cl.uint))],
    sender,
  );
}

function ownerOf(tokenId: number) {
  return simnet.callReadOnlyFn(NFT, 'get-owner', [Cl.uint(tokenId)], deployer).result;
}

/** Both mint sources authorized, recipe 1 = three tier-1s into one tier-2. */
function setup() {
  authorizeMinter(minter);
  authorizeMinter(`${deployer}.${FORGE}`);
  createRecipe(1, 3, 2);
}

// ---------------------------------------------------------------------------

describe('forge: recipes', () => {
  it('only the owner can create a recipe', () => {
    expect(createRecipe(1, 3, 2, T2_URI, alice)).toBeErr(ERR_NOT_OWNER);
    expect(
      simnet.callReadOnlyFn(FORGE, 'get-last-recipe-id', [], alice).result,
    ).toBeUint(0);
  });

  it('rejects nonsensical recipes', () => {
    expect(createRecipe(0, 3, 2)).toBeErr(ERR_BAD_RECIPE); // tier 0 does not exist
    expect(createRecipe(1, 0, 2)).toBeErr(ERR_BAD_RECIPE); // zero inputs
    expect(createRecipe(1, 6, 2)).toBeErr(ERR_BAD_RECIPE); // beyond the list cap
    expect(createRecipe(2, 3, 2)).toBeErr(ERR_BAD_RECIPE); // no tier increase
    expect(createRecipe(3, 3, 2)).toBeErr(ERR_BAD_RECIPE); // tier decrease
  });

  it('exposes the recipe publicly so players can plan without trusting the UI', () => {
    createRecipe(1, 3, 2);
    const { result } = simnet.callReadOnlyFn(FORGE, 'get-recipe', [Cl.uint(1)], alice);
    expect(result).toBeSome(
      Cl.tuple({
        'input-tier': Cl.uint(1),
        'input-count': Cl.uint(3),
        'output-tier': Cl.uint(2),
        'output-uri': Cl.stringAscii(T2_URI),
      }),
    );
  });

  it('supports the full 4-tier ladder', () => {
    expect(createRecipe(1, 3, 2)).toBeOk(Cl.uint(1));
    expect(createRecipe(2, 3, 3)).toBeOk(Cl.uint(2));
    expect(createRecipe(3, 3, 4)).toBeOk(Cl.uint(3));
  });
});

describe('forge: happy path', () => {
  beforeEach(setup);

  it('burns three tier-1 tokens and mints one tier-2 to the forger', () => {
    const a = mintTo(alice, 1);
    const b = mintTo(alice, 1);
    const c = mintTo(alice, 1);

    const { result } = forge(1, [a, b, c], alice);
    expect(result).toBeOk(Cl.uint(4)); // next id after the three inputs

    // Inputs are gone - actually destroyed, not parked at a burn address.
    expect(ownerOf(a)).toBeOk(Cl.none());
    expect(ownerOf(b)).toBeOk(Cl.none());
    expect(ownerOf(c)).toBeOk(Cl.none());

    // Output belongs to the forger at the recipe's output tier.
    expect(ownerOf(4)).toBeOk(Cl.some(Cl.principal(alice)));
    expect(
      simnet.callReadOnlyFn(NFT, 'get-token-tier', [Cl.uint(4)], alice).result,
    ).toBeOk(Cl.some(Cl.uint(2)));
    expect(
      simnet.callReadOnlyFn(NFT, 'get-token-uri', [Cl.uint(4)], alice).result,
    ).toBeOk(Cl.some(Cl.stringAscii(T2_URI)));
  });

  it('is guaranteed - the same inputs always produce the same output, no roll', () => {
    const first = forge(1, [mintTo(alice, 1), mintTo(alice, 1), mintTo(alice, 1)], alice);
    const second = forge(1, [mintTo(alice, 1), mintTo(alice, 1), mintTo(alice, 1)], alice);
    expect(first.result).toBeOk(Cl.uint(4));
    expect(second.result).toBeOk(Cl.uint(8));

    for (const id of [4, 8]) {
      expect(
        simnet.callReadOnlyFn(NFT, 'get-token-tier', [Cl.uint(id)], alice).result,
      ).toBeOk(Cl.some(Cl.uint(2)));
    }
  });

  it('lets a forged token be used as input to the next tier up', () => {
    createRecipe(2, 3, 3, 'ipfs://forged/tier-3.json'); // recipe 2

    const tier2s: number[] = [];
    for (let i = 0; i < 3; i++) {
      const ids = [mintTo(alice, 1), mintTo(alice, 1), mintTo(alice, 1)];
      const { result } = forge(1, ids, alice);
      tier2s.push(Number((result as { value: { value: bigint } }).value.value));
    }

    const { result } = forge(2, tier2s, alice);
    expect(result).toBeOk(Cl.uint(13));
    expect(
      simnet.callReadOnlyFn(NFT, 'get-token-tier', [Cl.uint(13)], alice).result,
    ).toBeOk(Cl.some(Cl.uint(3)));
  });
});

describe('forge: on-chain validation cannot be bypassed', () => {
  beforeEach(setup);

  it('rejects an unknown recipe', () => {
    const ids = [mintTo(alice, 1), mintTo(alice, 1), mintTo(alice, 1)];
    expect(forge(99, ids, alice).result).toBeErr(ERR_RECIPE_NOT_FOUND);
  });

  it('rejects the wrong number of inputs', () => {
    const a = mintTo(alice, 1);
    const b = mintTo(alice, 1);
    const c = mintTo(alice, 1);
    const d = mintTo(alice, 1);

    expect(forge(1, [a, b], alice).result).toBeErr(ERR_WRONG_INPUT_COUNT);
    expect(forge(1, [a, b, c, d], alice).result).toBeErr(ERR_WRONG_INPUT_COUNT);
    expect(forge(1, [], alice).result).toBeErr(ERR_WRONG_INPUT_COUNT);

    // Nothing was consumed by the failed attempts.
    for (const id of [a, b, c, d]) {
      expect(ownerOf(id)).toBeOk(Cl.some(Cl.principal(alice)));
    }
  });

  it('rejects a token the caller does not own', () => {
    const a = mintTo(alice, 1);
    const b = mintTo(alice, 1);
    const stolen = mintTo(bob, 1);

    expect(forge(1, [a, b, stolen], alice).result).toBeErr(ERR_BAD_INPUT);

    // Critical: the two tokens alice DID own are still hers. A failed forge
    // burns nothing, because the whole transaction reverts.
    expect(ownerOf(a)).toBeOk(Cl.some(Cl.principal(alice)));
    expect(ownerOf(b)).toBeOk(Cl.some(Cl.principal(alice)));
    expect(ownerOf(stolen)).toBeOk(Cl.some(Cl.principal(bob)));
  });

  it('rejects a token whose owner check fails even when it is the first input', () => {
    const stolen = mintTo(bob, 1);
    const a = mintTo(alice, 1);
    const b = mintTo(alice, 1);

    expect(forge(1, [stolen, a, b], alice).result).toBeErr(ERR_BAD_INPUT);
    expect(ownerOf(stolen)).toBeOk(Cl.some(Cl.principal(bob)));
    expect(ownerOf(a)).toBeOk(Cl.some(Cl.principal(alice)));
  });

  it('rejects an input whose tier does not match the recipe', () => {
    const a = mintTo(alice, 1);
    const b = mintTo(alice, 1);
    const wrongTier = mintTo(alice, 2);

    expect(forge(1, [a, b, wrongTier], alice).result).toBeErr(ERR_BAD_INPUT);
    for (const id of [a, b, wrongTier]) {
      expect(ownerOf(id)).toBeOk(Cl.some(Cl.principal(alice)));
    }
  });

  it('rejects the same token supplied more than once', () => {
    // Otherwise one token could satisfy a three-input recipe.
    const a = mintTo(alice, 1);
    expect(forge(1, [a, a, a], alice).result).toBeErr(ERR_BAD_INPUT);
    expect(ownerOf(a)).toBeOk(Cl.some(Cl.principal(alice)));
  });

  it('rejects a nonexistent token id', () => {
    const a = mintTo(alice, 1);
    const b = mintTo(alice, 1);
    expect(forge(1, [a, b, 999], alice).result).toBeErr(ERR_BAD_INPUT);
    expect(ownerOf(a)).toBeOk(Cl.some(Cl.principal(alice)));
  });

  it('rejects an already-burned token', () => {
    const a = mintTo(alice, 1);
    const b = mintTo(alice, 1);
    const c = mintTo(alice, 1);
    expect(forge(1, [a, b, c], alice).result).toBeOk(Cl.uint(4));

    const d = mintTo(alice, 1);
    const e = mintTo(alice, 1);
    expect(forge(1, [d, e, a], alice).result).toBeErr(ERR_BAD_INPUT);
    expect(ownerOf(d)).toBeOk(Cl.some(Cl.principal(alice)));
  });
});

describe('forge: minter authorization', () => {
  it('cannot forge at all if the forge is not an authorized minter', () => {
    authorizeMinter(minter);
    createRecipe(1, 3, 2);
    // Deliberately NOT authorizing the forge contract.

    const ids = [mintTo(alice, 1), mintTo(alice, 1), mintTo(alice, 1)];
    const { result } = forge(1, ids, alice);
    // Fails at the first burn rather than the later mint: burn and mint share
    // the same authorization gate on character-loot-nft, and the burn comes
    // first. Surfaces as forge's own ERR-BAD-INPUT.
    expect(result).toBeErr(ERR_BAD_INPUT);

    // Nothing was consumed.
    for (const id of ids) {
      expect(ownerOf(id)).toBeOk(Cl.some(Cl.principal(alice)));
    }
  });

  it('cannot burn inputs if the forge loses authorization mid-life', () => {
    setup();
    const ids = [mintTo(alice, 1), mintTo(alice, 1), mintTo(alice, 1)];
    authorizeMinter(`${deployer}.${FORGE}`, false);

    expect(forge(1, ids, alice).result).toBeErr(ERR_BAD_INPUT);
    for (const id of ids) {
      expect(ownerOf(id)).toBeOk(Cl.some(Cl.principal(alice)));
    }
  });
});

import { Cl } from '@stacks/transactions';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectNoStxMovement, expectRevenueNotPool, sponsorPool, stx } from './helpers/revenue';

/**
 * forge-v2 tests.
 *
 * forge.test.ts already covers the burn/mint logic, which is byte-identical
 * here. What this file tests is the part that is new, and it is the part that
 * moves money:
 *
 *   - the forge fee lands with contract-owner and never touches sponsor-pool
 *     (via the shared `expectRevenueNotPool`, same as the mint price)
 *   - a failed forge costs nothing AND burns nothing - the fee and the burn
 *     succeed together or not at all
 *   - the fee scales with the recipe, at the launch ladder of 0.5 / 1 / 2 STX
 *   - a recipe with a zero fee is rejected at creation rather than shipped
 *     uncallable
 */

const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer')!; // CONTRACT-OWNER
const minter = accounts.get('wallet_1')!; // stands in for game-core as a mint source
const alice = accounts.get('wallet_2')!;
const bob = accounts.get('wallet_3')!;

const FORGE = 'forge-v2';
const NFT = 'character-loot-nft';

const ERR_NOT_OWNER = Cl.uint(300);
const ERR_RECIPE_NOT_FOUND = Cl.uint(301);
const ERR_WRONG_INPUT_COUNT = Cl.uint(302);
const ERR_BAD_INPUT = Cl.uint(303);
const ERR_BAD_RECIPE = Cl.uint(304);

/** The launch ladder: output tier 2 / 3 / 4 costs 0.5 / 1 / 2 STX. */
const FEE_TIER_2 = 500_000n;
const FEE_TIER_3 = stx(1);
const FEE_TIER_4 = stx(2);

// --- helpers ---

function authorizeMinter(who: string, allowed = true) {
  simnet.callPublicFn(NFT, 'set-minter', [Cl.principal(who), Cl.bool(allowed)], deployer);
}

function mintTo(recipient: string, tier: number): number {
  const { result } = simnet.callPublicFn(
    NFT,
    'mint',
    [Cl.principal(recipient), Cl.stringAscii(`ipfs://loot/t${tier}.json`), Cl.uint(tier)],
    minter,
  );
  return Number((result as unknown as { value: { value: bigint } }).value.value);
}

function createRecipe(options: {
  inputTier: number;
  inputCount: number;
  outputTier: number;
  fee: bigint;
  uri?: string;
  sender?: string;
}) {
  const { result } = simnet.callPublicFn(
    FORGE,
    'create-recipe',
    [
      Cl.uint(options.inputTier),
      Cl.uint(options.inputCount),
      Cl.uint(options.outputTier),
      Cl.stringAscii(options.uri ?? `ipfs://forged/tier-${options.outputTier}.json`),
      Cl.uint(options.fee),
    ],
    options.sender ?? deployer,
  );
  return result;
}

function forge(recipeId: number, tokenIds: number[], sender: string) {
  return simnet.callPublicFn(
    FORGE,
    'forge',
    [Cl.uint(recipeId), Cl.list(tokenIds.map((id) => Cl.uint(id)))],
    sender,
  );
}

function ownerOf(tokenId: number) {
  const { result } = simnet.callReadOnlyFn(NFT, 'get-owner', [Cl.uint(tokenId)], deployer);
  return result;
}

function recipeFee(recipeId: number): bigint | null {
  const { result } = simnet.callReadOnlyFn(FORGE, 'get-recipe-fee', [Cl.uint(recipeId)], deployer);
  const value = (result as unknown as { value?: { value: bigint } }).value;
  return value ? value.value : null;
}

/** Three tier-1 tokens owned by `who`, and a 3-for-1 recipe that consumes them. */
function setupForge(who: string, fee = FEE_TIER_2): { recipeId: number; tokens: number[] } {
  authorizeMinter(minter);
  authorizeMinter(`${deployer}.${FORGE}`);
  createRecipe({ inputTier: 1, inputCount: 3, outputTier: 2, fee });
  return { recipeId: 1, tokens: [mintTo(who, 1), mintTo(who, 1), mintTo(who, 1)] };
}

describe('the forge fee is revenue (the load-bearing invariant)', () => {
  it('sends the fee to contract-owner and never to sponsor-pool', async () => {
    const { recipeId, tokens } = setupForge(alice);

    const result = expectRevenueNotPool({
      payer: alice,
      owner: deployer,
      amountUstx: FEE_TIER_2,
      label: 'forge',
      call: () => forge(recipeId, tokens, alice),
    });

    expect(result).toBeOk(Cl.uint(4)); // the forged token, after the three inputs
    expect(ownerOf(4)).toBeOk(Cl.some(Cl.principal(alice)));
  });

  it('leaves a funded pool at exactly what the owner funded it with', async () => {
    // A zero pool would pass this test even if the fee were being credited to it.
    const { recipeId, tokens } = setupForge(alice);
    simnet.callPublicFn('game-core', 'fund-pool', [Cl.uint(stx(10))], deployer);

    expectRevenueNotPool({
      payer: alice,
      owner: deployer,
      amountUstx: FEE_TIER_2,
      label: 'forge (funded pool)',
      call: () => forge(recipeId, tokens, alice),
    });

    expect(sponsorPool(deployer)).toBe(stx(10));
  });

  it('charges each recipe its own fee, at the launch ladder', async () => {
    authorizeMinter(minter);
    authorizeMinter(`${deployer}.${FORGE}`);
    createRecipe({ inputTier: 1, inputCount: 3, outputTier: 2, fee: FEE_TIER_2 });
    createRecipe({ inputTier: 2, inputCount: 3, outputTier: 3, fee: FEE_TIER_3 });
    createRecipe({ inputTier: 3, inputCount: 3, outputTier: 4, fee: FEE_TIER_4 });

    expect(recipeFee(1)).toBe(FEE_TIER_2);
    expect(recipeFee(2)).toBe(FEE_TIER_3);
    expect(recipeFee(3)).toBe(FEE_TIER_4);

    for (const [recipeId, tier, fee] of [
      [1, 1, FEE_TIER_2],
      [2, 2, FEE_TIER_3],
      [3, 3, FEE_TIER_4],
    ] as const) {
      const tokens = [mintTo(bob, tier), mintTo(bob, tier), mintTo(bob, tier)];
      expectRevenueNotPool({
        payer: bob,
        owner: deployer,
        amountUstx: fee,
        label: `forge recipe ${recipeId}`,
        call: () => forge(recipeId, tokens, bob),
      });
    }
  });

  it('holds no STX balance of its own', async () => {
    const { recipeId, tokens } = setupForge(alice);
    forge(recipeId, tokens, alice);

    const held = simnet.getAssetsMap().get('STX')?.get(`${deployer}.${FORGE}`) ?? 0n;
    expect(held).toBe(0n);
  });
});

describe('a failed forge costs nothing and burns nothing', () => {
  it('charges no fee when the input count is wrong', async () => {
    const { recipeId, tokens } = setupForge(alice);

    expectNoStxMovement({
      principals: [alice, deployer],
      owner: deployer,
      label: 'forge with two inputs',
      call: () => forge(recipeId, tokens.slice(0, 2), alice),
    });

    // And every input survived.
    for (const id of tokens) expect(ownerOf(id)).toBeOk(Cl.some(Cl.principal(alice)));
  });

  it('charges no fee when an input belongs to someone else', async () => {
    const { recipeId } = setupForge(alice);
    const stolen = [mintTo(bob, 1), mintTo(bob, 1), mintTo(bob, 1)];

    expectNoStxMovement({
      principals: [alice, bob, deployer],
      owner: deployer,
      label: 'forge with borrowed inputs',
      call: () => forge(recipeId, stolen, alice),
    });

    expect(forge(recipeId, stolen, alice).result).toBeErr(ERR_BAD_INPUT);
    for (const id of stolen) expect(ownerOf(id)).toBeOk(Cl.some(Cl.principal(bob)));
  });

  it('charges no fee for a recipe that does not exist', async () => {
    setupForge(alice);

    expectNoStxMovement({
      principals: [alice, deployer],
      owner: deployer,
      label: 'forge with unknown recipe',
      call: () => forge(99, [1, 2, 3], alice),
    });
    expect(forge(99, [1, 2, 3], alice).result).toBeErr(ERR_RECIPE_NOT_FOUND);
  });

  it('reverts the fee when the burn fails, so tokens and STX move together', async () => {
    // The fee is charged before the burn. A burn failure after the transfer must
    // take the transfer with it - which Clarity's all-or-nothing transaction
    // semantics give us, and this is the test that proves we are relying on it
    // correctly rather than assuming it.
    const { recipeId, tokens } = setupForge(alice);
    // Revoke the forge's minting rights: burn-input will fail mid-fold, after
    // the fee has already transferred within this transaction.
    authorizeMinter(`${deployer}.${FORGE}`, false);

    expectNoStxMovement({
      principals: [alice, deployer],
      owner: deployer,
      label: 'forge with revoked minter',
      call: () => forge(recipeId, tokens, alice),
    });

    for (const id of tokens) expect(ownerOf(id)).toBeOk(Cl.some(Cl.principal(alice)));
  });
});

describe('recipe creation', () => {
  it('rejects a zero fee rather than shipping an uncallable recipe', async () => {
    // stx-transfer? fails on a zero amount, so a zero-fee recipe would look
    // valid and fail for every player who tried it.
    expect(createRecipe({ inputTier: 1, inputCount: 3, outputTier: 2, fee: 0n })).toBeErr(
      ERR_BAD_RECIPE,
    );
    expect(recipeFee(1)).toBeNull();
  });

  it('is owner-only', async () => {
    expect(
      createRecipe({ inputTier: 1, inputCount: 3, outputTier: 2, fee: FEE_TIER_2, sender: alice }),
    ).toBeErr(ERR_NOT_OWNER);
  });

  it('keeps the inherited config guards', async () => {
    // Same three checks forge.clar has; a v2 that dropped one would be a
    // regression hidden behind a new filename.
    expect(createRecipe({ inputTier: 0, inputCount: 3, outputTier: 2, fee: FEE_TIER_2 })).toBeErr(
      ERR_BAD_RECIPE,
    );
    expect(createRecipe({ inputTier: 1, inputCount: 6, outputTier: 2, fee: FEE_TIER_2 })).toBeErr(
      ERR_BAD_RECIPE,
    );
    expect(createRecipe({ inputTier: 2, inputCount: 3, outputTier: 2, fee: FEE_TIER_2 })).toBeErr(
      ERR_BAD_RECIPE,
    );
  });

  it('publishes the fee so a player can price a forge before signing', async () => {
    createRecipe({ inputTier: 1, inputCount: 3, outputTier: 2, fee: FEE_TIER_2 });
    const { result } = simnet.callReadOnlyFn(FORGE, 'get-recipe', [Cl.uint(1)], alice);
    expect(result).toBeSome(
      Cl.tuple({
        'input-tier': Cl.uint(1),
        'input-count': Cl.uint(3),
        'output-tier': Cl.uint(2),
        'output-uri': Cl.stringAscii('ipfs://forged/tier-2.json'),
        'stx-fee': Cl.uint(FEE_TIER_2),
      }),
    );
  });
});

describe('coexistence with the deployed forge', () => {
  it('does not share recipes with forge v1', async () => {
    // Both contracts exist on mainnet. Their state is separate, so a recipe id
    // means different things in each and the UI must target one explicitly.
    authorizeMinter(`${deployer}.${FORGE}`);
    createRecipe({ inputTier: 1, inputCount: 3, outputTier: 2, fee: FEE_TIER_2 });

    const { result } = simnet.callReadOnlyFn('forge', 'get-recipe', [Cl.uint(1)], deployer);
    expect(result).toBeNone();
  });

  it('leaves v1 unable to mint once its authorization is revoked', async () => {
    // The operator's migration step: v2 gets minting rights, v1 loses them.
    authorizeMinter(minter);
    authorizeMinter(`${deployer}.forge`, false);
    authorizeMinter(`${deployer}.${FORGE}`);

    simnet.callPublicFn(
      'forge',
      'create-recipe',
      [Cl.uint(1), Cl.uint(3), Cl.uint(2), Cl.stringAscii('ipfs://v1.json')],
      deployer,
    );
    const tokens = [mintTo(alice, 1), mintTo(alice, 1), mintTo(alice, 1)];

    const { result } = simnet.callPublicFn(
      'forge',
      'forge',
      [Cl.uint(1), Cl.list(tokens.map((id) => Cl.uint(id)))],
      alice,
    );
    expect(result).toBeErr(ERR_BAD_INPUT); // burn refused, fold short-circuits
    for (const id of tokens) expect(ownerOf(id)).toBeOk(Cl.some(Cl.principal(alice)));
  });
});

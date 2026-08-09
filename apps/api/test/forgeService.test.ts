/**
 * ForgeService tests.
 *
 * The load-bearing assertion here is a negative one: when the chain read fails,
 * `listRecipes()` must THROW rather than substitute the `SEED_RECIPES`
 * constants. A hardcoded ladder served as if it were chain state would recreate
 * exactly the "trust the UI" problem the on-chain recipe map exists to remove —
 * a player planning a forge against constants that no longer match the contract
 * would burn real NFTs on a recipe that doesn't exist.
 *
 * The rest guards partial-failure honesty: an unseeded forge is an empty list
 * and not an error, one malformed rung does not blank the ladder, and a nonsense
 * nonce cannot turn one request into thousands of chain calls.
 */

import { describe, expect, it } from 'vitest';
import { Cl, ClarityType, deserializeCV, type ClarityValue } from '@stacks/transactions';
import {
  CONTRACT_NAMES,
  FORGE_FEE_BY_OUTPUT_TIER,
  SEED_RECIPES,
  getNetworkConfig,
} from '@grimhallow/shared';
import { ForgeService } from '../src/services/forgeService.js';
import type { ApiError } from '../src/lib/errors.js';
import type { ChainClient, ChainTransaction, NftHolding } from '../src/lib/hiro.js';
import { unresolvedMintBlock, unsupportedChainWrites } from './helpers/chain.js';

function recipeTuple(input: {
  inputTier: number;
  inputCount: number;
  outputTier: number;
  outputUri: string;
  /** What `forge-v2` charges for this rung. Defaulted so the existing cases
   *  read as before; the fee's own behaviour is asserted separately. */
  stxFee?: bigint;
}): ClarityValue {
  return Cl.some(
    Cl.tuple({
      'input-tier': Cl.uint(input.inputTier),
      'input-count': Cl.uint(input.inputCount),
      'output-tier': Cl.uint(input.outputTier),
      'output-uri': Cl.stringAscii(input.outputUri),
      'stx-fee': Cl.uint(input.stxFee ?? 500_000n),
    }),
  );
}

class FakeChain implements ChainClient {
  lastRecipeId: ClarityValue = Cl.uint(0);
  /** Keyed by recipe id. A missing id answers `none`. */
  recipes = new Map<number, ClarityValue>();
  lastIdError: Error | null = null;
  recipeError: Error | null = null;
  /** Every `get-recipe` id requested, in order. */
  readonly recipeCalls: number[] = [];

  async getNftHoldings(): Promise<NftHolding[]> {
    return [];
  }

  async getTokenMetadata(): Promise<null> {
    return null;
  }

  async getBlockTimestamp(): Promise<number | null> {
    return null;
  }

  async getNftAcquisitionBlock(): Promise<number | null> {
    return null;
  }

  async callReadOnly(params: {
    functionName: string;
    functionArgsHex?: readonly string[];
  }): Promise<ClarityValue> {
    if (params.functionName === 'get-last-recipe-id') {
      if (this.lastIdError) throw this.lastIdError;
      return this.lastRecipeId;
    }
    if (params.functionName === 'get-recipe') {
      if (this.recipeError) throw this.recipeError;
      // Decoded from the argument rather than inferred from the call count, so
      // a test that asks for one specific id gets that id.
      const arg = params.functionArgsHex?.[0];
      const cv = arg ? deserializeCV(arg) : null;
      const id = cv && cv.type === ClarityType.UInt ? Number(cv.value) : NaN;
      this.recipeCalls.push(id);
      return this.recipes.get(id) ?? Cl.none();
    }
    throw new Error(`unexpected read-only call: ${params.functionName}`);
  }

  getTransaction: (txId: string) => Promise<ChainTransaction | null> =
    unsupportedChainWrites().getTransaction;
  broadcastRawTx: (rawTxHex: string) => Promise<string> = unsupportedChainWrites().broadcastRawTx;
  listContractCalls: ChainClient['listContractCalls'] = unsupportedChainWrites().listContractCalls;
  getNftMintBlock: ChainClient['getNftMintBlock'] = unresolvedMintBlock().getNftMintBlock;
}

const stacks = getNetworkConfig('devnet');

function makeService(chain: FakeChain): ForgeService {
  return new ForgeService({ chain, stacks });
}

describe('ForgeService.listRecipes', () => {
  it('reports an unseeded forge as an empty list, not an error', () => {
    // The contract deploys inert and `scripts/seed-contracts.mjs` creates the
    // recipes afterwards, so "none yet" is a real and temporary state.
    const chain = new FakeChain();
    chain.lastRecipeId = Cl.uint(0);

    return expect(makeService(chain).listRecipes()).resolves.toEqual([]);
  });

  it('mirrors the recipes the chain actually holds', async () => {
    const chain = new FakeChain();
    chain.lastRecipeId = Cl.uint(2);
    chain.recipes.set(1, recipeTuple({ inputTier: 1, inputCount: 3, outputTier: 2, outputUri: 'ipfs://epic' }));
    chain.recipes.set(2, recipeTuple({ inputTier: 2, inputCount: 3, outputTier: 3, outputUri: 'ipfs://mythic' }));

    const recipes = await makeService(chain).listRecipes();

    expect(recipes).toHaveLength(2);
    expect(recipes[0]).toMatchObject({
      id: 1,
      inputTier: 1,
      inputCount: 3,
      outputTier: 2,
      outputUri: 'ipfs://epic',
    });
    expect(recipes[0].inputTierName).toBeTruthy();
    expect(recipes[0].outputTierName).toBeTruthy();
    expect(recipes[1]).toMatchObject({ id: 2, inputTier: 2, outputTier: 3 });
  });

  it('THROWS rather than falling back to the SEED_RECIPES constants', async () => {
    // The single most important assertion in this file. Serving hardcoded
    // constants as if they were chain state is worse than serving nothing:
    // a player would plan a forge against a ladder we cannot vouch for.
    const chain = new FakeChain();
    chain.lastIdError = new Error('node unreachable');

    await expect(makeService(chain).listRecipes()).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('never returns the seed constants on a read failure, even partially', async () => {
    const chain = new FakeChain();
    chain.lastIdError = new Error('node unreachable');

    const err = await makeService(chain)
      .listRecipes()
      .then(
        () => null,
        (e: ApiError) => e,
      );

    expect(err).not.toBeNull();
    // Nothing resembling a recipe came back — the rejection carries no payload.
    expect(SEED_RECIPES.length).toBeGreaterThan(0); // guard: the constants do exist
  });

  it('skips one malformed rung rather than blanking the whole ladder', async () => {
    // The other rungs are still true and still plannable.
    const chain = new FakeChain();
    chain.lastRecipeId = Cl.uint(3);
    chain.recipes.set(1, recipeTuple({ inputTier: 1, inputCount: 3, outputTier: 2, outputUri: 'ipfs://a' }));
    // Recipe 2 is present but its input-tier is a string where a uint belongs.
    chain.recipes.set(
      2,
      Cl.some(
        Cl.tuple({
          'input-tier': Cl.stringAscii('nonsense'),
          'input-count': Cl.uint(3),
          'output-tier': Cl.uint(3),
          'output-uri': Cl.stringAscii('ipfs://b'),
        }),
      ),
    );
    chain.recipes.set(3, recipeTuple({ inputTier: 3, inputCount: 3, outputTier: 4, outputUri: 'ipfs://c' }));

    const recipes = await makeService(chain).listRecipes();

    expect(recipes.map((r) => r.id)).toEqual([1, 3]);
  });

  it('treats a gap in the id space as a skip, not a failure', async () => {
    const chain = new FakeChain();
    chain.lastRecipeId = Cl.uint(2);
    chain.recipes.set(2, recipeTuple({ inputTier: 2, inputCount: 3, outputTier: 3, outputUri: 'ipfs://b' }));
    // Id 1 answers `none`.

    const recipes = await makeService(chain).listRecipes();
    expect(recipes.map((r) => r.id)).toEqual([2]);
  });

  it('bounds the number of chain reads a nonsense nonce can trigger', async () => {
    // A corrupted or hostile node reporting a huge nonce must not turn one
    // request into thousands of chain calls.
    const chain = new FakeChain();
    chain.lastRecipeId = Cl.uint(100_000);

    await makeService(chain).listRecipes();

    expect(chain.recipeCalls.length).toBeLessThanOrEqual(32);
  });

  it('reads from forge-v2, not the deployed v1 and not the loot contract', async () => {
    // v1 is still on chain and still answers `get-recipe`, but it was never
    // authorised to mint and its recipes carry no fee. Reading it would quote a
    // price of nothing for a forge that cannot run.
    const chain = new FakeChain();
    chain.lastRecipeId = Cl.uint(1);
    chain.recipes.set(1, recipeTuple({ inputTier: 1, inputCount: 3, outputTier: 2, outputUri: 'ipfs://a' }));

    const seen: string[] = [];
    const original = chain.callReadOnly.bind(chain);
    chain.callReadOnly = async (params: {
      contractId?: string;
      functionName: string;
      functionArgsHex?: readonly string[];
    }) => {
      if (params.contractId) seen.push(params.contractId);
      return original(params);
    };

    await makeService(chain).listRecipes();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((id) => id.endsWith(`.${CONTRACT_NAMES.forgeV2}`))).toBe(true);
    expect(seen.some((id) => id.endsWith(`.${CONTRACT_NAMES.forge}`))).toBe(false);
  });
});

/**
 * The fee is the one field that must never be guessed.
 *
 * It goes straight into a `willSendEq` post-condition, so a value we invented is
 * a transaction that aborts after the player signed it — they pay a network fee
 * and get nothing. Every case below is therefore "refuse" rather than "default".
 */
describe('ForgeService and the forge fee', () => {
  it('reports the fee the chain holds, as a decimal string', async () => {
    const chain = new FakeChain();
    chain.lastRecipeId = Cl.uint(1);
    chain.recipes.set(
      1,
      recipeTuple({
        inputTier: 1,
        inputCount: 3,
        outputTier: 2,
        outputUri: 'ipfs://a',
        stxFee: 1_000_000n,
      }),
    );

    const [recipe] = await makeService(chain).listRecipes();
    // A string, not a number: uSTX is a Clarity uint and JSON loses precision
    // above 2^53, so every uSTX value crosses this boundary the same way.
    expect(recipe.stxFeeUstx).toBe('1000000');
    expect(typeof recipe.stxFeeUstx).toBe('string');
  });

  it('never quotes FORGE_FEE_BY_OUTPUT_TIER for a recipe missing its fee', async () => {
    // A v1-shaped tuple. The constant would produce a plausible-looking number
    // for output tier 2 — which is precisely the failure this rejects: the
    // constant is what the owner *seeds*, not what the chain *charges*.
    const chain = new FakeChain();
    chain.lastRecipeId = Cl.uint(1);
    chain.recipes.set(
      1,
      Cl.some(
        Cl.tuple({
          'input-tier': Cl.uint(1),
          'input-count': Cl.uint(3),
          'output-tier': Cl.uint(2),
          'output-uri': Cl.stringAscii('ipfs://a'),
        }),
      ),
    );

    const recipes = await makeService(chain).listRecipes();

    expect(recipes).toEqual([]);
    expect(FORGE_FEE_BY_OUTPUT_TIER[2]).toBeGreaterThan(0n); // guard: the constant exists
  });

  it('skips a rung whose fee is the wrong Clarity type', async () => {
    const chain = new FakeChain();
    chain.lastRecipeId = Cl.uint(2);
    chain.recipes.set(
      1,
      Cl.some(
        Cl.tuple({
          'input-tier': Cl.uint(1),
          'input-count': Cl.uint(3),
          'output-tier': Cl.uint(2),
          'output-uri': Cl.stringAscii('ipfs://a'),
          'stx-fee': Cl.stringAscii('free'),
        }),
      ),
    );
    chain.recipes.set(2, recipeTuple({ inputTier: 2, inputCount: 3, outputTier: 3, outputUri: 'ipfs://b' }));

    const recipes = await makeService(chain).listRecipes();
    expect(recipes.map((r) => r.id)).toEqual([2]);
  });
});

describe('ForgeService.requireRecipe', () => {
  it('returns the recipe when the chain has it', async () => {
    const chain = new FakeChain();
    chain.lastRecipeId = Cl.uint(1);
    chain.recipes.set(1, recipeTuple({ inputTier: 1, inputCount: 3, outputTier: 2, outputUri: 'ipfs://a' }));

    await expect(makeService(chain).requireRecipe(1)).resolves.toMatchObject({ id: 1 });
  });

  it('throws 503 for a recipe that does not exist', async () => {
    // Deliberately the same failure as an unreadable one: the player's next step
    // — sign nothing, try again — is identical, and guessing which happened
    // would be guessing.
    const chain = new FakeChain();

    await expect(makeService(chain).requireRecipe(7)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('throws rather than returning a zero fee when the read fails', async () => {
    const chain = new FakeChain();
    chain.recipeError = new Error('node unreachable');

    const err = await makeService(chain)
      .requireRecipe(1)
      .then(
        () => null,
        (e: ApiError) => e,
      );

    expect(err).not.toBeNull();
    expect(err?.statusCode).toBe(503);
    // Says plainly that nothing happened, because a forge that half-happened is
    // the thing a player reading this would be afraid of.
    expect(err?.message).toMatch(/nothing was burned/i);
  });
});

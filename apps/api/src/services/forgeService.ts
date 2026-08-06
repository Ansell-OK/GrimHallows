/**
 * Forge recipes + power-up inventory — 04-backend-api-spec.md#2 and #7.
 *
 * Everything here is a read of public chain state. The forge moves no STX at
 * all (it burns NFTs and mints one), so nothing in this module touches the
 * sponsor pool, a gate fee, or a signing key.
 *
 * RECIPES ARE MIRRORED, NOT AUTHORED. The recipe table lives on chain
 * precisely so a player can plan a forge without trusting a UI claim
 * (03-smart-contracts-spec.md#4). This service reads `get-last-recipe-id` and
 * then each `get-recipe`, and reports what it found. It does not fall back to
 * the `SEED_RECIPES` constants when a read fails: shipping a hardcoded ladder
 * that disagrees with chain state would recreate exactly the "trust the UI"
 * problem the on-chain map exists to remove.
 */

import {
  contractId as buildContractId,
  lootTierName,
  type ForgeRecipe,
  type NetworkConfig,
} from '@grimhallow/shared';
import { ClarityType, serializeCV, uintCV, type ClarityValue } from '@stacks/transactions';
import { upstreamUnavailable } from '../lib/errors.js';
import type { ChainClient } from '../lib/hiro.js';

export interface ForgeServiceDeps {
  readonly chain: ChainClient;
  readonly stacks: NetworkConfig;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * Recipe ids are assigned from a nonce starting at 1, so a bound is enough to
 * stop a nonsense read (a corrupted or hostile node reporting a huge nonce)
 * from turning one request into thousands of chain calls.
 */
const MAX_RECIPES_READ = 32;

function requireUint(value: ClarityValue | undefined, field: string): bigint {
  if (!value || value.type !== ClarityType.UInt) {
    throw new Error(`Expected ${field} to be a uint, got ${value?.type ?? 'nothing'}`);
  }
  return BigInt(value.value);
}

function requireAscii(value: ClarityValue | undefined, field: string): string {
  if (!value || value.type !== ClarityType.StringASCII) {
    throw new Error(`Expected ${field} to be a string-ascii, got ${value?.type ?? 'nothing'}`);
  }
  return value.value;
}

export class ForgeService {
  constructor(private readonly deps: ForgeServiceDeps) {}

  private get forgeId(): string {
    // forge-v2, not forge. v1 is still on chain and still readable, but it is
    // not authorized to mint (see scripts/seed-contracts.mjs) and its recipes
    // carry no fee, so reading it would quote a price of nothing for a forge
    // that cannot run.
    return buildContractId(this.deps.stacks, 'forgeV2');
  }

  /**
   * The recipe ladder as the chain currently holds it.
   *
   * An unseeded forge is an empty list, not an error: the contract deploys
   * inert and `scripts/seed-contracts.mjs` creates the recipes afterwards, so
   * "no recipes yet" is a real and temporary state worth rendering honestly.
   */
  async listRecipes(): Promise<ForgeRecipe[]> {
    let lastId: bigint;
    try {
      lastId = requireUint(
        await this.deps.chain.callReadOnly({
          contractId: this.forgeId,
          functionName: 'get-last-recipe-id',
        }),
        'get-last-recipe-id',
      );
    } catch (err) {
      // Refuse rather than substitute the seed constants. A recipe list that
      // does not come from chain is a claim, and the whole point of a public
      // recipe map is that players do not have to take our word for it.
      this.deps.log?.('could not read the forge recipe nonce', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw upstreamUnavailable(
        'The forge recipes could not be read from chain right now. Nothing was ' +
          'changed. Try again shortly.',
      );
    }

    if (lastId === 0n) return [];

    const bound = lastId > BigInt(MAX_RECIPES_READ) ? MAX_RECIPES_READ : Number(lastId);
    if (Number(lastId) > bound) {
      this.deps.log?.('forge recipe nonce exceeds the read bound; truncating', {
        lastRecipeId: lastId.toString(),
        readBound: bound,
      });
    }

    const recipes: ForgeRecipe[] = [];
    for (let id = 1; id <= bound; id++) {
      const recipe = await this.readRecipe(id);
      if (recipe) recipes.push(recipe);
    }
    return recipes;
  }

  /**
   * One recipe, or a thrown error — for the path that builds a transaction.
   *
   * `listRecipes` is allowed to skip a rung it cannot read, because the other
   * rungs are still true and a partial ladder is still plannable. Building a
   * payload is the opposite case: the fee goes into a post-condition, so a
   * recipe we cannot read exactly is one we must not quote at all. Same reason
   * `requirePaidDungeon` throws rather than defaulting the gate fee.
   */
  async requireRecipe(id: number): Promise<ForgeRecipe> {
    let recipe: ForgeRecipe | null;
    try {
      recipe = await this.readRecipe(id);
    } catch {
      recipe = null;
    }
    if (recipe) return recipe;

    // Deliberately one error for both "no such recipe" and "could not read it".
    // Distinguishing them here would mean guessing which happened, and the
    // player's next step — don't sign anything, try again — is the same either
    // way. The log line above `readRecipe` records which it actually was.
    throw upstreamUnavailable(
      `Recipe ${id} could not be read from chain. Nothing was burned and no ` +
        `transaction was prepared. Try again shortly.`,
    );
  }

  /** One recipe, or null when the id holds nothing or cannot be parsed. */
  private async readRecipe(id: number): Promise<ForgeRecipe | null> {
    try {
      const result = await this.deps.chain.callReadOnly({
        contractId: this.forgeId,
        functionName: 'get-recipe',
        functionArgsHex: [`0x${serializeCV(uintCV(id))}`],
      });

      // A gap in the id space is possible in principle and is not an error.
      if (result.type !== ClarityType.OptionalSome) return null;
      if (result.value.type !== ClarityType.Tuple) {
        throw new Error(`get-recipe returned ${result.value.type} inside the optional`);
      }

      const tuple = result.value.value;
      const inputTier = Number(requireUint(tuple['input-tier'], 'input-tier'));
      const outputTier = Number(requireUint(tuple['output-tier'], 'output-tier'));

      return {
        id,
        inputTier,
        inputTierName: lootTierName(inputTier),
        inputCount: Number(requireUint(tuple['input-count'], 'input-count')),
        outputTier,
        outputTierName: lootTierName(outputTier),
        outputUri: requireAscii(tuple['output-uri'], 'output-uri'),
        // Required, not defaulted. A recipe whose fee cannot be read is a recipe
        // we cannot price, and `0` would build a post-condition asserting the
        // player pays nothing while the contract charged the real amount — the
        // transaction would abort after signing. `requireUint` throws, which the
        // catch below turns into "skip this rung", which is the honest outcome.
        stxFeeUstx: requireUint(tuple['stx-fee'], 'stx-fee').toString(),
      };
    } catch (err) {
      // One malformed recipe must not blank the whole ladder — the other rungs
      // are still true and still plannable.
      this.deps.log?.('skipping a forge recipe that could not be read', {
        recipeId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

/**
 * The character shop's chain reads — 04-backend-api-spec.md#2.
 *
 * Two questions, both answered by `character-nft.clar` and neither by a
 * constant: what does a character cost right now, and are sales open?
 *
 * WHY NOT `CHARACTER_MINT_PRICE_USTX`. That constant is what the deploy script
 * *writes*; the contract's `mint-price` data-var is what the contract *charges*,
 * and the owner can change it with `set-mint-price` without redeploying
 * anything. Quoting the constant would eventually pin a post-condition at a
 * price the contract no longer charges — the player signs, the transaction
 * aborts, and they pay a network fee for our stale copy. Same rule as the gate
 * fee and the forge fee: the chain is the authority on every number that ends up
 * in a post-condition.
 *
 * A FAILED READ IS AN ERROR, NOT A DEFAULT. Every method here throws rather than
 * falling back, for the same reason `ForgeService.listRecipes` refuses to
 * substitute the seed constants.
 *
 * This service reads. It never builds a transaction, holds a key, or signs
 * anything — the mint is user-signed like every other money-moving call
 * (02-architecture.md ground rule).
 */

import {
  contractId as buildContractId,
  isCharClass,
  type CharClass,
  type NetworkConfig,
} from '@grimhallow/shared';
import { ClarityType, serializeCV, uintCV, type ClarityValue } from '@stacks/transactions';
import { upstreamUnavailable } from '../lib/errors.js';
import type { ChainClient } from '../lib/hiro.js';

export interface CharacterMintServiceDeps {
  readonly chain: ChainClient;
  readonly stacks: NetworkConfig;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/** What the shop needs to quote a mint. */
export interface MintQuote {
  /** `get-mint-price`, as a decimal string — see `ForgeRecipe.stxFeeUstx`. */
  readonly priceUstx: string;
  /** `is-mint-paused`. The owner's switch for stopping sales. */
  readonly paused: boolean;
}

export class CharacterMintService {
  constructor(private readonly deps: CharacterMintServiceDeps) {}

  private get nftId(): string {
    return buildContractId(this.deps.stacks, 'characterNft');
  }

  /**
   * The live price and pause state.
   *
   * Read together in one call because the shop needs both to decide what to
   * render, and because a price shown next to a stale "sales open" is worse
   * than either alone.
   */
  async quote(): Promise<MintQuote> {
    try {
      const [priceCv, pausedCv] = await Promise.all([
        this.deps.chain.callReadOnly({
          contractId: this.nftId,
          functionName: 'get-mint-price',
        }),
        this.deps.chain.callReadOnly({
          contractId: this.nftId,
          functionName: 'is-mint-paused',
        }),
      ]);

      if (priceCv.type !== ClarityType.UInt) {
        throw new Error(`get-mint-price returned ${priceCv.type}, expected a uint`);
      }
      if (pausedCv.type !== ClarityType.BoolTrue && pausedCv.type !== ClarityType.BoolFalse) {
        throw new Error(`is-mint-paused returned ${pausedCv.type}, expected a bool`);
      }

      return {
        priceUstx: BigInt(priceCv.value).toString(),
        paused: pausedCv.type === ClarityType.BoolTrue,
      };
    } catch (err) {
      this.deps.log?.('could not read the character mint price', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw upstreamUnavailable(
        'The character shop could not be read from chain right now. Nothing was ' +
          'changed and no transaction was prepared. Try again shortly.',
      );
    }
  }

  /**
   * The on-chain class of one of our character tokens, or null.
   *
   * Null covers every "not ours to answer" case — a token id that was never
   * minted, a malformed response, an unreachable node — because the caller's
   * next step is identical for all of them: fall through to the normal class
   * derivation. See `deriveClass`, which ignores an unrecognised value for the
   * same reason.
   *
   * Deliberately does NOT throw on a failed read. A character list that fails
   * entirely because one class lookup timed out would be a worse outcome than a
   * character shown with its contract-derived class — the class is cosmetic
   * until the player enters a dungeon, and by then this has been read again.
   */
  async mintedClass(tokenId: string): Promise<CharClass | null> {
    if (!/^\d+$/.test(tokenId)) return null;

    try {
      const result = await this.deps.chain.callReadOnly({
        contractId: this.nftId,
        functionName: 'get-character-class',
        functionArgsHex: [`0x${serializeCV(uintCV(BigInt(tokenId)))}`],
      });

      // `(ok (optional (string-ascii 16)))` — unwrap both layers before trusting
      // anything. A `none` is a token that does not exist in this collection.
      const inner: ClarityValue | undefined =
        result.type === ClarityType.ResponseOk ? result.value : undefined;
      if (!inner || inner.type !== ClarityType.OptionalSome) return null;
      if (inner.value.type !== ClarityType.StringASCII) return null;

      const classId = inner.value.value;
      // An unrecognised class id is ignored rather than trusted. The contract
      // rejects unknown ids at mint (ERR-BAD-CLASS), so seeing one here means
      // something upstream is wrong, and the safe reading of a value that should
      // be impossible is to not believe it.
      return isCharClass(classId) ? classId : null;
    } catch (err) {
      this.deps.log?.('could not read a character class; falling through to derivation', {
        tokenId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

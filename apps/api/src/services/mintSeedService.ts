/**
 * Resolves the seed that a minted character's rarity floor is rolled from.
 *
 * One question: for one of our own `character-nft` tokens, what was the hash of
 * the block that confirmed its mint? That value goes into `deriveCharacter` as
 * `mintSeed` and nowhere else, and `mintFloorFromSeed`
 * (packages/shared/src/rarity.ts) turns it into the token's floor.
 *
 * WHY A SEED FROM CHAIN AT ALL. The floor used to be a pure function of
 * `(contractId, tokenId)`, which is precomputable: `character-nft` issues
 * sequential ids and `get-last-token-id` is public, so anyone could hash
 * `lastId + 1` off chain, learn their floor before paying, and mint only when it
 * came up Rare. The published 60/30/10 table would then describe nobody's real
 * odds. A block hash closes that: it does not exist when the transaction is
 * signed, and the minter does not choose which block includes them.
 *
 * A MISS IS NOT AN ERROR. Every method returns null rather than throwing, and null
 * means "derive with no floor" (stats.ts `effectiveRarity`) — the same degrade
 * 02-architecture.md#4 applies to holder age. A just-minted token whose mint is
 * still in the mempool has no resolvable seed yet, and that is the common case, not
 * a fault. The player sees their character at its tenure rarity for a block or two
 * and then sees it corrected upward, which is the safe direction to be wrong in.
 * Guessing a seed would be worse than having none: the floor would change once the
 * real one landed.
 *
 * It never signs, never writes to chain, and holds no key.
 */

import { parseAssetIdentifier, type ChainClient } from '../lib/hiro.js';
import type { MintSeedRepo } from '../repos/mintSeeds.js';

export interface MintSeedServiceDeps {
  readonly chain: ChainClient;
  readonly repo: MintSeedRepo;
  /**
   * Asset identifier of our character collection, e.g.
   * `SP...character-nft::grimhallow-character`. Passed in rather than rebuilt here
   * so the caller's notion of "our collection" and this one cannot drift.
   */
  readonly assetIdentifier: string;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

export class MintSeedService {
  constructor(private readonly deps: MintSeedServiceDeps) {}

  /** The contract this service answers for; anything else gets null. */
  private get contractId(): string | null {
    return parseAssetIdentifier(this.deps.assetIdentifier)?.contractId ?? null;
  }

  /**
   * The seed for a token, from cache or chain, or null if it cannot be resolved.
   *
   * Cache first, and the cached row is trusted without revalidation — see
   * `nft_mint_seeds`, where permanence is the point rather than a saving.
   *
   * Refuses a token from any other contract. The floor exists only for our own
   * mints (`classSource === 'mint'`), and a seed resolved for a curated-collection
   * token would be a value that has no business existing: a caller that then
   * passed it on would give eight collections a floor they are specified not to
   * have, and break v4's byte-for-byte agreement with v3 for those tokens.
   */
  async forToken(contractId: string, tokenId: string): Promise<string | null> {
    if (!this.contractId || contractId !== this.contractId) return null;
    if (!/^\d+$/.test(tokenId)) return null;

    const cached = await this.deps.repo.get(contractId, tokenId).catch(() => null);
    if (cached) return cached.mintSeed;

    const block = await this.deps.chain
      .getNftMintBlock({ assetIdentifier: this.deps.assetIdentifier, tokenId })
      .catch(() => null);
    if (!block) {
      this.deps.log?.('mint seed unresolved; deriving with no rarity floor', {
        contractId,
        tokenId,
      });
      return null;
    }

    // A write failure must not cost the caller the floor it just resolved: the
    // seed in hand is already correct, and the next request re-resolves it.
    await this.deps.repo
      .put({
        contractId,
        tokenId,
        mintBlockHeight: block.height,
        mintSeed: block.hash,
      })
      .catch(() => {});

    return block.hash;
  }
}

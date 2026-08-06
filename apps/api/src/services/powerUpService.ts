/**
 * Power-up NFTs a wallet holds — 04-backend-api-spec.md#2.
 *
 *   GET /characters/:contractId/:tokenId/power-ups
 *
 * TIER COMES FROM THE CHAIN, NOT FROM METADATA. Each holding's tier is read
 * with `get-token-tier`, which reads `character-loot-nft`'s on-chain
 * `token-metadata` map. The metadata URI is reported alongside it as flavour
 * and is never consulted for a number: 01-game-design.md#6 requires that
 * rewriting a JSON file cannot change what an item does, and the only way to
 * guarantee that is to never read one for a bonus.
 *
 * The bonus itself is `powerUpBonus(tier)` from `@grimhallow/shared` — the same
 * function the combat resolver applies and any verification tool would call.
 * This service formats it for display; it does not compute it.
 */

import {
  contractId as buildContractId,
  describeDiceUpgrade,
  getPower,
  isValidPowerUpTier,
  powerUpBonus,
  type NetworkConfig,
  type PowerUpNft,
} from '@grimhallow/shared';
import { ClarityType, serializeCV, uintCV } from '@stacks/transactions';
import type { ChainClient } from '../lib/hiro.js';

/** Bound on concurrent tier reads, matching CharacterService's metadata bound. */
const TIER_CONCURRENCY = 6;

export interface PowerUpServiceDeps {
  readonly chain: ChainClient;
  readonly stacks: NetworkConfig;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/** A power-up with its bonus resolved against one specific power. */
export interface EquippablePowerUp extends PowerUpNft {
  readonly tierName: string;
  readonly summary: string;
  readonly defenseBonus: number;
}

/**
 * A chosen loadout that does not check out on chain.
 *
 * Its own class so routes can map it to a 400 rather than a 500: a wallet that
 * does not hold what it asked to equip is a bad request, not a server fault.
 */
export class PowerUpOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PowerUpOwnershipError';
  }
}

export class PowerUpService {
  constructor(private readonly deps: PowerUpServiceDeps) {}

  private get lootId(): string {
    return buildContractId(this.deps.stacks, 'characterLootNft');
  }

  /**
   * Every power-up the wallet holds, described against `basePowerId`.
   *
   * The character the power-ups would be equipped on determines how the dice
   * upgrade reads (`1d6->1d8` against a Rogue's Quick Cut, `1d8->1d10` against
   * a Warrior's Strike), so the caller passes the power it wants described.
   * The underlying bonus is the same either way — only the rendering differs.
   */
  async listForAddress(address: string, basePowerId: string | null): Promise<EquippablePowerUp[]> {
    const holdings = await this.deps.chain.getNftHoldings(address);
    const ours = holdings.filter((h) => h.contractId === this.lootId);

    const baseFormula = basePowerId ? (getPower(basePowerId)?.diceFormula ?? null) : null;

    const results: EquippablePowerUp[] = [];
    for (let i = 0; i < ours.length; i += TIER_CONCURRENCY) {
      const batch = ours.slice(i, i + TIER_CONCURRENCY);
      const resolved = await Promise.all(
        batch.map((h) => this.describeOne(h.tokenId, basePowerId, baseFormula)),
      );
      results.push(...resolved.filter((r): r is EquippablePowerUp => r !== null));
    }

    // Best first, then by token id, so the list is stable between reloads.
    return results.sort(
      (a, b) => b.tier - a.tier || Number(a.tokenId) - Number(b.tokenId),
    );
  }

  /**
   * Resolve the tiers of a chosen loadout, verifying ownership on chain.
   *
   * THE CLIENT SENDS TOKEN IDS, NEVER TIERS. A tier is what decides how much
   * extra damage a run deals, so accepting one from a request would let a player
   * equip a legendary bonus on a token they do not hold — or on no token at all.
   * Both facts are read here: holdings come from the chain, and each tier comes
   * from `get-token-tier` on the token itself.
   *
   * Throws on any id the wallet does not hold or whose tier cannot be read.
   * Silently dropping one would start the run with a weaker loadout than the
   * player chose and charge them for it.
   */
  async resolveEquippedTiers(
    address: string,
    tokenIds: readonly string[],
  ): Promise<number[]> {
    if (tokenIds.length === 0) return [];

    const holdings = await this.deps.chain.getNftHoldings(address);
    const held = new Set(
      holdings.filter((h) => h.contractId === this.lootId).map((h) => h.tokenId),
    );

    const missing = tokenIds.filter((id) => !held.has(id));
    if (missing.length > 0) {
      throw new PowerUpOwnershipError(
        `Power-up ${missing.map((id) => `#${id}`).join(', ')} is not held by ${address}`,
      );
    }

    const tiers: number[] = [];
    for (let i = 0; i < tokenIds.length; i += TIER_CONCURRENCY) {
      const batch = tokenIds.slice(i, i + TIER_CONCURRENCY);
      const resolved = await Promise.all(batch.map((id) => this.readTier(id)));
      resolved.forEach((tier, n) => {
        if (tier === null) {
          throw new PowerUpOwnershipError(
            `Could not read the on-chain tier of power-up #${batch[n]}`,
          );
        }
        tiers.push(tier);
      });
    }

    // Sorted so a loadout's stored tier list is a function of the *set* chosen,
    // not of the order a UI happened to list it in. Bonuses sum, so this cannot
    // change the fight — it only makes two identical loadouts store identically.
    return tiers.sort((a, b) => a - b);
  }

  private async describeOne(
    tokenId: string,
    basePowerId: string | null,
    baseFormula: string | null,
  ): Promise<EquippablePowerUp | null> {
    const tier = await this.readTier(tokenId);
    if (tier === null) return null;

    const bonus = powerUpBonus(tier);
    return {
      contractId: this.lootId,
      tokenId,
      tier,
      tierName: bonus.tierName,
      grantedPowerId: basePowerId,
      diceFormulaBonus: describeDiceUpgrade(baseFormula, tier),
      // Every power-up in this collection is minted by either `game-core` (a
      // dungeon reward) or `forge`. Distinguishing them needs the mint tx, which
      // the indexer backfills in Phase 7; until then a reward is the honest
      // default, since forging cannot happen before rewards exist.
      mintedVia: 'dungeon_reward',
      metadataUri: await this.readUri(tokenId),
      summary: bonus.summary,
      defenseBonus: bonus.defenseBonus,
    };
  }

  /** On-chain tier, or null when it cannot be read or is out of range. */
  private async readTier(tokenId: string): Promise<number | null> {
    try {
      const result = await this.deps.chain.callReadOnly({
        contractId: this.lootId,
        functionName: 'get-token-tier',
        functionArgsHex: [`0x${serializeCV(uintCV(BigInt(tokenId)))}`],
      });

      if (result.type !== ClarityType.OptionalSome) return null;
      if (result.value.type !== ClarityType.UInt) return null;

      const tier = Number(result.value.value);
      if (!isValidPowerUpTier(tier)) {
        // A tier the bonus table cannot price. Dropping it is better than
        // guessing: an item shown with the wrong bonus is worse than one not
        // shown at all.
        this.deps.log?.('power-up has a tier outside the known range', { tokenId, tier });
        return null;
      }
      return tier;
    } catch (err) {
      this.deps.log?.('could not read a power-up tier', {
        tokenId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Flavour only — never read for a number. Null if unreadable. */
  private async readUri(tokenId: string): Promise<string | null> {
    try {
      const result = await this.deps.chain.callReadOnly({
        contractId: this.lootId,
        functionName: 'get-token-uri',
        functionArgsHex: [`0x${serializeCV(uintCV(BigInt(tokenId)))}`],
      });

      // `get-token-uri` is SIP-009: `(response (optional (string-ascii 256)) uint)`.
      const inner = result.type === ClarityType.ResponseOk ? result.value : result;
      if (inner.type !== ClarityType.OptionalSome) return null;
      if (inner.value.type !== ClarityType.StringASCII) return null;
      return inner.value.value;
    } catch {
      return null;
    }
  }
}

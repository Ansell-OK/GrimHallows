/**
 * Power-up NFTs a wallet holds — 04-backend-api-spec.md#2.
 *
 *   GET /characters/:contractId/:tokenId/power-ups
 *
 * EVERY NUMBER COMES FROM THE CHAIN, NOT FROM A DOCUMENT. A holding's tier is
 * read with `get-token-tier` and its archetype is parsed out of the URI STRING
 * returned by `get-token-uri`. Both live in `character-loot-nft`'s on-chain
 * `token-metadata` map, are written once inside `mint`, and have no setter.
 *
 * THE JSON DOCUMENT AT THAT URI IS STILL NEVER FETCHED, and the distinction is
 * the whole reason this is allowed: 01-game-design.md#6 requires that rewriting a
 * pinned file cannot change what an item does, and the only way to guarantee that
 * is to never read one for a bonus. Parsing the string the contract stores is not
 * reading the document it names — see the header of `lootArchetypes.ts`, which
 * makes the argument in full, including the counterargument.
 *
 * The bonus itself is `archetypeBonusVector(archetype, tier)` from
 * `@grimhallow/shared` — the same table the combat resolver applies and any
 * verification tool would call. This service formats it for display; it does not
 * compute it.
 */

import {
  MAX_EQUIPPED_POWER_UPS,
  archetypeBonusVector,
  archetypeTierName,
  contractId as buildContractId,
  compareEquippedItems,
  describeDiceUpgrade,
  getPower,
  isValidPowerUpTier,
  lootDisplayName,
  parseLootUri,
  toEquippedItem,
  type EquippedItem,
  type NetworkConfig,
  type PowerUpNft,
} from '@grimhallow/shared';
import { ClarityType, serializeCV, uintCV } from '@stacks/transactions';
import type { ChainClient } from '../lib/hiro.js';

/** Bound on concurrent chain reads, matching CharacterService's metadata bound. */
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
  /** Added to the holder's max (and starting) HP while equipped. */
  readonly maxHpBonus: number;
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

/**
 * One token's on-chain facts: the two fields `token-metadata` holds.
 *
 * Read together, always. They used to be read separately because only `tier` was
 * load-bearing and the uri was decoration; now the uri carries the archetype, and
 * a token described from one without the other would be described wrong.
 */
interface TokenFacts {
  readonly tier: number;
  readonly uri: string | null;
  readonly archetype: string;
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
   * Resolve a chosen loadout into equipped items, verifying ownership on chain.
   *
   * THE CLIENT SENDS TOKEN IDS, NEVER TIERS OR ARCHETYPES. Both decide how much
   * damage a run deals, so accepting either from a request would let a player
   * equip a legendary sword's bonus on a token they do not hold — or on no token
   * at all. Every fact here is read from the chain: holdings from the wallet,
   * tier from `get-token-tier`, archetype from the uri `get-token-uri` returns.
   *
   * Throws on any id the wallet does not hold or whose facts cannot be read.
   * Silently dropping one would start the run with a weaker loadout than the
   * player chose and charge them for it.
   */
  async resolveEquippedItems(
    address: string,
    tokenIds: readonly string[],
  ): Promise<EquippedItem[]> {
    if (tokenIds.length === 0) return [];

    // Checked here rather than only at the route, because this is the function
    // that decides what a run's dice are. The pure engine's dice-budget proof
    // (`MAX_DAMAGE_DICE`) assumes a loadout is at most this long, and overrunning
    // it throws mid-combat and aborts a run the player has already paid for.
    if (tokenIds.length > MAX_EQUIPPED_POWER_UPS) {
      throw new PowerUpOwnershipError(
        `A character may equip at most ${MAX_EQUIPPED_POWER_UPS} power-ups; got ${tokenIds.length}`,
      );
    }

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

    const items: EquippedItem[] = [];
    for (let i = 0; i < tokenIds.length; i += TIER_CONCURRENCY) {
      const batch = tokenIds.slice(i, i + TIER_CONCURRENCY);
      const resolved = await Promise.all(batch.map((id) => this.readFacts(id)));
      resolved.forEach((facts, n) => {
        if (facts === null) {
          throw new PowerUpOwnershipError(
            `Could not read the on-chain tier of power-up #${batch[n]}`,
          );
        }
        items.push(toEquippedItem(facts.archetype, facts.tier));
      });
    }

    // Sorted so a loadout's stored item list is a function of the *set* chosen,
    // not of the order a UI happened to list it in. Bonuses are summed before
    // they are applied, so this cannot change the fight — it only makes two
    // identical loadouts store identically. The comparator moved into `shared`
    // when a tier stopped being a complete description of an item.
    return items.sort(compareEquippedItems);
  }

  private async describeOne(
    tokenId: string,
    basePowerId: string | null,
    baseFormula: string | null,
  ): Promise<EquippablePowerUp | null> {
    const facts = await this.readFacts(tokenId);
    if (facts === null) return null;

    const item = toEquippedItem(facts.archetype, facts.tier);
    const vector = archetypeBonusVector(item.archetype, item.tier);
    return {
      contractId: this.lootId,
      tokenId,
      tier: facts.tier,
      archetype: item.archetype,
      name: lootDisplayName(item.archetype, item.tier, tokenId),
      tierName: archetypeTierName(item.tier),
      // What the ITEM grants, not what the character was already going to cast.
      // This used to echo the caller's `basePowerId`, which made every power-up
      // in the list claim to grant the power it was merely being described
      // against — harmless while nothing granted anything, and wrong the moment
      // `elixir` did.
      grantedPowerId: vector.grantsPowerId,
      diceFormulaBonus: describeDiceUpgrade(baseFormula, item),
      // Every power-up in this collection is minted by either `game-core` (a
      // dungeon reward) or `forge`. Distinguishing them needs the mint tx, which
      // the indexer backfills in Phase 7; until then a reward is the honest
      // default, since forging cannot happen before rewards exist.
      mintedVia: 'dungeon_reward',
      metadataUri: facts.uri,
      summary: describeVector(vector),
      defenseBonus: vector.defenseBonus,
      maxHpBonus: vector.maxHp,
    };
  }

  /**
   * Both on-chain fields for a token, or null when the tier cannot be trusted.
   *
   * The two reads are issued together rather than sequentially: they are
   * independent, and a loadout of three already costs three round trips per
   * field. `describeOne` previously read the uri anyway, so listing a wallet's
   * holdings costs exactly what it did before.
   *
   * A FAILED URI READ IS NOT FATAL, a failed tier read is. An unreadable uri
   * yields `relic`, which is what the token would have been before archetypes
   * existed — playable, and honest about what we know. An unreadable or
   * out-of-range tier has no such safe default, because tier is the axis the
   * whole bonus table is indexed by.
   */
  private async readFacts(tokenId: string): Promise<TokenFacts | null> {
    const [tier, uri] = await Promise.all([this.readTier(tokenId), this.readUri(tokenId)]);
    if (tier === null) return null;

    const parsed = parseLootUri(uri);
    if (uri !== null && parsed.tier !== tier) {
      // The uri encodes a tier too, and the two disagreeing means one of them was
      // written wrong at mint. `get-token-tier` wins — it is what `forge-v2`
      // validates against and what the contract range-checks — but the
      // disagreement is logged, because it can only have come from our own mint
      // path and is not otherwise visible.
      this.deps.log?.('power-up uri tier disagrees with get-token-tier', {
        tokenId,
        uri,
        uriTier: parsed.tier,
        chainTier: tier,
      });
    }
    return { tier, uri, archetype: parsed.slug };
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

  /**
   * The on-chain uri STRING. Null if unreadable.
   *
   * No longer "flavour only": `parseLootUri` reads the archetype out of this,
   * which is a number-bearing field. What has not changed is that the document
   * this string names is never fetched — see the module header.
   */
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

/**
 * Player-facing one-liner for a bonus vector, e.g. `+2 Defense, +20 Max HP`.
 *
 * Generated from the vector rather than stored beside it. The tier-only table
 * carried a hand-written `summary` per tier, which worked while there were four
 * strings to keep honest; there are now 52 vectors, and a hand-written line that
 * drifts from its numbers is a UI that lies about what an item does.
 */
function describeVector(vector: ReturnType<typeof archetypeBonusVector>): string {
  const parts: string[] = [];
  if (vector.dieSizeSteps) {
    parts.push(`Damage dice +${vector.dieSizeSteps} size${vector.dieSizeSteps > 1 ? 's' : ''}`);
  }
  if (vector.extraDice) parts.push(`+${vector.extraDice} ${vector.extraDice > 1 ? 'dice' : 'die'}`);
  if (vector.flatDamage) parts.push(`+${vector.flatDamage} damage`);
  if (vector.defenseBonus) parts.push(`+${vector.defenseBonus} Defense`);
  if (vector.maxHp) parts.push(`+${vector.maxHp} Max HP`);
  if (vector.grantsPowerId) parts.push(`grants ${getPower(vector.grantsPowerId)?.name ?? 'a power'}`);
  // Unreachable for every catalogued vector — each costs its full tier budget,
  // so at least one axis is non-zero — but a fallback beats an empty card.
  return parts.length > 0 ? parts.join(', ') : 'No mechanical bonus';
}

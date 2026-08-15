/**
 * Power-up NFTs: what an equipped item actually grants.
 *
 * 01-game-design.md#6 fixes the principle and leaves the numbers open. The
 * principle is the load-bearing part and is not tunable:
 *
 *   NEVER KEY A NUMBER OFF ANYTHING A PLAYER CAN CHANGE AFTER MINT.
 *
 * That rule used to be written as "the bonus keys off the on-chain `tier`, never
 * off metadata", and the numbers came from `tier` alone. They now come from
 * `(archetype, tier)`, where archetype is parsed out of the token's on-chain uri
 * STRING (`parseLootUri`). This is a widening of the rule's *implementation*, not
 * a weakening of the rule, and the distinction is worth stating because the old
 * wording reads like a prohibition on exactly this change:
 *
 *   - The `uri` string is written once, inside `character-loot-nft.mint`, by our
 *     own code, and is immutable for life — no setter, no base-uri. Identical
 *     mutability profile to `tier`, which sits in the same map entry.
 *   - `mint` is `contract-caller`-gated to game-core and forge, so a player
 *     cannot call it and cannot choose what the string says.
 *   - The JSON DOCUMENT at that uri is a different thing entirely: it lives on a
 *     host, it is mutable by whoever controls that host, and it remains flavour.
 *     **Nothing here ever fetches it.** Rewriting a pinned document still cannot
 *     change a single die.
 *
 * The asymmetry that survives: `tier` is a `uint` the contract range-checks,
 * while a `(string-ascii 256)` is 256 bytes `mint` never inspects. We supply the
 * closure the contract does not — a fixed registry, a total parser that degrades
 * to `relic`, and a round-trip property test over the full cross-product — so an
 * unexpected string yields today's legacy item rather than an unpriced one.
 *
 * The numbers below ARE tunable and are marked as such. No doc specifies them
 * and 07's open question #6 covers only recipe design, so they are set here as
 * a coherent starting ladder rather than picked silently per-call site. They
 * get the same treatment as `JACKPOT_AMOUNT_USTX`: one constant, one place.
 *
 * SIGNED OFF as written — the ladder and the equip cap were reviewed together
 * and approved for mainnet play. Retuning either is still a normal change; it
 * just needs `POWER_UP_ALGO_VERSION` bumped with it, so a run resolved under the
 * old numbers keeps pointing at the table that resolved it.
 *
 * Bonuses are expressed as a transform on a power's dice formula because
 * 01-game-design.md#5 makes dice size and count "the primary way powers
 * differentiate themselves" — an upgrade a player can see on the die itself,
 * not a hidden multiplier applied after the roll.
 */

import { formatDiceFormula, parseDiceFormula, type DiceFormula, type DiceSides } from './dice.js';
import { MAX_POWER_UP_TIER } from './contracts.js';
import { lootTierName, type LootTierName } from './rewards.js';
import {
  DEFAULT_ARCHETYPE,
  archetypeBonusVector,
  type ArchetypeBonusVector,
  type EquippedItem,
} from './lootArchetypes.js';

/**
 * Version of the item→bonus table.
 *
 * Bumped whenever a number below changes. A stored run references the version
 * that resolved it, so retuning the ladder cannot silently rewrite what an old
 * run's dice meant.
 *
 * v1 → v2: the table changed shape from tier-only to (archetype, tier). This
 * bump is observably a NO-OP for every token that exists: each one parses to
 * `relic`, whose per-tier vector is byte-identical to the v1 `BONUSES` array
 * (pinned by a test that reads the real `BONUSES` rather than a copy of it).
 * The version is not persisted and `toVerification` does not publish it, so the
 * bump invalidates nothing — it records that the table's *domain* grew.
 */
export const POWER_UP_ALGO_VERSION = 'powerup-v2' as const;

/**
 * How many power-ups one character may equip for a single run. TUNABLE.
 *
 * A cap exists for balance rather than for safety: bonuses sum, so an uncapped
 * equip lets a player who has hoarded twenty legendaries walk into a starter
 * dungeon rolling dice no monster table was tuned against. Three is enough to
 * make the forge ladder worth climbing without letting accumulation replace the
 * fight.
 *
 * It is also well under the derivation stride's hard ceiling (`MAX_DAMAGE_DICE`
 * in encounter.ts), so a legal loadout can never overrun a turn's dice budget
 * and abort a run mid-combat. That ceiling is the safety net; this is the
 * design decision, and it is approved at 3 alongside the ladder below.
 *
 * The worst legal case that approval accepts: three legendaries on a 1d8 power
 * roll 4d12+9 at +9 Defense.
 */
export const MAX_EQUIPPED_POWER_UPS = 3;

/**
 * Ceiling on the summed Defense DC bonus from a whole loadout. NOT TUNABLE
 * UPWARD without re-deriving the argument below.
 *
 * THIS IS A CORRECTNESS CEILING, NOT A BALANCE KNOB. A player whose Defense DC
 * exceeds the highest attack roll in the game is not merely strong — they are
 * unhittable, and an unhittable character does not stall out and lose on
 * `MAX_TURNS`. They kill the monsters slowly and **win every time**. Paired with
 * a 100% loot drop rate that is an infinite loot printer.
 *
 * The arithmetic: the strongest monster has `str: 25` (`monsters.ts`), so
 * `statModifier(25) = 7` and the maximum possible monster attack roll is
 * `20 + 7 = 27`. Player Defense is `10 + floor(vit/2)` plus this bonus.
 *
 * NINE IS EXACTLY TODAY'S MAXIMUM — three tier-4 items at +3 each — so this
 * clamp is provably a no-op for every loadout expressible under `powerup-v1`,
 * which is why introducing it does not force an encounter-version bump. It is
 * pinned by an exhaustive test over every multiset of <= 3 tiers.
 *
 * The archetype table makes the clamp necessary rather than theoretical: `boots`
 * grants +5 at tier 4, so a triple-boots stack would reach +15 and drop the
 * lockout threshold to `vit >= 6` — essentially every character.
 */
export const MAX_TOTAL_DEFENSE_BONUS = 9;

/**
 * Ceiling on the summed max-HP bonus from a whole loadout. TUNABLE.
 *
 * A new axis with no history, so this number is free to choose rather than
 * derived from what already shipped. Three tier-4 `chestplate`s would grant +90,
 * which does not break anything the way unhittability does — it just makes a
 * fight long. 60 keeps a full tank stack meaningfully durable while leaving
 * monsters able to finish it.
 */
export const MAX_TOTAL_MAXHP_BONUS = 60;

/**
 * Damage dice ladder. A step up moves one place right.
 *
 * d20 is deliberately absent: it is the attack-roll die (01-game-design.md#5),
 * and letting a damage die reach it would make a legendary power-up's damage
 * roll indistinguishable from an attack roll in the log.
 */
export const DAMAGE_DIE_LADDER: readonly DiceSides[] = [4, 6, 8, 10, 12];

/** What one tier grants. TUNABLE — see the module note. */
export interface PowerUpBonus {
  readonly tier: number;
  readonly tierName: LootTierName;
  /** Places to move right along `DAMAGE_DIE_LADDER`, e.g. 1 turns d6 into d8. */
  readonly dieSizeSteps: number;
  /** Extra dice added to the count, e.g. 1 turns 1d8 into 2d8. */
  readonly extraDice: number;
  /** Flat bonus added to every damage roll this power makes. */
  readonly flatDamage: number;
  /** Added to the holder's Defense DC while equipped. */
  readonly defenseBonus: number;
  /** Player-facing summary, e.g. "Damage dice +1 size". */
  readonly summary: string;
}

/**
 * TUNABLE. The ladder is monotonic by tier and deliberately modest: a legendary
 * power-up roughly doubles a base power's damage, it does not replace the game.
 * Tuned against the starter kit in `powers.ts`, where base damage runs 1d6–2d8.
 */
const BONUSES: readonly Omit<PowerUpBonus, 'tier' | 'tierName'>[] = [
  // Tier 1 — rare
  { dieSizeSteps: 1, extraDice: 0, flatDamage: 0, defenseBonus: 0, summary: 'Damage dice +1 size' },
  // Tier 2 — epic
  { dieSizeSteps: 1, extraDice: 0, flatDamage: 2, defenseBonus: 1, summary: 'Damage dice +1 size, +2 damage, +1 Defense' },
  // Tier 3 — mythic
  { dieSizeSteps: 2, extraDice: 0, flatDamage: 2, defenseBonus: 2, summary: 'Damage dice +2 sizes, +2 damage, +2 Defense' },
  // Tier 4 — legendary
  { dieSizeSteps: 2, extraDice: 1, flatDamage: 3, defenseBonus: 3, summary: 'Damage dice +2 sizes and +1 die, +3 damage, +3 Defense' },
];

if (BONUSES.length !== MAX_POWER_UP_TIER) {
  // A tier the chain can mint but the table cannot price would resolve a run
  // with a silently absent bonus. Fail at import instead.
  throw new Error(
    `Power-up bonus table has ${BONUSES.length} entries but MAX_POWER_UP_TIER is ${MAX_POWER_UP_TIER}`,
  );
}

export function isValidPowerUpTier(tier: number): boolean {
  return Number.isInteger(tier) && tier >= 1 && tier <= MAX_POWER_UP_TIER;
}

/** What a tier grants. Throws on a tier the chain should never have minted. */
export function powerUpBonus(tier: number): PowerUpBonus {
  if (!isValidPowerUpTier(tier)) {
    throw new Error(`Power-up tier must be an integer in [1, ${MAX_POWER_UP_TIER}]; got ${tier}`);
  }
  return { tier, tierName: lootTierName(tier), ...BONUSES[tier - 1] };
}

/**
 * Sum every axis across a loadout, then clamp the two capped ones.
 *
 * SUMMED BEFORE APPLIED, and that ordering is a contract rather than an
 * implementation detail. It is what makes the loadout order-independent — which
 * a verifier depends on, because it recomputes a run's dice from the seed and has
 * no way to know what order a UI listed items in — and it is what lets
 * `resolveEquippedItems` sort a stored loadout into canonical order without
 * changing the fight. An axis applied per item instead of to the total would make
 * `stepDieSize` saturate repeatedly and break replay of every run already stored.
 *
 * The clamps live here, on the total, for the same reason: clamping per item
 * would let three items each sit under the cap and still sum past it.
 *
 * AN OUT-OF-RANGE TIER THROWS HERE, THOUGH `archetypeBonusVector` CLAMPS IT.
 * That asymmetry is deliberate and runs opposite to the archetype one, for the
 * reason the header gives: a slug is 256 uninspected bytes, so an unrecognized
 * one is an ordinary event that must degrade to something playable — but `tier`
 * is a range-checked `uint` and its authority is `get-token-tier`. A tier the
 * chain could not have minted therefore means our read is wrong, not that the
 * token is odd, and resolving a run with a bonus that quietly evaluated to the
 * nearest legal value would charge the player for gear that did not apply.
 * `archetypeBonusVector` stays total because its other callers are display code
 * — a wallet card must render, not throw.
 */
function totalBonus(items: readonly EquippedItem[]): ArchetypeBonusVector {
  for (const item of items) {
    if (!isValidPowerUpTier(item.tier)) {
      throw new Error(
        `Power-up tier must be an integer in [1, ${MAX_POWER_UP_TIER}]; got ${item.tier}`,
      );
    }
  }
  const total = items.reduce(
    (acc, item) => {
      const v = archetypeBonusVector(item.archetype, item.tier);
      return {
        dieSizeSteps: acc.dieSizeSteps + v.dieSizeSteps,
        extraDice: acc.extraDice + v.extraDice,
        flatDamage: acc.flatDamage + v.flatDamage,
        defenseBonus: acc.defenseBonus + v.defenseBonus,
        maxHp: acc.maxHp + v.maxHp,
        grantsPowerId: null,
      };
    },
    {
      dieSizeSteps: 0,
      extraDice: 0,
      flatDamage: 0,
      defenseBonus: 0,
      maxHp: 0,
      grantsPowerId: null,
    } as ArchetypeBonusVector,
  );
  return {
    ...total,
    defenseBonus: Math.min(total.defenseBonus, MAX_TOTAL_DEFENSE_BONUS),
    maxHp: Math.min(total.maxHp, MAX_TOTAL_MAXHP_BONUS),
  };
}

/**
 * Adapt a legacy tier list to items, for callers that still hold bare tiers.
 *
 * Every such tier came from a token minted before archetypes existed, and every
 * one of those tokens parses to `relic` — so this is the same normalization
 * `fromRow` applies to a stored setup, expressed once.
 */
export function legacyItems(tiers: readonly number[]): readonly EquippedItem[] {
  return tiers.map((tier) => ({ archetype: DEFAULT_ARCHETYPE, tier }));
}

/** Step a die size up the ladder, saturating at the top rather than wrapping. */
export function stepDieSize(sides: DiceSides, steps: number): DiceSides {
  const at = DAMAGE_DIE_LADDER.indexOf(sides);
  if (at === -1) {
    // A power rolling a die outside the damage ladder (a d20) gets no size
    // upgrade rather than being silently relocated onto it.
    return sides;
  }
  const to = Math.min(Math.max(at + steps, 0), DAMAGE_DIE_LADDER.length - 1);
  return DAMAGE_DIE_LADDER[to];
}

/**
 * Apply the equipped items to a power's dice formula.
 *
 * Pure and order-independent: bonuses are summed before being applied, so two
 * items equipped in either order produce the same formula. That matters
 * because a run's dice are recomputed from the seed during verification, and a
 * verifier has no way to know what order a UI listed items in.
 *
 * Returns null for a power that rolls no dice at all (a Guard), which is not an
 * error — it has no formula to upgrade.
 */
export function applyPowerUps(
  diceFormula: string | null,
  items: readonly EquippedItem[],
): string | null {
  if (!diceFormula) return null;
  if (items.length === 0) return diceFormula;

  const base = parseDiceFormula(diceFormula);
  const totals = totalBonus(items);

  const upgraded: DiceFormula = {
    count: base.count + totals.extraDice,
    sides: stepDieSize(base.sides, totals.dieSizeSteps),
    modifier: base.modifier + totals.flatDamage,
  };
  return formatDiceFormula(upgraded);
}

/** Summed Defense DC bonus from every equipped item, clamped at the ceiling. */
export function powerUpDefenseBonus(items: readonly EquippedItem[]): number {
  return totalBonus(items).defenseBonus;
}

/**
 * Summed max-HP bonus from every equipped item, clamped at the ceiling.
 *
 * Added to both `maxHp` and starting `hp`, so a tank walks in at full health
 * rather than at a fraction of a larger pool.
 */
export function powerUpMaxHpBonus(items: readonly EquippedItem[]): number {
  return totalBonus(items).maxHp;
}

/**
 * The powers a loadout grants for the run, in loadout order, deduped.
 *
 * Deduped because two elixirs of the same tier grant the same id, and a power
 * appearing twice in `Fighter.powerIds` would let one cooldown be dodged by
 * selecting the "other" copy.
 */
export function grantedPowerIds(items: readonly EquippedItem[]): readonly string[] {
  const ids: string[] = [];
  for (const item of items) {
    const id = archetypeBonusVector(item.archetype, item.tier).grantsPowerId;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * How an item reads against one specific power, e.g. `1d6->1d8`.
 *
 * This is the `PowerUpNft.diceFormulaBonus` field: a display string showing
 * what this item would do to that power, computed from the same pure transform
 * the combat resolver uses. Null when the power rolls nothing.
 */
export function describeDiceUpgrade(
  diceFormula: string | null,
  item: EquippedItem,
): string | null {
  const upgraded = applyPowerUps(diceFormula, [item]);
  if (!upgraded || !diceFormula) return null;
  return `${diceFormula}->${upgraded}`;
}

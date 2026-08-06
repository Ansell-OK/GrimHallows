/**
 * Power-up NFTs: what a tier actually grants.
 *
 * 01-game-design.md#6 fixes the principle and leaves the numbers open. The
 * principle is the load-bearing part and is not tunable:
 *
 *   THE BONUS KEYS OFF THE ON-CHAIN `tier`, NEVER OFF METADATA. `tier` is
 *   stored in `character-loot-nft`'s `token-metadata` map on chain
 *   (03-smart-contracts-spec.md#1) precisely so it cannot be spoofed. A JSON
 *   file at a metadata URI is flavour — a name, an image, a description — and
 *   is "never the sole source of power". Rewriting one must not change a single
 *   die. Every function here takes a tier and nothing else.
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

/**
 * Version of the tier→bonus table.
 *
 * Bumped whenever a number below changes. A stored run references the version
 * that resolved it, so retuning the ladder cannot silently rewrite what an old
 * run's dice meant.
 */
export const POWER_UP_ALGO_VERSION = 'powerup-v1' as const;

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
 * Apply the equipped power-ups to a power's dice formula.
 *
 * Pure and order-independent: bonuses are summed before being applied, so two
 * power-ups equipped in either order produce the same formula. That matters
 * because a run's dice are recomputed from the seed during verification, and a
 * verifier has no way to know what order a UI listed items in.
 *
 * Returns null for a power that rolls no dice at all (a Guard), which is not an
 * error — it has no formula to upgrade.
 */
export function applyPowerUps(
  diceFormula: string | null,
  tiers: readonly number[],
): string | null {
  if (!diceFormula) return null;
  if (tiers.length === 0) return diceFormula;

  const base = parseDiceFormula(diceFormula);
  const totals = tiers.reduce(
    (acc, tier) => {
      const bonus = powerUpBonus(tier);
      return {
        dieSizeSteps: acc.dieSizeSteps + bonus.dieSizeSteps,
        extraDice: acc.extraDice + bonus.extraDice,
        flatDamage: acc.flatDamage + bonus.flatDamage,
      };
    },
    { dieSizeSteps: 0, extraDice: 0, flatDamage: 0 },
  );

  const upgraded: DiceFormula = {
    count: base.count + totals.extraDice,
    sides: stepDieSize(base.sides, totals.dieSizeSteps),
    modifier: base.modifier + totals.flatDamage,
  };
  return formatDiceFormula(upgraded);
}

/** Summed Defense DC bonus from every equipped power-up. */
export function powerUpDefenseBonus(tiers: readonly number[]): number {
  return tiers.reduce((total, tier) => total + powerUpBonus(tier).defenseBonus, 0);
}

/**
 * How a tier reads against one specific power, e.g. `1d6->1d8`.
 *
 * This is the `PowerUpNft.diceFormulaBonus` field: a display string showing
 * what this item would do to that power, computed from the same pure transform
 * the combat resolver uses. Null when the power rolls nothing.
 */
export function describeDiceUpgrade(diceFormula: string | null, tier: number): string | null {
  const upgraded = applyPowerUps(diceFormula, [tier]);
  if (!upgraded || !diceFormula) return null;
  return `${diceFormula}->${upgraded}`;
}

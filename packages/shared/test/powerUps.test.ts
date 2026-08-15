/**
 * Power-up bonus tests.
 *
 * The anti-spoofing property is central: the numbers come from `(archetype,
 * tier)`, both of which are fixed on chain at mint and immutable after — never
 * from the JSON document at the token's uri, which is mutable by whoever hosts
 * it and is never fetched. The tests that matter most confirm the second-order
 * properties that follow: `applyPowerUps` is order-independent (because a
 * verifier has no way to know UI ordering), dice sizes saturate rather than wrap
 * (because a die off the damage ladder must not be relocated onto it), and the
 * two totals that can break the game are clamped on the SUM rather than per item.
 *
 * Every assertion below that predates archetypes is now written against explicit
 * `relic` items rather than bare tiers. That is deliberate and is itself the
 * point: `relic` is the archetype every already-minted token parses to, so these
 * tests going through unchanged — same inputs, same expected strings — is the
 * evidence that widening the table to (archetype, tier) did not move a number
 * any live token depends on.
 */

import { describe, expect, it } from 'vitest';
import {
  DAMAGE_DIE_LADDER,
  MAX_EQUIPPED_POWER_UPS,
  MAX_TOTAL_DEFENSE_BONUS,
  MAX_TOTAL_MAXHP_BONUS,
  applyPowerUps,
  describeDiceUpgrade,
  grantedPowerIds,
  isValidPowerUpTier,
  legacyItems,
  powerUpBonus,
  powerUpDefenseBonus,
  powerUpMaxHpBonus,
  stepDieSize,
} from '../src/powerUps.js';
import { MAX_POWER_UP_TIER } from '../src/contracts.js';
import {
  DEFAULT_ARCHETYPE,
  archetypeBonusVector,
  type EquippedItem,
} from '../src/lootArchetypes.js';

/** A legacy item: the archetype every pre-archetype token parses to. */
const r = (tier: number): EquippedItem => ({ archetype: DEFAULT_ARCHETYPE, tier });

describe('isValidPowerUpTier', () => {
  it('accepts tiers in [1, MAX_POWER_UP_TIER]', () => {
    for (let i = 1; i <= MAX_POWER_UP_TIER; i++) {
      expect(isValidPowerUpTier(i)).toBe(true);
    }
  });

  it('rejects tier 0', () => {
    expect(isValidPowerUpTier(0)).toBe(false);
  });

  it('rejects tier MAX+1', () => {
    expect(isValidPowerUpTier(MAX_POWER_UP_TIER + 1)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(isValidPowerUpTier(1.5)).toBe(false);
    expect(isValidPowerUpTier(NaN)).toBe(false);
  });
});

describe('powerUpBonus', () => {
  it('returns a complete bonus for every valid tier', () => {
    for (let tier = 1; tier <= MAX_POWER_UP_TIER; tier++) {
      const bonus = powerUpBonus(tier);
      expect(bonus.tier).toBe(tier);
      expect(bonus.tierName).toBeTruthy();
      expect(bonus.summary).toBeTruthy();
      expect(typeof bonus.dieSizeSteps).toBe('number');
      expect(typeof bonus.extraDice).toBe('number');
      expect(typeof bonus.flatDamage).toBe('number');
      expect(typeof bonus.defenseBonus).toBe('number');
    }
  });

  it('throws on tier 0', () => {
    expect(() => powerUpBonus(0)).toThrow();
  });

  it('throws on tier MAX+1', () => {
    expect(() => powerUpBonus(MAX_POWER_UP_TIER + 1)).toThrow();
  });
});

describe('DAMAGE_DIE_LADDER', () => {
  it('excludes d20 — that is the attack die, not a damage die', () => {
    // A legendary power-up's damage roll must stay distinguishable from an
    // attack roll in the turn log (01-game-design.md#5).
    expect(DAMAGE_DIE_LADDER).not.toContain(20);
  });

  it('is strictly ascending, so a step right is always an upgrade', () => {
    for (let i = 1; i < DAMAGE_DIE_LADDER.length; i++) {
      expect(DAMAGE_DIE_LADDER[i]).toBeGreaterThan(DAMAGE_DIE_LADDER[i - 1]);
    }
  });
});

describe('stepDieSize', () => {
  it('steps d6 up by 1 to d8', () => {
    expect(stepDieSize(6, 1)).toBe(8);
  });

  it('steps d6 up by 2 to d10', () => {
    expect(stepDieSize(6, 2)).toBe(10);
  });

  it('saturates at d12 rather than wrapping', () => {
    expect(stepDieSize(10, 5)).toBe(12);
    expect(stepDieSize(12, 1)).toBe(12);
  });

  it('leaves a die outside the ladder unchanged', () => {
    // d20 is the attack roll, not damage — a power-up must not relocate it.
    expect(stepDieSize(20, 1)).toBe(20);
    expect(stepDieSize(20, -1)).toBe(20);
  });

  it('supports negative steps', () => {
    expect(stepDieSize(10, -1)).toBe(8);
    expect(stepDieSize(6, -1)).toBe(4);
  });

  it('saturates at the low end too', () => {
    expect(stepDieSize(4, -5)).toBe(4);
  });
});

describe('applyPowerUps', () => {
  it('returns null for a null formula', () => {
    expect(applyPowerUps(null, [r(1)])).toBeNull();
  });

  it('returns the formula unchanged when nothing is equipped', () => {
    expect(applyPowerUps('1d6', [])).toBe('1d6');
    expect(applyPowerUps('2d8+3', [])).toBe('2d8+3');
  });

  it('applies one tier', () => {
    // Tier 1 is +1 die size, so 1d6 -> 1d8
    const result = applyPowerUps('1d6', [r(1)]);
    expect(result).toBe('1d8');
  });

  it('is order-independent', () => {
    // Two tiers equipped in either order must produce the same result, because a
    // verifier has no way to know what order the UI listed them in.
    const a = applyPowerUps('1d8', [r(1), r(2)]);
    const b = applyPowerUps('1d8', [r(2), r(1)]);
    expect(a).toBe(b);
  });

  it('sums bonuses before applying them', () => {
    // Tier 1: dieSizeSteps=1, extraDice=0, flatDamage=0
    // Tier 2: dieSizeSteps=1, extraDice=0, flatDamage=2
    // Total: dieSizeSteps=2, extraDice=0, flatDamage=2
    // 1d6 + 2 steps = 1d10, +2 flat = 1d10+2
    const result = applyPowerUps('1d6', [r(1), r(2)]);
    expect(result).toBe('1d10+2');
  });

  it('adds extra dice', () => {
    // Tier 4: dieSizeSteps=2, extraDice=1, flatDamage=3
    // 1d6 + 2 steps = 1d10, +1 die = 2d10, +3 flat = 2d10+3
    const result = applyPowerUps('1d6', [r(4)]);
    expect(result).toBe('2d10+3');
  });

  it('preserves an existing modifier and adds to it', () => {
    // Tier 2: flatDamage=2
    const result = applyPowerUps('1d8+1', [r(2)]);
    expect(result).toBe('1d10+3'); // +1 die size, +2 flat on top of the existing +1
  });
});

describe('powerUpDefenseBonus', () => {
  it('returns 0 for nothing equipped', () => {
    expect(powerUpDefenseBonus([])).toBe(0);
  });

  it('sums the defense bonus from every tier', () => {
    // Tier 1: defenseBonus=0, Tier 2: defenseBonus=1
    expect(powerUpDefenseBonus([r(1), r(2)])).toBe(1);
  });
});

describe('describeDiceUpgrade', () => {
  it('shows the before->after formula', () => {
    // Tier 1 is +1 die size
    expect(describeDiceUpgrade('1d6', r(1))).toBe('1d6->1d8');
  });

  it('returns null for a null formula', () => {
    expect(describeDiceUpgrade(null, r(1))).toBeNull();
  });

  it('handles a formula with a modifier', () => {
    // Tier 2: +1 die size, +2 flat
    expect(describeDiceUpgrade('1d8+1', r(2))).toBe('1d8+1->1d10+3');
  });
});

describe('the defense clamp is a no-op on every loadout that already exists', () => {
  // THE TEST THAT LETS THE CLAMP SHIP WITHOUT AN ENCOUNTER BUMP.
  //
  // MAX_TOTAL_DEFENSE_BONUS was introduced to stop `boots` (+5 at tier 4) from
  // making a character unhittable — and an unhittable character does not stall
  // and lose, it wins every time, which at a 100% drop rate is an infinite loot
  // printer. But introducing a clamp is only safe for stored runs if it can
  // never fire on a loadout those runs could have had.
  //
  // Exhaustive, not sampled: every multiset of up to MAX_EQUIPPED_POWER_UPS
  // legacy tiers. That is the complete space of loadouts expressible under
  // powerup-v1, so "the clamp never fires" is proven rather than sampled.
  function everyLegacyLoadout(): EquippedItem[][] {
    const out: EquippedItem[][] = [[]];
    let frontier: EquippedItem[][] = [[]];
    for (let size = 0; size < MAX_EQUIPPED_POWER_UPS; size++) {
      const next: EquippedItem[][] = [];
      for (const loadout of frontier) {
        const lowest = loadout.length ? loadout[loadout.length - 1].tier : 1;
        for (let tier = lowest; tier <= MAX_POWER_UP_TIER; tier++) {
          next.push([...loadout, r(tier)]);
        }
      }
      out.push(...next);
      frontier = next;
    }
    return out;
  }

  it('covers the whole legacy loadout space', () => {
    // 1 + 4 + 10 + 20 = 35 multisets of size 0..3 over 4 tiers. Asserted so a
    // bug in the generator cannot make the sweep below vacuously pass.
    expect(everyLegacyLoadout().length).toBe(35);
  });

  it('never clamps a legacy loadout, and tops out at exactly the ceiling', () => {
    let observedMax = 0;
    for (const loadout of everyLegacyLoadout()) {
      const clamped = powerUpDefenseBonus(loadout);
      const unclamped = loadout.reduce((t, i) => t + powerUpBonus(i.tier).defenseBonus, 0);
      expect(clamped, JSON.stringify(loadout)).toBe(unclamped);
      observedMax = Math.max(observedMax, clamped);
    }
    // The ceiling is not an arbitrary number: it IS the old maximum. If this
    // stops being an equality the clamp has started changing history.
    expect(observedMax).toBe(MAX_TOTAL_DEFENSE_BONUS);
  });

  it('grants no maxHp for any legacy loadout', () => {
    // The other half of the no-bump argument: the new axis is identically zero
    // for every run that exists, so adding it to maxHp/hp cannot move one.
    for (const loadout of everyLegacyLoadout()) {
      expect(powerUpMaxHpBonus(loadout)).toBe(0);
    }
  });
});

describe('the clamps bind on the total, not per item', () => {
  it('caps defense for a stack that would otherwise exceed the ceiling', () => {
    // Three tier-4 boots are +5 each. Unclamped that is +15, which drops the
    // unhittable threshold to vit >= 6 — essentially every character.
    const boots = Array.from({ length: MAX_EQUIPPED_POWER_UPS }, () => ({
      archetype: 'boots' as const,
      tier: 4,
    }));
    expect(boots.reduce((t, i) => t + archetypeBonusVector(i.archetype, i.tier).defenseBonus, 0))
      .toBeGreaterThan(MAX_TOTAL_DEFENSE_BONUS);
    expect(powerUpDefenseBonus(boots)).toBe(MAX_TOTAL_DEFENSE_BONUS);
  });

  it('caps maxHp for a full chestplate stack', () => {
    // 3 x tier-4 chestplate is +90 raw.
    const plate = Array.from({ length: MAX_EQUIPPED_POWER_UPS }, () => ({
      archetype: 'chestplate' as const,
      tier: 4,
    }));
    expect(powerUpMaxHpBonus(plate)).toBe(MAX_TOTAL_MAXHP_BONUS);
  });

  it('leaves a sub-ceiling stack alone', () => {
    // The clamp must not quietly become a floor or a rounding step.
    expect(powerUpDefenseBonus([{ archetype: 'boots', tier: 1 }])).toBe(1);
    expect(powerUpMaxHpBonus([{ archetype: 'chestplate', tier: 1 }])).toBe(5);
  });

  it('does not cap flatDamage, which is the intended payoff', () => {
    // Stated so that "why is this axis uncapped" is answered in the suite: a
    // triple-legendary sword stack ending fights fast is the reward for the
    // forge ladder. It is bounded by MAX_EQUIPPED_POWER_UPS, and unlike defense
    // it cannot produce a character the game is unable to kill.
    const swords = Array.from({ length: MAX_EQUIPPED_POWER_UPS }, () => ({
      archetype: 'sword' as const,
      tier: 4,
    }));
    expect(applyPowerUps('1d6', swords)).toBe('4d12+27');
  });
});

describe('archetypes change the numbers, tiers alone no longer decide them', () => {
  it('gives two archetypes at one tier different bonuses', () => {
    // The whole point of the widening. If these were equal, the (archetype,
    // tier) table would be a tier table with extra steps.
    const sword = applyPowerUps('1d6', [{ archetype: 'sword', tier: 4 }]);
    const chest = applyPowerUps('1d6', [{ archetype: 'chestplate', tier: 4 }]);
    expect(sword).not.toBe(chest);
  });

  it('stays order-independent across mixed archetypes', () => {
    // Order-independence is what lets a stored loadout be sorted into canonical
    // form. With one axis per item it was easy; with six axes and archetypes it
    // is worth re-proving, because `stepDieSize` saturates and a per-item
    // application would make order matter.
    const a = applyPowerUps('1d6', [
      { archetype: 'warhammer', tier: 4 },
      { archetype: 'axe', tier: 2 },
      { archetype: 'ring', tier: 3 },
    ]);
    const b = applyPowerUps('1d6', [
      { archetype: 'ring', tier: 3 },
      { archetype: 'warhammer', tier: 4 },
      { archetype: 'axe', tier: 2 },
    ]);
    expect(a).toBe(b);
  });

  it('degrades an unregistered archetype to relic rather than to nothing', () => {
    // A token whose uri says something we do not recognise must still play. The
    // safe direction is today's behaviour, not a zeroed item.
    const unknown = applyPowerUps('1d6', [{ archetype: 'trebuchet' as never, tier: 4 }]);
    expect(unknown).toBe(applyPowerUps('1d6', [r(4)]));
  });
});

describe('grantedPowerIds', () => {
  it('is empty for a loadout of legacy items', () => {
    expect(grantedPowerIds([r(1), r(4)])).toEqual([]);
  });

  it('collects the power an elixir grants', () => {
    const ids = grantedPowerIds([{ archetype: 'elixir', tier: 2 }]);
    expect(ids).toEqual(['potion-heal-2']);
  });

  it('dedupes two items granting the same id', () => {
    // Two identical elixirs must not put the id in `powerIds` twice — a
    // duplicate would let a player dodge the cooldown by selecting the "other"
    // copy, since cooldowns are keyed by power id.
    const ids = grantedPowerIds([
      { archetype: 'elixir', tier: 3 },
      { archetype: 'elixir', tier: 3 },
    ]);
    expect(ids).toEqual(['potion-heal-3']);
  });

  it('keeps distinct grants from different tiers of one archetype', () => {
    const ids = grantedPowerIds([
      { archetype: 'elixir', tier: 1 },
      { archetype: 'tome', tier: 4 },
    ]);
    expect(ids).toEqual(['potion-heal-1', 'tome-nova-4']);
  });
});

describe('legacyItems', () => {
  it('turns a stored tier list into relic items', () => {
    // The single definition of the legacy normalization, used by `fromRow` on a
    // pre-archetype `encounter_setup_json` and by any caller still holding
    // tiers. Written once so two call sites cannot normalize differently.
    expect(legacyItems([2, 3])).toEqual([
      { archetype: DEFAULT_ARCHETYPE, tier: 2 },
      { archetype: DEFAULT_ARCHETYPE, tier: 3 },
    ]);
  });

  it('resolves identically to the tiers it replaces', () => {
    for (let tier = 1; tier <= MAX_POWER_UP_TIER; tier++) {
      expect(applyPowerUps('1d6', legacyItems([tier]))).toBe(applyPowerUps('1d6', [r(tier)]));
    }
  });
});

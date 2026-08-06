/**
 * Power-up bonus tests.
 *
 * The anti-spoofing property is central: tier is read from chain, metadata is
 * flavor. The tests that matter most confirm the second-order properties that
 * follow from it: `applyPowerUps` is order-independent (because a verifier has
 * no way to know UI ordering), and dice sizes saturate rather than wrap
 * (because a die off the damage ladder must not be relocated onto it).
 */

import { describe, expect, it } from 'vitest';
import {
  DAMAGE_DIE_LADDER,
  applyPowerUps,
  describeDiceUpgrade,
  isValidPowerUpTier,
  powerUpBonus,
  powerUpDefenseBonus,
  stepDieSize,
} from '../src/powerUps.js';
import { MAX_POWER_UP_TIER } from '../src/contracts.js';

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
    expect(applyPowerUps(null, [1])).toBeNull();
  });

  it('returns the formula unchanged when no tiers are equipped', () => {
    expect(applyPowerUps('1d6', [])).toBe('1d6');
    expect(applyPowerUps('2d8+3', [])).toBe('2d8+3');
  });

  it('applies one tier', () => {
    // Tier 1 is +1 die size, so 1d6 -> 1d8
    const result = applyPowerUps('1d6', [1]);
    expect(result).toBe('1d8');
  });

  it('is order-independent', () => {
    // Two tiers equipped in either order must produce the same result, because a
    // verifier has no way to know what order the UI listed them in.
    const a = applyPowerUps('1d8', [1, 2]);
    const b = applyPowerUps('1d8', [2, 1]);
    expect(a).toBe(b);
  });

  it('sums bonuses before applying them', () => {
    // Tier 1: dieSizeSteps=1, extraDice=0, flatDamage=0
    // Tier 2: dieSizeSteps=1, extraDice=0, flatDamage=2
    // Total: dieSizeSteps=2, extraDice=0, flatDamage=2
    // 1d6 + 2 steps = 1d10, +2 flat = 1d10+2
    const result = applyPowerUps('1d6', [1, 2]);
    expect(result).toBe('1d10+2');
  });

  it('adds extra dice', () => {
    // Tier 4: dieSizeSteps=2, extraDice=1, flatDamage=3
    // 1d6 + 2 steps = 1d10, +1 die = 2d10, +3 flat = 2d10+3
    const result = applyPowerUps('1d6', [4]);
    expect(result).toBe('2d10+3');
  });

  it('preserves an existing modifier and adds to it', () => {
    // Tier 2: flatDamage=2
    const result = applyPowerUps('1d8+1', [2]);
    expect(result).toBe('1d10+3'); // +1 die size, +2 flat on top of the existing +1
  });
});

describe('powerUpDefenseBonus', () => {
  it('returns 0 for no equipped tiers', () => {
    expect(powerUpDefenseBonus([])).toBe(0);
  });

  it('sums the defense bonus from every tier', () => {
    // Tier 1: defenseBonus=0, Tier 2: defenseBonus=1
    expect(powerUpDefenseBonus([1, 2])).toBe(1);
  });
});

describe('describeDiceUpgrade', () => {
  it('shows the before->after formula', () => {
    // Tier 1 is +1 die size
    expect(describeDiceUpgrade('1d6', 1)).toBe('1d6->1d8');
  });

  it('returns null for a null formula', () => {
    expect(describeDiceUpgrade(null, 1)).toBeNull();
  });

  it('handles a formula with a modifier', () => {
    // Tier 2: +1 die size, +2 flat
    expect(describeDiceUpgrade('1d8+1', 2)).toBe('1d8+1->1d10+3');
  });
});

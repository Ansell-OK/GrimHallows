/**
 * Rarity derivation tests (01-game-design.md#4b).
 *
 * Two properties carry the design:
 *   - the tier boundaries are inclusive and contiguous, so no hold duration is
 *     unclassified and no threshold passes without the character changing;
 *   - the clock is the CURRENT holder's, so a transfer resets it to zero.
 *
 * The second one is enforced end-to-end by the devnet transfer test; here it is
 * pinned as arithmetic, which is the part that could regress silently.
 */

import { describe, it, expect } from 'vitest';
import {
  RARITY_ORDER,
  RARITY_TIERS,
  holdDaysSince,
  nextRarityTier,
  rarityFromHoldDays,
  rarityMultiplier,
} from '../src/rarity.js';

const DAY_MS = 86_400_000;

describe('the tier table', () => {
  it('has six tiers, ascending, with no gaps', () => {
    expect(RARITY_TIERS).toHaveLength(6);
    expect(RARITY_ORDER).toEqual(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']);
    for (let i = 1; i < RARITY_TIERS.length; i++) {
      expect(RARITY_TIERS[i].minHoldDays).toBeGreaterThan(RARITY_TIERS[i - 1].minHoldDays);
      expect(RARITY_TIERS[i].multiplier).toBeGreaterThan(RARITY_TIERS[i - 1].multiplier);
    }
  });

  it('starts at day zero and multiplier 1.0, so a fresh character is unscaled', () => {
    expect(RARITY_TIERS[0]).toMatchObject({ rarity: 'common', minHoldDays: 0, multiplier: 1.0 });
  });

  it('pins the thresholds — changing one reassigns every character at once', () => {
    expect(RARITY_TIERS.map((t) => t.minHoldDays)).toEqual([0, 30, 90, 180, 365, 730]);
    expect(RARITY_TIERS.map((t) => t.multiplier)).toEqual([1.0, 1.1, 1.2, 1.35, 1.5, 1.75]);
  });
});

describe('rarityFromHoldDays', () => {
  it('treats minHoldDays as inclusive — exactly 30 days is Uncommon', () => {
    for (const { rarity, minHoldDays } of RARITY_TIERS) {
      expect(rarityFromHoldDays(minHoldDays)).toBe(rarity);
    }
  });

  it('stays on the lower tier one day short of each boundary', () => {
    expect(rarityFromHoldDays(29)).toBe('common');
    expect(rarityFromHoldDays(89)).toBe('uncommon');
    expect(rarityFromHoldDays(179)).toBe('rare');
    expect(rarityFromHoldDays(364)).toBe('epic');
    expect(rarityFromHoldDays(729)).toBe('legendary');
  });

  it('handles fractional days at a boundary', () => {
    expect(rarityFromHoldDays(29.999)).toBe('common');
    expect(rarityFromHoldDays(30.001)).toBe('uncommon');
  });

  it('caps at mythic no matter how long the hold', () => {
    expect(rarityFromHoldDays(730)).toBe('mythic');
    expect(rarityFromHoldDays(100_000)).toBe('mythic');
    expect(rarityFromHoldDays(Number.POSITIVE_INFINITY)).toBe('common'); // non-finite -> floor
  });

  it('floors a failed lookup to common rather than throwing', () => {
    // 02-architecture.md#4: a holder-age lookup failure means "treat it as
    // freshly acquired" — an underestimate, never a broken character screen.
    for (const bad of [0, -1, -10_000, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(rarityFromHoldDays(bad)).toBe('common');
    }
  });
});

describe('rarityMultiplier', () => {
  it('returns each tier’s multiplier', () => {
    for (const { rarity, multiplier } of RARITY_TIERS) {
      expect(rarityMultiplier(rarity)).toBe(multiplier);
    }
  });

  it('never scales a character down', () => {
    for (const r of RARITY_ORDER) expect(rarityMultiplier(r)).toBeGreaterThanOrEqual(1.0);
  });
});

describe('holdDaysSince', () => {
  const now = Date.UTC(2026, 0, 1);

  it('counts elapsed days against an injected now', () => {
    expect(holdDaysSince(now - 30 * DAY_MS, now)).toBe(30);
    expect(holdDaysSince(new Date(now - 90 * DAY_MS), new Date(now))).toBe(90);
  });

  it('is fractional, so an hour past a threshold counts', () => {
    const justOver = holdDaysSince(now - (30 * DAY_MS + 3_600_000), now);
    expect(justOver).toBeGreaterThan(30);
    expect(rarityFromHoldDays(justOver)).toBe('uncommon');
  });

  it('floors at zero for a future or invalid timestamp', () => {
    expect(holdDaysSince(now + 5 * DAY_MS, now)).toBe(0);
    expect(holdDaysSince(Number.NaN, now)).toBe(0);
    expect(holdDaysSince(now, Number.NaN)).toBe(0);
  });

  it('resets when the acquisition timestamp moves to the transfer — the whole mechanism', () => {
    const boughtTwoYearsAgo = now - 800 * DAY_MS;
    expect(rarityFromHoldDays(holdDaysSince(boughtTwoYearsAgo, now))).toBe('mythic');
    // Sold today: the new owner's acquisition block is now, so the clock is zero.
    expect(rarityFromHoldDays(holdDaysSince(now, now))).toBe('common');
  });
});

describe('nextRarityTier', () => {
  it('names the next tier and the days left to it', () => {
    expect(nextRarityTier(0)).toEqual({ rarity: 'uncommon', daysRemaining: 30 });
    expect(nextRarityTier(12)).toEqual({ rarity: 'uncommon', daysRemaining: 18 });
    expect(nextRarityTier(30)).toEqual({ rarity: 'rare', daysRemaining: 60 });
    expect(nextRarityTier(364)).toEqual({ rarity: 'legendary', daysRemaining: 1 });
  });

  it('returns null at mythic — there is nothing above it', () => {
    expect(nextRarityTier(730)).toBeNull();
    expect(nextRarityTier(10_000)).toBeNull();
  });

  it('treats a failed lookup as day zero', () => {
    expect(nextRarityTier(-5)).toEqual({ rarity: 'uncommon', daysRemaining: 30 });
    expect(nextRarityTier(Number.NaN)).toEqual({ rarity: 'uncommon', daysRemaining: 30 });
  });

  it('always points at the tier immediately above the current one', () => {
    for (const days of [0, 15, 30, 89, 90, 200, 400, 729]) {
      const current = rarityFromHoldDays(days);
      const next = nextRarityTier(days);
      expect(next).not.toBeNull();
      expect(RARITY_ORDER.indexOf(next!.rarity)).toBe(RARITY_ORDER.indexOf(current) + 1);
    }
  });
});

/**
 * Reward-table tests.
 *
 * This table decides real mainnet payouts, so the properties worth locking down
 * are not "does it return a shape" but:
 *   - determinism (same seed → same reward, forever, or verification is a lie)
 *   - the odds actually match the operator's numbers over a large sample
 *   - a degrade produces loot, never a skipped reward and never a jackpot the
 *     pool can't cover
 *   - nothing here can be talked into paying out on a loss
 */

import { describe, expect, it } from 'vitest';
import {
  JACKPOT_AMOUNT_USTX,
  JACKPOT_ODDS_BPS,
  LOOT_ODDS_BPS,
  LOOT_TIER_NAMES,
  LOOT_TIER_WEIGHTS_BPS,
  NO_REWARD,
  REWARD_DRAW_RANGE,
  drawLootTier,
  drawReward,
  drawRewardTable,
  lootTierName,
  lootUriForTier,
  resolveReward,
} from '../src/index.js';

/** Deterministic distinct seeds: sha-shaped hex, varied by index only. */
function seedAt(i: number): string {
  return i.toString(16).padStart(64, '0');
}

const RICH_POOL = 1_000_000_000n;

describe('reward table constants', () => {
  it('matches the operator-specified rates', () => {
    expect(JACKPOT_ODDS_BPS / REWARD_DRAW_RANGE).toBe(0.01);
    expect(LOOT_ODDS_BPS / REWARD_DRAW_RANGE).toBe(0.3);
    expect(JACKPOT_AMOUNT_USTX).toBe(10_000_000n);
    expect(LOOT_TIER_NAMES).toEqual(['rare', 'epic', 'mythic', 'legendary']);
  });

  it('has tier weights that sum to the draw range', () => {
    expect(LOOT_TIER_WEIGHTS_BPS.reduce((a, b) => a + b, 0)).toBe(REWARD_DRAW_RANGE);
  });
});

describe('drawRewardTable', () => {
  it('is deterministic for a given seed', () => {
    for (let i = 0; i < 20; i++) {
      expect(drawRewardTable(seedAt(i))).toEqual(drawRewardTable(seedAt(i)));
    }
  });

  it('always publishes the roll that selected the branch', () => {
    const draw = drawRewardTable(seedAt(1));
    expect(draw.roll).toBeGreaterThanOrEqual(0);
    expect(draw.roll).toBeLessThan(REWARD_DRAW_RANGE);
  });

  it('sets amount only on a jackpot and tier only on loot', () => {
    for (let i = 0; i < 300; i++) {
      const d = drawRewardTable(seedAt(i));
      if (d.kind === 'jackpot') {
        expect(d.amountUstx).toBe(JACKPOT_AMOUNT_USTX);
        expect(d.tier).toBeNull();
      } else if (d.kind === 'loot') {
        expect(d.amountUstx).toBeNull();
        expect(d.tier).toBeGreaterThanOrEqual(1);
        expect(d.tier).toBeLessThanOrEqual(LOOT_TIER_NAMES.length);
      } else {
        expect(d.amountUstx).toBeNull();
        expect(d.tier).toBeNull();
      }
    }
  });

  it('hits roughly the specified rates over a large sample', () => {
    const N = 20_000;
    let jackpots = 0;
    let loot = 0;
    for (let i = 0; i < N; i++) {
      const kind = drawRewardTable(seedAt(i)).kind;
      if (kind === 'jackpot') jackpots++;
      else if (kind === 'loot') loot++;
    }
    // Generous bands — this asserts the table is wired to the right cutoffs, not
    // that sha256 is uniform to three decimal places.
    expect(jackpots / N).toBeGreaterThan(0.005);
    expect(jackpots / N).toBeLessThan(0.017);
    expect(loot / N).toBeGreaterThan(0.28);
    expect(loot / N).toBeLessThan(0.32);
  });
});

describe('drawLootTier', () => {
  it('is deterministic and independent of the reward draw index', () => {
    expect(drawLootTier(seedAt(7))).toBe(drawLootTier(seedAt(7)));
  });

  it('stays inside the tier range for every seed sampled', () => {
    for (let i = 0; i < 2_000; i++) {
      const tier = drawLootTier(seedAt(i));
      expect(Number.isInteger(tier)).toBe(true);
      expect(tier).toBeGreaterThanOrEqual(1);
      expect(tier).toBeLessThanOrEqual(LOOT_TIER_NAMES.length);
    }
  });

  it('reaches every tier, including the rarest', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i++) seen.add(drawLootTier(seedAt(i)));
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it('weights lower tiers more heavily than higher ones', () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 10_000; i++) counts[drawLootTier(seedAt(i)) - 1]++;
    expect(counts[0]).toBeGreaterThan(counts[1]);
    expect(counts[1]).toBeGreaterThan(counts[2]);
    expect(counts[2]).toBeGreaterThan(counts[3]);
  });
});

describe('tier helpers', () => {
  it('names tiers lowest to highest', () => {
    expect([1, 2, 3, 4].map(lootTierName)).toEqual(['rare', 'epic', 'mythic', 'legendary']);
  });

  it('refuses an out-of-range tier rather than minting a nonexistent one', () => {
    expect(() => lootTierName(0)).toThrow(/Loot tier must be/);
    expect(() => lootTierName(5)).toThrow(/Loot tier must be/);
    expect(() => lootUriForTier(1.5)).toThrow(/Loot tier must be/);
  });

  it('builds a uri per tier', () => {
    expect(lootUriForTier(3)).toBe('ipfs://grimhallow/power-up/tier-3.json');
  });
});

describe('drawReward — degrade path (03-smart-contracts-spec.md#3)', () => {
  /** First seed index whose table draw is a jackpot. */
  const jackpotSeed = (() => {
    for (let i = 0; i < 20_000; i++) {
      if (drawRewardTable(seedAt(i)).kind === 'jackpot') return seedAt(i);
    }
    throw new Error('no jackpot seed found in sample — table is misconfigured');
  })();

  it('pays the full jackpot when the pool covers it', () => {
    const r = drawReward(jackpotSeed, JACKPOT_AMOUNT_USTX);
    expect(r.kind).toBe('jackpot');
    expect(r.amountUstx).toBe(JACKPOT_AMOUNT_USTX.toString());
    expect(r.degraded).toBe(false);
    expect(r.lootUri).toBeNull();
  });

  it('degrades to loot — not to nothing — when the pool is one microSTX short', () => {
    const r = drawReward(jackpotSeed, JACKPOT_AMOUNT_USTX - 1n);
    expect(r.kind).toBe('loot');
    expect(r.degraded).toBe(true);
    expect(r.amountUstx).toBeNull();
    expect(r.tier).toBeGreaterThanOrEqual(1);
    expect(r.lootUri).toBe(lootUriForTier(r.tier as number));
  });

  it('degrades on an entirely empty pool', () => {
    const r = drawReward(jackpotSeed, 0n);
    expect(r.kind).toBe('loot');
    expect(r.degraded).toBe(true);
  });

  it('never reports a jackpot amount exceeding the pool it was given', () => {
    for (let i = 0; i < 3_000; i++) {
      for (const pool of [0n, 1n, JACKPOT_AMOUNT_USTX - 1n, JACKPOT_AMOUNT_USTX, RICH_POOL]) {
        const r = drawReward(seedAt(i), pool);
        if (r.kind === 'jackpot') {
          expect(BigInt(r.amountUstx as string)).toBeLessThanOrEqual(pool);
        }
      }
    }
  });

  it('leaves non-jackpot draws untouched by the pool balance', () => {
    for (let i = 0; i < 500; i++) {
      const seed = seedAt(i);
      if (drawRewardTable(seed).kind === 'jackpot') continue;
      expect(drawReward(seed, 0n)).toEqual(drawReward(seed, RICH_POOL));
      expect(drawReward(seed, 0n).degraded).toBe(false);
    }
  });

  it('refuses a negative pool balance instead of guessing', () => {
    expect(() => drawReward(seedAt(1), -1n)).toThrow(/cannot be negative/);
  });
});

describe('resolveReward', () => {
  it('draws the table on a win', () => {
    const seed = seedAt(42);
    expect(resolveReward({ seed, combatOutcome: 'win', sponsorPoolUstx: RICH_POOL })).toEqual(
      drawReward(seed, RICH_POOL),
    );
  });

  it('pays nothing on a loss, however rich the pool and however lucky the seed', () => {
    for (let i = 0; i < 2_000; i++) {
      const r = resolveReward({
        seed: seedAt(i),
        combatOutcome: 'loss',
        sponsorPoolUstx: RICH_POOL,
      });
      expect(r).toEqual(NO_REWARD);
      expect(r.amountUstx).toBeNull();
    }
  });
});

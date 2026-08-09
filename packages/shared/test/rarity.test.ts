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
  MINT_FLOOR_TIERS,
  RARITY_ORDER,
  RARITY_TIERS,
  holdDaysSince,
  maxRarity,
  mintFloorFromSeed,
  nextRarityTier,
  rarityFromHoldDays,
  rarityMultiplier,
} from '../src/rarity.js';
import type { Rarity } from '../src/types.js';

const DAY_MS = 86_400_000;

/** A stand-in for our own mint contract; the floor is a pure function of identity. */
const MINT_CONTRACT = 'SP000000000000000000002Q6VF78.character-nft';

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

  it('climbs from max(floor, age), so a Rare-floored fresh mint points at Epic not Uncommon', () => {
    // The bug the floor param fixes: without it, a Rare-floored token at day 0
    // would be told "30 days to Uncommon" — a tier it is already past.
    expect(nextRarityTier(0, 'rare')).toEqual({ rarity: 'epic', daysRemaining: 180 });
  });

  it('lets tenure overtake the floor — once age exceeds it, the floor stops mattering', () => {
    // Uncommon floor, but held long enough to be Epic on tenure alone: the next
    // tier is above Epic (Legendary), computed from age, not the floor.
    expect(nextRarityTier(200, 'uncommon')).toEqual({ rarity: 'legendary', daysRemaining: 165 });
  });

  it('defaults the floor to common, so an unfloored token behaves exactly as before', () => {
    for (const days of [0, 12, 30, 364]) {
      expect(nextRarityTier(days, 'common')).toEqual(nextRarityTier(days));
    }
  });

  it('returns null when the floor alone is already mythic-adjacent and age caps out', () => {
    // A Legendary floor at max tenure is Mythic; nothing is above it.
    expect(nextRarityTier(10_000, 'legendary')).toBeNull();
  });
});

describe('maxRarity', () => {
  it('returns the higher tier by rarity order', () => {
    expect(maxRarity('common', 'rare')).toBe('rare');
    expect(maxRarity('rare', 'common')).toBe('rare');
    expect(maxRarity('epic', 'uncommon')).toBe('epic');
    expect(maxRarity('mythic', 'legendary')).toBe('mythic');
  });

  it('is idempotent on equal tiers', () => {
    for (const r of RARITY_ORDER) expect(maxRarity(r, r)).toBe(r);
  });

  it('is commutative across every pair', () => {
    for (const a of RARITY_ORDER) {
      for (const b of RARITY_ORDER) expect(maxRarity(a, b)).toBe(maxRarity(b, a));
    }
  });
});

describe('mintFloorFromSeed', () => {
  // A block hash stands in for the real seed throughout. Any hex string works —
  // the roll hashes it — but using something block-hash-shaped keeps the tests
  // honest about where the value comes from.
  const SEED_A = '0x4f1c2b8a9d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8';
  const SEED_B = '0x9e8d7c6b5a4938271605f4e3d2c1b0a998877665544332211ffeeddccbbaa9988';

  it('is deterministic — the same identity and seed always roll the same floor', () => {
    expect(mintFloorFromSeed(MINT_CONTRACT, '1', SEED_A)).toBe(
      mintFloorFromSeed(MINT_CONTRACT, '1', SEED_A),
    );
    expect(mintFloorFromSeed(MINT_CONTRACT, '777', SEED_A)).toBe(
      mintFloorFromSeed(MINT_CONTRACT, '777', SEED_A),
    );
  });

  it('is case-insensitive on the contract id, like the stat digest', () => {
    expect(mintFloorFromSeed(MINT_CONTRACT.toUpperCase(), '42', SEED_A)).toBe(
      mintFloorFromSeed(MINT_CONTRACT.toLowerCase(), '42', SEED_A),
    );
  });

  it('normalizes the seed, so one block hash is one floor however it is written', () => {
    // Hiro returns block hashes 0x-prefixed and lowercase, but the value passes
    // through a cache and a JSON column on its way here. If `0xABC…`, `abc…` and
    // a padded copy rolled three different floors, a token's rarity would depend
    // on which code path fetched it — the one thing a *derived* value must never
    // do. Pinned because the normalization is one easy-to-drop line.
    const floor = mintFloorFromSeed(MINT_CONTRACT, '5', SEED_A);
    expect(mintFloorFromSeed(MINT_CONTRACT, '5', SEED_A.toUpperCase())).toBe(floor);
    expect(mintFloorFromSeed(MINT_CONTRACT, '5', SEED_A.replace(/^0x/, ''))).toBe(floor);
    expect(mintFloorFromSeed(MINT_CONTRACT, '5', `  ${SEED_A}  `)).toBe(floor);
  });

  it('is NOT precomputable from the token id alone — the seed changes the roll', () => {
    // The whole reason this function takes a seed. Token ids are sequential and
    // `get-last-token-id` is public, so a floor derived from identity alone lets
    // anyone hash `lastId + 1`, learn the outcome, and mint only on a Rare —
    // which would make the published 60/30/10 table describe nobody's real odds.
    // Two seeds over the same id must disagree somewhere in a small sample; if
    // this ever passes trivially, the seed has stopped reaching the digest.
    const differs = Array.from({ length: 50 }, (_, i) => String(i)).filter(
      (id) =>
        mintFloorFromSeed(MINT_CONTRACT, id, SEED_A) !==
        mintFloorFromSeed(MINT_CONTRACT, id, SEED_B),
    );
    expect(differs.length).toBeGreaterThan(0);
  });

  it('travels with the token: the floor depends on identity and seed, never holder or tenure', () => {
    // There is no holdDays or owner input at all — the type makes it impossible
    // to make the floor depend on tenure, which is what makes a free
    // self-transfer unable to reroll it. The mint block hash is fixed once the
    // mint confirms, so it is stable for the life of the token. This pins both.
    const floor = mintFloorFromSeed(MINT_CONTRACT, '99', SEED_A);
    expect(mintFloorFromSeed(MINT_CONTRACT, '99', SEED_A)).toBe(floor);
  });

  it('varies across token ids so re-minting rolls independently', () => {
    const seen = new Set<Rarity>();
    for (let i = 0; i < 500; i++) seen.add(mintFloorFromSeed(MINT_CONTRACT, String(i), SEED_A));
    // With a 60/30/10 table over 500 ids, all three buckets must appear.
    expect(seen).toEqual(new Set<Rarity>(['common', 'uncommon', 'rare']));
  });

  it('varies across seeds for one token id, which is the anti-grinding property', () => {
    // Same token id, many different confirming blocks. A minter cannot choose
    // which block includes their transaction, so this is the distribution they
    // actually face — and it must span the table rather than being pinned by the
    // id they can predict.
    const seen = new Set<Rarity>();
    for (let i = 0; i < 500; i++) {
      seen.add(mintFloorFromSeed(MINT_CONTRACT, '1', `block-hash-${i}`));
    }
    expect(seen).toEqual(new Set<Rarity>(['common', 'uncommon', 'rare']));
  });

  it('is capped at Rare — a mint never rolls Epic or above', () => {
    const capIndex = RARITY_ORDER.indexOf('rare');
    for (let i = 0; i < 2000; i++) {
      const floor = mintFloorFromSeed(MINT_CONTRACT, String(i), SEED_A);
      expect(RARITY_ORDER.indexOf(floor)).toBeLessThanOrEqual(capIndex);
    }
    // And it matches the table exactly — no floor tier outside MINT_FLOOR_TIERS.
    const allowed = new Set<Rarity>(MINT_FLOOR_TIERS.map((t) => t.rarity));
    expect(allowed).toEqual(new Set<Rarity>(['common', 'uncommon', 'rare']));
  });

  it('roughly matches the 60/30/10 weighting over many ids', () => {
    const counts: Record<string, number> = { common: 0, uncommon: 0, rare: 0 };
    const N = 20_000;
    for (let i = 0; i < N; i++) counts[mintFloorFromSeed(MINT_CONTRACT, String(i), SEED_A)]++;
    // Generous tolerance (±4 points) — this guards against a broken bucket or a
    // reintroduced modulo skew, not against normal sampling noise.
    expect(counts.common / N).toBeGreaterThan(0.56);
    expect(counts.common / N).toBeLessThan(0.64);
    expect(counts.uncommon / N).toBeGreaterThan(0.26);
    expect(counts.uncommon / N).toBeLessThan(0.34);
    expect(counts.rare / N).toBeGreaterThan(0.06);
    expect(counts.rare / N).toBeLessThan(0.14);
  });

  it('holds the weighting when the seed varies and the id is fixed', () => {
    // The distribution that matters in production. The test above varies the id,
    // which is the axis an attacker controls; this varies the axis they don't,
    // and the odds have to be the same 60/30/10 on both.
    const counts: Record<string, number> = { common: 0, uncommon: 0, rare: 0 };
    const N = 20_000;
    for (let i = 0; i < N; i++) counts[mintFloorFromSeed(MINT_CONTRACT, '1', `block-${i}`)]++;
    expect(counts.common / N).toBeGreaterThan(0.56);
    expect(counts.common / N).toBeLessThan(0.64);
    expect(counts.uncommon / N).toBeGreaterThan(0.26);
    expect(counts.uncommon / N).toBeLessThan(0.34);
    expect(counts.rare / N).toBeGreaterThan(0.06);
    expect(counts.rare / N).toBeLessThan(0.14);
  });
});

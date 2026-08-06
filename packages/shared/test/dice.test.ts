/**
 * Determinism tests for the dice derivation (06-mvp-roadmap.md Phase 4:
 * "same seed + inputs -> same rolls, always").
 *
 * The golden-vector test is the load-bearing one: it pins exact outputs so an
 * accidental change to the derivation is caught here rather than silently
 * invalidating every historical run's verifiability.
 */

import { describe, it, expect } from 'vitest';
import {
  DERIVATION_INDEX,
  DICE_ALGO_VERSION,
  deriveHash,
  deriveValue,
  formatDiceFormula,
  parseDiceFormula,
  rollDie,
  rollFormula,
  turnIndex,
} from '../src/dice.js';

const SEED = '0x' + 'a3'.repeat(32);
const SEED_B = '0x' + 'f1'.repeat(32);

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('deriveHash', () => {
  it('is deterministic across calls', () => {
    expect(toHex(deriveHash(SEED, 7))).toBe(toHex(deriveHash(SEED, 7)));
  });

  it('accepts hex strings with and without 0x identically', () => {
    expect(toHex(deriveHash(SEED, 3))).toBe(toHex(deriveHash(SEED.slice(2), 3)));
  });

  it('differs per index and per seed', () => {
    expect(toHex(deriveHash(SEED, 1))).not.toBe(toHex(deriveHash(SEED, 2)));
    expect(toHex(deriveHash(SEED, 1))).not.toBe(toHex(deriveHash(SEED_B, 1)));
  });

  it('rejects malformed seeds rather than silently coercing', () => {
    expect(() => deriveHash('0xzz', 0)).toThrow();
    expect(() => deriveHash('0xabc', 0)).toThrow();
    expect(() => deriveHash('', 0)).toThrow();
  });

  it('rejects out-of-range derivation indices', () => {
    expect(() => deriveHash(SEED, -1)).toThrow();
    expect(() => deriveHash(SEED, 1.5)).toThrow();
    expect(() => deriveHash(SEED, 2 ** 32)).toThrow();
  });
});

describe('deriveValue', () => {
  it('stays within [0, range)', () => {
    for (let i = 0; i < 500; i++) {
      const v = deriveValue(SEED, i, 20);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(20);
    }
  });

  it('rejects a non-positive range', () => {
    expect(() => deriveValue(SEED, 0, 0)).toThrow();
    expect(() => deriveValue(SEED, 0, -3)).toThrow();
  });

  it('produces a plausibly uniform d20 spread', () => {
    const counts = new Array(20).fill(0);
    for (let i = 0; i < 20_000; i++) counts[deriveValue(SEED, i, 20)]++;
    // Expected 1000 per face; generous bounds — this catches a broken
    // derivation, not a subtly biased one.
    for (const c of counts) {
      expect(c).toBeGreaterThan(800);
      expect(c).toBeLessThan(1200);
    }
  });
});

describe('rollDie', () => {
  it('stays within [1, sides]', () => {
    for (const sides of [4, 6, 8, 10, 12, 20] as const) {
      for (let i = 0; i < 200; i++) {
        const v = rollDie(SEED, i, sides);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(sides);
      }
    }
  });
});

describe('turnIndex', () => {
  it('never collides across turns or slots', () => {
    const seen = new Set<number>();
    for (let turn = 1; turn <= 100; turn++) {
      for (let slot = 0; slot < 16; slot++) {
        const idx = turnIndex(turn, slot);
        expect(seen.has(idx)).toBe(false);
        seen.add(idx);
      }
    }
  });

  it('never collides with the reward draw or initiative indices', () => {
    const reserved = new Set<number>([
      DERIVATION_INDEX.REWARD_DRAW,
      ...Array.from({ length: 8 }, (_, i) => DERIVATION_INDEX.INITIATIVE_BASE + i),
    ]);
    for (let turn = 1; turn <= 1000; turn++) {
      for (let slot = 0; slot < 16; slot++) {
        expect(reserved.has(turnIndex(turn, slot))).toBe(false);
      }
    }
  });

  it('rejects invalid turn numbers and slots', () => {
    expect(() => turnIndex(0)).toThrow();
    expect(() => turnIndex(1, 16)).toThrow();
    expect(() => turnIndex(1, -1)).toThrow();
  });
});

describe('rollFormula', () => {
  it('returns one die face per die and sums correctly', () => {
    const r = rollFormula(SEED, 100, { count: 3, sides: 6, modifier: 2 }, 4);
    expect(r.dice).toHaveLength(3);
    expect(r.raw).toBe(r.dice.reduce((a, b) => a + b, 0));
    expect(r.modifier).toBe(6);
    expect(r.total).toBe(r.raw + 6);
  });

  it('is fully deterministic', () => {
    const f = { count: 2, sides: 8, modifier: 1 } as const;
    expect(rollFormula(SEED, 42, f)).toEqual(rollFormula(SEED, 42, f));
  });

  it('rejects a zero dice count', () => {
    expect(() => rollFormula(SEED, 0, { count: 0, sides: 6, modifier: 0 })).toThrow();
  });
});

describe('parseDiceFormula', () => {
  it('round-trips through formatDiceFormula', () => {
    for (const s of ['1d6', '2d8+3', '3d10-2', '1d20']) {
      expect(formatDiceFormula(parseDiceFormula(s))).toBe(s);
    }
  });

  it('tolerates whitespace', () => {
    expect(parseDiceFormula('  2d6 + 1 ')).toEqual({ count: 2, sides: 6, modifier: 1 });
  });

  it('rejects malformed and unsupported formulas', () => {
    for (const s of ['d6', '2x6', '2d7', '2d6+', 'abc', '']) {
      expect(() => parseDiceFormula(s)).toThrow();
    }
  });
});

describe('golden vectors (pin the derivation)', () => {
  it('matches known seed -> known output', () => {
    // If this fails, the derivation changed and every past run's published
    // verification data is now unreproducible. Bump DICE_ALGO_VERSION instead.
    expect(DICE_ALGO_VERSION).toBe('dice-v1');
    expect(toHex(deriveHash(SEED, 0)).slice(0, 16)).toMatchInlineSnapshot(`"30b7e7c52d70be38"`);
    expect([
      rollDie(SEED, DERIVATION_INDEX.INITIATIVE_BASE, 20),
      rollDie(SEED, turnIndex(1, 0), 20),
      rollDie(SEED, turnIndex(1, 1), 6),
      deriveValue(SEED, DERIVATION_INDEX.REWARD_DRAW, 10_000),
    ]).toMatchInlineSnapshot(`
      [
        13,
        19,
        3,
        520,
      ]
    `);
  });
});

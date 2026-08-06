/**
 * Stat derivation tests (06-mvp-roadmap.md Phase 2: "unit tested with known
 * seeds -> known outputs").
 *
 * The anti-spoofing tests matter most: they assert that rewriting an NFT's
 * metadata cannot meaningfully inflate a character, per 01-game-design.md#4c.
 *
 * Under stats-v3 those tests got easier to state, because metadata no longer
 * reaches class or rarity at all — class comes from the curated allowlist
 * (classes.ts) and rarity from the current holder's tenure (rarity.ts). What
 * remains here is the one holder-influenced input: the bounded per-stat
 * metadata bonus.
 *
 * `CONTRACT` is a real supported collection rather than a mock, because there is
 * no longer such a thing as stats for an unlisted one — see the
 * `UNSUPPORTED` block at the bottom, which pins that.
 */

import { describe, it, expect } from 'vitest';
import {
  STATS_ALGO_VERSION,
  defenseDc,
  deriveCharacter,
  deriveStats,
  statModifier,
  type NftMetadata,
} from '../src/stats.js';
import { UnsupportedCollectionError, deriveClass } from '../src/classes.js';
import { rarityFromHoldDays } from '../src/rarity.js';

/** Rogue, per the allowlist. */
const CONTRACT = 'SP16SRR777TVB1WS5XSS9QT3YEZEC9JQFKYZENRAJ.bitcoin-pepe';
/** Not in the allowlist: no class, therefore no stats. */
const UNSUPPORTED = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.mock-nft';

describe('determinism', () => {
  it('returns identical stats for identical inputs', () => {
    expect(deriveStats(CONTRACT, '1')).toEqual(deriveStats(CONTRACT, '1'));
  });

  it('is case-insensitive on the contract id', () => {
    expect(deriveStats(CONTRACT.toUpperCase(), '1')).toEqual(
      deriveStats(CONTRACT.toLowerCase(), '1'),
    );
  });

  it('produces different stats per token', () => {
    const a = deriveStats(CONTRACT, '1');
    const b = deriveStats(CONTRACT, '2');
    expect(a).not.toEqual(b);
  });

  it('rejects an unknown algo version rather than silently using the current one', () => {
    expect(() => deriveStats(CONTRACT, '1', null, 0, null, 'stats-v99')).toThrow();
  });
});

describe('bounds', () => {
  it('keeps every stat positive across many tokens', () => {
    for (let i = 0; i < 400; i++) {
      const s = deriveStats(CONTRACT, String(i));
      expect(s.hp).toBeGreaterThan(0);
      expect(s.str).toBeGreaterThan(0);
      expect(s.agi).toBeGreaterThan(0);
      expect(s.int).toBeGreaterThan(0);
      expect(s.vit).toBeGreaterThan(0);
    }
  });

  it('gives every token in the collection the same class', () => {
    // The hash fallback this replaced spread one collection across all four
    // classes. A collection is now one class, by definition.
    const classes = new Set<string>();
    for (let i = 0; i < 400; i++) classes.add(deriveClass(CONTRACT, String(i))!.classId);
    expect([...classes]).toEqual(['rogue']);
  });

  it('produces every rarity tier across a range of hold durations', () => {
    const rarities = new Set<string>();
    for (const days of [0, 30, 90, 180, 365, 730, 5_000]) rarities.add(rarityFromHoldDays(days));
    expect(rarities.size).toBe(6);
  });
});

describe('hold duration drives power (01-game-design.md#4b)', () => {
  it('scales stats up as the current holder’s tenure grows', () => {
    const fresh = deriveStats(CONTRACT, '7', null, 0);
    const mythic = deriveStats(CONTRACT, '7', null, 800);
    expect(mythic.hp).toBeGreaterThan(fresh.hp);
    expect(mythic.str).toBeGreaterThan(fresh.str);
    expect(mythic.vit).toBeGreaterThan(fresh.vit);
  });

  it('treats a failed hold-duration lookup as freshly acquired, never as an error', () => {
    const fresh = deriveStats(CONTRACT, '7', null, 0);
    expect(deriveStats(CONTRACT, '7', null, -1)).toEqual(fresh);
    expect(deriveStats(CONTRACT, '7', null, Number.NaN)).toEqual(fresh);
  });

  it('resets to Common the moment the clock resets — the transfer invariant', () => {
    // The buyer of a two-year-old Mythic gets a Common. See rarity.ts's header;
    // the end-to-end version of this runs against a real devnet transfer.
    const seller = deriveCharacter({ contractId: CONTRACT, tokenId: '7', holdDays: 800 });
    const buyer = deriveCharacter({ contractId: CONTRACT, tokenId: '7', holdDays: 0 });
    expect(seller.rarityTier).toBe('mythic');
    expect(buyer.rarityTier).toBe('common');
    expect(buyer.stats.hp).toBeLessThan(seller.stats.hp);
    // ...but the class does not move. It is a fact about the token, not the holder.
    expect(buyer.classId).toBe(seller.classId);
  });
});

describe('anti-spoofing (01-game-design.md#4c)', () => {
  const huge: NftMetadata = {
    attributes: [
      { trait_type: 'str', value: 9_999_999 },
      { trait_type: 'agi', value: 9_999_999 },
      { trait_type: 'int', value: 9_999_999 },
      { trait_type: 'vit', value: 9_999_999 },
      { trait_type: 'hp', value: 9_999_999 },
    ],
  };

  it('clamps an absurd metadata bonus to a small bounded amount', () => {
    const base = deriveStats(CONTRACT, '7');
    const spoofed = deriveStats(CONTRACT, '7', huge);
    expect(spoofed.str - base.str).toBeLessThanOrEqual(4);
    expect(spoofed.vit - base.vit).toBeLessThanOrEqual(4);
    expect(spoofed.hp - base.hp).toBeLessThanOrEqual(20);
  });

  it('clamps negative metadata symmetrically', () => {
    const base = deriveStats(CONTRACT, '7');
    const negative = deriveStats(CONTRACT, '7', {
      attributes: [{ trait_type: 'str', value: -9_999_999 }],
    });
    expect(base.str - negative.str).toBeLessThanOrEqual(4);
  });

  it('ignores unknown traits and non-numeric values', () => {
    const base = deriveStats(CONTRACT, '7');
    expect(
      deriveStats(CONTRACT, '7', {
        attributes: [
          { trait_type: 'luck', value: 500 },
          { trait_type: 'str', value: 'over nine thousand' },
          { trait_type: undefined, value: 5 },
        ],
      }),
    ).toEqual(base);
  });

  it('treats null and empty metadata as the base', () => {
    const base = deriveStats(CONTRACT, '7');
    expect(deriveStats(CONTRACT, '7', null)).toEqual(base);
    expect(deriveStats(CONTRACT, '7', {})).toEqual(base);
    expect(deriveStats(CONTRACT, '7', { attributes: [] })).toEqual(base);
  });

  it('cannot change class or rarity via metadata — neither reads it', () => {
    const plain = deriveCharacter({ contractId: CONTRACT, tokenId: '7', holdDays: 100 });
    const spoofed = deriveCharacter({
      contractId: CONTRACT,
      tokenId: '7',
      holdDays: 100,
      metadata: {
        ...huge,
        attributes: [
          ...(huge.attributes ?? []),
          { trait_type: 'class', value: 'mage' },
          { trait_type: 'rarity', value: 'mythic' },
        ],
      },
    });
    expect(spoofed.classId).toBe(plain.classId);
    expect(spoofed.rarityTier).toBe(plain.rarityTier);
  });
});

describe('deriveCharacter (one computation, consistent fields)', () => {
  it('publishes the same holdDays the tier was computed from', () => {
    const c = deriveCharacter({ contractId: CONTRACT, tokenId: '3', holdDays: -5 });
    expect(c.holdDays).toBe(0);
    expect(c.rarityTier).toBe(rarityFromHoldDays(c.holdDays));
  });

  it('agrees with the standalone derivations it composes', () => {
    const c = deriveCharacter({ contractId: CONTRACT, tokenId: '42', holdDays: 200 });
    const cls = deriveClass(CONTRACT, '42', null)!;
    expect(c.classId).toBe(cls.classId);
    expect(c.className).toBe(cls.className);
    expect(c.classSource).toBe(cls.classSource);
    expect(c.rarityTier).toBe('epic');
    expect(c.stats).toEqual(deriveStats(CONTRACT, '42', null, 200));
    expect(c.algoVersion).toBe(STATS_ALGO_VERSION);
  });

  it('honors a minted class over the collection mapping', () => {
    const c = deriveCharacter({ contractId: CONTRACT, tokenId: '42', mintedClassId: 'mage' });
    expect(c.classId).toBe('mage');
    expect(c.classSource).toBe('mint');
    // ...and the stats follow the chosen class, not the collection's.
    expect(c.stats).toEqual(deriveStats(CONTRACT, '42', null, 0, 'mage'));
  });
});

describe('an unsupported collection has no stats at all', () => {
  it('throws rather than defaulting to a class', () => {
    // A default here would be the hash fallback under a shorter name: every NFT
    // on Stacks would have a stat block again, with only a caller-side filter
    // between it and a player.
    expect(() => deriveStats(UNSUPPORTED, '1')).toThrow(UnsupportedCollectionError);
    expect(() => deriveCharacter({ contractId: UNSUPPORTED, tokenId: '1' })).toThrow(
      UnsupportedCollectionError,
    );
  });

  it('names the pair it refused, so the caller can say which token', () => {
    expect(() => deriveStats(UNSUPPORTED, '9')).toThrow(/mock-nft/);
  });

  it('still derives when the token is one of our own mints', () => {
    // Our `character-nft` contract is deliberately not in the allowlist; its
    // class arrives as `mintedClassId` instead. Without that path, every
    // character a player bought would throw.
    const c = deriveCharacter({
      contractId: UNSUPPORTED,
      tokenId: '1',
      mintedClassId: 'paladin',
    });
    expect(c.classId).toBe('paladin');
    expect(c.classSource).toBe('mint');
  });
});

describe('combat helpers', () => {
  it('computes D&D-style modifiers', () => {
    expect(statModifier(10)).toBe(0);
    expect(statModifier(11)).toBe(0);
    expect(statModifier(12)).toBe(1);
    expect(statModifier(8)).toBe(-1);
    expect(statModifier(20)).toBe(5);
  });

  it('computes Defense DC as 10 + VIT/2', () => {
    expect(defenseDc({ hp: 100, str: 10, agi: 10, int: 10, vit: 20 })).toBe(20);
    expect(defenseDc({ hp: 100, str: 10, agi: 10, int: 10, vit: 15 })).toBe(17);
  });
});

describe('golden vectors (pin the derivation)', () => {
  it('matches known token -> known stats', () => {
    // If this fails, every character's stats just changed. Bump
    // STATS_ALGO_VERSION rather than editing a rule in place.
    expect(STATS_ALGO_VERSION).toBe('stats-v3');
    expect({
      token1Fresh: deriveStats(CONTRACT, '1', null, 0),
      token1Epic: deriveStats(CONTRACT, '1', null, 200),
      token1023: deriveStats(CONTRACT, '1023', null, 0),
      class1: deriveClass(CONTRACT, '1')!.classId,
      classSource1: deriveClass(CONTRACT, '1')!.classSource,
    }).toMatchInlineSnapshot(`
      {
        "class1": "rogue",
        "classSource1": "supported_collection",
        "token1023": {
          "agi": 24,
          "hp": 83,
          "int": 11,
          "str": 18,
          "vit": 9,
        },
        "token1Epic": {
          "agi": 48,
          "hp": 155,
          "int": 12,
          "str": 18,
          "vit": 22,
        },
        "token1Fresh": {
          "agi": 35,
          "hp": 100,
          "int": 9,
          "str": 13,
          "vit": 16,
        },
      }
    `);
  });
});

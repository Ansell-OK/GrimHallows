/**
 * Portrait resolver tests.
 *
 * Three properties carry the feature:
 *   - portraits are for OUR MINTS ONLY — a supported-collection token keeps its
 *     native NFT art, so the resolver must return undefined for it even when a
 *     matching file exists;
 *   - RARE IS THE BASE LAYER — there are only 4 tiers of art (rare, epic,
 *     legendary, mythic), so Common and Uncommon mints resolve to the RARE
 *     portrait; the display tier is max(rarity, 'rare');
 *   - the portrait is keyed on (class, tier), so as a mint climbs from Rare into
 *     Epic/Legendary/Mythic the resolved art changes.
 *
 * The 16 real files (4 classes × 4 tiers, `.jpg`) are present, so the real
 * `portraitFor` is exercised against the actual bundle rather than a stub.
 */

import { describe, expect, it } from 'vitest';
import {
  PORTRAIT_FLOOR,
  indexPortraits,
  portraitFor,
  portraitRarity,
  portraitStem,
  resolvePortrait,
} from '../src/lib/portraits';

/** A fake glob module map, keyed like Vite's paths and using the real `.jpg`. */
const FAKE_MODULES: Record<string, string> = {
  '../assets/portraits/warrior-rare.jpg': '/assets/warrior-rare.hash.jpg',
  '../assets/portraits/warrior-epic.jpg': '/assets/warrior-epic.hash.jpg',
  '../assets/portraits/mage-mythic.jpg': '/assets/mage-mythic.hash.jpg',
};
const INDEX = indexPortraits(FAKE_MODULES);

describe('portraitRarity (rare is the base layer)', () => {
  it('floors Common and Uncommon up to Rare', () => {
    expect(portraitRarity('common')).toBe('rare');
    expect(portraitRarity('uncommon')).toBe('rare');
  });

  it('leaves Rare and above untouched', () => {
    for (const r of ['rare', 'epic', 'legendary', 'mythic'] as const) {
      expect(portraitRarity(r)).toBe(r);
    }
  });

  it('exposes the floor it clamps to', () => {
    expect(PORTRAIT_FLOOR).toBe('rare');
  });
});

describe('portraitStem', () => {
  it('formats as {class}-{tier}, using the floored tier', () => {
    expect(portraitStem('warrior', 'rare')).toBe('warrior-rare');
    expect(portraitStem('mage', 'mythic')).toBe('mage-mythic');
    // Common floors to rare in the stem, so it points at the rare art.
    expect(portraitStem('warrior', 'common')).toBe('warrior-rare');
  });
});

describe('indexPortraits', () => {
  it('keys by the bare filename stem, dropping path and extension', () => {
    expect(INDEX['warrior-rare']).toBe('/assets/warrior-rare.hash.jpg');
    expect(INDEX['mage-mythic']).toBe('/assets/mage-mythic.hash.jpg');
  });

  it('strips both .jpg and .jpeg, case-insensitively', () => {
    const idx = indexPortraits({
      '../assets/portraits/Rogue-Epic.JPG': '/x.jpg',
      '../assets/portraits/paladin-rare.jpeg': '/y.jpeg',
    });
    expect(idx['rogue-epic']).toBe('/x.jpg');
    expect(idx['paladin-rare']).toBe('/y.jpeg');
  });

  it('is empty for an empty module map', () => {
    expect(indexPortraits({})).toEqual({});
  });
});

describe('resolvePortrait', () => {
  it('returns the matching portrait for one of our mints', () => {
    expect(resolvePortrait(INDEX, 'mint', 'warrior', 'rare')).toBe(
      '/assets/warrior-rare.hash.jpg',
    );
  });

  it('resolves a Common mint to the Rare portrait — the base layer', () => {
    expect(resolvePortrait(INDEX, 'mint', 'warrior', 'common')).toBe(
      '/assets/warrior-rare.hash.jpg',
    );
    expect(resolvePortrait(INDEX, 'mint', 'warrior', 'uncommon')).toBe(
      '/assets/warrior-rare.hash.jpg',
    );
  });

  it('never returns a portrait for a supported collection — native art wins', () => {
    // The "our mints only" guarantee: even with the file right there in the
    // index, a supported-collection token must fall through to its NFT image.
    expect(resolvePortrait(INDEX, 'supported_collection', 'warrior', 'rare')).toBeUndefined();
  });

  it('keys on tier, so a mint’s portrait swaps as its rarity climbs', () => {
    const rare = resolvePortrait(INDEX, 'mint', 'warrior', 'rare');
    const epic = resolvePortrait(INDEX, 'mint', 'warrior', 'epic');
    expect(rare).toBe('/assets/warrior-rare.hash.jpg');
    expect(epic).toBe('/assets/warrior-epic.hash.jpg');
    expect(epic).not.toBe(rare);
  });

  it('returns undefined for a mint whose art is not in the bundle yet', () => {
    // paladin has no file in FAKE_MODULES: the caller falls back to imageUrl.
    expect(resolvePortrait(INDEX, 'mint', 'paladin', 'legendary')).toBeUndefined();
  });
});

describe('portraitFor (real bundle — 16 files present)', () => {
  const CLASSES = ['warrior', 'paladin', 'rogue', 'mage'] as const;
  const TIERS = ['rare', 'epic', 'legendary', 'mythic'] as const;

  it('resolves every class × tier to a bundled .jpg URL', () => {
    for (const c of CLASSES) {
      for (const t of TIERS) {
        const url = portraitFor('mint', c, t);
        expect(url, `${c}-${t}`).toBeTruthy();
        expect(url).toMatch(/\.jpg/i);
      }
    }
  });

  it('shows the Rare portrait for Common and Uncommon mints', () => {
    for (const c of CLASSES) {
      const rare = portraitFor('mint', c, 'rare');
      expect(portraitFor('mint', c, 'common')).toBe(rare);
      expect(portraitFor('mint', c, 'uncommon')).toBe(rare);
    }
  });

  it('still returns undefined for supported collections', () => {
    expect(portraitFor('supported_collection', 'warrior', 'mythic')).toBeUndefined();
  });
});

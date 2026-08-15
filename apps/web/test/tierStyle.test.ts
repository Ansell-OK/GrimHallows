/**
 * Tier → presentation, and why every function clamps instead of throwing.
 *
 * The duplicated `tierAccent`/`tierBorder` helpers grew their own copies on three
 * screens because tier presentation was "too trivial to test". Trivial to read
 * and trivial to diverge are the same property: the forge's copy was one edit
 * away from shipping a gold legendary while the inventory showed purple, and no
 * test would have caught it. This module collapses them, so its tests are cheap
 * insurance that the four call sites (inventory, loadout picker, forge, and now
 * the reward screen's loot card) are telling the same story about a tier.
 *
 * The clamping matters because of what feeds these functions. A tier here comes
 * from an API response, not from `shared`'s validated table draw: `reward.tier`
 * is a database column that a future schema migration or a hand-edited row can
 * hold 0, 5, or garbage in. The reward screen must render a legible card for all
 * of those, because a blank or crashed screen over a corrupted row makes the
 * corruption worse. So out-of-range resolves to the top tier for colours — a
 * tier that is 5 is more plausibly a newer, higher tier than a corrupt one —
 * and to the nearest valid name for text.
 *
 * Each test below carries its why. Read them with the tier ladder in mind:
 * 1=rare, 2=epic, 3=mythic, 4=legendary (`MAX_POWER_UP_TIER` is 4 and the tier
 * order is a contract-level fact — see `LOOT_TIER_NAMES` in shared/rewards).
 */

import { describe, expect, it } from 'vitest';
import {
  clampTier,
  tierAccent,
  tierBorder,
  tierBorderAlways,
  tierDot,
  tierName,
  tierTitle,
} from '../src/lib/tierStyle';

describe('clampTier', () => {
  it('is the identity on the four live tiers', () => {
    // The safe cases are the common ones — pass-through must never perturb them.
    expect(clampTier(1)).toBe(1);
    expect(clampTier(4)).toBe(4);
  });

  it('resolves below-range tiers to 1 rather than to an invalid name', () => {
    // `tierName(0)` must not be `LOOT_TIER_NAMES[-1]` (undefined) — that is the
    // corrupt-row case a reward screen has to survive, not crash on.
    expect(clampTier(0)).toBe(1);
    expect(clampTier(-3)).toBe(1);
  });

  it('resolves above-range tiers to the top tier, not to undefined', () => {
    // A tier of 5 is most likely a future, higher tier — flooring it to 4 keeps
    // the row legible while the real tier 5 rolls out.
    expect(clampTier(5)).toBe(4);
    expect(clampTier(99)).toBe(4);
  });

  it('treats non-numeric and fractional input as a tier of 1', () => {
    // `Number.isInteger` is the strict check used elsewhere; a fractional or
    // NaN tier means the column held something that was never a tier at all.
    expect(clampTier(Number.NaN)).toBe(1);
    expect(clampTier(2.7)).toBe(2);
    expect(clampTier(Infinity)).toBe(4);
  });
});

describe('tierAccent', () => {
  it('climbs blue → void → blood → gold across the tier ladder', () => {
    // The ladder's own ordering: rare (blue) through legendary (gold). The
    // colour ramp is what tells the tiers apart on cards, so it must follow the
    // same direction as the names.
    expect(tierAccent(1)).toBe('text-blue-400');
    expect(tierAccent(2)).toBe('text-void');
    expect(tierAccent(3)).toBe('text-blood');
    expect(tierAccent(4)).toBe('text-gold');
  });

  it('resolves out-of-range tiers upward to legendary gold', () => {
    expect(tierAccent(0)).toBe('text-blue-400');
    expect(tierAccent(5)).toBe('text-gold');
  });
});

describe('tierBorder', () => {
  it('is always the neutral stone when unselected, whatever the tier', () => {
    // Selection is the message here — an unselected card that glows gold would
    // steal the selected card's only channel for saying "picked".
    expect(tierBorder(4, false)).toBe('border-stone');
    expect(tierBorder(1, false)).toBe('border-stone');
  });

  it('shows the tier colour only when selected', () => {
    expect(tierBorder(1, true)).toBe('border-blue-400');
    expect(tierBorder(2, true)).toBe('border-void');
    expect(tierBorder(3, true)).toBe('border-blood');
    expect(tierBorder(4, true)).toBe('border-gold');
  });
});

describe('tierBorderAlways', () => {
  it('is the selected border — the always-lit card has no neutral state', () => {
    // The reward screen's loot card is always lit, so its border is the tier's
    // colour with the selection condition folded in. This test pins that
    // `tierBorderAlways` and the selected state of the pickers never diverge.
    expect(tierBorderAlways(1)).toBe(tierBorder(1, true));
    expect(tierBorderAlways(4)).toBe(tierBorder(4, true));
  });
});

describe('tierDot', () => {
  it('tracks the accent but for background colours', () => {
    // The inventory's corner marker uses a background swatch; the mapping must
    // stay in step with the text ramp so a card's dot and its tier name never
    // disagree about what tier is being shown.
    expect(tierDot(1)).toBe('bg-blue-400');
    expect(tierDot(2)).toBe('bg-void');
    expect(tierDot(3)).toBe('bg-blood');
    expect(tierDot(4)).toBe('bg-gold');
  });
});

describe('tierName / tierTitle', () => {
  it('maps the tier numbers to the contract-level name order', () => {
    // These are the words `LOOT_TIER_NAMES` puts on chain order — rare before
    // legendary — and the order is itself a contract fact (see the array in
    // shared/rewards), not a display preference.
    expect(tierName(1)).toBe('rare');
    expect(tierName(2)).toBe('epic');
    expect(tierName(3)).toBe('mythic');
    expect(tierName(4)).toBe('legendary');
  });

  it('clamps out-of-range tiers to the nearest valid name instead of throwing', () => {
    expect(tierName(0)).toBe('rare');
    expect(tierName(7)).toBe('legendary');
  });

  it('is title case for headings', () => {
    // `tierItemName` used to be tested below this and is gone: loot has an
    // archetype now, so a drop is named by `lootDisplayName(slug, tier)` in
    // shared, which owns the nouns. `tierTitle` outlived it because casing a
    // rarity word is presentation, and the heading on the reward card still
    // wants one.
    expect(tierTitle(1)).toBe('Rare');
    expect(tierTitle(4)).toBe('Legendary');
  });
});

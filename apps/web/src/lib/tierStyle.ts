/**
 * The one place a loot tier becomes a colour or a name.
 *
 * A tier is a bare integer 1–4 everywhere it travels — on chain in
 * `character-loot-nft`'s `{uri, tier}`, in `EquippablePowerUp.tier`, in a run's
 * `reward.tier`. Turning it into something a player can read is therefore pure
 * presentation, and it was duplicated verbatim in three screens
 * (`pages/Inventory.tsx`, `components/ui/LoadoutPicker.tsx`, `pages/Forge.tsx`).
 * Three copies of a four-line switch is tolerable; the reward screen's loot card
 * is a fourth, and four copies of a colour ramp is how a legendary ends up gold
 * in the forge and purple in the inventory. Hence this module.
 *
 * THE CLASS NAMES ARE SPELT OUT ON PURPOSE, and must stay that way. Tailwind v4
 * finds utilities by scanning source text for literal class names (this app has
 * no config file — the palette is declared in `index.css`'s `@theme`). Collapsing
 * these into one `TIER_COLORS = ['blue-400', 'void', …]` array and building
 * `text-${colour}` would read better and would compile — and would then ship with
 * every tier colour purged out of the stylesheet, because no literal `text-gold`
 * appears anywhere for the scanner to find. The repetition below is the cost of
 * that scanner, not an oversight.
 *
 * NOTHING HERE THROWS. `lootTierName` in `shared` asserts its range, which is
 * correct for a function whose output goes on chain in a metadata URI — but a
 * tier reaching this module has come from an API response, and a `reward.tier` of
 * 0 or 5 from a row written by a future version must not be able to blank a
 * player's reward screen. So every function clamps into range instead, and the
 * out-of-range direction resolves upward to the top tier for colours (an unknown
 * tier is more likely new-and-higher than corrupt) while names go through a
 * clamp that keeps `tierName` total.
 */

import { LOOT_TIER_NAMES, MAX_POWER_UP_TIER, type LootTierName } from '@grimhallow/shared';

/**
 * A tier clamped into `[1, MAX_POWER_UP_TIER]`.
 *
 * `NaN` is the only input with no sensible direction to clamp toward — it is not
 * high or low, it is "this column did not hold a number" — so it takes the floor.
 * Infinities do have a direction and follow it, which keeps the rule "anything
 * above the range reads as the top tier" true without an exception.
 */
export function clampTier(tier: number): number {
  if (Number.isNaN(tier)) return 1;
  const whole = Math.floor(tier);
  if (whole < 1) return 1;
  if (whole > MAX_POWER_UP_TIER) return MAX_POWER_UP_TIER;
  return whole;
}

/** Text colour for a tier: blue → void → blood → gold as it climbs. */
export function tierAccent(tier: number): string {
  if (tier >= 4) return 'text-gold';
  if (tier === 3) return 'text-blood';
  if (tier === 2) return 'text-void';
  return 'text-blue-400';
}

/**
 * Border colour for a selectable card.
 *
 * Unselected is deliberately `border-stone` regardless of tier: the tier colour
 * is what selection *communicates* on these pickers, so colouring an unselected
 * card would leave nothing for the selected state to say.
 */
export function tierBorder(tier: number, selected: boolean): string {
  if (!selected) return 'border-stone';
  if (tier >= 4) return 'border-gold';
  if (tier === 3) return 'border-blood';
  if (tier === 2) return 'border-void';
  return 'border-blue-400';
}

/** Border colour for a card that is always lit — no selection state to express. */
export function tierBorderAlways(tier: number): string {
  return tierBorder(tier, true);
}

/** Background colour for the small corner marker on an inventory card. */
export function tierDot(tier: number): string {
  if (tier >= 4) return 'bg-gold';
  if (tier === 3) return 'bg-blood';
  if (tier === 2) return 'bg-void';
  return 'bg-blue-400';
}

/** `'rare' | 'epic' | 'mythic' | 'legendary'`, clamped rather than asserted. */
export function tierName(tier: number): LootTierName {
  return LOOT_TIER_NAMES[clampTier(tier) - 1];
}

/** Title case, for a heading: `Legendary`. */
export function tierTitle(tier: number): string {
  const name = tierName(tier);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/*
 * `tierItemName(tier)` — `Mythic Power-Up` — lived here between Phase 1 and
 * Phase 4 and has been removed rather than kept as a fallback.
 *
 * It was a stopgap for loot having no identity beyond its tier, and it predicted
 * it would become the fallback for a token whose URI carries no archetype. That
 * fallback exists, but not here: an unparseable URI degrades to `relic`, and
 * `lootDisplayName('relic', tier)` already answers `Mythic Relic`. Two spellings
 * of the same fallback is how a screen ends up naming one item two ways, so
 * naming now has exactly one home — the shared module that also owns the nouns.
 */

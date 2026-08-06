/**
 * Rarity derivation — from the CURRENT holder's hold duration, nothing else.
 *
 * Per 01-game-design.md#4b. Shared by the API and any verification tooling so
 * two implementations can never drift.
 *
 * THE RULE THAT MATTERS: rarity is not a property of the token. It is a
 * property of *this wallet's tenure holding this token*, and **any transfer
 * resets it to zero for the new owner**. It is not cumulative across past
 * owners. Selling a two-year-old Mythic hands the buyer a Common.
 *
 * That is a deliberate anti-flip mechanism, and it has two consequences worth
 * keeping in view rather than discovering later:
 *
 *   - Rarity cannot be bought. There is no transaction that produces a
 *     high-tier character, which is what makes it a fair power lever in a game
 *     where everything else is purchasable.
 *   - The reset cannot distinguish "sold" from "moved". Consolidating wallets
 *     or migrating to a hardware wallet wipes the clock exactly as thoroughly
 *     as a sale does. There is no on-chain signal that separates the two, so
 *     this is a real cost borne by honest holders, not an edge case. Flagged in
 *     07-glossary-and-open-questions.md #10 for retuning against real data.
 *
 * Consequently the acquisition timestamp is NOT permanently cacheable — see
 * `nft_holder_age_cache` in 05-data-model.md and the owner-scoped invalidation
 * rule in 02-architecture.md#4.
 */

import type { Rarity } from './types.js';

/**
 * Tiers in ascending order, by the current holder's hold duration in days.
 *
 * `minHoldDays` is INCLUSIVE and the tiers are contiguous, so exactly 30 days
 * is Uncommon rather than Common. The doc's ranges ("0-30", "30-90") overlap at
 * the boundary and something has to break the tie; taking the higher tier means
 * a player never watches a threshold pass without their character changing.
 *
 * These numbers are conservative defaults, explicitly flagged in the design doc
 * as "tune from real data post-launch". Retuning them reassigns the tier of
 * every character at once and changes derived stats, so it is a
 * `STATS_ALGO_VERSION` bump, not a config edit.
 */
export const RARITY_TIERS = [
  { rarity: 'common', minHoldDays: 0, multiplier: 1.0 },
  { rarity: 'uncommon', minHoldDays: 30, multiplier: 1.1 },
  { rarity: 'rare', minHoldDays: 90, multiplier: 1.2 },
  { rarity: 'epic', minHoldDays: 180, multiplier: 1.35 },
  { rarity: 'legendary', minHoldDays: 365, multiplier: 1.5 },
  { rarity: 'mythic', minHoldDays: 730, multiplier: 1.75 },
] as const satisfies readonly {
  readonly rarity: Rarity;
  readonly minHoldDays: number;
  readonly multiplier: number;
}[];

/** Ascending, weakest first. Useful for sorting and for UI legends. */
export const RARITY_ORDER: readonly Rarity[] = RARITY_TIERS.map((t) => t.rarity);

const MULTIPLIER_BY_RARITY: Record<Rarity, number> = Object.fromEntries(
  RARITY_TIERS.map((t) => [t.rarity, t.multiplier]),
) as Record<Rarity, number>;

/**
 * Hold duration -> tier.
 *
 * A non-finite or negative `holdDays` floors to Common rather than throwing.
 * The caller most likely to produce one is the holder-age lookup failing, and
 * 02-architecture.md#4 is explicit that the failure mode there is "treat it as
 * freshly acquired" — a temporary underestimate of rarity, never a broken
 * character-select screen.
 */
export function rarityFromHoldDays(holdDays: number): Rarity {
  if (!Number.isFinite(holdDays) || holdDays <= 0) return 'common';

  let result: Rarity = 'common';
  for (const tier of RARITY_TIERS) {
    if (holdDays >= tier.minHoldDays) result = tier.rarity;
    else break;
  }
  return result;
}

/** The stat multiplier for a tier. */
export function rarityMultiplier(rarity: Rarity): number {
  return MULTIPLIER_BY_RARITY[rarity] ?? 1.0;
}

/**
 * Days elapsed between an acquisition timestamp and now.
 *
 * Fractional on purpose — flooring here would make a character that crossed a
 * threshold an hour ago read as if it hadn't. `now` is injectable so this stays
 * pure and testable; the transfer-resets-rarity regression test depends on
 * being able to move it.
 */
export function holdDaysSince(acquiredAt: Date | number, now: Date | number = Date.now()): number {
  const acquiredMs = acquiredAt instanceof Date ? acquiredAt.getTime() : acquiredAt;
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(acquiredMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, (nowMs - acquiredMs) / 86_400_000);
}

/**
 * The next tier up and what it costs to get there, or null at Mythic.
 *
 * Published so the UI can show "18 days to Rare" instead of an opaque badge.
 * The thresholds are public anyway; making the next one legible is the
 * difference between a mechanic a player can act on and one that just happens
 * to them.
 */
export function nextRarityTier(
  holdDays: number,
): { readonly rarity: Rarity; readonly daysRemaining: number } | null {
  // Normalized the same way rarityFromHoldDays normalizes, and for the same
  // reason: a failed lookup reads as day zero. Math.max(0, NaN) is NaN, so
  // skipping this would ship "NaN days to Uncommon" to the UI.
  const safeHoldDays = Number.isFinite(holdDays) && holdDays > 0 ? holdDays : 0;

  const current = rarityFromHoldDays(safeHoldDays);
  const index = RARITY_ORDER.indexOf(current);
  const next = RARITY_TIERS[index + 1];
  if (!next) return null;
  return {
    rarity: next.rarity,
    daysRemaining: Math.max(0, next.minHoldDays - safeHoldDays),
  };
}

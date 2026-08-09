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

import { sha256 } from '@noble/hashes/sha2';
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
 * The higher of two tiers by RARITY_ORDER.
 *
 * Used to combine a mint floor with a tenure-derived tier — `max(floor, age)` —
 * so holding can only ever raise a character's rarity above its floor, never
 * lower it. See stats.ts `effectiveRarity`.
 */
export function maxRarity(a: Rarity, b: Rarity): Rarity {
  return RARITY_ORDER.indexOf(a) >= RARITY_ORDER.indexOf(b) ? a : b;
}

/**
 * The mint-floor roll table — the random base rarity a freshly minted
 * `character-nft` token is guaranteed before it has been held for any time.
 *
 * This is the one place rarity is a property of the TOKEN rather than the
 * holder's tenure, and it exists ONLY for our own mints (`classSource ===
 * 'mint'`); the eight supported collections stay pure-tenure and never roll a
 * floor. The floor is DERIVED, not stored, so it travels with the token across
 * transfers and cannot be rerolled by a free self-transfer (only a real new
 * mint rolls a fresh one, at a real 1-STX cost). See stats.ts
 * `effectiveRarity`, which combines this floor with the tenure tier via
 * `maxRarity`.
 *
 * WHY THE ROLL NEEDS A SEED FROM THE CHAIN. An earlier version of this derived
 * the floor from `(contractId, tokenId)` alone, which is precomputable and so
 * gameable: `character-nft` hands out sequential ids and `get-last-token-id` is
 * public, so anyone could hash `lastId + 1` off chain, learn the floor before
 * paying, and mint only when it came up Rare. The published 60/30/10 table would
 * then describe nobody's actual odds. `mintFloorFromSeed` therefore requires a
 * `mintSeed` — the hash of the block that confirmed the mint — which is not
 * knowable when the transaction is signed and cannot be chosen by the minter.
 *
 * The recipient principal was the other candidate and is NOT sufficient: the
 * minter is `tx-sender`, keypairs are free to generate off chain, so an address
 * could simply be ground against the predicted token id. The acquisition block
 * fails the other way — it moves on transfer, which would make the floor
 * re-rollable for the price of sending a token to yourself.
 *
 * Capped at Rare on purpose: Epic, Legendary and Mythic remain reachable only
 * by holding (01-game-design.md#4b keeps the top tiers a tenure reward, so mint
 * luck can seed a run but never buy a top-tier character, and mint stays a
 * purchase rather than a wager). Like RARITY_TIERS these weights are tunable —
 * but retuning them re-rolls every mint's floor and changes derived stats, so it
 * is a `STATS_ALGO_VERSION` bump, not a config edit.
 *
 * Weights are out of 10000; the total is computed from the table so a retune
 * stays consistent with the roll in `mintFloorFromIdentity`.
 */
export const MINT_FLOOR_TIERS = [
  { rarity: 'common', weight: 6000 },
  { rarity: 'uncommon', weight: 3000 },
  { rarity: 'rare', weight: 1000 },
] as const satisfies readonly { readonly rarity: Rarity; readonly weight: number }[];

const MINT_FLOOR_WEIGHT_TOTAL = MINT_FLOOR_TIERS.reduce((sum, t) => sum + t.weight, 0);

/**
 * The deterministic mint floor for a token, as a weighted roll over
 * MINT_FLOOR_TIERS.
 *
 * `mintSeed` is the hash of the block that confirmed the mint, and it is
 * REQUIRED rather than defaulted — see the note on MINT_FLOOR_TIERS for why a
 * floor derived from identity alone is gameable. A required parameter is the
 * cheapest guarantee that the precomputable version cannot come back by
 * omission: there is no way to call this without a seed. A caller that has not
 * resolved one yet must not guess a substitute; it serves the token with no
 * floor at all (stats.ts `effectiveRarity`) and rolls once the seed arrives.
 *
 * The digest is DOMAIN-SEPARATED from the stat digest in stats.ts (prefixed
 * `mint-floor::`) so a token's floor roll is statistically independent of its
 * stat rolls — the same identity feeding two hashes must not correlate them.
 * The seed is folded in on its own segment, lowercased like the contract id, so
 * a `0x`-prefixed and a bare hash of the same block roll identically rather
 * than becoming two different floors for one token.
 *
 * Four bytes (read unsigned) rather than two: reducing a 16-bit value modulo
 * 10000 skews ~3.4 points toward the low buckets (65536 % 10000 = 5536, all
 * landing in Common), which would quietly turn the 60/30/10 table into
 * ~63/27/9. A 32-bit value drops that bias to ~0.0002%, so the odds match the
 * table. `>>> 0` reads the top byte as unsigned.
 */
export function mintFloorFromSeed(contractId: string, tokenId: string, mintSeed: string): Rarity {
  const seed = mintSeed.trim().toLowerCase().replace(/^0x/, '');
  const digest = sha256(
    new TextEncoder().encode(`mint-floor::${contractId.toLowerCase()}::${tokenId}::${seed}`),
  );
  const roll =
    (((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0) %
    MINT_FLOOR_WEIGHT_TOTAL;

  let cumulative = 0;
  for (const tier of MINT_FLOOR_TIERS) {
    cumulative += tier.weight;
    if (roll < cumulative) return tier.rarity;
  }
  // Unreachable: roll < total and the weights sum to total, so the last tier
  // always claims any remaining roll. Return the top of the table defensively.
  return MINT_FLOOR_TIERS[MINT_FLOOR_TIERS.length - 1].rarity;
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
 *
 * `floor` is the token's mint floor (Common for a supported-collection token,
 * which has none). The "current" tier a player is climbing from is
 * `max(floor, age)`, not the age tier alone — otherwise a Rare-floored fresh
 * mint would be told "30 days to Uncommon" when it is already Rare and its real
 * next step is Epic. `daysRemaining` stays hold-time-based: the floor sets where
 * you start, tenure is still what carries you upward.
 */
export function nextRarityTier(
  holdDays: number,
  floor: Rarity = 'common',
): { readonly rarity: Rarity; readonly daysRemaining: number } | null {
  // Normalized the same way rarityFromHoldDays normalizes, and for the same
  // reason: a failed lookup reads as day zero. Math.max(0, NaN) is NaN, so
  // skipping this would ship "NaN days to Uncommon" to the UI.
  const safeHoldDays = Number.isFinite(holdDays) && holdDays > 0 ? holdDays : 0;

  const current = maxRarity(floor, rarityFromHoldDays(safeHoldDays));
  const index = RARITY_ORDER.indexOf(current);
  const next = RARITY_TIERS[index + 1];
  if (!next) return null;
  return {
    rarity: next.rarity,
    daysRemaining: Math.max(0, next.minHoldDays - safeHoldDays),
  };
}

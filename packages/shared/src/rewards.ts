/**
 * The paid-dungeon reward table, per 01-game-design.md#7 and
 * 03-smart-contracts-spec.md#3.
 *
 * CRITICAL — this is real money on mainnet. Every value here is derived from the
 * committed seed via `dice.ts` (`hash(seed || i) % range`). Nothing in this
 * module may consult `Math.random()`, the clock, the chain tip, or anything a
 * caller supplies beyond the seed itself. A player must be able to recompute
 * their own draw from the revealed seed and get the identical result, which is
 * why this lives in `/packages/shared` alongside the dice and is imported by the
 * backend rather than reimplemented there (02-architecture.md ground rules).
 *
 * Two things it deliberately does NOT do:
 *  - It never reads or writes the sponsor pool. It is handed a balance and
 *    returns a decision; moving STX is the contract's job.
 *  - It never considers the gate fee. Entry revenue and prize budget are two
 *    unrelated flows (02-architecture.md#3), and a reward table that knew how
 *    much had been paid in would quietly reintroduce the pari-mutuel model the
 *    whole design exists to avoid.
 *
 * Versioned: changing any odds or size below changes what historical runs would
 * have paid, so bump REWARD_ALGO_VERSION rather than editing a number in place
 * once runs exist on chain.
 */

import { DERIVATION_INDEX, deriveValue } from './dice.js';
import type { RewardKind, RewardResult } from './types.js';

export const REWARD_ALGO_VERSION = 'reward-v1' as const;

/**
 * Odds are expressed in basis points of a 10,000-way draw rather than as
 * floating-point percentages: `%` on a float is not reproducible across
 * languages, and a verifier reimplementing this in Python must land on the same
 * branch we did, every time.
 */
export const REWARD_DRAW_RANGE = 10_000;

/** 1% of paid runs roll the jackpot (operator decision, 2026-08-05). */
export const JACKPOT_ODDS_BPS = 100;

/** 30% roll a power-up NFT. The remaining 69% resolve to `none`. */
export const LOOT_ODDS_BPS = 3_000;

/**
 * Fixed jackpot: 10 STX.
 *
 * Fixed rather than a fraction of the pool so the number shown to a player
 * before they pay is the number they can win — a percentage-of-pool prize would
 * change between the map screen and the resolve. Operator-tunable: raising it
 * only changes future draws, and the degrade path below already covers the case
 * where the pool cannot currently cover it.
 */
export const JACKPOT_AMOUNT_USTX = 10_000_000n;

/**
 * Power-up tiers, lowest to highest. Index + 1 is the on-chain `tier` uint that
 * `character-loot-nft` stores and that `forge` validates recipes against, so
 * this array's order is a contract-level fact, not a display preference.
 */
export const LOOT_TIER_NAMES = ['rare', 'epic', 'mythic', 'legendary'] as const;

export type LootTierName = (typeof LOOT_TIER_NAMES)[number];

/**
 * Tier distribution within a loot drop, in basis points, lowest tier first.
 * Must sum to REWARD_DRAW_RANGE (asserted below).
 *
 * ASSUMPTION, flagged for the operator: the reward table's hit rates (1%
 * jackpot / 30% loot) were specified; the split *within* a loot drop was not.
 * Weighted hard toward tier 1 because 01-game-design.md#7 describes the dungeon
 * drop as "common tier" and because the forge (3-for-1, 03-smart-contracts-spec
 * #4) is meant to be the route to a high tier — a 2% direct legendary already
 * makes forging optional, and anything flatter would make it pointless. Change
 * these four numbers to retune; nothing else depends on their values.
 */
export const LOOT_TIER_WEIGHTS_BPS = [7_000, 2_000, 800, 200] as const;

const TIER_WEIGHT_TOTAL = LOOT_TIER_WEIGHTS_BPS.reduce((a, b) => a + b, 0);
if (TIER_WEIGHT_TOTAL !== REWARD_DRAW_RANGE) {
  // Thrown at import time on purpose: a table that does not sum to the draw
  // range silently makes the top tier unreachable, and that is not something to
  // discover from a player's resolve.
  throw new Error(
    `LOOT_TIER_WEIGHTS_BPS must sum to ${REWARD_DRAW_RANGE}; got ${TIER_WEIGHT_TOTAL}`,
  );
}

if (JACKPOT_ODDS_BPS + LOOT_ODDS_BPS > REWARD_DRAW_RANGE) {
  throw new Error(
    `Jackpot + loot odds exceed the draw range (${JACKPOT_ODDS_BPS} + ${LOOT_ODDS_BPS} > ${REWARD_DRAW_RANGE})`,
  );
}

/** Metadata URI for a dungeon-dropped power-up. Mirrors the forge's convention. */
export function lootUriForTier(tier: number): string {
  assertTier(tier);
  return `ipfs://grimhallow/power-up/tier-${tier}.json`;
}

export function lootTierName(tier: number): LootTierName {
  assertTier(tier);
  return LOOT_TIER_NAMES[tier - 1];
}

function assertTier(tier: number): void {
  if (!Number.isInteger(tier) || tier < 1 || tier > LOOT_TIER_NAMES.length) {
    throw new Error(`Loot tier must be an integer in [1, ${LOOT_TIER_NAMES.length}]; got ${tier}`);
  }
}

/**
 * The raw table draw, before any pool check.
 *
 * Split out from `drawReward` so verification tooling can show a player exactly
 * what the table said, independently of whether the pool happened to cover it —
 * "you rolled a jackpot and the pool was short" is a different statement from
 * "you rolled loot", and a player checking our work is entitled to both.
 */
export interface RewardDraw {
  readonly kind: RewardKind;
  /** The 0..9999 value the table was indexed with. Published for verification. */
  readonly roll: number;
  /** Set when `kind` is `jackpot`. */
  readonly amountUstx: bigint | null;
  /** Set when `kind` is `loot`. */
  readonly tier: number | null;
}

export function drawRewardTable(seed: string | Uint8Array): RewardDraw {
  const roll = deriveValue(seed, DERIVATION_INDEX.REWARD_DRAW, REWARD_DRAW_RANGE);

  if (roll < JACKPOT_ODDS_BPS) {
    return { kind: 'jackpot', roll, amountUstx: JACKPOT_AMOUNT_USTX, tier: null };
  }
  if (roll < JACKPOT_ODDS_BPS + LOOT_ODDS_BPS) {
    return { kind: 'loot', roll, amountUstx: null, tier: drawLootTier(seed) };
  }
  return { kind: 'none', roll, amountUstx: null, tier: null };
}

/** Which tier a loot drop mints at. Uses its own derivation index — see dice.ts. */
export function drawLootTier(seed: string | Uint8Array): number {
  const roll = deriveValue(seed, DERIVATION_INDEX.REWARD_TIER_DRAW, REWARD_DRAW_RANGE);
  let cursor = 0;
  for (let i = 0; i < LOOT_TIER_WEIGHTS_BPS.length; i++) {
    cursor += LOOT_TIER_WEIGHTS_BPS[i];
    if (roll < cursor) return i + 1;
  }
  // Unreachable: the weights are asserted to sum to the draw range at import.
  return LOOT_TIER_WEIGHTS_BPS.length;
}

/**
 * The reward as it will actually be submitted to `reveal-and-resolve`, after
 * applying the underfunded-pool degrade from 03-smart-contracts-spec.md#3.
 *
 * `sponsorPoolUstx` must be the balance read live from `get-sponsor-pool`
 * immediately before resolving. Passing a cached or estimated value would make
 * the degrade decision disagree with the contract's own check, which is the one
 * that reverts.
 *
 * Note the contract's revert-on-insufficient-pool remains the hard backstop
 * (§3.3). This function exists to avoid *attempting* a doomed payout, not to be
 * the thing that prevents an over-payout.
 */
export function drawReward(seed: string | Uint8Array, sponsorPoolUstx: bigint): RewardResult {
  if (sponsorPoolUstx < 0n) {
    throw new Error(`Sponsor pool balance cannot be negative; got ${sponsorPoolUstx}`);
  }

  const draw = drawRewardTable(seed);

  if (draw.kind === 'jackpot') {
    const amount = draw.amountUstx as bigint;
    if (amount > sponsorPoolUstx) {
      // Degrade, don't skip: 01-game-design.md#7 promises a run is never a total
      // whiff, and the player did roll the top prize. They get the next tier
      // down, which costs the pool nothing because loot is minted fresh.
      const tier = drawLootTier(seed);
      return {
        kind: 'loot',
        amountUstx: null,
        lootUri: lootUriForTier(tier),
        tier,
        degraded: true,
      };
    }
    return {
      kind: 'jackpot',
      amountUstx: amount.toString(),
      lootUri: null,
      tier: null,
      degraded: false,
    };
  }

  if (draw.kind === 'loot') {
    const tier = draw.tier as number;
    return {
      kind: 'loot',
      amountUstx: null,
      lootUri: lootUriForTier(tier),
      tier,
      degraded: false,
    };
  }

  return { kind: 'none', amountUstx: null, lootUri: null, tier: null, degraded: false };
}

/** No reward at all — what a losing run resolves with. */
export const NO_REWARD: RewardResult = {
  kind: 'none',
  amountUstx: null,
  lootUri: null,
  tier: null,
  degraded: false,
};

/**
 * The single entry point the oracle's resolve step calls.
 *
 * Wraps `drawReward` with the win requirement, because "which runs get a draw at
 * all" is as much a part of the reward rule as the odds are, and a verifier
 * reproducing a payout needs both from one place. 01-game-design.md#7 rolls the
 * table on a paid-dungeon *completion*; a party that was wiped out did not
 * complete it, and still gets its rank credit either way (§8), which is emitted
 * by the contract on every resolve regardless of reward.
 */
export function resolveReward(args: {
  readonly seed: string | Uint8Array;
  readonly combatOutcome: 'win' | 'loss';
  readonly sponsorPoolUstx: bigint;
}): RewardResult {
  if (args.combatOutcome !== 'win') return NO_REWARD;
  return drawReward(args.seed, args.sponsorPoolUstx);
}

/**
 * The same table, drawn for a run that paid no gate fee (docs/09 B7).
 *
 * WHY FREE RUNS DRAW AT ALL. Loot is the forge's entire input supply, and forging
 * is meant to be its own progression path. Gating loot behind the gate fee left a
 * non-paying player unable to ever forge anything, which was a bug in the
 * free/paid split rather than a deliberate boundary.
 *
 * THE SPLIT IS BY REWARD TYPE, NOT BY DUNGEON TYPE. Loot mints fresh and costs
 * the sponsor pool nothing, so it drops everywhere. A jackpot is real STX out of
 * an owner-funded pool, and paying one on a free entry would mean the pool funds
 * prizes for runs that contributed no revenue — so the jackpot stays behind the
 * fee. `sponsorPoolUstx` is therefore not a parameter here at all: this function
 * cannot spend the pool, and could not be made to by passing it a balance.
 *
 * A ROLLED JACKPOT BECOMES `none`, NOT LOOT. Upgrading it would hand free runs
 * 31% loot against a paid run's 30% — a skew in the free direction, which B7
 * rules out as explicitly as the reverse ("same loot table everywhere"). Mapping
 * it to `none` keeps the loot branch firing on exactly the same 3,000 basis
 * points either way, which is what makes the two tables comparable.
 *
 * Deliberately not the underfunded-pool `degraded` path, even though both turn a
 * jackpot into something else: `degraded` means "the pool was short, top it up"
 * and is logged for the operator. A free run's jackpot roll is not an incident
 * and must not read as one.
 */
export function resolveFreeRunReward(args: {
  readonly seed: string | Uint8Array;
  readonly combatOutcome: 'win' | 'loss';
}): RewardResult {
  if (args.combatOutcome !== 'win') return NO_REWARD;

  const draw = drawRewardTable(args.seed);
  if (draw.kind !== 'loot') return NO_REWARD;

  const tier = draw.tier as number;
  return {
    kind: 'loot',
    amountUstx: null,
    lootUri: lootUriForTier(tier),
    tier,
    degraded: false,
  };
}

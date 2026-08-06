/**
 * Leaderboard scoring — the one place a rank number is computed.
 *
 * 07-glossary-and-open-questions.md calls rank "a player-address-keyed score
 * computed as a verifiable index over on-chain (and, for now, some
 * off-chain-logged) dungeon outcomes". *Verifiable* is the load-bearing word and
 * it is why this file is in `/packages/shared` rather than in a SQL expression
 * inside the API: a player who reads `GET /leaderboard` gets the counts that fed
 * the score alongside the score itself, and can call `leaderboardScore()` on
 * those counts to get the same number back. A score computed in a query nobody
 * outside the server can run would be a claim, not an index.
 *
 * WHAT IS AND ISN'T SETTLED HERE
 *
 * The *inputs* are fixed by 04-backend-api-spec.md#8 — dungeons completed,
 * jackpots won, highest forge tier. The *weights* are not, and 01-game-design.md#8
 * says so in as many words: "Rank inputs (tune weights during playtesting)". So
 * the table below is a coherent starting point rather than a settled answer, set
 * in one place rather than picked silently at a call site, and given the same
 * treatment as `JACKPOT_AMOUNT_USTX` and the power-up ladder: one constant, one
 * version string. Retuning them reorders a table and moves no money.
 *
 * ONE LISTED INPUT IS DELIBERATELY ABSENT. 01-game-design.md#8 also lists
 * "dice-roll performance (e.g. crits landed)". 04-backend-api-spec.md#8 fixes the
 * response to the other three, and the frontend was built against that shape, so
 * crits are left out here rather than added as a field nothing asked for. The
 * data exists — `combat_turns.attack_roll` — so this is a deliberate deferral,
 * not a missing capability.
 *
 * TWO RULES THAT ARE NOT TUNABLE
 *
 * 1. A LOSS IS NOT A COMPLETION. Only a resolved run whose `combatOutcome` is
 *    `win` counts. This is not a judgement call: 01-game-design.md#8 credits
 *    "every *completed* raid", and `rewards.ts` already reads that same word the
 *    same way — "a party that was wiped out did not complete it". It is also the
 *    only reading under which rank cannot be bought, since a paid entry costs
 *    1 STX and the fee is non-refundable whatever happens; if a loss scored, a
 *    wallet with enough STX could buy its way up the table without ever winning.
 *
 * 2. NO REWARD AMOUNT ENTERS THE SCORE. `jackpotsWon` is a *count* of jackpots
 *    actually paid, not a sum of microSTX, and gate fees appear nowhere. Scoring
 *    by STX would make the leaderboard a ranking of who the sponsor pool paid
 *    most, which is a ranking of luck denominated in the operator's money — and
 *    it would put a pool figure and a revenue figure in reach of the same
 *    expression, which the economic model forbids everywhere else.
 *
 *    A *degraded* jackpot does not count. The roll came up jackpot and the pool
 *    could not cover it, so the player was paid loot instead (rewards.ts) and the
 *    stored `reward.kind` is `loot`. Counting it would credit a payout that never
 *    happened; the run still scores as the completed dungeon it was.
 */

/** Bumped whenever a weight below changes, so an old ranking stays explicable. */
export const LEADERBOARD_ALGO_VERSION = 'leaderboard-v1' as const;

/**
 * Points per contributing fact. TUNABLE.
 *
 * `forgeTier` multiplies the *highest tier ever reached*, not a count of forges:
 * climbing the ladder is a milestone, and paying it per-forge would reward
 * grinding tier 1s over reaching tier 4.
 */
export const SCORE_WEIGHTS = {
  /** A won free dungeon. The baseline unit of play; costs nothing but time. */
  freeDungeon: 5,
  /**
   * A won paid dungeon. Worth more because the content is harder and the entry
   * is a real cost — but only 5x, not 50x, so a large wallet cannot outrank a
   * good player without also winning.
   */
  paidDungeon: 25,
  /**
   * A jackpot draw. Luck, not skill, so it is deliberately modest: one jackpot
   * is worth four won paid dungeons, not forty.
   */
  jackpot: 100,
  /** Multiplied by the highest forge tier reached. Caps at 4 tiers = 200. */
  forgeTier: 50,
} as const;

/** The facts a score is computed from. Exactly what the API publishes beside it. */
export interface LeaderboardCounts {
  readonly freeDungeonsCompleted: number;
  readonly paidDungeonsCompleted: number;
  readonly jackpotsWon: number;
  readonly highestForgeTier: number;
}

/**
 * The score. Pure, integer, and recomputable by anyone holding the published
 * counts — which is the whole point of it living here.
 */
export function leaderboardScore(counts: LeaderboardCounts): number {
  return (
    counts.freeDungeonsCompleted * SCORE_WEIGHTS.freeDungeon +
    counts.paidDungeonsCompleted * SCORE_WEIGHTS.paidDungeon +
    counts.jackpotsWon * SCORE_WEIGHTS.jackpot +
    counts.highestForgeTier * SCORE_WEIGHTS.forgeTier
  );
}

/**
 * Total dungeons completed.
 *
 * A derived sum rather than a stored fourth number, so the total can never
 * disagree with the two halves published beside it.
 */
export function dungeonsCompleted(counts: LeaderboardCounts): number {
  return counts.freeDungeonsCompleted + counts.paidDungeonsCompleted;
}

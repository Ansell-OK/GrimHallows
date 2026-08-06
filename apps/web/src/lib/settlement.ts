/**
 * What a finished run actually paid, as statements rather than markup.
 *
 * These four functions are the entire truth-claim surface of the reward screen:
 * whether the reward table was rolled, what kind it drew, what moved as a result,
 * and how much rank the run credited. They live here rather than inside
 * `Reward.tsx` because the repo has no DOM test environment, and untestable
 * assertions about money are the specific failure the reward screen was rewritten
 * to remove — a component that can only be read, not run, is where a false
 * payout sentence survives.
 *
 * Every value comes from `RunResponse`. Nothing here reads a constant that could
 * be retuned after a run resolved: the jackpot amount comes from the run's own
 * `amountUstx`, and the loot tier from the tier the API derived from the revealed
 * seed. The one table that *is* consulted is `SCORE_WEIGHTS`, and only because
 * the leaderboard scores live from it too — a stale weight there would be wrong
 * on the leaderboard first, and visibly.
 */

import { SCORE_WEIGHTS, formatStx, type RewardKind, type RunResponse } from '@grimhallow/shared';

/**
 * Whether the reward table was rolled at all.
 *
 * Only a *won paid* run draws: `resolveReward` returns `NO_REWARD` on a loss
 * before touching the table, and a free run never reaches it. The distinction
 * matters because "the draw came up empty" and "there was no draw" are different
 * facts, and only one of them describes a wipe.
 */
export function drewRewardTable(data: RunResponse): boolean {
  return data.dungeonType === 'paid' && data.combatOutcome === 'win';
}

/** The kind drawn, or null when no draw happened. Never a fallback kind. */
export function drawnKind(data: RunResponse): RewardKind | null {
  if (!drewRewardTable(data)) return null;
  return data.reward?.kind ?? 'none';
}

/**
 * Rank points this run credited.
 *
 * Zero on a loss, and that is not a rounding-down: the leaderboard aggregate
 * filters on `combat_outcome = 'win'`, so a wipe contributes nothing. The design
 * doc's "a run is never a total whiff" is not what the code does, and the screen
 * reports the code.
 */
export function rankCredit(data: RunResponse): number {
  if (data.combatOutcome !== 'win') return 0;
  const base =
    data.dungeonType === 'paid' ? SCORE_WEIGHTS.paidDungeon : SCORE_WEIGHTS.freeDungeon;
  return base + (drawnKind(data) === 'jackpot' ? SCORE_WEIGHTS.jackpot : 0);
}

/**
 * The one sentence about whether anything moved.
 *
 * A payout is only ever asserted from the run's own recorded amount or tier. When
 * there is no such value the sentence says nothing was paid, rather than
 * describing a payout it cannot evidence — the previous version of this screen
 * printed "rewards have been sent to your wallet" unconditionally, which was
 * false for the large majority of runs.
 */
export function settlementText(data: RunResponse): string {
  const reward = data.reward;
  const kind = drawnKind(data);

  if (data.dungeonType === 'free') {
    return 'Nothing was paid and nothing was minted — a free run has no payout path.';
  }
  if (data.combatOutcome !== 'win') {
    return 'No STX moved and no item was minted. The gate fee was spent on entry, as it always is.';
  }
  if (kind === 'jackpot' && reward?.amountUstx) {
    return `${formatStx(BigInt(reward.amountUstx))} STX was sent to your wallet from the sponsor pool.`;
  }
  if (kind === 'loot' && reward?.tier) {
    return `A tier-${reward.tier} power-up was minted to your wallet.`;
  }
  return 'Nothing was paid out for this run.';
}

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
 * Any *won* run draws, free or paid, since docs/09 B7 — loot is the forge's only
 * input supply and gating it behind the gate fee left a non-paying player unable
 * to ever forge. `resolveReward` and `resolveFreeRunReward` are two functions over
 * the same table; what differs is that the free one cannot return a jackpot,
 * because that is real STX out of an owner-funded pool.
 *
 * Still false on a loss, and that distinction is the reason this function exists:
 * both reward functions return `NO_REWARD` before touching the table, so "the draw
 * came up empty" and "there was no draw" are different facts and only one of them
 * describes a wipe.
 */
export function drewRewardTable(data: RunResponse): boolean {
  return data.combatOutcome === 'win';
}

/**
 * The kind drawn, or null when no draw happened. Never a fallback kind.
 *
 * `jackpot` is unreachable on a free run — `resolveFreeRunReward` maps a jackpot
 * roll to `none` rather than paying one, so the sponsor pool only ever pays out
 * where a gate fee was paid in.
 */
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
 *
 * FREE RUNS ARE THE HARD CASE (docs/09 B7). A free win can draw loot, but its NFT
 * is minted by a separate ceremony that runs minutes after this screen appears —
 * so at the instant a player reads this, the tier is real and the token usually is
 * not. Saying "minted to your wallet" there would be the same false claim in a new
 * place, and saying nothing would leave the item on screen unexplained. So the
 * free-loot sentence is driven by `lootMint.state`, and only the `minted` branch
 * — which the API sets from a token id read off a confirmed transaction — asserts
 * that the item exists.
 */
export function settlementText(data: RunResponse): string {
  const reward = data.reward;
  const kind = drawnKind(data);

  if (data.combatOutcome !== 'win') {
    return data.dungeonType === 'free'
      ? 'No STX moved and no item was minted. A free run costs nothing to enter, so nothing was lost but the attempt.'
      : 'No STX moved and no item was minted. The gate fee was spent on entry, as it always is.';
  }

  if (data.dungeonType === 'free') {
    // No STX branch at all, in either direction: a free entry funds nothing and
    // the sponsor pool pays nothing back. A jackpot roll on a free run is mapped
    // to `none` before it ever reaches here.
    if (kind !== 'loot' || !reward?.tier) {
      return 'Nothing was drawn for this run. A free run pays no STX either way — the sponsor pool is funded by paid entries.';
    }
    return freeLootText(data, reward.tier);
  }

  if (kind === 'jackpot' && reward?.amountUstx) {
    return `${formatStx(BigInt(reward.amountUstx))} STX was sent to your wallet from the sponsor pool.`;
  }
  if (kind === 'loot' && reward?.tier) {
    return `A tier-${reward.tier} power-up was minted to your wallet.`;
  }
  return 'Nothing was paid out for this run.';
}

/**
 * The free-run loot sentence, one per state of the mint.
 *
 * Absent `lootMint` is treated as pending rather than as minted. An older API, a
 * partial response, or a row the worker has not reached yet all arrive as null,
 * and the safe reading of "I don't know" is that the item is not in the wallet
 * yet — the opposite default would claim an NFT on missing data.
 */
function freeLootText(data: RunResponse, tier: number): string {
  const mint = data.lootMint;

  if (mint?.state === 'minted') {
    return mint.tokenId
      ? `A tier-${tier} power-up was minted to your wallet — token #${mint.tokenId}.`
      : `A tier-${tier} power-up was minted to your wallet.`;
  }
  if (mint?.state === 'failed') {
    return `A tier-${tier} power-up was drawn, but the mint has not gone through. Nothing is in your wallet yet — the drop is recorded against this run and has been flagged for the operator.`;
  }
  return `A tier-${tier} power-up was drawn. Free runs mint in a separate transaction shortly after the fight, so it is not in your wallet yet — this screen and your inventory will show the token once the chain confirms it.`;
}

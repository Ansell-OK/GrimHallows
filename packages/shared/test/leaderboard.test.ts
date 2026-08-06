/**
 * Leaderboard scoring tests.
 *
 * The score itself is arithmetic and not worth much testing. What is worth
 * locking down is the set of properties the leaderboard's honesty rests on, and
 * which a future weight change must not quietly break:
 *
 *   - the function is pure and total, so a player recomputing it from published
 *     counts gets the same number the API did
 *   - no reward amount can enter it — the signature only accepts counts
 *   - a win outranks a loss, structurally: there is no input that credits a loss
 *   - a paid dungeon cannot be *so* much more valuable that STX outranks skill
 */

import { describe, expect, it } from 'vitest';
import {
  LEADERBOARD_ALGO_VERSION,
  SCORE_WEIGHTS,
  dungeonsCompleted,
  leaderboardScore,
  type LeaderboardCounts,
} from '../src/index.js';

const EMPTY: LeaderboardCounts = {
  freeDungeonsCompleted: 0,
  paidDungeonsCompleted: 0,
  jackpotsWon: 0,
  highestForgeTier: 0,
};

describe('leaderboardScore', () => {
  it('scores nothing for a player who has done nothing', () => {
    expect(leaderboardScore(EMPTY)).toBe(0);
  });

  it('is the weighted sum of exactly its four inputs', () => {
    const counts: LeaderboardCounts = {
      freeDungeonsCompleted: 3,
      paidDungeonsCompleted: 2,
      jackpotsWon: 1,
      highestForgeTier: 4,
    };
    expect(leaderboardScore(counts)).toBe(
      3 * SCORE_WEIGHTS.freeDungeon +
        2 * SCORE_WEIGHTS.paidDungeon +
        1 * SCORE_WEIGHTS.jackpot +
        4 * SCORE_WEIGHTS.forgeTier,
    );
  });

  it('is deterministic — the same counts always score the same', () => {
    const counts: LeaderboardCounts = {
      freeDungeonsCompleted: 7,
      paidDungeonsCompleted: 5,
      jackpotsWon: 2,
      highestForgeTier: 3,
    };
    const first = leaderboardScore(counts);
    for (let i = 0; i < 100; i += 1) {
      expect(leaderboardScore({ ...counts })).toBe(first);
    }
  });

  it('produces an integer for integer counts', () => {
    // The API publishes this next to the counts that produced it, and a client
    // compares the two. A float would compare unequal across a JSON round trip.
    for (let i = 1; i <= 20; i += 1) {
      const score = leaderboardScore({
        freeDungeonsCompleted: i,
        paidDungeonsCompleted: i * 2,
        jackpotsWon: i % 3,
        highestForgeTier: (i % 4) + 1,
      });
      expect(Number.isInteger(score)).toBe(true);
    }
  });

  it('is monotonic in every input — no count can lower a score', () => {
    const base = leaderboardScore(EMPTY);
    expect(leaderboardScore({ ...EMPTY, freeDungeonsCompleted: 1 })).toBeGreaterThan(base);
    expect(leaderboardScore({ ...EMPTY, paidDungeonsCompleted: 1 })).toBeGreaterThan(base);
    expect(leaderboardScore({ ...EMPTY, jackpotsWon: 1 })).toBeGreaterThan(base);
    expect(leaderboardScore({ ...EMPTY, highestForgeTier: 1 })).toBeGreaterThan(base);
  });
});

describe('score weights', () => {
  it('are all positive — a contributing fact never costs a player points', () => {
    for (const [name, weight] of Object.entries(SCORE_WEIGHTS)) {
      expect(weight, name).toBeGreaterThan(0);
    }
  });

  /**
   * The anti-pay-to-win property, as a number.
   *
   * A paid entry costs 1 STX and is non-refundable whatever happens, so if paid
   * wins were worth vastly more than free ones, the table would rank wallets. 5x
   * keeps a paid win meaningfully better — the content is harder — while leaving
   * a free player able to outrank a paying one by winning five times as often.
   */
  it('keeps a paid win within a small multiple of a free win', () => {
    expect(SCORE_WEIGHTS.paidDungeon / SCORE_WEIGHTS.freeDungeon).toBeLessThanOrEqual(10);
  });

  /**
   * The anti-luck property. A jackpot is a 1% dice draw, not an achievement, so
   * it must not be worth more than a modest run of won dungeons — otherwise the
   * top of the table is a list of who got lucky with the operator's money.
   */
  it('keeps a jackpot worth only a handful of paid wins', () => {
    expect(SCORE_WEIGHTS.jackpot / SCORE_WEIGHTS.paidDungeon).toBeLessThanOrEqual(10);
  });
});

describe('dungeonsCompleted', () => {
  it('is exactly the two halves published beside it', () => {
    const counts: LeaderboardCounts = {
      ...EMPTY,
      freeDungeonsCompleted: 9,
      paidDungeonsCompleted: 4,
    };
    expect(dungeonsCompleted(counts)).toBe(13);
  });
});

describe('algorithm version', () => {
  it('is pinned, so an old ranking stays explicable', () => {
    expect(LEADERBOARD_ALGO_VERSION).toBe('leaderboard-v1');
  });
});

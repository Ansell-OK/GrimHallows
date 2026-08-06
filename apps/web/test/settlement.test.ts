/**
 * The reward screen's truth claims.
 *
 * These tests exist because the screen they back replaced a design mock whose
 * every number was a hardcoded literal — a fabricated pool size, a fabricated
 * payout, and an unconditional "rewards have been sent to your wallet" that was
 * false for most runs. The point of each case below is a sentence the screen must
 * not print: no payout claim without a recorded amount, no rank credit for a
 * wipe, no reward draw where the code never rolled one.
 */

import { describe, expect, it } from 'vitest';
import type { RunResponse } from '@grimhallow/shared';
import {
  drawnKind,
  drewRewardTable,
  rankCredit,
  settlementText,
} from '../src/lib/settlement';

function run(over: Partial<RunResponse> = {}): RunResponse {
  return {
    runId: 'r1',
    dungeonType: 'paid',
    state: 'resolved',
    combatOutcome: 'win',
    turns: [],
    encounter: null,
    reward: null,
    verification: {
      seed: 'ab'.repeat(32),
      seedHash: 'cd'.repeat(32),
      commitTxId: null,
      resolveTxId: null,
      oracleAddress: 'SP000000000000000000002Q6VF78',
      commitSignature: null,
      resolveSignature: null,
      committedAt: null,
      resolvedAt: null,
    },
    ...over,
  } as RunResponse;
}

describe('drewRewardTable', () => {
  it('is true only for a won paid run', () => {
    expect(drewRewardTable(run())).toBe(true);
  });

  it('is false for a lost paid run — the table is never reached on a loss', () => {
    expect(drewRewardTable(run({ combatOutcome: 'loss' }))).toBe(false);
  });

  it('is false for a free run however it ended', () => {
    expect(drewRewardTable(run({ dungeonType: 'free' }))).toBe(false);
    expect(drewRewardTable(run({ dungeonType: 'free', combatOutcome: 'loss' }))).toBe(false);
  });
});

describe('drawnKind', () => {
  it('reports the drawn kind for a won paid run', () => {
    const r = run({
      reward: { kind: 'jackpot', amountUstx: '1500000', lootUri: null, tier: null, degraded: false },
    });
    expect(drawnKind(r)).toBe('jackpot');
  });

  it("distinguishes 'no draw happened' from 'the draw came up empty'", () => {
    // A wipe: null, because the table was never rolled.
    expect(drawnKind(run({ combatOutcome: 'loss' }))).toBeNull();
    // A win whose roll missed everything: 'none'. Different fact, different card.
    expect(
      drawnKind(
        run({ reward: { kind: 'none', amountUstx: null, lootUri: null, tier: null, degraded: false } }),
      ),
    ).toBe('none');
  });

  it("reads a degraded jackpot as the loot it actually paid, not the jackpot it rolled", () => {
    const r = run({
      reward: { kind: 'loot', amountUstx: null, lootUri: 'ipfs://x', tier: 2, degraded: true },
    });
    expect(drawnKind(r)).toBe('loot');
  });
});

describe('rankCredit', () => {
  it('credits nothing for a wipe, because the leaderboard filters on wins', () => {
    expect(rankCredit(run({ combatOutcome: 'loss' }))).toBe(0);
    expect(rankCredit(run({ dungeonType: 'free', combatOutcome: 'loss' }))).toBe(0);
  });

  it('credits a won free run and a won paid run at their own weights', () => {
    expect(rankCredit(run({ dungeonType: 'free' }))).toBeGreaterThan(0);
    expect(rankCredit(run())).toBeGreaterThan(rankCredit(run({ dungeonType: 'free' })));
  });

  it('adds the jackpot weight only when a jackpot actually paid', () => {
    const plain = rankCredit(run());
    const jackpot = rankCredit(
      run({
        reward: {
          kind: 'jackpot',
          amountUstx: '1500000',
          lootUri: null,
          tier: null,
          degraded: false,
        },
      }),
    );
    expect(jackpot).toBeGreaterThan(plain);

    // Degraded: rolled a jackpot, paid loot. Stored kind is 'loot', so no jackpot
    // credit — which matches what the leaderboard aggregate counts.
    const degraded = rankCredit(
      run({ reward: { kind: 'loot', amountUstx: null, lootUri: null, tier: 2, degraded: true } }),
    );
    expect(degraded).toBe(plain);
  });
});

describe('settlementText', () => {
  it('never claims a payout for a free run', () => {
    const text = settlementText(run({ dungeonType: 'free' }));
    expect(text).toMatch(/no payout path/i);
    expect(text).not.toMatch(/sent to your wallet/i);
  });

  it('says the gate fee was spent, not refunded, after a wipe', () => {
    const text = settlementText(run({ combatOutcome: 'loss' }));
    expect(text).toMatch(/spent on entry/i);
    expect(text).not.toMatch(/refund/i);
  });

  it('quotes the jackpot from the run’s own recorded amount', () => {
    const text = settlementText(
      run({
        reward: {
          kind: 'jackpot',
          amountUstx: '1500000',
          lootUri: null,
          tier: null,
          degraded: false,
        },
      }),
    );
    expect(text).toContain('1.5');
    expect(text).toMatch(/sponsor pool/i);
  });

  it('claims nothing when a won run has no recorded reward amount or tier', () => {
    const text = settlementText(
      run({ reward: { kind: 'none', amountUstx: null, lootUri: null, tier: null, degraded: false } }),
    );
    expect(text).toMatch(/nothing was paid out/i);
  });

  it('does not assert a jackpot payout when the amount is missing', () => {
    const text = settlementText(
      run({ reward: { kind: 'jackpot', amountUstx: null, lootUri: null, tier: null, degraded: false } }),
    );
    expect(text).not.toMatch(/sent to your wallet/i);
    expect(text).toMatch(/nothing was paid out/i);
  });
});

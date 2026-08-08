/**
 * The reward screen's truth claims.
 *
 * These tests exist because the screen they back replaced a design mock whose
 * every number was a hardcoded literal — a fabricated pool size, a fabricated
 * payout, and an unconditional "rewards have been sent to your wallet" that was
 * false for most runs. The point of each case below is a sentence the screen must
 * not print: no payout claim without a recorded amount, no rank credit for a
 * wipe, no reward draw where the code never rolled one.
 *
 * Free-run loot (docs/09 B7) adds a case the paid path never had: an item that
 * was genuinely drawn and genuinely is not in the wallet yet, because its mint is
 * a separate ceremony that runs minutes later. That interval is where the old
 * unconditional sentence would come back if nobody pinned it, so the free
 * branches below are all about which of the three mint states may say "minted".
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
    lootMint: null,
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

/** A won free run that drew tier-2 loot, with its mint wherever `mint` says. */
function freeLoot(mint: RunResponse['lootMint']): RunResponse {
  return run({
    dungeonType: 'free',
    reward: { kind: 'loot', amountUstx: null, lootUri: 'ipfs://x', tier: 2, degraded: false },
    lootMint: mint,
  });
}

describe('drewRewardTable', () => {
  it('is true for a won run of either kind', () => {
    // Free runs draw since B7: loot is the forge's only input supply, so gating
    // it behind the gate fee left a non-paying player unable to ever forge.
    expect(drewRewardTable(run())).toBe(true);
    expect(drewRewardTable(run({ dungeonType: 'free' }))).toBe(true);
  });

  it('is false after a wipe — the table is never reached on a loss', () => {
    expect(drewRewardTable(run({ combatOutcome: 'loss' }))).toBe(false);
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

  it('reports loot on a free run, which draws from the same table', () => {
    expect(drawnKind(freeLoot(null))).toBe('loot');
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

  it('gives a free run no jackpot credit, because it cannot draw one', () => {
    // `resolveFreeRunReward` maps a jackpot roll to `none` rather than paying out
    // of an owner-funded pool. A free run scoring a jackpot bonus here would be
    // rank for a prize the code refuses to award.
    expect(rankCredit(freeLoot(null))).toBe(rankCredit(run({ dungeonType: 'free' })));
  });
});

describe('settlementText', () => {
  it('says the gate fee was spent, not refunded, after a paid wipe', () => {
    const text = settlementText(run({ combatOutcome: 'loss' }));
    expect(text).toMatch(/spent on entry/i);
    expect(text).not.toMatch(/refund/i);
  });

  it('does not tell a wiped free player a fee was spent', () => {
    // There was no fee. The paid sentence would be a small invented loss, and
    // this screen exists because small invented facts were the previous version.
    const text = settlementText(run({ dungeonType: 'free', combatOutcome: 'loss' }));
    expect(text).not.toMatch(/gate fee|spent on entry/i);
    expect(text).toMatch(/costs nothing to enter/i);
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

  describe('a free run, whose loot is minted after this screen loads', () => {
    it('does not claim the item is in the wallet while the mint is pending', () => {
      // The whole reason `lootMint` exists. At this instant the tier is real and
      // the NFT is not — the paid sentence would be false for every free drop for
      // the first few minutes of its life, which is when players read this screen.
      const text = settlementText(freeLoot({ state: 'pending', txId: '0xabc', tokenId: null, failedReason: null }));
      expect(text).toMatch(/tier-2/i);
      expect(text).not.toMatch(/was minted to your wallet/i);
      expect(text).toMatch(/not in your wallet yet/i);
    });

    it('treats a missing mint status as pending, not as minted', () => {
      // An older API, a partial response, or a row the worker has not reached
      // all arrive as null. The safe reading of "I don't know" is that the item
      // is not there — the other default claims an NFT on missing data.
      const text = settlementText(freeLoot(null));
      expect(text).not.toMatch(/was minted to your wallet/i);
      expect(text).toMatch(/not in your wallet yet/i);
    });

    it('claims the mint only once a token id proves it happened', () => {
      // `minted` is set from a token id the indexer read off a *confirmed*
      // transaction. A txid alone would only mean the node accepted a broadcast,
      // which is the exact distinction the settlement verifier exists for.
      const text = settlementText(
        freeLoot({ state: 'minted', txId: '0xabc', tokenId: '88', failedReason: null }),
      );
      expect(text).toMatch(/was minted to your wallet/i);
      expect(text).toContain('#88');
    });

    it('says a failed mint failed rather than leaving it pending forever', () => {
      // A parked ceremony never advances on its own. Left as "minting", the
      // player waits indefinitely for something nobody is working on.
      const text = settlementText(
        freeLoot({
          state: 'failed',
          txId: '0xabc',
          tokenId: null,
          failedReason: 'ENTER_ABORTED: entry aborted',
        }),
      );
      expect(text).toMatch(/has not gone through/i);
      expect(text).toMatch(/nothing is in your wallet/i);
      expect(text).not.toMatch(/was minted to your wallet/i);
    });

    it('never mentions STX for a free run, in either direction', () => {
      // No jackpot out, and no fee in. A sentence about the sponsor pool paying
      // or the entry funding it would be wrong both ways round.
      const drew = settlementText(freeLoot({ state: 'minted', txId: '0xa', tokenId: '1', failedReason: null }));
      expect(drew).not.toMatch(/STX/);

      const empty = settlementText(
        run({
          dungeonType: 'free',
          reward: { kind: 'none', amountUstx: null, lootUri: null, tier: null, degraded: false },
        }),
      );
      expect(empty).toMatch(/pays no STX either way/i);
    });
  });
});

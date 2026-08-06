/**
 * PaidRunOracle tests — Phase 5.
 *
 * This is the module that holds the key which can move sponsor-pool funds, so
 * the tests are about what it refuses to sign as much as what it signs.
 *
 * THE REWARD IS NOT AN INPUT. `resolveRun` takes a run id, a seed and a combat
 * outcome, and decides the reward itself from the shared table. A caller can ask
 * it to settle a run; it cannot tell it what the run paid out. The first group
 * below pins that down by driving the same call with different pool balances and
 * watching the decision change.
 *
 * THE POOL IS READ FRESH, EVERY TIME. A cached balance would let this module's
 * degrade check disagree with the contract's own check, and the contract's is the
 * one that reverts — costing a fee and stranding the run in `committed`.
 *
 * Signing itself is stubbed. `makeContractCall` needs a node to estimate a fee,
 * and what these tests are about is the decision that precedes the signature,
 * not the signature's bytes.
 */

import { describe, expect, it, vi } from 'vitest';
import { Cl, type ClarityValue } from '@stacks/transactions';
import {
  JACKPOT_AMOUNT_USTX,
  REWARD_ALGO_VERSION,
  drawRewardTable,
  type NetworkConfig,
} from '@grimhallow/shared';
import { PaidRunOracle, PaidOracleError } from '../src/oracle/paidRunOracle.js';
import { stubChain, TEST_ORACLE_KEY } from './helpers/oracle.js';

const STACKS: NetworkConfig = {
  network: 'devnet',
  deployer: 'ST3AM1A56AK2C1XAFJ4115ZSV26EB49BVQ10MGCS0',
  apiUrl: 'http://localhost:3999',
  explorerUrl: 'http://localhost:8000',
};

const PLAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const SEED = 'a'.repeat(64);

/**
 * A seed that draws a jackpot, found by scanning rather than asserted blindly.
 *
 * Hard-coding a seed and hoping it still rolls a jackpot would make this file
 * fail mysteriously if the table's constants were ever retuned. Searching for one
 * keeps the tests about the degrade rule instead.
 */
function seedDrawing(kind: 'jackpot' | 'loot' | 'none'): string {
  for (let i = 0; i < 5_000; i++) {
    const seed = i.toString(16).padStart(64, '0');
    if (drawRewardTable(seed).kind === kind) return seed;
  }
  throw new Error(`no seed found drawing ${kind} within the search bound`);
}

/**
 * An oracle whose broadcast is captured rather than sent.
 *
 * `signAndBroadcast` is private and needs a live node, so it is replaced on the
 * instance. Everything above it — the pool read, the reward decision, the
 * degrade check and the refusal — runs for real.
 */
function buildOracle(opts: {
  sponsorPoolUstx: bigint | ClarityValue;
  onBroadcast?: (params: { functionName: string }) => void;
}) {
  const poolReads: string[] = [];
  const logs: { message: string; detail?: Record<string, unknown> }[] = [];

  const chain = stubChain({
    async callReadOnly(params: { functionName: string }) {
      poolReads.push(params.functionName);
      return typeof opts.sponsorPoolUstx === 'bigint'
        ? Cl.uint(opts.sponsorPoolUstx)
        : opts.sponsorPoolUstx;
    },
  });

  const oracle = new PaidRunOracle({
    chain,
    stacks: STACKS,
    oraclePrivateKey: TEST_ORACLE_KEY,
    log: (message, detail) => logs.push({ message, detail }),
  });

  const broadcast = vi.fn(async (params: { functionName: string }) => {
    opts.onBroadcast?.(params);
    return '0xresolved';
  });
  // Replace the one method that needs a node. Private by design, so reaching it
  // takes a cast — the alternative is not testing the decision at all.
  (oracle as unknown as { signAndBroadcast: typeof broadcast }).signAndBroadcast = broadcast;

  return { oracle, broadcast, poolReads, logs };
}

describe('PaidRunOracle', () => {
  describe('reads the sponsor pool', () => {
    it('reads the live balance rather than trusting a cached one', async () => {
      const { oracle, poolReads } = buildOracle({ sponsorPoolUstx: 50_000_000n });
      expect(await oracle.readSponsorPool()).toBe(50_000_000n);
      expect(poolReads).toEqual(['get-sponsor-pool']);
    });

    it('reads the pool again on every resolve', async () => {
      const { oracle, poolReads } = buildOracle({ sponsorPoolUstx: 50_000_000n });
      const args = { seed: SEED, combatOutcome: 'win' as const, lootRecipient: PLAYER };

      await oracle.resolveRun({ runId: '1', ...args });
      await oracle.resolveRun({ runId: '2', ...args });

      // Twice, not once. A balance cached between runs is a degrade check that
      // can disagree with the contract's.
      expect(poolReads).toEqual(['get-sponsor-pool', 'get-sponsor-pool']);
    });

    it('refuses to proceed when the pool cannot be read as a uint', async () => {
      const { oracle } = buildOracle({ sponsorPoolUstx: Cl.none() });
      await expect(oracle.readSponsorPool()).rejects.toThrow(PaidOracleError);
    });
  });

  describe('decides the reward itself', () => {
    it('pays a jackpot the pool can cover', async () => {
      const seed = seedDrawing('jackpot');
      const { oracle } = buildOracle({ sponsorPoolUstx: JACKPOT_AMOUNT_USTX });

      const result = await oracle.resolveRun({
        runId: '1',
        seed,
        combatOutcome: 'win',
        lootRecipient: PLAYER,
      });

      expect(result.reward.kind).toBe('jackpot');
      expect(result.reward.amountUstx).toBe(JACKPOT_AMOUNT_USTX.toString());
      expect(result.reward.degraded).toBe(false);
    });

    it('degrades a jackpot the pool cannot cover, rather than attempting it', async () => {
      // 03-smart-contracts-spec.md#3.2. Submitting a doomed payout burns a fee
      // and leaves the run stuck in `committed`.
      const seed = seedDrawing('jackpot');
      const { oracle } = buildOracle({ sponsorPoolUstx: JACKPOT_AMOUNT_USTX - 1n });

      const result = await oracle.resolveRun({
        runId: '1',
        seed,
        combatOutcome: 'win',
        lootRecipient: PLAYER,
      });

      expect(result.reward.kind).toBe('loot');
      expect(result.reward.degraded).toBe(true);
      expect(result.reward.amountUstx).toBeNull();
      // Degraded, not skipped: the player did roll the top prize.
      expect(result.reward.tier).toBeGreaterThan(0);
    });

    it('logs a degrade distinctly, as an operational signal', async () => {
      const seed = seedDrawing('jackpot');
      const { oracle, logs } = buildOracle({ sponsorPoolUstx: 0n });

      await oracle.resolveRun({
        runId: '7',
        seed,
        combatOutcome: 'win',
        lootRecipient: PLAYER,
      });

      // Must not be indistinguishable from an ordinary loot drop in the log —
      // this is the operator's cue that the pool needs topping up.
      const degrade = logs.find((l) => l.message.includes('REWARD DEGRADED'));
      expect(degrade).toBeDefined();
      expect(degrade?.detail?.runId).toBe('7');
      expect(degrade?.detail?.sponsorPoolUstx).toBe('0');
      expect(degrade?.detail?.action).toContain('fund-pool');
    });

    it('pays nothing for a loss, whatever the pool holds', async () => {
      // A party that was wiped out did not complete the dungeon. The draw is not
      // rolled at all, so a rich pool cannot turn a loss into a payout.
      const seed = seedDrawing('jackpot');
      const { oracle } = buildOracle({ sponsorPoolUstx: 999_000_000_000n });

      const result = await oracle.resolveRun({
        runId: '1',
        seed,
        combatOutcome: 'loss',
        lootRecipient: PLAYER,
      });

      expect(result.reward.kind).toBe('none');
      expect(result.reward.amountUstx).toBeNull();
      expect(result.reward.degraded).toBe(false);
    });

    it('derives the reward from the seed, so the same run resolves the same way', async () => {
      const seed = seedDrawing('loot');
      const a = buildOracle({ sponsorPoolUstx: 50_000_000n });
      const b = buildOracle({ sponsorPoolUstx: 50_000_000n });

      const first = await a.oracle.resolveRun({
        runId: '1',
        seed,
        combatOutcome: 'win',
        lootRecipient: PLAYER,
      });
      const second = await b.oracle.resolveRun({
        runId: '1',
        seed,
        combatOutcome: 'win',
        lootRecipient: PLAYER,
      });

      // The property the whole architecture rests on: anyone holding the revealed
      // seed can recompute the payout and get the same answer.
      expect(second.reward).toEqual(first.reward);
    });

    it('publishes the pool balance it decided against, for the audit log', async () => {
      const { oracle } = buildOracle({ sponsorPoolUstx: 12_345_678n });
      const result = await oracle.resolveRun({
        runId: '1',
        seed: SEED,
        combatOutcome: 'win',
        lootRecipient: PLAYER,
      });

      expect(result.sponsorPoolUstx).toBe('12345678');
      expect(result.rewardAlgoVersion).toContain(REWARD_ALGO_VERSION);
    });
  });

  describe('signs only the two calls it is allowed to', () => {
    it('calls commit-seed to commit', async () => {
      const { oracle, broadcast } = buildOracle({ sponsorPoolUstx: 0n });
      const txId = await oracle.commitSeed({ runId: '1', seedHash: 'b'.repeat(64) });

      expect(txId).toBe('0xresolved');
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast.mock.calls[0]?.[0].functionName).toBe('commit-seed');
    });

    it('commits with no post-conditions, because nothing moves', async () => {
      const { oracle, broadcast } = buildOracle({ sponsorPoolUstx: 0n });
      await oracle.commitSeed({ runId: '1', seedHash: 'b'.repeat(64) });

      const call = broadcast.mock.calls[0]?.[0] as unknown as { postConditions: unknown[] };
      // Deny mode with no conditions says exactly that: if this call somehow
      // transferred an asset, it would abort.
      expect(call.postConditions).toEqual([]);
    });

    it('calls reveal-and-resolve to resolve', async () => {
      const { oracle, broadcast } = buildOracle({ sponsorPoolUstx: 50_000_000n });
      await oracle.resolveRun({
        runId: '1',
        seed: SEED,
        combatOutcome: 'win',
        lootRecipient: PLAYER,
      });

      expect(broadcast.mock.calls[0]?.[0].functionName).toBe('reveal-and-resolve');
    });

    it('pins a jackpot payout to the exact amount with a post-condition', async () => {
      const seed = seedDrawing('jackpot');
      const { oracle, broadcast } = buildOracle({ sponsorPoolUstx: JACKPOT_AMOUNT_USTX });

      await oracle.resolveRun({
        runId: '1',
        seed,
        combatOutcome: 'win',
        lootRecipient: PLAYER,
      });

      const call = broadcast.mock.calls[0]?.[0] as unknown as { postConditions: unknown[] };
      // If the contract paid more than the table said, this aborts.
      expect(call.postConditions).toHaveLength(1);
    });

    it('attaches no STX post-condition when no STX moves', async () => {
      const seed = seedDrawing('loot');
      const { oracle, broadcast } = buildOracle({ sponsorPoolUstx: 50_000_000n });

      await oracle.resolveRun({
        runId: '1',
        seed,
        combatOutcome: 'win',
        lootRecipient: PLAYER,
      });

      const call = broadcast.mock.calls[0]?.[0] as unknown as { postConditions: unknown[] };
      expect(call.postConditions).toEqual([]);
    });
  });
});

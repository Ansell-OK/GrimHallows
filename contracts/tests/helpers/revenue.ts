/**
 * The revenue-not-pool assertion, in one place.
 *
 * GrimHallow has three independent revenue lines — the dungeon gate fee, the
 * character mint price, and the forge fee — and exactly one sponsor pool. The
 * pool is credited ONLY by the owner calling `fund-pool`. No player payment may
 * ever increase it, in any contract, by any path (02-architecture.md §3,
 * 03-smart-contracts-spec.md §2-3).
 *
 * That invariant is the one this project treats as load-bearing, so it gets one
 * implementation rather than a hand-written assertion per test. A one-off
 * `expect(sponsorPool()).toBe(0n)` at each call site is weaker than it looks: it
 * passes just as happily when the fee vanished into the contract's own balance,
 * or when the owner was credited twice, or when the pool was already non-zero
 * and the payment landed in it anyway. This checks the whole ledger around the
 * call instead of one number.
 *
 * WHAT IT ASSERTS, for a payment of N uSTX:
 *   1. The contract owner's balance rose by exactly N.
 *   2. The payer's balance fell by exactly N.
 *   3. The sponsor pool is byte-identical before and after.
 *   4. game-core's own principal holds exactly what it held before — a fee
 *      parked in the contract is money nobody can spend and is the shape a
 *      pool-credit bug takes when the pool variable itself is left alone.
 *
 * Simnet charges no transaction fee, so these are exact equalities rather than
 * ranges. If that ever changes, the payer assertion is the one to relax; the
 * other three must stay exact.
 */

import { Cl, type ClarityValue } from '@stacks/transactions';
import { expect } from 'vitest';

const CORE = 'game-core';

export interface CallResult {
  readonly result: ClarityValue;
  readonly events: unknown[];
}

function stxBalance(who: string): bigint {
  return simnet.getAssetsMap().get('STX')?.get(who) ?? 0n;
}

/**
 * The sponsor pool as game-core reports it.
 *
 * Read from the contract rather than from its STX balance on purpose: the pool
 * is a `data-var` that must agree with the contract's holdings, and reading the
 * var is what catches a credit that updated the accounting without moving STX.
 * `poolBackingHeld` below covers the other direction.
 */
export function sponsorPool(sender: string): bigint {
  const { result } = simnet.callReadOnlyFn(CORE, 'get-sponsor-pool', [], sender);
  return (result as unknown as { value: bigint }).value;
}

/** The STX actually sitting in game-core's principal, backing the pool. */
export function poolBackingHeld(deployer: string): bigint {
  return stxBalance(`${deployer}.${CORE}`);
}

export interface RevenueExpectation {
  /** The wallet paying. Must not be the owner, or the test proves nothing. */
  readonly payer: string;
  /** The contract owner / deployer, who receives all three revenue lines. */
  readonly owner: string;
  /** Exact amount in uSTX the payer is expected to part with. */
  readonly amountUstx: bigint;
  /** The call under test. Run exactly once, between the two balance reads. */
  readonly call: () => CallResult;
  /** Label used in failure messages, e.g. 'mint-character'. */
  readonly label: string;
}

/**
 * Run a paid call and assert the money went to revenue, not to the pool.
 *
 * Returns the call's result so the caller can go on to assert whatever the
 * function was actually for (a token id, an ok response) without running it a
 * second time — running it twice would double the payment and quietly
 * invalidate every balance assertion here.
 */
export function expectRevenueNotPool(expectation: RevenueExpectation): ClarityValue {
  const { payer, owner, amountUstx, call, label } = expectation;

  if (payer === owner) {
    // A self-payment nets to zero and would satisfy every assertion below while
    // proving nothing at all. Fail loudly rather than pass vacuously.
    throw new Error(
      `expectRevenueNotPool(${label}): payer and owner are the same principal, ` +
        'so the balance deltas cancel out. Use a non-owner wallet as the payer.',
    );
  }

  const ownerBefore = stxBalance(owner);
  const payerBefore = stxBalance(payer);
  const poolBefore = sponsorPool(owner);
  const backingBefore = poolBackingHeld(owner);

  const outcome = call();

  const ownerAfter = stxBalance(owner);
  const payerAfter = stxBalance(payer);
  const poolAfter = sponsorPool(owner);
  const backingAfter = poolBackingHeld(owner);

  // The assertion this whole file exists for.
  expect(
    poolAfter,
    `${label}: sponsor pool changed (${poolBefore} -> ${poolAfter}). Player payments ` +
      'are revenue and must never credit the pool; only fund-pool may increase it.',
  ).toBe(poolBefore);

  expect(
    backingAfter,
    `${label}: game-core's own STX balance changed (${backingBefore} -> ${backingAfter}). ` +
      'A fee that lands in the contract is stranded, and is what a pool credit ' +
      'looks like when the pool var is left alone.',
  ).toBe(backingBefore);

  expect(
    ownerAfter - ownerBefore,
    `${label}: the contract owner should have received exactly ${amountUstx} uSTX.`,
  ).toBe(amountUstx);

  expect(
    payerBefore - payerAfter,
    `${label}: the payer should have parted with exactly ${amountUstx} uSTX.`,
  ).toBe(amountUstx);

  return outcome.result;
}

/**
 * Assert a call moved no STX anywhere — the counterpart for free paths.
 *
 * Free dungeon entry, burns, and transfers all have to be provably costless;
 * this is how a fee accidentally introduced into one of them gets caught.
 */
export function expectNoStxMovement(options: {
  readonly principals: readonly string[];
  readonly owner: string;
  readonly call: () => CallResult;
  readonly label: string;
}): ClarityValue {
  const { principals, owner, call, label } = options;

  const before = principals.map(stxBalance);
  const poolBefore = sponsorPool(owner);
  const backingBefore = poolBackingHeld(owner);

  const outcome = call();

  principals.forEach((who, i) => {
    expect(stxBalance(who), `${label}: ${who} should not have moved any STX.`).toBe(before[i]);
  });
  expect(sponsorPool(owner), `${label}: sponsor pool should be untouched.`).toBe(poolBefore);
  expect(poolBackingHeld(owner), `${label}: pool backing should be untouched.`).toBe(backingBefore);

  return outcome.result;
}

/** Convenience: uSTX from whole STX, so tests read in the units humans use. */
export function stx(whole: number): bigint {
  return BigInt(whole) * 1_000_000n;
}

/** Re-exported so call sites building arguments need one import, not two. */
export { Cl };

/**
 * Job lease store tests (docs/09 B7).
 *
 * The lease is the only thing standing between two warm serverless instances and
 * two `reveal-and-resolve` broadcasts for one drop, so the cases here are about
 * the three ways a lease stops being a mutex.
 *
 * IT IS EXCLUSIVE WHILE HELD. Obvious, and asserted first because everything else
 * is a qualification of it.
 *
 * IT EXPIRES WITHOUT BEING HANDED BACK. A holder can vanish — an instance frozen
 * mid-pass and never resumed, a process killed, a deploy replacing the fleet — and
 * in none of those cases does anything run a release. A lease that could only be
 * given back would wedge the job permanently the first time that happened, and
 * would do it silently: every later pass returns a healthy "skipped".
 *
 * RELEASE IS SCOPED TO THE HOLDER. The corollary of expiry. Once a lease has timed
 * out and been taken by someone else, the original holder is still running and will
 * still try to release on its way out. An unscoped delete there would free the new
 * holder's claim mid-pass and reintroduce the race — worse, it would do it
 * precisely when passes are already running long.
 *
 * Only `MemoryJobLeaseStore` is exercised: `PostgresJobLeaseStore` needs a
 * database, as `PostgresRunStore` does. What these pin is the contract both
 * implement, and the SQL is written to mirror it statement for statement — the
 * `where job_leases.lease_until <= now()` on the upsert is the expiry rule below,
 * and the `and holder = $2` on the delete is the scoping rule.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOOT_MINT_JOB, MemoryJobLeaseStore } from '../src/repos/jobLeases.js';

const A = 'instance-a';
const B = 'instance-b';

describe('MemoryJobLeaseStore', () => {
  let leases: MemoryJobLeaseStore;

  beforeEach(() => {
    leases = new MemoryJobLeaseStore();
    vi.useRealTimers();
  });

  it('grants a free lease', async () => {
    expect(await leases.acquire(LOOT_MINT_JOB, 120, A)).toBe(true);
  });

  it('refuses a second holder while the first still has it', async () => {
    await leases.acquire(LOOT_MINT_JOB, 120, A);
    // The whole point. False is an ordinary "skip this pass", not an error — a
    // caller that retried until it won would be the race with extra steps.
    expect(await leases.acquire(LOOT_MINT_JOB, 120, B)).toBe(false);
  });

  it('grants it to the next caller once released', async () => {
    await leases.acquire(LOOT_MINT_JOB, 120, A);
    await leases.release(LOOT_MINT_JOB, A);
    expect(await leases.acquire(LOOT_MINT_JOB, 120, B)).toBe(true);
  });

  it('grants an expired lease to somebody else without a release', async () => {
    // The recovery path, and the only one there is: nothing runs a release when
    // an instance is frozen mid-pass or killed outright.
    vi.useFakeTimers();
    await leases.acquire(LOOT_MINT_JOB, 120, A);

    vi.advanceTimersByTime(121_000);
    expect(await leases.acquire(LOOT_MINT_JOB, 120, B)).toBe(true);
  });

  it('holds the lease right up to its expiry, not merely most of the way', async () => {
    // An off-by-one that granted the lease a tick early would be invisible in the
    // exclusivity test above and would be a real overlap window in production.
    vi.useFakeTimers();
    await leases.acquire(LOOT_MINT_JOB, 120, A);

    vi.advanceTimersByTime(119_000);
    expect(await leases.acquire(LOOT_MINT_JOB, 120, B)).toBe(false);
  });

  it('ignores a release from a holder that has already lost the lease', async () => {
    // A overran its TTL, B took over, and A is still running — it will release on
    // its way out. That release must not free B's claim: A is the pass that was
    // already too slow, and cutting B loose mid-pass is the double-broadcast this
    // whole mechanism exists to prevent.
    vi.useFakeTimers();
    await leases.acquire(LOOT_MINT_JOB, 120, A);
    vi.advanceTimersByTime(121_000);
    await leases.acquire(LOOT_MINT_JOB, 120, B);

    await leases.release(LOOT_MINT_JOB, A);

    expect(await leases.acquire(LOOT_MINT_JOB, 120, A)).toBe(false);
  });

  it('treats releasing a lease nobody holds as a no-op', async () => {
    // Reachable whenever a pass loses its lease and tidies up anyway, so it must
    // not throw — the release runs in a `finally` that must not fail the pass.
    await expect(leases.release(LOOT_MINT_JOB, A)).resolves.toBeUndefined();
  });

  it('keeps separate jobs from blocking each other', async () => {
    // Nothing else uses a lease today. The key exists so that the first job that
    // does is not silently serialised behind the loot ceremony.
    await leases.acquire(LOOT_MINT_JOB, 120, A);
    expect(await leases.acquire('some-other-job', 120, A)).toBe(true);
  });
});

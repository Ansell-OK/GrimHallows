/**
 * Cross-instance mutual exclusion for scheduled jobs (docs/09 B7).
 *
 * WHAT THIS IS FOR, AND WHY AN IN-PROCESS FLAG IS NOT ENOUGH
 *
 * `LootMinterLoop` already refuses to start a pass while one is running. That
 * boolean covers one process, which was the whole world when the only driver was
 * a `setInterval` on a host that owned its own process. It is no longer: the
 * ceremony is driven over HTTP by two schedulers against a serverless deployment
 * that can have several warm instances at once, and a flag on one of them says
 * nothing about the others.
 *
 * Two concurrent passes read the same run at the same recorded step — neither has
 * written its txid back yet — and both broadcast it. One confirms; the other
 * confirms as `abort_by_response`. If the aborted txid is the one that got
 * recorded, the run is parked as failed after the player was already shown their
 * drop. Nothing is lost on chain and no money moves wrongly, but a player is owed
 * an NFT until an operator clears `loot_mint_failed_reason` by hand.
 *
 * WHY A LEASE AND NOT AN ADVISORY LOCK
 *
 * `pg_try_advisory_lock` is the obvious tool and is unavailable here. It is
 * session-scoped, and this codebase talks to Supabase's *transaction* pooler,
 * where consecutive queries are not guaranteed to land on the same backend — the
 * lock would be taken on one connection and the unlock attempted on another. See
 * the rules at the top of `src/db.ts`. A row with an expiry needs no session
 * affinity at all: acquire and release are each one statement, which is exactly
 * what that pooler supports.
 *
 * WHY IT EXPIRES RATHER THAN BEING HELD
 *
 * The holder can vanish. A serverless instance is frozen mid-pass and never
 * resumed, a deploy replaces the fleet, a process is killed — in every case
 * nothing runs the release. A lease that had to be handed back would wedge the
 * job permanently the first time that happened, and it would wedge silently.
 * `leaseUntil` in the past means "whoever held this is gone", so the worst case
 * is one TTL of delay rather than a job that never runs again.
 *
 * The cost of that choice is the thing to keep in view: a pass that runs *longer*
 * than its TTL loses the lease while still working, and a second pass can start
 * underneath it. So the TTL is a claim about maximum pass duration, and it has to
 * stay comfortably above the real one. See `DEFAULT_LOOT_MINTER_LOOP_CONFIG`.
 */

import { query } from '../db.js';

/** The lease key for the free-run loot ceremony. */
export const LOOT_MINT_JOB = 'loot-mint';

export interface JobLeaseStore {
  /**
   * Take the lease if it is free or expired. True means the caller owns it.
   *
   * False is an ordinary outcome, not an error: it means another instance is
   * mid-pass and this one should do nothing. Callers must treat it as "skip",
   * never as "retry until it works" — a spin here would be two passes racing
   * again with extra steps.
   */
  acquire(job: string, ttlSeconds: number, holder: string): Promise<boolean>;

  /**
   * Hand the lease back, if this holder still owns it.
   *
   * Scoped to `holder` on purpose. A pass that overran its TTL has already lost
   * the lease to someone else, and an unscoped delete would release *their*
   * claim on the way out — turning one late pass into an unbounded pile-up.
   * Releasing a lease you no longer hold is a no-op, which is the correct
   * outcome and not worth reporting.
   */
  release(job: string, holder: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

export class PostgresJobLeaseStore implements JobLeaseStore {
  async acquire(job: string, ttlSeconds: number, holder: string): Promise<boolean> {
    // One statement, which is what makes this safe on the transaction pooler and
    // safe against a concurrent caller: the `on conflict` path is evaluated under
    // the row lock the insert attempt takes, so two instances arriving together
    // are serialised by Postgres and exactly one sees the pre-update row as
    // expired. The `where` is on `job_leases.lease_until` — the value already
    // stored — not on `excluded`, which is the row we are proposing.
    //
    // `now()` is transaction time on the server, so this does not depend on the
    // clocks of the instances racing for it. Two functions in different regions
    // with skewed clocks still agree about who won.
    const { rowCount } = await query(
      `insert into job_leases (job, holder, lease_until)
       values ($1, $2, now() + make_interval(secs => $3::int))
       on conflict (job) do update
          set holder = excluded.holder,
              lease_until = excluded.lease_until
        where job_leases.lease_until <= now()`,
      [job, holder, ttlSeconds],
    );
    return (rowCount ?? 0) === 1;
  }

  async release(job: string, holder: string): Promise<void> {
    // Deleted rather than expired-in-place so the next pass starts immediately
    // instead of waiting out a TTL that has no purpose once the work is done.
    await query(`delete from job_leases where job = $1 and holder = $2`, [job, holder]);
  }
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

/**
 * Single-process equivalent.
 *
 * Redundant with `LootMinterLoop`'s own in-flight flag when it is the only
 * process — which is the point. A deployment without `DATABASE_URL` is a
 * developer's machine, and having the same code path run there means the lease
 * is exercised by every test rather than being production-only code that first
 * executes on mainnet.
 */
export class MemoryJobLeaseStore implements JobLeaseStore {
  private readonly leases = new Map<string, { holder: string; until: number }>();

  async acquire(job: string, ttlSeconds: number, holder: string): Promise<boolean> {
    const held = this.leases.get(job);
    // Mirrors the SQL's `lease_until <= now()`: an expired lease is available.
    if (held && held.until > Date.now()) return false;
    this.leases.set(job, { holder, until: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  async release(job: string, holder: string): Promise<void> {
    if (this.leases.get(job)?.holder === holder) this.leases.delete(job);
  }
}

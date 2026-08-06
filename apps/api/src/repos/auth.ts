/**
 * Auth storage: single-use login challenges and issued sessions.
 *
 * The challenge table is what stops the obvious replay attacks on wallet login:
 *
 *   - A challenge this server never issued is rejected, so a caller cannot pick
 *     a string they happen to already have a signature for.
 *   - A challenge is consumed atomically on first successful verify, so one
 *     captured signature cannot be redeemed twice.
 *   - Challenges expire, bounding how long a leaked signature is worth anything.
 *
 * The interface exists so route tests can run against an in-memory double while
 * production runs against Postgres — the rules above are enforced identically in
 * both, and `test/authStore.test.ts` checks the in-memory one keeps its side of
 * the bargain.
 */

import { randomBytes } from 'node:crypto';
import { query } from '../db.js';

export interface ChallengeRecord {
  readonly challenge: string;
  readonly expiresAt: Date;
}

export interface AuthStore {
  /** Record a freshly-minted challenge. */
  issueChallenge(challenge: string, expiresAt: Date): Promise<void>;
  /**
   * Atomically consume an unconsumed, unexpired challenge.
   * Returns false if it is unknown, already used, or expired.
   */
  consumeChallenge(challenge: string, now?: Date): Promise<boolean>;
  /** Record an issued session (audit trail; the JWT itself is stateless). */
  recordSession(address: string, expiresAt: Date): Promise<void>;
  /** Housekeeping: drop expired challenges and sessions. */
  sweepExpired(now?: Date): Promise<void>;
}

/** 32 bytes of CSPRNG output. Never Math.random(), even here. */
export function generateChallenge(): string {
  return `grimhallow-login-${randomBytes(32).toString('hex')}`;
}

export class PostgresAuthStore implements AuthStore {
  async issueChallenge(challenge: string, expiresAt: Date): Promise<void> {
    await query(
      `insert into auth_challenges (challenge, expires_at) values ($1, $2)
       on conflict (challenge) do nothing`,
      [challenge, expiresAt],
    );
  }

  async consumeChallenge(challenge: string, now: Date = new Date()): Promise<boolean> {
    // Consume in the WHERE clause, not in a read-then-write: two concurrent
    // verifies of the same challenge must not both succeed.
    const { rowCount } = await query(
      `update auth_challenges
          set consumed_at = $2
        where challenge = $1
          and consumed_at is null
          and expires_at > $2`,
      [challenge, now],
    );
    return (rowCount ?? 0) > 0;
  }

  async recordSession(address: string, expiresAt: Date): Promise<void> {
    await query(`insert into sessions (address, expires_at) values ($1, $2)`, [
      address,
      expiresAt,
    ]);
  }

  async sweepExpired(now: Date = new Date()): Promise<void> {
    await query(`delete from auth_challenges where expires_at < $1`, [now]);
    await query(`delete from sessions where expires_at < $1`, [now]);
  }
}

/** In-memory equivalent, for tests and for `npm run dev` without Postgres. */
export class MemoryAuthStore implements AuthStore {
  private readonly challenges = new Map<string, { expiresAt: Date; consumed: boolean }>();
  private readonly sessions: { address: string; expiresAt: Date }[] = [];

  async issueChallenge(challenge: string, expiresAt: Date): Promise<void> {
    this.challenges.set(challenge, { expiresAt, consumed: false });
  }

  async consumeChallenge(challenge: string, now: Date = new Date()): Promise<boolean> {
    const record = this.challenges.get(challenge);
    if (!record || record.consumed || record.expiresAt <= now) return false;
    record.consumed = true;
    return true;
  }

  async recordSession(address: string, expiresAt: Date): Promise<void> {
    this.sessions.push({ address, expiresAt });
  }

  async sweepExpired(now: Date = new Date()): Promise<void> {
    for (const [key, record] of this.challenges) {
      if (record.expiresAt < now) this.challenges.delete(key);
    }
  }
}

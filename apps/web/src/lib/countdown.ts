/**
 * Spawn countdowns.
 *
 * A free dungeon closes at a server-set `expiresAt`, and the marker on the map
 * is the only warning a player gets. Two things this module exists to prevent:
 *
 *   - Guessing. The original mock decided "expiring soon" by reading the first
 *     integer out of a label string. Urgency here is a fact about a timestamp,
 *     not about how a string happens to be spelled.
 *   - Counting past zero. A marker that reads "-3m 12s" is worse than one that
 *     says "Closed", because it invites a click that the API will refuse.
 *
 * Client clocks drift, so treat all of this as display only: whether a spawn is
 * still enterable is decided by the server, which compares against its own clock
 * and returns 409 if the spawn has closed.
 */

/** Below this, the marker switches to its urgent styling. */
export const EXPIRING_SOON_MS = 15 * 60 * 1000;

/** Milliseconds until `expiresAt`, floored at 0. NaN input reads as closed. */
export function msRemaining(expiresAt: string, now: number = Date.now()): number {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return 0;
  return Math.max(0, expiry - now);
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * `1_020_000` → `"17m 00s"`. Matches the `27m 12s` shape the map was designed
 * around, and degrades to `1h 05m` rather than showing a three-digit minute
 * count.
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'Closed';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0 ? `${hours}h ${pad(minutes)}m` : `${minutes}m ${pad(seconds)}s`;
}

export function isExpiringSoon(ms: number): boolean {
  return ms > 0 && ms <= EXPIRING_SOON_MS;
}

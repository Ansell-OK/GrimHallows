/**
 * Browser-side session storage.
 *
 * What lives here is a *convenience* record, never an authority. The session
 * token authenticates off-chain reads; it cannot move money, and the backend
 * re-reads ownership from chain on every request (04-backend-api-spec.md#intro).
 * So a tampered localStorage entry buys an attacker nothing — the worst case is
 * a token the API rejects.
 *
 * Everything is read defensively: localStorage can be disabled, full, or hold
 * whatever a previous version of this app wrote.
 */

const SESSION_KEY = 'grimhallow.session';
const ACTIVE_CHARACTER_KEY = 'grimhallow.activeCharacter';
const ACTIVE_RUN_KEY = 'grimhallow.activeRun';

export interface StoredSession {
  readonly token: string;
  readonly address: string;
  /** ISO timestamp from the API. */
  readonly expiresAt: string;
}

/** A character the player picked on the select screen, by on-chain identity. */
export interface ActiveCharacter {
  readonly contractId: string;
  readonly tokenId: string;
}

/**
 * The run the player is currently inside, handed back by dungeon entry.
 *
 * `runToken` is scoped to this one run and, like the session token, cannot move
 * money — it authorises submitting turns and nothing else. It is stored so a
 * refresh mid-dungeon doesn't strand the player outside their own run.
 */
export interface ActiveRun {
  readonly runId: string;
  readonly dungeonType: 'free' | 'paid';
  readonly runToken: string;
  readonly monsterTableId: string;
  readonly spawnId: string | null;
  /** ISO timestamp after which the run token stops being accepted. */
  readonly expiresAt: string;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private-mode / quota failures are not worth breaking the app over; the
    // player simply has to reconnect next visit.
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Returns the stored session, or null if absent, malformed, or expired. */
export function loadSession(): StoredSession | null {
  const stored = readJson<Partial<StoredSession>>(SESSION_KEY);
  if (!stored?.token || !stored.address || !stored.expiresAt) return null;

  const expiry = Date.parse(stored.expiresAt);
  // Drop it locally the moment it expires rather than letting the player click
  // into a screen that will 401 on them.
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    remove(SESSION_KEY);
    return null;
  }

  return stored as StoredSession;
}

export function saveSession(session: StoredSession): void {
  writeJson(SESSION_KEY, session);
}

export function clearSession(): void {
  remove(SESSION_KEY);
  remove(ACTIVE_CHARACTER_KEY);
  remove(ACTIVE_RUN_KEY);
}

export function loadActiveCharacter(): ActiveCharacter | null {
  const stored = readJson<Partial<ActiveCharacter>>(ACTIVE_CHARACTER_KEY);
  if (!stored?.contractId || !stored.tokenId) return null;
  return stored as ActiveCharacter;
}

export function saveActiveCharacter(character: ActiveCharacter): void {
  writeJson(ACTIVE_CHARACTER_KEY, {
    contractId: character.contractId,
    tokenId: character.tokenId,
  });
}

/** Stable key for a token, used for React keys and selection comparisons. */
export function characterKey(c: { contractId: string; tokenId: string }): string {
  return `${c.contractId}::${c.tokenId}`;
}

/** Returns the stored run, or null if absent, malformed, or expired. */
export function loadActiveRun(): ActiveRun | null {
  const stored = readJson<Partial<ActiveRun>>(ACTIVE_RUN_KEY);
  if (!stored?.runId || !stored.runToken || !stored.expiresAt) return null;

  const expiry = Date.parse(stored.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    remove(ACTIVE_RUN_KEY);
    return null;
  }

  return {
    runId: stored.runId,
    dungeonType: stored.dungeonType === 'paid' ? 'paid' : 'free',
    runToken: stored.runToken,
    monsterTableId: stored.monsterTableId ?? '',
    spawnId: stored.spawnId ?? null,
    expiresAt: stored.expiresAt,
  };
}

export function saveActiveRun(run: ActiveRun): void {
  writeJson(ACTIVE_RUN_KEY, run);
}

export function clearActiveRun(): void {
  remove(ACTIVE_RUN_KEY);
}

/**
 * Session storage tests.
 *
 * The point of these is that a corrupt, hostile, or unavailable localStorage
 * must never break the app or resurrect an expired session. The store is a
 * convenience cache, not an authority — but "not an authority" is only true if
 * an expired token actually stops being used.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  characterKey,
  clearActiveRun,
  clearSession,
  loadActiveCharacter,
  loadActiveRun,
  loadSession,
  saveActiveCharacter,
  saveActiveRun,
  saveSession,
} from '../src/lib/session';

function installStorage(overrides: Partial<Storage> = {}) {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    ...overrides,
  } as Storage;
  vi.stubGlobal('window', { localStorage: storage });
  return { map, storage };
}

const future = () => new Date(Date.now() + 60_000).toISOString();

const run = (overrides: Record<string, unknown> = {}) => ({
  runId: '1000000000',
  dungeonType: 'free' as const,
  runToken: 'run-token',
  monsterTableId: 'forsaken-crypt',
  spawnId: '0f1e2d3c-4b5a-4967-8899-aabbccddeeff',
  expiresAt: future(),
  ...overrides,
});

beforeEach(() => {
  vi.unstubAllGlobals();
  installStorage();
});

describe('loadSession', () => {
  it('round-trips a valid session', () => {
    const session = { token: 'tok', address: 'ST123', expiresAt: future() };
    saveSession(session);
    expect(loadSession()).toEqual(session);
  });

  it('returns null when nothing is stored', () => {
    expect(loadSession()).toBeNull();
  });

  it('drops an expired session and removes it from storage', () => {
    const { map } = installStorage();
    saveSession({
      token: 'tok',
      address: 'ST123',
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    expect(loadSession()).toBeNull();
    expect(map.has('grimhallow.session')).toBe(false);
  });

  it('treats an unparseable expiry as expired rather than as valid forever', () => {
    const { storage } = installStorage();
    storage.setItem(
      'grimhallow.session',
      JSON.stringify({ token: 't', address: 'ST1', expiresAt: 'not a date' }),
    );
    expect(loadSession()).toBeNull();
  });

  it('returns null for malformed JSON instead of throwing', () => {
    const { storage } = installStorage();
    storage.setItem('grimhallow.session', '{ not json');
    expect(loadSession()).toBeNull();
  });

  it.each([
    ['missing token', { address: 'ST1', expiresAt: '2999-01-01T00:00:00Z' }],
    ['missing address', { token: 't', expiresAt: '2999-01-01T00:00:00Z' }],
    ['missing expiry', { token: 't', address: 'ST1' }],
    ['empty token', { token: '', address: 'ST1', expiresAt: '2999-01-01T00:00:00Z' }],
  ])('returns null when the record is incomplete: %s', (_label, record) => {
    const { storage } = installStorage();
    storage.setItem('grimhallow.session', JSON.stringify(record));
    expect(loadSession()).toBeNull();
  });

  it('survives localStorage being unavailable', () => {
    installStorage({
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(loadSession()).toBeNull();
  });
});

describe('saveSession', () => {
  it('does not throw when storage is full', () => {
    installStorage({
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    });
    expect(() =>
      saveSession({ token: 't', address: 'ST1', expiresAt: future() }),
    ).not.toThrow();
  });
});

describe('clearSession', () => {
  it('removes the session, the active character and the active run', () => {
    const { map } = installStorage();
    saveSession({ token: 't', address: 'ST1', expiresAt: future() });
    saveActiveCharacter({ contractId: 'ST1.nft', tokenId: '4' });
    saveActiveRun(run());

    clearSession();

    expect(map.size).toBe(0);
    expect(loadSession()).toBeNull();
    expect(loadActiveCharacter()).toBeNull();
    // Disconnecting must not leave a run token behind for the next wallet to
    // inherit — it speaks for the address that entered that run.
    expect(loadActiveRun()).toBeNull();
  });
});

describe('active character', () => {
  it('round-trips contract id and token id', () => {
    saveActiveCharacter({ contractId: 'ST1.nft', tokenId: '4' });
    expect(loadActiveCharacter()).toEqual({ contractId: 'ST1.nft', tokenId: '4' });
  });

  it('stores only on-chain identity, never derived stats', () => {
    const { storage } = installStorage();
    saveActiveCharacter({
      contractId: 'ST1.nft',
      tokenId: '4',
      // A caller passing a whole character must not get its stats persisted —
      // stats are re-derived server-side, and a cached copy could go stale or
      // be edited by hand.
      ...({ stats: { hp: 9999 }, rarity: 'mythic' } as object),
    });
    const raw = storage.getItem('grimhallow.activeCharacter')!;
    expect(JSON.parse(raw)).toEqual({ contractId: 'ST1.nft', tokenId: '4' });
    expect(raw).not.toContain('9999');
  });

  it('returns null for a partial record', () => {
    const { storage } = installStorage();
    storage.setItem('grimhallow.activeCharacter', JSON.stringify({ contractId: 'ST1.nft' }));
    expect(loadActiveCharacter()).toBeNull();
  });
});

describe('active run', () => {
  it('round-trips a run', () => {
    const record = run();
    saveActiveRun(record);
    expect(loadActiveRun()).toEqual(record);
  });

  it('returns null when nothing is stored', () => {
    expect(loadActiveRun()).toBeNull();
  });

  it('drops an expired run token and removes it from storage', () => {
    // The token is dead to the API at this point; keeping it around would only
    // send the player into a run that 401s on the first turn.
    const { map } = installStorage();
    saveActiveRun(run({ expiresAt: new Date(Date.now() - 1).toISOString() }));
    expect(loadActiveRun()).toBeNull();
    expect(map.has('grimhallow.activeRun')).toBe(false);
  });

  it('treats an unparseable expiry as expired rather than as valid forever', () => {
    const { storage } = installStorage();
    storage.setItem('grimhallow.activeRun', JSON.stringify(run({ expiresAt: 'soon' })));
    expect(loadActiveRun()).toBeNull();
  });

  it('returns null for malformed JSON instead of throwing', () => {
    const { storage } = installStorage();
    storage.setItem('grimhallow.activeRun', '{ not json');
    expect(loadActiveRun()).toBeNull();
  });

  it.each([
    ['missing runId', { runToken: 't', expiresAt: '2999-01-01T00:00:00Z' }],
    ['missing token', { runId: '1', expiresAt: '2999-01-01T00:00:00Z' }],
    ['missing expiry', { runId: '1', runToken: 't' }],
  ])('returns null when the record is incomplete: %s', (_label, record) => {
    const { storage } = installStorage();
    storage.setItem('grimhallow.activeRun', JSON.stringify(record));
    expect(loadActiveRun()).toBeNull();
  });

  it('does not upgrade an unknown dungeon type to paid', () => {
    // A paid run implies a confirmed on-chain entry. Nothing read out of
    // localStorage gets to make that claim on its own.
    const { storage } = installStorage();
    storage.setItem('grimhallow.activeRun', JSON.stringify(run({ dungeonType: 'sponsored' })));
    expect(loadActiveRun()?.dungeonType).toBe('free');
  });

  it('clears on demand', () => {
    saveActiveRun(run());
    clearActiveRun();
    expect(loadActiveRun()).toBeNull();
  });

  it('survives localStorage being unavailable', () => {
    installStorage({
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(loadActiveRun()).toBeNull();
  });
});

describe('characterKey', () => {
  it('distinguishes the same token id across different collections', () => {
    expect(characterKey({ contractId: 'ST1.a', tokenId: '1' })).not.toBe(
      characterKey({ contractId: 'ST1.b', tokenId: '1' }),
    );
  });

  it('is stable for the same token', () => {
    const c = { contractId: 'ST1.a', tokenId: '1' };
    expect(characterKey(c)).toBe(characterKey({ ...c }));
  });
});

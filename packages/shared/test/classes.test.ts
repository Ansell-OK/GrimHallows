/**
 * Class resolution tests (01-game-design.md#4a, curated-collection delta).
 *
 * Two rules carry everything else: a minted class is read rather than derived
 * and so wins, and a token from an unlisted collection has no class at all.
 * The second is the one worth guarding hardest — it is the difference between a
 * curated roster and "every NFT on Stacks is playable", and the previous
 * behaviour was the latter.
 *
 * These tests use the real table rather than installing fixtures into it. The
 * eight principals are now data the game ships with, so a test that emptied the
 * table and refilled it would be checking a lookup function against itself while
 * the shipped mapping went unexercised.
 */

import { describe, it, expect } from 'vitest';
import {
  CLASS_BLURBS,
  CLASS_DISPLAY_NAMES,
  CLASS_EMPHASIS,
  CLASS_IDS,
  SUPPORTED_CLASS_CONTRACTS,
  UnsupportedCollectionError,
  classCatalog,
  classDisplayName,
  deriveClass,
  isCharClass,
  isSupportedCollection,
  normalizeContractId,
  supportedCollections,
} from '../src/classes.js';
import type { CharClass } from '../src/types.js';

/** Not in the table, and never will be — the "ordinary NFT" case. */
const UNLISTED = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.mock-nft';

/** A real entry, so the assertions below run against shipped data. */
const WARRIOR_COLLECTION = 'SP2RNHHQDTHGHPEVX83291K4AQZVGWEJ7WCQQDA9R.giga-pepe-v2';
const MAGE_COLLECTION = 'SP2N959SER36FZ5QT1CX9BR63W3E8X35WQCMBYYWC.leo-cats';

describe('the class table', () => {
  it('has exactly four classes with unique ids', () => {
    expect(CLASS_IDS).toHaveLength(4);
    expect(new Set(CLASS_IDS).size).toBe(4);
  });

  it('gives every class a display name, an emphasis, and a blurb', () => {
    for (const id of CLASS_IDS) {
      expect(CLASS_DISPLAY_NAMES[id]).toBeTruthy();
      expect(CLASS_EMPHASIS[id].length).toBeGreaterThan(0);
      expect(CLASS_BLURBS[id]).toBeTruthy();
    }
    expect(new Set(Object.values(CLASS_DISPLAY_NAMES)).size).toBe(4);
  });

  it('exposes the catalog in display order', () => {
    expect(classCatalog().map((c) => c.classId)).toEqual([...CLASS_IDS]);
    expect(classDisplayName('warrior')).toBe('Warrior');
  });
});

describe('the supported-collection allowlist', () => {
  it('lists exactly eight collections', () => {
    expect(Object.keys(SUPPORTED_CLASS_CONTRACTS)).toHaveLength(8);
  });

  it('covers all four classes, two collections each', () => {
    const perClass: Record<string, number> = {};
    for (const classId of Object.values(SUPPORTED_CLASS_CONTRACTS)) {
      perClass[classId] = (perClass[classId] ?? 0) + 1;
    }
    for (const id of CLASS_IDS) expect(perClass[id]).toBe(2);
  });

  it('stores every key already normalized', () => {
    // The module throws at import time if this is violated, so a failure here
    // means the guard itself stopped working rather than a key slipping past.
    for (const key of Object.keys(SUPPORTED_CLASS_CONTRACTS)) {
      expect(key).toBe(normalizeContractId(key));
    }
  });

  it('maps every key to a real class id', () => {
    for (const classId of Object.values(SUPPORTED_CLASS_CONTRACTS)) {
      expect(isCharClass(classId)).toBe(true);
    }
  });

  it('reports membership case-insensitively', () => {
    expect(isSupportedCollection(WARRIOR_COLLECTION)).toBe(true);
    expect(isSupportedCollection(WARRIOR_COLLECTION.toUpperCase())).toBe(true);
    expect(isSupportedCollection(`  ${WARRIOR_COLLECTION}  `)).toBe(true);
    expect(isSupportedCollection(UNLISTED)).toBe(false);
  });

  it('publishes the list with a display name per entry', () => {
    const list = supportedCollections();
    expect(list).toHaveLength(8);
    for (const entry of list) {
      expect(entry.className).toBe(CLASS_DISPLAY_NAMES[entry.classId]);
      expect(isSupportedCollection(entry.contractId)).toBe(true);
    }
  });
});

describe('isCharClass', () => {
  it('accepts the four ids and nothing else', () => {
    for (const id of CLASS_IDS) expect(isCharClass(id)).toBe(true);
    for (const bad of ['Warrior', 'iron-templar', 'necromancer', '', null, undefined, 3, {}]) {
      expect(isCharClass(bad)).toBe(false);
    }
  });
});

describe('precedence: mint > supported collection > nothing', () => {
  it('takes the minted class when there is one — it is read, not derived', () => {
    expect(deriveClass(UNLISTED, '1', 'mage')).toEqual({
      classId: 'mage',
      className: 'Mage',
      classSource: 'mint',
    });
  });

  it('prefers the minted class even over a supported collection', () => {
    const c = deriveClass(WARRIOR_COLLECTION, '1', 'rogue');
    expect(c?.classSource).toBe('mint');
    expect(c?.classId).toBe('rogue');
  });

  it('takes the allowlist mapping for a supported collection', () => {
    expect(deriveClass(MAGE_COLLECTION, '1')).toEqual({
      classId: 'mage',
      className: 'Mage',
      classSource: 'supported_collection',
    });
  });

  it('gives every token in a supported collection the same class', () => {
    for (const token of ['1', '2', '9999']) {
      expect(deriveClass(WARRIOR_COLLECTION, token)?.classId).toBe('warrior');
    }
  });

  it('resolves every shipped collection to its mapped class', () => {
    for (const [contractId, classId] of Object.entries(SUPPORTED_CLASS_CONTRACTS)) {
      expect(deriveClass(contractId, '1')).toEqual({
        classId,
        className: CLASS_DISPLAY_NAMES[classId],
        classSource: 'supported_collection',
      });
    }
  });
});

describe('an unlisted collection is not a character', () => {
  it('returns null rather than a class', () => {
    expect(deriveClass(UNLISTED, '1')).toBeNull();
  });

  it('returns null for every token id, not just some', () => {
    // The rule this replaced hashed (contract || token) into a class, so a
    // per-token answer here would mean a fallback survived somewhere.
    for (let i = 0; i < 200; i++) expect(deriveClass(UNLISTED, String(i))).toBeNull();
  });

  it('never emits a classSource other than the two real ones', () => {
    const sources = new Set<string>();
    for (const contractId of Object.keys(SUPPORTED_CLASS_CONTRACTS)) {
      sources.add(deriveClass(contractId, '1')!.classSource);
    }
    sources.add(deriveClass(UNLISTED, '1', 'rogue')!.classSource);
    expect([...sources].sort()).toEqual(['mint', 'supported_collection']);
  });
});

describe('an unrecognized minted class is ignored, not trusted', () => {
  it('falls through to the allowlist', () => {
    const c = deriveClass(WARRIOR_COLLECTION, '1', 'necromancer');
    expect(c?.classId).toBe('warrior');
    expect(c?.classSource).toBe('supported_collection');
  });

  it('leaves an unlisted token with no class at all', () => {
    // The contract rejects unknown class ids, so one reaching here means
    // something upstream is wrong. Do not believe an impossible value.
    for (const bad of ['necromancer', 'Warrior', '', ' mage ']) {
      expect(deriveClass(UNLISTED, '1', bad)).toBeNull();
    }
    expect(deriveClass(UNLISTED, '1', null)).toBeNull();
  });
});

describe('contract ids compare case- and whitespace-insensitively', () => {
  it('matches a supported contract regardless of case', () => {
    expect(deriveClass(MAGE_COLLECTION.toUpperCase(), '1')?.classId).toBe('mage');
    expect(deriveClass(MAGE_COLLECTION.toLowerCase(), '1')?.classId).toBe('mage');
    expect(deriveClass(`  ${MAGE_COLLECTION}  `, '1')?.classId).toBe('mage');
  });

  it('normalizes to lowercase and trims', () => {
    expect(normalizeContractId('  SP1ABC.Thing  ')).toBe('sp1abc.thing');
  });
});

describe('resolution is stable', () => {
  it('returns the same answer for the same token every time', () => {
    expect(deriveClass(WARRIOR_COLLECTION, '77')).toEqual(deriveClass(WARRIOR_COLLECTION, '77'));
  });

  it('ignores the token id entirely', () => {
    const first = deriveClass(WARRIOR_COLLECTION, '1');
    for (const token of ['2', '500', '999999']) {
      expect(deriveClass(WARRIOR_COLLECTION, token)).toEqual(first);
    }
  });

  it('always names the class it returns', () => {
    for (const contractId of Object.keys(SUPPORTED_CLASS_CONTRACTS)) {
      const c = deriveClass(contractId, '1')!;
      expect(c.className).toBe(CLASS_DISPLAY_NAMES[c.classId satisfies CharClass]);
    }
  });
});

describe('UnsupportedCollectionError', () => {
  it('carries the pair that could not be resolved', () => {
    const err = new UnsupportedCollectionError(UNLISTED, '4');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UnsupportedCollectionError');
    expect(err.contractId).toBe(UNLISTED);
    expect(err.tokenId).toBe('4');
    expect(err.message).toContain(UNLISTED);
  });
});

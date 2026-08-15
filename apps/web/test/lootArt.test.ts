/**
 * Loot art resolution tests.
 *
 * The art index is the only place the web app turns an on-chain archetype into a
 * picture, and it runs on every inventory row, every loadout card, and the reward
 * screen a player sees immediately after a win. So the properties that matter are
 * about *degrading*, not about looking right:
 *
 * 1. It is total. `slug` arrives from `parseLootUri`, which is downstream of a raw
 *    `(string-ascii 256)` chain read. A throw here would blank the inventory page
 *    for a holder whose token carries something unexpected, so every hostile shape
 *    must return `undefined` and let the caller fall back.
 *
 * 2. `relic` never gets art. Mainnet loot token #1 parses to `relic` and is held by
 *    a real player; it must keep today's generic loot picture even if a file called
 *    `relic-tier-1.jpg` is dropped into the folder by accident. This is asserted
 *    against a synthetic index that DOES contain that file, because the folder
 *    shipping empty would make the assertion pass for the wrong reason.
 *
 * 3. The floor fallback fires per archetype, not globally. A half-produced art set
 *    is the expected state for a while: tier-1 art exists, tiers 2-4 do not. Every
 *    tier of that archetype must show its tier-1 image, and an archetype with no
 *    art at all must NOT borrow another archetype's.
 *
 * 4. Stems agree with `shared`. The bundled filename, the pinned metadata document,
 *    and the image the document points at are all named by `lootFileStem`. The test
 *    builds its synthetic index from that function rather than from typed-in
 *    strings, so a rename in `shared` fails here instead of silently unindexing
 *    all 48 files — a miss returns `undefined`, which looks exactly like art that
 *    has not been produced yet, and would ship as "the images never showed up".
 *
 * `lootArtFor` itself is not exercised: it closes over `import.meta.glob`, which
 * binds an empty folder today, so every call returns `undefined` regardless of the
 * logic. That is precisely why `resolveLootArt` takes its index as a parameter.
 */

import { describe, expect, it } from 'vitest';
import {
  LOOT_ART_EXEMPT,
  LOOT_ART_FLOOR_TIER,
  indexLootArt,
  resolveLootArt,
} from '@/lib/lootArt';
import {
  DEFAULT_ARCHETYPE,
  LOOT_ARCHETYPES,
  MAX_POWER_UP_TIER,
  lootFileStem,
  type LootArchetype,
} from '@grimhallow/shared';

const TIERS = Array.from({ length: MAX_POWER_UP_TIER }, (_, i) => i + 1);
const SLUGS = LOOT_ARCHETYPES.map((a) => a.slug);
const ART_BEARING = SLUGS.filter((s) => !LOOT_ART_EXEMPT.includes(s));

/** A synthetic glob map, keyed the way Vite keys one: absolute-ish source paths. */
function globMap(stems: readonly string[]): Record<string, string> {
  return Object.fromEntries(stems.map((s) => [`../assets/loot/${s}.jpg`, `/assets/${s}-abc123.jpg`]));
}

/** The full 48-file set, as it will exist once the art is produced. */
function fullIndex(): Record<string, string> {
  return indexLootArt(
    globMap(ART_BEARING.flatMap((slug) => TIERS.map((tier) => lootFileStem(slug, tier)))),
  );
}

describe('indexLootArt', () => {
  it('keys by bare filename stem, not by the glob’s path', () => {
    // The caller only knows `sword-tier-4`; where the bundler put the file is not
    // its business, and the hashed URL is unpredictable at author time.
    const index = indexLootArt(globMap(['sword-tier-4']));
    expect(index['sword-tier-4']).toBe('/assets/sword-tier-4-abc123.jpg');
  });

  it('accepts .jpeg and mixed case, since a hand-dropped file may be either', () => {
    const index = indexLootArt({
      '../assets/loot/Boots-Tier-2.JPEG': '/a.jpg',
      '../assets/loot/axe-tier-3.jpg': '/b.jpg',
    });
    expect(index['boots-tier-2']).toBe('/a.jpg');
    expect(index['axe-tier-3']).toBe('/b.jpg');
  });

  it('is an empty map for an empty folder rather than a throw', () => {
    // The real folder ships empty. If this were not total the app would fail to
    // boot until all 48 files existed.
    expect(indexLootArt({})).toEqual({});
  });
});

describe('resolveLootArt finds the right file', () => {
  it('resolves every art-bearing archetype at every tier from the full set', () => {
    // The full cross-product against stems built by `lootFileStem`, so this fails
    // on a stem rename rather than degrading 48 files to "not produced yet".
    const index = fullIndex();
    for (const slug of ART_BEARING) {
      for (const tier of TIERS) {
        expect(resolveLootArt(index, slug, tier), `${slug} tier ${tier}`).toBe(
          `/assets/${lootFileStem(slug, tier)}-abc123.jpg`,
        );
      }
    }
  });

  it('clamps an out-of-range tier to a real file instead of missing', () => {
    // Tier reaching the UI is authoritative (`get-token-tier`), but a cross-check
    // disagreement or a future MAX_POWER_UP_TIER change should show art, not a gap.
    const index = fullIndex();
    expect(resolveLootArt(index, 'sword', 0)).toBe(resolveLootArt(index, 'sword', 1));
    expect(resolveLootArt(index, 'sword', 99)).toBe(
      resolveLootArt(index, 'sword', MAX_POWER_UP_TIER),
    );
    expect(resolveLootArt(index, 'sword', NaN)).toBe(resolveLootArt(index, 'sword', 1));
  });
});

describe('the tier-1 floor fallback', () => {
  it('shows an archetype’s tier-1 art at every tier while the rest is unproduced', () => {
    // The expected state for a while: the art lands one archetype at a time. A
    // tier-3 sword should look like a sword, not like the generic placeholder.
    const index = indexLootArt(globMap([lootFileStem('sword', LOOT_ART_FLOOR_TIER)]));
    for (const tier of TIERS) {
      expect(resolveLootArt(index, 'sword', tier)).toBe('/assets/sword-tier-1-abc123.jpg');
    }
  });

  it('prefers the exact tier over the floor when both exist', () => {
    const index = indexLootArt(globMap(['sword-tier-1', 'sword-tier-4']));
    expect(resolveLootArt(index, 'sword', 4)).toBe('/assets/sword-tier-4-abc123.jpg');
    expect(resolveLootArt(index, 'sword', 3)).toBe('/assets/sword-tier-1-abc123.jpg');
  });

  it('never borrows another archetype’s art', () => {
    // The failure this rules out is a *global* floor: falling back to "some
    // tier-1 file" would show boots on an axe, which reads as a bug in the game
    // rather than as missing art.
    const index = indexLootArt(globMap(['sword-tier-1', 'sword-tier-4']));
    for (const tier of TIERS) {
      expect(resolveLootArt(index, 'axe', tier)).toBeUndefined();
    }
  });
});

describe('relic is art-exempt', () => {
  it('returns undefined even when relic art is present in the bundle', () => {
    // Asserted against an index that DOES contain the files. Against the real
    // empty folder this test would pass without testing anything, and the
    // protection it describes — token #1 keeps the picture it was earned with —
    // would quietly not exist.
    const index = indexLootArt(
      globMap(TIERS.map((tier) => lootFileStem(DEFAULT_ARCHETYPE, tier))),
    );
    for (const tier of TIERS) {
      expect(resolveLootArt(index, DEFAULT_ARCHETYPE, tier)).toBeUndefined();
    }
  });

  it('exempts the archetype an unreadable uri degrades to', () => {
    // Ties the exemption to the parser's default rather than to the string
    // 'relic': if DEFAULT_ARCHETYPE ever moved, the exemption must move with it,
    // because it is the *fallback* archetype that must not gain a look.
    expect(LOOT_ART_EXEMPT).toContain(DEFAULT_ARCHETYPE);
  });
});

describe('resolveLootArt never throws', () => {
  // Every entry is something `parseLootUri` could hand over, or something an
  // unregistered slug would look like. All must degrade to undefined via relic.
  const HOSTILE: readonly string[] = [
    '',
    ' ',
    'trebuchet',
    'RELIC',
    'SWORD',
    'sword-tier-4',
    '../sword',
    'relic',
    '__proto__',
    'constructor',
    'toString',
    'a'.repeat(300),
  ];

  const index = fullIndex();

  for (const slug of HOSTILE) {
    it(`degrades safely: ${JSON.stringify(slug).slice(0, 40)}`, () => {
      for (const tier of [-1, 0, 1, 4, 99, NaN]) {
        expect(resolveLootArt(index, slug, tier)).toBeUndefined();
      }
    });
  }

  it('does not resolve a prototype key to a function', () => {
    // `index` is a plain object literal, so `index['toString']` would inherit
    // Object.prototype.toString and hand the UI a function where a URL string is
    // expected — an `<img src>` set to source code. The unregistered-slug degrade
    // path catches it first, and this states that outcome rather than assuming it.
    const art = resolveLootArt(fullIndex(), 'toString', 1);
    expect(art).toBeUndefined();
    expect(typeof art).not.toBe('function');
  });
});

describe('the art set matches the archetype registry', () => {
  it('needs exactly one file per art-bearing archetype per tier', () => {
    // The number quoted in the README and in the plan. If an archetype is added
    // to the registry this fails, which is the reminder that the folder's file
    // list and the operator's pinning job both grew.
    expect(ART_BEARING.length * MAX_POWER_UP_TIER).toBe(48);
  });

  it('gives every art-bearing archetype a distinct stem at every tier', () => {
    // Two archetypes sharing a stem would silently collapse to one file in the
    // index, and the loser would show the winner's art.
    const stems = ART_BEARING.flatMap((slug: LootArchetype) =>
      TIERS.map((tier) => lootFileStem(slug, tier)),
    );
    expect(new Set(stems).size).toBe(stems.length);
  });
});

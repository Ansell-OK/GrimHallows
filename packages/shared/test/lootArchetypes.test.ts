/**
 * Archetype registry tests.
 *
 * This module ships dark — nothing imports it yet — so these tests are not
 * checking behaviour a player can reach. They are checking the four properties
 * that make it SAFE to wire up later, and each one guards something that cannot
 * be undone once a token is minted.
 *
 * 1. `relic` is byte-identical to today's `BONUSES`. Mainnet loot token #1 is
 *    held by a real player and parses to `relic`, so these four vectors are that
 *    token's live stats. Drift re-stats real property with no way to re-roll.
 *    The check reads the REAL `BONUSES` array from `powerUps.ts` rather than a
 *    copy of the numbers, because a copy checking a copy passes when the same
 *    fat finger edits both.
 *
 * 2. `parseLootUri` is total. It sits directly downstream of a chain read, so its
 *    input is whatever 256 bytes a contract hands back. Every hostile and
 *    malformed shape must degrade to `relic` rather than throw — a throw here
 *    would take out a run resolution, and the table below includes the real
 *    mainnet URI as the case that matters most.
 *
 * 3. Round-trip over the full cross-product. `lootUriFor` is the only writer of a
 *    loot URI and `parseLootUri` is its declared inverse; if they disagree for
 *    even one pair, the game plays one item while the wallet displays another,
 *    permanently, because a token's uri is immutable and has no setter.
 *
 * 4. The dice ceiling. Overrunning `MAX_DAMAGE_DICE` throws mid-combat and
 *    aborts a run, so the worst legal loadout is checked against it here — and
 *    the base dice count is computed from `POWERS` rather than hardcoded, so a
 *    `4d6` power added years from now trips this test instead of a player's
 *    fight. Following `encounter.ts:89-92`, this lives in a test rather than an
 *    import-time assertion precisely because it reads two modules.
 */

import { describe, expect, it } from 'vitest';
import {
  AXIS_COST,
  BUDGET_TOLERANCE,
  DECLARED_GRANT_IDS,
  DEFAULT_ARCHETYPE,
  GRANT_VALUE,
  LOOT_ARCHETYPES,
  LOOT_METADATA_CID,
  POWER_GRANTS_PENDING,
  RELIC_TIERS,
  RESERVED_SLUGS,
  TIER_BUDGET,
  archetypeBonusVector,
  archetypeSpec,
  archetypeTierName,
  isLootArchetype,
  lootDisplayName,
  lootFileStem,
  lootMetadataPinned,
  lootUriFor,
  lootUriForCid,
  parseLootUri,
  vectorCost,
  type LootArchetype,
} from '../src/lootArchetypes.js';
import { MAX_EQUIPPED_POWER_UPS, applyPowerUps, powerUpBonus } from '../src/powerUps.js';
import { MAX_DAMAGE_DICE } from '../src/encounter.js';
import { MAX_POWER_UP_TIER } from '../src/contracts.js';
import { POWERS, getPower } from '../src/powers.js';
import { parseDiceFormula } from '../src/dice.js';
import type { EquippedItem } from '../src/lootArchetypes.js';

const TIERS = Array.from({ length: MAX_POWER_UP_TIER }, (_, i) => i + 1);
const SLUGS = LOOT_ARCHETYPES.map((a) => a.slug);

describe('relic is today’s table', () => {
  it('matches BONUSES on every mechanical axis at every tier', () => {
    // Read through the public `powerUpBonus` rather than the private BONUSES
    // const: it is the function the resolver actually calls, so this compares
    // relic to what a tier really grants in play, not to a table that might
    // stop being the one in use.
    for (const tier of TIERS) {
      const legacy = powerUpBonus(tier);
      const relic = archetypeBonusVector(DEFAULT_ARCHETYPE, tier);
      expect({
        dieSizeSteps: relic.dieSizeSteps,
        extraDice: relic.extraDice,
        flatDamage: relic.flatDamage,
        defenseBonus: relic.defenseBonus,
      }).toEqual({
        dieSizeSteps: legacy.dieSizeSteps,
        extraDice: legacy.extraDice,
        flatDamage: legacy.flatDamage,
        defenseBonus: legacy.defenseBonus,
      });
    }
  });

  it('grants no power and no maxHp at any tier', () => {
    // The two NEW axes. If relic ever picked up either one, a pre-archetype
    // token would gain a stat it did not have when its owner earned it — which
    // is the exact thing the legacy fallback exists to prevent, and the reason
    // the powerup-v1 → v2 bump can be called a no-op.
    for (const vector of RELIC_TIERS) {
      expect(vector.maxHp).toBe(0);
      expect(vector.grantsPowerId).toBeNull();
    }
  });

  it('is the archetype an unparseable URI resolves to', () => {
    expect(DEFAULT_ARCHETYPE).toBe('relic');
    expect(isLootArchetype(DEFAULT_ARCHETYPE)).toBe(true);
  });
});

describe('parseLootUri never throws', () => {
  // Every entry is something a chain read could plausibly return, or something
  // an attacker would try if they could write the field. All must yield relic.
  const HOSTILE: readonly (string | null | undefined)[] = [
    // THE ONE THAT IS REAL: mainnet loot token #1 carries exactly this.
    'ipfs://grimhallow/power-up/tier-1.json',
    'ipfs://grimhallow/power-up/tier-4.json',
    null,
    undefined,
    '',
    ' ',
    'ipfs://',
    'not a uri at all',
    'ipfs://grimhallow/power-up/sword-tier-1',          // no extension
    'ipfs://grimhallow/power-up/sword-tier-0.json',     // tier below range
    'ipfs://grimhallow/power-up/sword-tier-5.json',     // tier above range
    'ipfs://grimhallow/power-up/sword-tier-99.json',
    'ipfs://grimhallow/power-up/SWORD-tier-1.json',     // uppercase slug
    'ipfs://grimhallow/power-up/trebuchet-tier-1.json', // unregistered slug
    'ipfs://grimhallow/power-up/../../sword-tier-4.json',
    'ipfs://evil.example/sword/power-up/relic-tier-1.json',
    'ipfs://grimhallow/power-up/sword-tier-1.json\nsword-tier-4.json',
    `ipfs://grimhallow/power-up/${'a'.repeat(300)}-tier-4.json`,
    'https://grimhallow.example/power-up/sword-tier-2.json',
  ];

  for (const uri of HOSTILE) {
    it(`degrades safely: ${JSON.stringify(uri)?.slice(0, 60) ?? 'undefined'}`, () => {
      const parts = parseLootUri(uri);
      expect(isLootArchetype(parts.slug)).toBe(true);
      expect(parts.tier).toBeGreaterThanOrEqual(1);
      expect(parts.tier).toBeLessThanOrEqual(MAX_POWER_UP_TIER);
    });
  }

  it('resolves the real mainnet token #1 URI to relic at tier 1', () => {
    // Stated on its own rather than folded into the sweep above, because this
    // single assertion is what makes the whole change safe for a token someone
    // already owns. `tier` is not a registered slug, so `tier-1` finds no
    // `<slug>-tier-<n>` match and rule 2 returns the legacy archetype.
    expect(parseLootUri('ipfs://grimhallow/power-up/tier-1.json')).toEqual({
      slug: 'relic',
      tier: 1,
    });
  });

  it('cannot be tricked by an archetype earlier in the path', () => {
    // A URI naming a strong archetype anywhere but the final segment must not
    // pick it up — otherwise the parse position becomes a place to hide one.
    const parts = parseLootUri('ipfs://warhammer/sword-tier-4/power-up/tier-1.json');
    expect(parts.slug).toBe('relic');
  });

  it('keeps a query string from changing the archetype', () => {
    expect(parseLootUri('ipfs://grimhallow/power-up/boots-tier-3.json?v=2')).toEqual({
      slug: 'boots',
      tier: 3,
    });
  });

  it('never returns a reserved slug', () => {
    for (const reserved of RESERVED_SLUGS) {
      const parts = parseLootUri(`ipfs://grimhallow/power-up/${reserved}-tier-2.json`);
      expect(parts.slug).not.toBe(reserved);
      expect(parts.slug).toBe(DEFAULT_ARCHETYPE);
    }
  });
});

describe('lootUriFor and parseLootUri are inverses', () => {
  // Phase 3 has not pinned a CID yet, so `lootUriFor` refuses to build anything.
  // The round-trip is exercised against a syntactically real CID through
  // `lootUriForCid`, which is the same shape-definer without the gate — the gate
  // itself is tested separately below.
  const FAKE_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

  it('round-trips every archetype at every tier', () => {
    // The full cross-product, not a sample. A single disagreeing pair means the
    // game plays one item while the wallet shows another, forever — the uri is
    // written once inside `mint` and there is no setter to correct it.
    for (const slug of SLUGS) {
      for (const tier of TIERS) {
        expect(parseLootUri(lootUriForCid(FAKE_CID, slug, tier))).toEqual({ slug, tier });
      }
    }
  });

  it('round-trips through an HTTP gateway URL for the same document', () => {
    // A wallet or explorer may hand back the gateway form rather than ipfs://.
    // It names the same document and must read as the same item.
    for (const slug of SLUGS) {
      for (const tier of TIERS) {
        const gateway = `https://ipfs.io/ipfs/${FAKE_CID}/${lootFileStem(slug, tier)}.json`;
        expect(parseLootUri(gateway)).toEqual({ slug, tier });
      }
    }
  });

  it('produces URIs that fit the contract’s (string-ascii 256) field', () => {
    // A uri longer than the field would fail the mint transaction, wasting the
    // fee and stranding a resolved run with no token.
    for (const slug of SLUGS) {
      for (const tier of TIERS) {
        const uri = lootUriForCid(FAKE_CID, slug, tier);
        expect(uri.length).toBeLessThanOrEqual(256);
        expect(/^[\x20-\x7e]+$/.test(uri)).toBe(true);
      }
    }
  });

  it('clamps an out-of-range tier rather than writing one', () => {
    // Writing `tier-0` or `tier-7` would mint a permanently unparseable token.
    expect(lootUriForCid(FAKE_CID, 'sword', 0)).toBe(lootUriForCid(FAKE_CID, 'sword', 1));
    expect(lootUriForCid(FAKE_CID, 'sword', 99)).toBe(
      lootUriForCid(FAKE_CID, 'sword', MAX_POWER_UP_TIER),
    );
    expect(lootUriForCid(FAKE_CID, 'sword', NaN)).toBe(lootUriForCid(FAKE_CID, 'sword', 1));
  });

  it('names every file with one stem definition', () => {
    // The metadata document, the image, and the web art index all key off this.
    expect(lootFileStem('chestplate', 4)).toBe('chestplate-tier-4');
    expect(lootFileStem('sword', 1)).toBe('sword-tier-1');
  });
});

describe('the IPFS pinning gate', () => {
  it('refuses to build a mintable URI until a CID is pinned', () => {
    // THE HARD GATE, as a value rather than a warning. A token's uri is written
    // once inside `mint` and is immutable for life — no setter, no base-uri, and
    // `burn` is contract-caller-gated so the player cannot even destroy a broken
    // token. Minting against an unpinned CID is unrecoverable, so the only
    // function that can build a mintable URI refuses to while the CID is empty.
    //
    // WHEN PHASE 3 PINS: this test inverts. Assert instead that lootUriFor
    // returns a URI starting `ipfs://<CID>/` and that it round-trips.
    if (lootMetadataPinned()) {
      for (const slug of SLUGS) {
        for (const tier of TIERS) {
          expect(parseLootUri(lootUriFor(slug, tier))).toEqual({ slug, tier });
          expect(lootUriFor(slug, tier).startsWith(`ipfs://${LOOT_METADATA_CID}/`)).toBe(true);
        }
      }
    } else {
      expect(() => lootUriFor('sword', 4)).toThrow(/LOOT_METADATA_CID is unset/);
    }
  });

  it('reports its own state honestly', () => {
    expect(lootMetadataPinned()).toBe(LOOT_METADATA_CID.length > 0);
  });
});

describe('the budget metric', () => {
  it('prices every vector at exactly its tier budget', () => {
    // The import-time assertion already enforces this; asserting it again here
    // names the archetype and tier in the failure, which the throw cannot do
    // for more than the first offender.
    for (const spec of LOOT_ARCHETYPES) {
      spec.tiers.forEach((vector, i) => {
        expect(
          Math.abs(vectorCost(vector) - TIER_BUDGET[i]),
          `${spec.slug} tier ${i + 1} costs ${vectorCost(vector)}, budget ${TIER_BUDGET[i]}`,
        ).toBeLessThanOrEqual(BUDGET_TOLERANCE);
      });
    }
  });

  it('derives the budget from the already-shipped table, not the other way round', () => {
    // The claim in the header is that TIER_BUDGET describes the balance that was
    // already approved and deployed, rather than being invented to fit the new
    // archetypes. relic is that shipped table, so relic scoring exactly its
    // budget at all four tiers IS the evidence for the claim.
    RELIC_TIERS.forEach((vector, i) => {
      expect(vectorCost(vector)).toBeCloseTo(TIER_BUDGET[i], 9);
    });
  });

  it('keeps budgets monotonically increasing by tier', () => {
    for (let i = 1; i < TIER_BUDGET.length; i++) {
      expect(TIER_BUDGET[i]).toBeGreaterThan(TIER_BUDGET[i - 1]);
    }
  });
});

describe('the dice ceiling', () => {
  it('keeps the worst legal loadout inside MAX_DAMAGE_DICE', () => {
    // Overrunning the per-turn dice span throws inside `resolveTurn` and aborts
    // the run mid-combat, so this is a correctness ceiling and not a balance
    // one. Both halves are COMPUTED, never typed in: the widest base formula is
    // scanned out of POWERS, and the largest extraDice out of the catalog. A
    // future 4d6 power or a 3-extra-dice archetype fails here, at build time,
    // rather than in someone's fight.
    const widestBase = Math.max(
      ...POWERS.map((p) => p.diceFormula)
        .filter((f): f is string => !!f)
        .map((f) => parseDiceFormula(f).count),
    );
    const largestExtra = Math.max(
      ...LOOT_ARCHETYPES.flatMap((a) => a.tiers.map((t) => t.extraDice)),
    );
    expect(widestBase + MAX_EQUIPPED_POWER_UPS * largestExtra).toBeLessThanOrEqual(
      MAX_DAMAGE_DICE,
    );
  });

  it('holds when the worst loadout is actually applied to the widest power', () => {
    // The arithmetic above assumes applyPowerUps adds extraDice linearly. This
    // runs it, so the assumption is checked rather than restated.
    //
    // The loadout is DERIVED from the table rather than written as three tier-4
    // items: the worst case is whichever (archetype, tier) carries the most
    // extraDice, and hardcoding it would keep passing after a table edit moved
    // the maximum somewhere else. Overrunning MAX_DAMAGE_DICE throws mid-combat
    // and aborts a live run, so this must fail here or it fails on a player.
    let worstItem: EquippedItem = { archetype: DEFAULT_ARCHETYPE, tier: 1 };
    for (const spec of LOOT_ARCHETYPES) {
      spec.tiers.forEach((vector, i) => {
        const best = archetypeBonusVector(worstItem.archetype, worstItem.tier).extraDice;
        if (vector.extraDice > best) worstItem = { archetype: spec.slug, tier: i + 1 };
      });
    }
    const worst = Array.from({ length: MAX_EQUIPPED_POWER_UPS }, () => worstItem);

    const widest = Math.max(
      ...POWERS.map((p) => p.diceFormula)
        .filter((f): f is string => !!f)
        .map((f) => parseDiceFormula(applyPowerUps(f, worst)!).count),
    );
    expect(widest).toBeLessThanOrEqual(MAX_DAMAGE_DICE);
  });
});

describe('granted powers', () => {
  it('declares every pending grant as absent from POWERS', () => {
    // A RATCHET, and it fails in both directions on purpose. While this module
    // ships ahead of Phase 6, the powers it names must NOT exist — if one turns
    // up, the pending list is stale and the real check below should be running
    // instead. When Phase 6 lands the powers it must also empty the set, and
    // this test is what forces that bookkeeping to happen.
    for (const id of POWER_GRANTS_PENDING) {
      expect(getPower(id), `${id} now exists — remove it from POWER_GRANTS_PENDING`).toBeNull();
    }
  });

  it('backs every declared grant with a real power once it is no longer pending', () => {
    // The check that actually matters, dark until Phase 6 empties the set. A
    // grant naming a power that does not exist would hand a player an item that
    // silently does nothing.
    for (const id of DECLARED_GRANT_IDS) {
      if (POWER_GRANTS_PENDING.has(id)) continue;
      expect(getPower(id), `archetype grants "${id}", which is not in powers.ts`).not.toBeNull();
    }
  });

  it('never grants the same power at two tiers of one archetype', () => {
    // Two tiers granting one id would make a tier-2 and tier-4 elixir
    // indistinguishable in the power list, and the higher one unreachable.
    for (const spec of LOOT_ARCHETYPES) {
      const granted = spec.tiers.map((t) => t.grantsPowerId).filter(Boolean);
      expect(new Set(granted).size).toBe(granted.length);
    }
  });

  /**
   * The cross-module check `GRANT_VALUE`'s doc says Phase 6 owes, and the reason
   * it is a test rather than an import-time assertion: it reads `powers.ts`, and
   * an assertion spanning two modules turns a load-order change into a crash.
   *
   * THE CAUSALITY RUNS FROM THE PRICE TO THE FORMULA. `GRANT_VALUE` prices the
   * four draughts at 2 / 3 / 4 / 6 budget units; `AXIS_COST.maxHp` is what a
   * point of HP costs. Divide and you get the HP a grant is allowed to be worth
   * — 5 / 7.5 / 10 / 15 — and the formulas were built backwards from that.
   *
   * Healing is priced at parity with max HP, which is deliberately the
   * conservative side of the argument: a point of healing is strictly weaker
   * than a point of max HP, since it costs a turn to take and is wasted at full
   * health. The alternative was a discount factor, which is exactly the kind of
   * free parameter the budget metric exists to eliminate.
   *
   * Averages are computed from the parsed formula rather than written down, so
   * editing a formula moves this test's expectation with it and only the price
   * stays fixed. That is the direction the dependency should run.
   */
  it('prices every granted heal at exactly the HP it restores', () => {
    const hpPerBudgetPoint = 1 / AXIS_COST.maxHp;

    for (const [id, price] of Object.entries(GRANT_VALUE)) {
      const power = getPower(id);
      if (!power || power.kind !== 'heal') continue;

      const f = parseDiceFormula(power.diceFormula!);
      // Uniform dice: the mean face of a dN is (N+1)/2.
      const average = f.count * ((f.sides + 1) / 2) + f.modifier;
      // Charges multiply the resource. A draught worth 5 HP twice is worth 10.
      const total = average * (power.charges ?? 1);

      expect(total, `${id} restores ${total} HP but is priced at ${price}`).toBeCloseTo(
        price * hpPerBudgetPoint,
        9,
      );
    }
  });

  it('leaves every granted heal out of the damage ceiling it cannot reach', () => {
    // A heal never passes through `applyPowerUps`, so its dice are not part of
    // the `MAX_DAMAGE_DICE` budget the sweep above computes over attack powers.
    // It still has to fit a turn's stride, because it rolls from the same slots
    // a damage roll would have used.
    for (const id of DECLARED_GRANT_IDS) {
      const power = getPower(id);
      if (!power || power.kind !== 'heal') continue;
      expect(parseDiceFormula(power.diceFormula!).count).toBeLessThanOrEqual(MAX_DAMAGE_DICE);
    }
  });
});

describe('display', () => {
  it('names an item the way minted characters are named', () => {
    expect(lootDisplayName('chestplate', 4, '17')).toBe('Legendary Chestplate #17');
    expect(lootDisplayName('sword', 1)).toBe('Rare Sword');
  });

  it('names a drop that has no token id yet', () => {
    // The reward screen names the item at resolve time, minutes before the mint
    // confirms and the chain assigns an id. A name reading "Sword #undefined"
    // would be the first thing a player saw after a win.
    expect(lootDisplayName('boots', 2)).not.toContain('#');
  });

  it('falls back to relic for an unregistered slug rather than throwing', () => {
    expect(lootDisplayName('trebuchet', 3, '9')).toBe('Mythic Relic #9');
    expect(archetypeSpec('trebuchet').slug).toBe(DEFAULT_ARCHETYPE);
  });

  it('clamps tier in every display path', () => {
    expect(archetypeTierName(0)).toBe('rare');
    expect(archetypeTierName(99)).toBe('legendary');
    expect(archetypeTierName(NaN)).toBe('rare');
  });
});

describe('registry integrity', () => {
  it('has unique slugs', () => {
    expect(new Set(SLUGS).size).toBe(SLUGS.length);
  });

  it('registers no reserved slug', () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(SLUGS).not.toContain(reserved as LootArchetype);
    }
  });

  it('gives every archetype exactly MAX_POWER_UP_TIER vectors', () => {
    for (const spec of LOOT_ARCHETYPES) {
      expect(spec.tiers.length).toBe(MAX_POWER_UP_TIER);
    }
  });

  it('has a distinct noun per archetype, so two items never read alike', () => {
    const nouns = LOOT_ARCHETYPES.map((a) => a.noun);
    expect(new Set(nouns).size).toBe(nouns.length);
  });
});

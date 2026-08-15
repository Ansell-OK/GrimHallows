/**
 * What a loot item *is*, beyond its tier.
 *
 * Today a loot item is a single integer 1–4. Every drop is a "Power-Up", every
 * tier shares one picture, and two legendaries are the same object. This module
 * adds the second axis — a sword is not a chestplate — and nothing more: it is
 * pure vocabulary, imported by nothing at first, so it can be reviewed on its
 * own terms before a single die changes.
 *
 * ---------------------------------------------------------------------------
 * WHERE ARCHETYPE COMES FROM, AND WHY IT IS THE URI
 * ---------------------------------------------------------------------------
 *
 * `powerUps.ts` opens with an invariant this module appears to break:
 *
 *   > THE BONUS KEYS OFF THE ON-CHAIN `tier`, NEVER OFF METADATA. […] A JSON
 *   > file at a metadata URI is flavour […] Rewriting one must not change a
 *   > single die.
 *
 * That rule is correct and stays in force. Read it precisely: it forbids keying
 * a number off **the document at a URI**. This module keys off **the URI string
 * itself**, which is a different object with a different threat model, and the
 * distinction is the whole reason this design is admissible.
 *
 * `character-loot-nft.clar` stores exactly two fields per token:
 *
 *   (define-map token-metadata uint {uri: (string-ascii 256), tier: uint})
 *
 * `map-set` on that map appears in precisely one place — inside `mint`, which is
 * `contract-caller`-gated to authorized minters. A player cannot call it. So for
 * any token in existence:
 *
 *   - the uri was written once, by our own code, at mint;
 *   - it can never be changed, by anyone, including us — there is no setter and
 *     no base-uri;
 *   - it has the **identical mutability profile to `tier`**, which the invariant
 *     already trusts completely.
 *
 * A JSON document is mutable by whoever controls the host. The string is not.
 * The honest form of the rule is therefore *"never key a number off anything a
 * player can change after mint"* — and under that form the string passes for the
 * same reason `tier` does, while the document still fails. **We never fetch the
 * document to compute any number.** Art and prose live there; dice do not.
 *
 * THE FAIR COUNTERARGUMENT, since a future reader deserves it rather than a
 * one-sided case: `tier` is trustworthy partly because it is a *closed validated
 * domain* — a `uint` the contract range-checks, priced exhaustively by a table
 * with an import-time assertion that every mintable value is either priced or
 * rejected. A `(string-ascii 256)` is 256 arbitrary bytes that `mint` never
 * inspects. That asymmetry is real, and the answer is not to deny it but to
 * build the closure here instead of borrowing the contract's: a fixed registry
 * (`LOOT_ARCHETYPES`), a total parser that cannot throw or return anything
 * outside it (`parseLootUri`), and a round-trip property test over the full
 * cross-product. What is left is a typo risk, not an exploit: a malformed URI
 * degrades to `relic`, loudly in tests and harmlessly in play.
 *
 * REJECTED: `archetype = f(sha256(tokenId))`, which needs no parsing and cannot
 * be spoofed at all. It is fatal for a different reason. `token-id` is
 * `(+ (var-get token-id-nonce) u1)`, computed *inside the contract at execution
 * time*, so the oracle cannot know it when it builds the mint. Any forge or
 * concurrent loot mint confirming in between shifts the nonce — and then the URI
 * written at mint disagrees with the derived archetype. The game plays boots
 * while the wallet displays a sword, permanently, with no setter to fix it.
 *
 * Under the shape below the URI is not metadata consulted for a stat. It is a
 * **serialization of a second on-chain field into the one string slot the
 * contract left us**, with `lootUriFor` as its only writer and `parseLootUri`
 * as its declared inverse.
 *
 * ---------------------------------------------------------------------------
 * WHY `relic` EXISTS
 * ---------------------------------------------------------------------------
 *
 * `DEFAULT_ARCHETYPE` is `relic`, and its per-tier vectors are **byte-identical
 * to today's `BONUSES` table**. That is not nostalgia, it is the migration:
 * mainnet loot token #1 carries `ipfs://grimhallow/power-up/tier-1.json` and is
 * held by a real player. Slug `tier` is not in the registry, so the parser
 * returns `relic`, so that token plays exactly as it does today. Nobody is
 * nerfed, nobody is buffed, and the `powerup-v1 → v2` bump is observably a no-op
 * for every token that currently exists — which is what a test can assert.
 *
 * `RESERVED_SLUGS` then makes that permanent: `tier` can never later be
 * registered as a real archetype and retroactively re-stat token #1.
 */

import { MAX_POWER_UP_TIER } from './contracts.js';
import { LOOT_TIER_NAMES, type LootTierName } from './rewards.js';

/**
 * Version of the archetype registry and its bonus vectors.
 *
 * Separate from `POWER_UP_ALGO_VERSION` on purpose: this module is vocabulary,
 * and it ships before anything reads it. Adding an archetype is a change to this
 * version; changing what an *existing* archetype grants is a change to both,
 * because that is what rewrites a resolved run's dice.
 */
export const LOOT_ARCHETYPE_VERSION = 'archetype-v1' as const;

/** Broad grouping, for UI sectioning and forge-recipe families. Not mechanical. */
export type LootFamily = 'blade' | 'armour' | 'trinket' | 'potion' | 'sigil' | 'legacy';

/**
 * The bonus vector for one (archetype, tier) pair.
 *
 * Mirrors `PowerUpBonus`'s mechanical fields exactly so that Phase 4 can widen
 * `powerUps.ts` to consume these without a translation layer. `maxHp` and
 * `grantsPowerId` are new axes, absent from today's table and therefore zero or
 * null for every `relic` entry — which is what keeps history byte-identical.
 */
export interface ArchetypeBonusVector {
  /** Places to move right along `DAMAGE_DIE_LADDER`, e.g. 1 turns d6 into d8. */
  readonly dieSizeSteps: number;
  /** Extra dice added to the count, e.g. 1 turns 1d8 into 2d8. */
  readonly extraDice: number;
  /** Flat bonus added to every damage roll. */
  readonly flatDamage: number;
  /** Added to the holder's Defense DC while equipped. */
  readonly defenseBonus: number;
  /** Added to the holder's maximum (and starting) HP. NEW AXIS — see header. */
  readonly maxHp: number;
  /**
   * A power id this item grants for the run, or null.
   *
   * The id must exist in `powers.ts`. Granted powers are real catalogue entries
   * rather than item-carried formulas because power ids are permanent and a
   * logged turn references one forever — an item that carried its own formula
   * would make a turn unreplayable once the item table changed.
   */
  readonly grantsPowerId: string | null;
}

/**
 * A registry entry: what an archetype is, and what it grants at each tier.
 *
 * `slug` is `string` here and NOT `LootArchetype`, which would be circular:
 * `LootArchetype` is derived from the table that `satisfies` this interface. The
 * narrow slug type is recovered on the way out, by `LootArchetypeEntry` below —
 * so this widening is confined to the authoring constraint and never reaches a
 * caller.
 */
export interface LootArchetypeSpec {
  readonly slug: string;
  readonly family: LootFamily;
  /** Singular, title-cased noun for display, e.g. `Chestplate`. */
  readonly noun: string;
  /** Indexed by tier - 1. Exactly `MAX_POWER_UP_TIER` entries, asserted below. */
  readonly tiers: readonly ArchetypeBonusVector[];
}

/** Shorthand so the table below reads as a grid rather than as prose. */
function v(
  dieSizeSteps: number,
  extraDice: number,
  flatDamage: number,
  defenseBonus: number,
  maxHp: number,
  grantsPowerId: string | null = null,
): ArchetypeBonusVector {
  return { dieSizeSteps, extraDice, flatDamage, defenseBonus, maxHp, grantsPowerId };
}

/**
 * THE CATALOG. TUNABLE, but only against the budget below.
 *
 * Every archetype redistributes a fixed per-tier budget rather than adding to
 * it, so a new archetype cannot be a power creep by construction. The budget is
 * derived from marginal value, not chosen: applying the weights in
 * `AXIS_COST` to the *existing, already-approved* `BONUSES` table in
 * `powerUps.ts` yields exactly 2 / 6 / 10 / 16 at tiers 1–4. The metric was not
 * reverse-engineered to fit — it describes the balance already shipped and
 * signed off for mainnet, and `relic` hitting its budget by construction is the
 * proof of that. `assertBudgetConformance` below enforces it at import.
 *
 * T1 COLLISIONS ARE INTENTIONAL AND NOT A BUG. At a budget of 2 there are only
 * a handful of expressible shapes, so several archetypes share a tier-1 vector
 * and diverge from tier 2 upward. A rare item being a small thing is correct;
 * the identity is carried by the name and the art at that tier, and by the
 * mechanics above it. Do not "fix" this by inflating tier 1.
 *
 * Ordering is display order — families grouped, `relic` last because it is
 * legacy rather than something a player should be shown first.
 */
export const LOOT_ARCHETYPES = [
  {
    slug: 'sword', family: 'blade', noun: 'Sword',
    tiers: [v(1, 0, 0, 0, 0), v(1, 0, 4, 0, 0), v(2, 0, 6, 0, 0), v(2, 1, 9, 0, 0)],
  },
  {
    slug: 'axe', family: 'blade', noun: 'Axe',
    tiers: [v(0, 0, 2, 0, 0), v(0, 1, 3, 0, 0), v(1, 1, 5, 0, 0), v(1, 2, 8, 0, 0)],
  },
  {
    slug: 'dagger', family: 'blade', noun: 'Dagger',
    tiers: [v(0, 0, 2, 0, 0), v(0, 0, 4, 1, 0), v(1, 0, 4, 2, 0), v(1, 1, 5, 3, 0)],
  },
  {
    slug: 'warhammer', family: 'blade', noun: 'Warhammer',
    tiers: [v(1, 0, 0, 0, 0), v(2, 0, 2, 0, 0), v(3, 0, 4, 0, 0), v(4, 0, 8, 0, 0)],
  },
  {
    slug: 'helm', family: 'armour', noun: 'Helm',
    tiers: [v(0, 0, 0, 1, 0), v(0, 0, 0, 2, 5), v(0, 0, 2, 3, 5), v(0, 0, 4, 4, 10)],
  },
  {
    slug: 'chestplate', family: 'armour', noun: 'Chestplate',
    tiers: [v(0, 0, 0, 0, 5), v(0, 0, 0, 0, 15), v(0, 0, 0, 1, 20), v(0, 0, 0, 2, 30)],
  },
  {
    slug: 'boots', family: 'armour', noun: 'Boots',
    tiers: [v(0, 0, 0, 1, 0), v(0, 0, 0, 3, 0), v(0, 0, 2, 4, 0), v(0, 0, 2, 5, 10)],
  },
  {
    slug: 'ring', family: 'trinket', noun: 'Ring',
    tiers: [v(0, 0, 2, 0, 0), v(0, 0, 2, 2, 0), v(0, 0, 4, 3, 0), v(1, 0, 6, 4, 0)],
  },
  {
    slug: 'amulet', family: 'trinket', noun: 'Amulet',
    tiers: [v(0, 0, 0, 0, 5), v(0, 0, 2, 0, 10), v(0, 0, 4, 0, 15), v(0, 1, 5, 0, 20)],
  },
  {
    slug: 'talisman', family: 'trinket', noun: 'Talisman',
    tiers: [v(1, 0, 0, 0, 0), v(1, 0, 0, 2, 0), v(2, 0, 0, 3, 0), v(2, 0, 4, 4, 0)],
  },
  {
    // The grant IS the item at tier 1; higher tiers keep the same power and add
    // a small stat line. Power ids are declared here but do not exist in
    // `powers.ts` until Phase 6 — see `POWER_GRANTS_PENDING` below.
    slug: 'elixir', family: 'potion', noun: 'Elixir',
    tiers: [
      v(0, 0, 0, 0, 0, 'potion-heal-1'),
      v(0, 0, 1, 0, 5, 'potion-heal-2'),
      v(0, 0, 2, 0, 10, 'potion-heal-3'),
      v(0, 0, 4, 0, 15, 'potion-heal-4'),
    ],
  },
  {
    slug: 'tome', family: 'sigil', noun: 'Tome',
    tiers: [
      v(0, 0, 0, 0, 0, 'tome-nova-1'),
      v(0, 0, 4, 0, 0, 'tome-nova-2'),
      v(1, 0, 2, 2, 0, 'tome-nova-3'),
      v(2, 0, 4, 3, 0, 'tome-nova-4'),
    ],
  },
  {
    // LEGACY. Byte-identical to `BONUSES` in powerUps.ts — see the header. Every
    // token minted before archetypes existed parses to this, so changing these
    // four vectors retroactively re-stats real mainnet property.
    slug: 'relic', family: 'legacy', noun: 'Relic',
    tiers: [v(1, 0, 0, 0, 0), v(1, 0, 2, 1, 0), v(2, 0, 2, 2, 0), v(2, 1, 3, 3, 0)],
  },
] as const satisfies readonly LootArchetypeSpec[];

/**
 * The slug of a registered archetype.
 *
 * Derived from the table rather than written out, so the union cannot drift
 * from the registry: adding an entry above widens this type, and a typo'd slug
 * in a caller is a compile error rather than a silent degrade to `relic` at
 * runtime. This is the closed domain the header promises — the counterargument
 * that `(string-ascii 256)` is not a validated domain like `uint` is answered
 * here, in the type system, and by `parseLootUri` being the only door from an
 * arbitrary chain string into it.
 */
export type LootArchetype = (typeof LOOT_ARCHETYPES)[number]['slug'];

/**
 * What a token whose URI carries no recognizable archetype resolves to.
 *
 * Every pre-archetype token, every malformed URI, every future slug this build
 * has not heard of. It must stay `relic` and `relic` must stay byte-identical to
 * today's table, or the parse-failure path silently re-stats live tokens.
 */
export const DEFAULT_ARCHETYPE = 'relic' satisfies LootArchetype;

/**
 * Slugs that must never become archetypes.
 *
 * `tier` is the legacy URI's first path segment (`.../power-up/tier-1.json`).
 * If it were ever registered, mainnet token #1 would stop resolving to `relic`
 * and start resolving to whatever `tier` had become — silently re-statting a
 * real player's property. Asserted at import, so the mistake is unshippable
 * rather than merely documented.
 */
export const RESERVED_SLUGS: readonly string[] = ['tier'];

/**
 * A registry entry as read back out, with its slug still narrow.
 *
 * `LootArchetypeSpec` has to type `slug` as `string` to break the circularity
 * described on it. That is an authoring concession, and it used to leak: reading
 * `archetypeSpec(x).slug` handed back a `string`, so the closed domain this
 * module promises evaporated at the one call that most needed it — normalizing an
 * arbitrary chain string. Two callers wrote their own way around that (see
 * `toEquippedItem`, and `resolveLootArt` in apps/web) and the second one did not
 * compile. Recovering the narrow type here fixes it once, at the accessor,
 * instead of at every reader.
 */
export type LootArchetypeEntry = LootArchetypeSpec & { readonly slug: LootArchetype };

const BY_SLUG: ReadonlyMap<string, LootArchetypeEntry> = new Map(
  LOOT_ARCHETYPES.map((a) => [a.slug, a]),
);

const RELIC_SPEC: LootArchetypeEntry = BY_SLUG.get(DEFAULT_ARCHETYPE) as LootArchetypeEntry;

// ---------------------------------------------------------------------------
// The budget metric
// ---------------------------------------------------------------------------

/**
 * Marginal value of one point on each axis, in budget units. TUNABLE, carefully.
 *
 * These weights are what make "redistribute, don't add" checkable instead of
 * aspirational. They are calibrated so that today's approved `BONUSES` table
 * scores exactly `TIER_BUDGET` at every tier — retuning a weight therefore
 * re-scores every archetype at once and will trip the conformance assertion,
 * which is the intended failure mode rather than an inconvenience.
 *
 * `maxHp` is cheap per point because HP is a buffer, not a threat: 10 HP is
 * roughly one extra monster turn survived, whereas +1 Defense removes a whole
 * band of attack rolls permanently. `extraDice` costs more than `dieSizeSteps`
 * because a die is both damage and variance, and because dice *count* is the
 * axis with the hard ceiling (`MAX_DAMAGE_DICE`).
 */
export const AXIS_COST = {
  dieSizeSteps: 2,
  extraDice: 3,
  flatDamage: 1,
  defenseBonus: 2,
  maxHp: 0.4,
} as const;

/**
 * What each granted power is worth in budget units. TUNABLE with the formulas.
 *
 * A grant cannot be priced by a single flat constant, and the attempt is
 * instructive: with `grant = 2` for everything, `tome` lands exactly on budget at
 * all four tiers while `elixir` undershoots by 1, 2 and 4 at tiers 2–4. That gap
 * is not a table error — it is the heal magnitude, which scales with tier while a
 * flat price does not.
 *
 * The two families are priced differently because they differ mechanically. A
 * granted *attack* substitutes for a basic attack the holder already had, so its
 * marginal value is the margin over that attack — small, and roughly constant
 * across tiers. A granted *heal* adds a resource that did not exist: it converts
 * turns into HP, and at tier 4 it converts a lot. Hence flat pricing for
 * `tome-nova-*` and rising pricing for `potion-heal-*`.
 *
 * THE CAUSALITY RUNS FROM THIS TABLE TO `powers.ts`, NOT THE OTHER WAY. These are
 * the prices the Phase 6 formulas must be built to match, not measurements of
 * formulas that already exist — none of these powers exist yet. Phase 6 owes a
 * test asserting each formula's average is consistent with its price here; that
 * check reads two modules and therefore belongs in a test rather than in an
 * import-time assertion, following `encounter.ts:89-92`.
 */
export const GRANT_VALUE: Readonly<Record<string, number>> = {
  'potion-heal-1': 2,
  'potion-heal-2': 3,
  'potion-heal-3': 4,
  'potion-heal-4': 6,
  'tome-nova-1': 2,
  'tome-nova-2': 2,
  'tome-nova-3': 2,
  'tome-nova-4': 2,
};

/** Budget available at each tier, indexed by tier - 1. Derived, not chosen. */
export const TIER_BUDGET: readonly number[] = [2, 6, 10, 16];

/**
 * Slack allowed when checking a vector against its budget.
 *
 * This is a floating-point epsilon and nothing more. Every one of the 52 vectors
 * in the catalog lands on its budget *exactly* — the tolerance exists only
 * because `maxHp * 0.4` is not exact in binary (15 × 0.4 evaluates to
 * 6.000000000000001), and a design invariant should not be defeated by the last
 * bit of a mantissa.
 *
 * DO NOT WIDEN THIS TO ACCOMMODATE A NEW ARCHETYPE. If a vector misses its
 * budget, either the vector is wrong or the axis is mispriced; widening the
 * tolerance converts a caught balance error into a shipped one, and the whole
 * point of the metric is that it is the thing that cannot be negotiated with.
 */
export const BUDGET_TOLERANCE = 1e-9;

/** What one vector costs, by the metric above. */
export function vectorCost(vector: ArchetypeBonusVector): number {
  return (
    vector.dieSizeSteps * AXIS_COST.dieSizeSteps +
    vector.extraDice * AXIS_COST.extraDice +
    vector.flatDamage * AXIS_COST.flatDamage +
    vector.defenseBonus * AXIS_COST.defenseBonus +
    vector.maxHp * AXIS_COST.maxHp +
    (vector.grantsPowerId ? (GRANT_VALUE[vector.grantsPowerId] ?? 0) : 0)
  );
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Whether a slug names a registered archetype. Narrows for callers. */
export function isLootArchetype(slug: string): slug is LootArchetype {
  return BY_SLUG.has(slug);
}

/**
 * The spec for a slug, or the `relic` spec for anything unregistered.
 *
 * Total, and the returned `slug` is narrow — so this doubles as the canonicalizer
 * for an arbitrary string: `archetypeSpec(anything).slug` is a `LootArchetype`.
 */
export function archetypeSpec(slug: string): LootArchetypeEntry {
  return BY_SLUG.get(slug) ?? RELIC_SPEC;
}

/**
 * Clamp a tier to a valid index into a spec's `tiers` array.
 *
 * `Math.floor(tier) || 1` maps both 0 and NaN to 1 — the only two inputs with no
 * meaningful direction to clamp toward — while an out-of-range number follows its
 * sign to whichever end it was heading for.
 */
function tierIndex(tier: number): number {
  return Math.min(Math.max(Math.floor(tier) || 1, 1), MAX_POWER_UP_TIER) - 1;
}

/**
 * The bonus vector for an (archetype, tier) pair.
 *
 * Total in both arguments: an unregistered slug degrades to `relic` and an
 * out-of-range tier clamps. Nothing here throws, because every caller is
 * downstream of a chain read — a token whose uri or tier is unexpected must
 * resolve to *something playable*, and the safe direction is today's behaviour.
 */
export function archetypeBonusVector(slug: string, tier: number): ArchetypeBonusVector {
  return archetypeSpec(slug).tiers[tierIndex(tier)];
}

/**
 * The player-facing name of an item: `Legendary Chestplate #17`.
 *
 * Mirrors `characterService.displayName()`'s shape — the minted characters read
 * `GrimHallow Character #1`, and loot reading the same way is deliberate. The
 * token id is optional because a *drop* has no id yet: the reward screen names
 * the item at resolve time, minutes before the mint confirms and assigns one.
 */
export function lootDisplayName(slug: string, tier: number, tokenId?: string): string {
  const rarity = LOOT_TIER_NAMES[tierIndex(tier)];
  const titled = rarity.charAt(0).toUpperCase() + rarity.slice(1);
  const base = `${titled} ${archetypeSpec(slug).noun}`;
  return tokenId ? `${base} #${tokenId}` : base;
}

/** The rarity word for a tier, clamped. Convenience for display code. */
export function archetypeTierName(tier: number): LootTierName {
  return LOOT_TIER_NAMES[tierIndex(tier)];
}

// ---------------------------------------------------------------------------
// The equipped item
// ---------------------------------------------------------------------------

/**
 * One equipped loot item, as the engine sees it.
 *
 * THE UNIT THE ENGINE RESOLVES AGAINST. Before archetypes, an equipped item was
 * a bare `number` and a loadout was `number[]`; this pair replaces it everywhere
 * — `PartyMemberSetup`, `Fighter`, `applyPowerUps`, `powerUpDefenseBonus`.
 *
 * WHY A PAIR AND NOT TWO PARALLEL ARRAYS. A `powerUpArchetypes` array alongside
 * `powerUpTiers` desyncs silently: a filter or a sort applied to one and not the
 * other re-stats every item with no error anywhere, and the wrong stats persist
 * into `encounter_setup_json` where they become the permanent record of what the
 * fight was. Keeping the two fields in one object makes that class of bug
 * unexpressible.
 *
 * WHY NOT AN OPAQUE `"sword-3"` STRING. It reads as compact, but every consumer
 * would have to re-parse a value we had already parsed once — and a parse that
 * happens in five places is a degrade path that can disagree with itself.
 *
 * `archetype` is the narrow union, not `string`: this shape is written into a
 * run's setup, which is the artifact a verifier replays years later. An
 * unregistered slug must be normalized at the boundary that reads the chain, not
 * carried inward — `archetypeSpec` degrades it to `relic` there, once.
 */
export interface EquippedItem {
  readonly archetype: LootArchetype;
  readonly tier: number;
}

/**
 * Canonical order for a stored loadout: tier ascending, then archetype.
 *
 * The property this preserves is the one `resolveEquippedTiers` already had — a
 * stored loadout is a function of the *set* of items chosen, not of the order a
 * UI happened to list them in — and it has to survive archetypes, because a
 * single tier number is no longer a complete description of an item.
 *
 * SAFE ONLY BECAUSE BONUSES ARE SUMMED BEFORE THEY ARE APPLIED. `applyPowerUps`
 * totals every axis across the loadout and then applies the total once, so
 * `stepDieSize` saturates a single time at the end and reordering cannot change
 * the result. Any axis added later inherits that obligation: sum first, apply
 * once. An axis applied per item — a multiplier, a clamp between items — would
 * make the sort order load-bearing and silently break replay of every run
 * already stored.
 */
export function compareEquippedItems(a: EquippedItem, b: EquippedItem): number {
  return a.tier - b.tier || a.archetype.localeCompare(b.archetype);
}

/**
 * Normalize whatever a chain read produced into an `EquippedItem`.
 *
 * The one place an unregistered slug or an out-of-range tier is allowed to
 * appear. Everything downstream takes the narrow type.
 */
export function toEquippedItem(slug: string, tier: number): EquippedItem {
  // Narrowed through the type guard rather than through `archetypeSpec().slug`.
  // Both are correct and both now type-check — `LootArchetypeEntry` recovers the
  // narrow slug — but the guard says what this line means: an unregistered slug
  // is *degraded*, deliberately, and naming `DEFAULT_ARCHETYPE` at the site is
  // what makes that visible. Going through the spec would reach the same value as
  // a side effect of a lookup and read like a lookup.
  return { archetype: isLootArchetype(slug) ? slug : DEFAULT_ARCHETYPE, tier };
}

// ---------------------------------------------------------------------------
// URI codec
// ---------------------------------------------------------------------------

/**
 * The IPFS CID of the pinned loot-metadata directory. EMPTY UNTIL PHASE 3 PINS IT.
 *
 * This is the hard gate, expressed as a value rather than as a warning in a doc.
 * A token's `{uri, tier}` is written once inside `mint` and is immutable for
 * life — there is no setter, no base-uri, and `burn` is `contract-caller`-gated
 * so a player cannot even destroy a broken token. Minting one URI against a
 * wrong or unpinned CID permanently ruins that token, with no migration and no
 * repair.
 *
 * So `lootUriFor` THROWS while this is empty, and the mint path inherits that
 * refusal for free. The gate cannot be forgotten, because the only function that
 * can build a mintable URI will not build one.
 *
 * TO CLOSE THE GATE (operator, Phase 3): pin the metadata directory, then set
 * this to the resulting CID — bare, no scheme, no slashes, e.g.
 * `bafybeih...`. Pin the IMAGE directory first: each metadata document's
 * `image` field references the image CID, so metadata cannot be generated until
 * the images are already pinned and final.
 */
export const LOOT_METADATA_CID = '';

/** Whether real archetype URIs can be minted yet. False until Phase 3 pins. */
export function lootMetadataPinned(): boolean {
  return LOOT_METADATA_CID.length > 0;
}

/**
 * Build a loot URI against an explicit CID. Pure, and the only shape-definer.
 *
 * Separate from `lootUriFor` so the shape can be tested, and so the Phase 3
 * pinning script can generate the 52 filenames, without either one needing a
 * pinned CID to exist. This function does NOT gate — it will happily build a
 * URI against a fake CID, which is exactly what a test wants and exactly what a
 * mint must never do. Mint through `lootUriFor`.
 */
export function lootUriForCid(cid: string, slug: LootArchetype, tier: number): string {
  return `ipfs://${cid}/${lootFileStem(slug, tier)}.json`;
}

/**
 * The filename stem for an (archetype, tier) pair: `sword-tier-4`.
 *
 * One definition, used by the metadata document names, the image filenames, and
 * the web art index. Three hand-maintained naming conventions that had to agree
 * would be three chances to typo a name into permanence.
 */
export function lootFileStem(slug: LootArchetype, tier: number): string {
  return `${slug}-tier-${tierIndex(tier) + 1}`;
}

/**
 * The on-chain URI for an (archetype, tier) metadata document.
 *
 * THROWS while the metadata CID is unpinned — see `LOOT_METADATA_CID`. This is
 * the one call that writes an irreversible on-chain field, and refusing is the
 * only safe failure mode: a thrown error costs a run resolution, while a minted
 * placeholder URI costs a player their item forever.
 *
 * THE SLUG PARAMETER IS TYPED while `parseLootUri` accepts any string. The
 * asymmetry is the point: reading must tolerate anything the chain returns,
 * writing must not compile for an unregistered slug.
 */
export function lootUriFor(slug: LootArchetype, tier: number): string {
  if (!lootMetadataPinned()) {
    throw new Error(
      `Cannot build a loot URI: LOOT_METADATA_CID is unset. Minting "${lootFileStem(slug, tier)}" ` +
        `against an unpinned CID would permanently break that token — a uri is immutable and ` +
        `has no setter. Pin the metadata directory (Phase 3) and set the CID first.`,
    );
  }
  return lootUriForCid(LOOT_METADATA_CID, slug, tier);
}

/** A decoded (archetype, tier) pair. Both fields resolve safely by design. */
export interface LootUriParts {
  readonly slug: LootArchetype;
  readonly tier: number;
}

/**
 * Matches a `<slug>-tier-<n>.json` FINAL PATH SEGMENT, and nothing else.
 *
 * The leading `(?:^|\/)` is load-bearing security, not tidiness: it forces the
 * slug to begin a path segment, so an archetype named anywhere earlier in a URI
 * cannot be picked up. `ipfs://warhammer/sword-tier-4/x/tier-1.json` reads as
 * `relic`, because only `tier-1.json` is the final segment and it carries no
 * `<slug>-` prefix.
 *
 * Deliberately NOT anchored to a scheme or to a `/power-up/` path. The real URI
 * is `ipfs://<CID>/<stem>.json`, where the CID is opaque and there is no
 * fixed parent segment to match on — an earlier draft of this regex required
 * `/power-up/` and would have silently read every real token as `relic`. A
 * gateway URL (`https://ipfs.io/ipfs/<CID>/sword-tier-1.json`) names the same
 * document and parses identically, which is correct.
 */
const LOOT_URI_RE = /(?:^|\/)([a-z][a-z0-9-]*)-tier-(\d+)\.json(?:\?[^/]*)?$/;

/**
 * Decode a loot URI into its archetype and tier. Total, never throws.
 *
 * Rule 1 — only the final `<slug>-tier-<n>.json` path segment is read, and only
 * where the slug begins that segment. A hypothetical
 * `ipfs://evil.example/axe/whatever.json` must not name a weapon: an attacker who
 * could write a URI string (they cannot — see the header) must still not be able
 * to pick a strong archetype off the front of a path, so the archetype is taken
 * from one fixed position or not at all.
 *
 * Rule 2 — anything that is not one of OUR shapes falls through to `relic` at
 * tier 1: a future scheme, garbage, an empty string, a 300-character URI, a
 * slug this build has never heard of. Degrading is correct rather than
 * defensive — every caller is downstream of a chain read, and a token that
 * cannot be understood must still be playable as what it was before archetypes
 * existed.
 *
 * Rule 3 — the legacy shape needs no special case, and that is worth stating
 * because it looks like an omission. Mainnet token #1 carries
 * `ipfs://grimhallow/power-up/tier-1.json`, whose final segment is `tier-1`:
 * there is no `<slug>-` prefix before `-tier-`, so rule 1 finds no match and
 * rule 2 returns `relic`. `RESERVED_SLUGS` guards the other direction — that
 * `tier` never becomes registered and starts winning a match it should lose.
 *
 * The returned tier is a CROSS-CHECK ONLY. Authority over a token's tier is
 * `get-token-tier` on chain; a caller that holds both should log a disagreement
 * and trust the chain, never this.
 */
export function parseLootUri(uri: string | null | undefined): LootUriParts {
  if (!uri) return { slug: DEFAULT_ARCHETYPE, tier: 1 };
  const match = LOOT_URI_RE.exec(uri);
  if (!match) return { slug: DEFAULT_ARCHETYPE, tier: 1 };
  const slug = match[1];
  if (!isLootArchetype(slug)) return { slug: DEFAULT_ARCHETYPE, tier: 1 };
  return { slug, tier: Math.min(Math.max(Number(match[2]), 1), MAX_POWER_UP_TIER) };
}

// ---------------------------------------------------------------------------
// Import-time integrity
// ---------------------------------------------------------------------------

/**
 * Grant ids the catalog declares that `powers.ts` does not define yet.
 *
 * This module ships DARK, ahead of the powers it names: Phase 6 adds
 * `potion-heal-*` and Phase 7 adds `tome-nova-*`. So a "grant must exist in
 * powers.ts" assertion cannot run here — it would throw on import for the whole
 * interval this module is deliberately unread, which is the interval it exists
 * to be reviewed in.
 *
 * The check is real and still owed; it belongs where it can see both tables. The
 * repo already states that convention explicitly at `encounter.ts:89-92` — a
 * constant is "exported so the power-up cap can be checked against it in a TEST
 * rather than kept in sync by comment … the two constants live in different
 * files." Same shape here, and `lootArchetypes.test.ts` implements it: while this
 * set is non-empty, the test asserts every pending id is absent from `POWERS`;
 * when Phase 6 empties the set, the same test asserts every declared grant is
 * present. The list cannot rot in either direction without failing.
 *
 * PHASE 6/7 SHRINK THIS SET as the powers land. It reaching empty is the signal
 * that the catalog's grants are fully backed.
 *
 * Phase 6 removed the four `potion-heal-*` ids: they are real entries in
 * `powers.ts` now, and `encounter.ts` resolves them. The four `tome-nova-*` ids
 * are Phase 7 and remain unbacked.
 */
export const POWER_GRANTS_PENDING: ReadonlySet<string> = new Set([
  'tome-nova-1', 'tome-nova-2', 'tome-nova-3', 'tome-nova-4',
]);

/** Every grant id the catalog declares, in catalog order. Read by the test. */
export const DECLARED_GRANT_IDS: readonly string[] = LOOT_ARCHETYPES.flatMap((spec) =>
  spec.tiers.map((t) => t.grantsPowerId).filter((id): id is string => id !== null),
);

// Thrown at import on purpose, in the style of powerUps.ts and rewards.ts: a
// table that silently misprices a tier or corrupts a live token is discovered by
// whoever ships the code, not by a player mid-resolve. Everything checked here
// is visible from THIS module alone — cross-module invariants are tests.
for (const spec of LOOT_ARCHETYPES) {
  if (!/^[a-z][a-z0-9-]*$/.test(spec.slug)) {
    throw new Error(`Archetype slug "${spec.slug}" must match /^[a-z][a-z0-9-]*$/`);
  }
  if (spec.tiers.length !== MAX_POWER_UP_TIER) {
    throw new Error(
      `Archetype "${spec.slug}" has ${spec.tiers.length} tier entries, need ${MAX_POWER_UP_TIER}`,
    );
  }
  const grantsSeen = new Set<string>();
  for (let i = 0; i < spec.tiers.length; i++) {
    const vector = spec.tiers[i];
    const budget = TIER_BUDGET[i];
    const cost = vectorCost(vector);
    if (Math.abs(cost - budget) > BUDGET_TOLERANCE) {
      throw new Error(
        `Archetype "${spec.slug}" tier ${i + 1} costs ${cost}, outside budget ` +
          `${budget} ± ${BUDGET_TOLERANCE} — redistribute it, do not widen the tolerance`,
      );
    }
    if (
      vector.dieSizeSteps < 0 ||
      vector.extraDice < 0 ||
      vector.flatDamage < 0 ||
      vector.defenseBonus < 0 ||
      vector.maxHp < 0
    ) {
      throw new Error(
        `Archetype "${spec.slug}" tier ${i + 1} has a negative bonus; equipping only ever adds`,
      );
    }
    if (vector.grantsPowerId !== null) {
      if (grantsSeen.has(vector.grantsPowerId)) {
        throw new Error(
          `Archetype "${spec.slug}" grants "${vector.grantsPowerId}" at more than one tier; ` +
            `a tier-N and tier-N+1 item would be indistinguishable in the power list`,
        );
      }
      grantsSeen.add(vector.grantsPowerId);
      if (!(vector.grantsPowerId in GRANT_VALUE)) {
        throw new Error(
          `Archetype "${spec.slug}" grants "${vector.grantsPowerId}", which has no entry in ` +
            `GRANT_VALUE — an unpriced grant would score 0 and pass the budget check for free`,
        );
      }
    }
  }
}

if (!BY_SLUG.has(DEFAULT_ARCHETYPE)) {
  throw new Error(`Default archetype "${DEFAULT_ARCHETYPE}" must be present in LOOT_ARCHETYPES`);
}

for (const reserved of RESERVED_SLUGS) {
  if (BY_SLUG.has(reserved)) {
    throw new Error(
      `Reserved slug "${reserved}" was registered as an archetype — this would re-stat ` +
        `every pre-archetype token on mainnet`,
    );
  }
}

/**
 * `relic`'s vectors, for the test that pins them to today's live `BONUSES`.
 *
 * This module deliberately does NOT import `powerUps.ts` to check that itself.
 * An import-time assertion here could only compare against numbers re-typed into
 * this file, which is a copy checking a copy: the same fat finger that edits the
 * table edits the assertion, and it passes. The check only has force when it
 * reads the real `BONUSES` array — a different module — so it lives in
 * `lootArchetypes.test.ts`, per the convention `encounter.ts:89-92` sets out.
 *
 * What that test protects is real property: mainnet loot token #1 parses to
 * `relic`, so these four vectors ARE its stats. Drift here silently re-stats a
 * token a player already owns and cannot re-roll.
 */
export const RELIC_TIERS: readonly ArchetypeBonusVector[] = RELIC_SPEC.tiers;

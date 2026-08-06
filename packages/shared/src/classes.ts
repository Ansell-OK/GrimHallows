/**
 * Class resolution — a static allowlist, not a derivation.
 *
 * Per 01-game-design.md#4a, as amended by the curated-collection delta. Shared
 * by the API and any verification tooling so two implementations cannot drift.
 *
 * WHAT DETERMINES A CLASS. Exactly two things, and neither is a guess:
 *
 *   1. `supported_collection` — the token's contract principal appears in
 *      `SUPPORTED_CLASS_CONTRACTS` below. Eight collections, two per class,
 *      mapped by hand.
 *   2. `mint`                 — a `character-nft.clar` token. The player chose
 *      the class at mint and the contract recorded it, so this is a read, not a
 *      derivation.
 *
 * THERE IS NO THIRD PATH. A token from any other collection is not a character
 * at all: `deriveClass` returns null and the API drops it before it reaches a
 * player. This replaces the earlier metadata-trait parsing and the
 * `hash(contractId || tokenId) % 4` fallback, both of which are deleted rather
 * than deprecated — a fallback that quietly makes every NFT playable is
 * indistinguishable, from the outside, from a curated roster.
 *
 * Metadata is deliberately absent. A contract principal is a single exact value
 * a token holder cannot edit, and matching on it needs no guess about whether a
 * collection spells its trait `Class`, `Type`, or `Archetype`. Combined with
 * hold-duration rarity (see `rarity.ts`), nothing a holder can edit reaches a
 * stat.
 */

import type { CharClass, ClassSource, StatKey } from './types.js';

/**
 * The four classes, in display order.
 *
 * No longer indexed into by any derivation — the hash fallback that made this
 * array's order load-bearing is gone. It is now an iteration order for the shop
 * catalog and a source of truth for "which ids exist", so reordering it is a
 * cosmetic change rather than a silent reassignment of anyone's class.
 */
export const CLASS_IDS = ['warrior', 'paladin', 'rogue', 'mage'] as const;

/**
 * Player-facing class names.
 *
 * The id is what is stored, compared, and written on chain; the display name is
 * only ever rendered. Keeping them separate means these can be rewritten for
 * flavour without a contract that disagrees with the UI — which is exactly what
 * happened when the placeholder archetype names (Iron Templar, Warden of Ash,
 * Shadow Lurker, Void Revenant) were replaced by the plain ones below. No id,
 * stat weight, or power changed with them.
 */
export const CLASS_DISPLAY_NAMES: Record<CharClass, string> = {
  warrior: 'Warrior',
  paladin: 'Paladin',
  rogue: 'Rogue',
  mage: 'Mage',
};

/** Which stats each class's budget skews toward. Mirrors CLASS_WEIGHTS in stats.ts. */
export const CLASS_EMPHASIS: Record<CharClass, readonly StatKey[]> = {
  warrior: ['str', 'vit'],
  paladin: ['vit', 'int'],
  rogue: ['agi'],
  mage: ['int'],
};

/** One-line flavour, shown on the shop's class picker. */
export const CLASS_BLURBS: Record<CharClass, string> = {
  warrior: 'Frontline tank',
  paladin: 'Hybrid support/control',
  rogue: 'Fast, evasive striker',
  mage: 'Arcane caster',
};

/**
 * How a character's class was arrived at. Published to players; see file header.
 * Declared in `types.ts` (to keep the import graph acyclic) and re-exported here
 * so callers can get it from the module that produces it.
 */
export type { ClassSource } from './types.js';

export interface DerivedClass {
  readonly classId: CharClass;
  readonly className: string;
  readonly classSource: ClassSource;
}

/**
 * The eight supported collections, two per class.
 *
 * This is the entire eligibility rule. A wallet's holdings are filtered against
 * these keys, and anything else is not offered as a character — see
 * `isSupportedCollection`.
 *
 * Keys must be lowercase full contract principals. `normalizeContractId` is
 * applied to every lookup, and the loop below fails the module at import time if
 * a key here is not already in that form, because a mis-cased key would silently
 * make a whole collection ineligible rather than error.
 *
 * WHY THIS LIVES IN CODE AND NOT ON CHAIN OR IN ENV: no money flows through it
 * and it changes rarely, so a contract would buy a deploy step, an init call and
 * a governance question for something a version-controlled constant solves. But
 * it is not a config tweak either — adding or reassigning a collection changes
 * the class of every character anyone plays from it, so it belongs next to
 * `deriveStats` where the rest of the derivation rules are versioned.
 */
export const SUPPORTED_CLASS_CONTRACTS: Readonly<Record<string, CharClass>> = {
  'sp2rnhhqdthghpevx83291k4aqzvgwej7wcqqda9r.giga-pepe-v2': 'warrior',
  'sp2rnhhqdthghpevx83291k4aqzvgwej7wcqqda9r.giga-pepe': 'warrior',
  'sp16srr777tvb1ws5xss9qt3yezec9jqfkyzenraj.bitcoin-pepe': 'rogue',
  'sp2kaf9rf86pvx3nee27dfv1cqx0t4wgr41x3s45c.deruptars': 'rogue',
  'sp2n959ser36fz5qt1cx9br63w3e8x35wqcmbyywc.leo-cats': 'mage',
  'spvg5j8hne9h5szdfzdqqz1agp9qttavt0m7427t.nakamoto_1_android': 'mage',
  'sp1fewh3946b7bys9w1cvgspc9fdkk5k32ztbsvbb.smoke-ethereals': 'paladin',
  'spv8c2n59ma417hyqng6372gcv0seqe01ev4z1rq.stacks-invaders-v0': 'paladin',
};

/** Contract principals are case-insensitive; compare them one way only. */
export function normalizeContractId(contractId: string): string {
  return contractId.trim().toLowerCase();
}

// A key written with the collection's own casing (e.g. `Nakamoto_1_Android`)
// would never match a normalized lookup, and the symptom — that collection is
// simply absent from every wallet — looks identical to "nobody holds one".
// Cheap to check once at import; impossible to notice in production.
for (const key of Object.keys(SUPPORTED_CLASS_CONTRACTS)) {
  if (key !== normalizeContractId(key)) {
    throw new Error(
      `SUPPORTED_CLASS_CONTRACTS keys must be normalized (lowercase, trimmed); got "${key}"`,
    );
  }
}

export function isCharClass(value: unknown): value is CharClass {
  return typeof value === 'string' && (CLASS_IDS as readonly string[]).includes(value);
}

export function classDisplayName(classId: CharClass): string {
  return CLASS_DISPLAY_NAMES[classId];
}

/**
 * Is this collection one of the eight?
 *
 * The hard filter the character list applies to a wallet's holdings. Note it is
 * deliberately *not* the whole eligibility test the API applies: our own
 * `character-nft` collection is playable too, and carries its class on chain
 * rather than in this table (see `deriveClass`). Callers that own a network
 * config check that contract separately.
 */
export function isSupportedCollection(contractId: string): boolean {
  return normalizeContractId(contractId) in SUPPORTED_CLASS_CONTRACTS;
}

/** The supported collections as a list, for diagnostics and the "why is my NFT not here" screen. */
export function supportedCollections(): readonly {
  readonly contractId: string;
  readonly classId: CharClass;
  readonly className: string;
}[] {
  return Object.entries(SUPPORTED_CLASS_CONTRACTS).map(([contractId, classId]) => ({
    contractId,
    classId,
    className: CLASS_DISPLAY_NAMES[classId],
  }));
}

/**
 * Resolve a character's class, or null if the token is not a character.
 *
 * `mintedClassId` is the on-chain class from `character-nft.clar`, when the
 * token is one of ours. It wins over everything else because it is not a
 * derivation at all — the player chose it and the contract recorded it. It is
 * also the reason this function has two sources rather than one: our own minted
 * tokens are playable and are not in the allowlist, and never will be.
 *
 * An unrecognized `mintedClassId` is IGNORED rather than trusted, and the token
 * falls through to the allowlist. The contract rejects unknown class ids
 * (03-smart-contracts-spec.md#5), so seeing one here means something upstream is
 * wrong; the safe reading of a value that should be impossible is to not believe
 * it.
 *
 * NULL IS A NORMAL ANSWER, not an error: it means "this NFT is not a playable
 * character", which is true of almost every NFT on Stacks.
 */
export function deriveClass(
  contractId: string,
  tokenId: string,
  mintedClassId: string | null = null,
): DerivedClass | null {
  void tokenId; // part of the identity, but no longer an input to the class

  if (mintedClassId != null && isCharClass(mintedClassId)) {
    return {
      classId: mintedClassId,
      className: CLASS_DISPLAY_NAMES[mintedClassId],
      classSource: 'mint',
    };
  }

  const supported = SUPPORTED_CLASS_CONTRACTS[normalizeContractId(contractId)];
  if (supported) {
    return {
      classId: supported,
      className: CLASS_DISPLAY_NAMES[supported],
      classSource: 'supported_collection',
    };
  }

  return null;
}

/**
 * Thrown when a token that is not a playable character reaches derivation.
 *
 * `deriveClass` returns null for these because "not a character" is a normal
 * answer to a question asked about an arbitrary NFT. But by the time something
 * is asking for that token's *stats*, the filter should already have run, so a
 * null there is a bug in the caller rather than a fact about the token — hence a
 * throw. Its own type so routes can answer 400 instead of 500 when the bad
 * `(contract, token)` pair came from a request body.
 */
export class UnsupportedCollectionError extends Error {
  readonly contractId: string;
  readonly tokenId: string;

  constructor(contractId: string, tokenId: string) {
    super(
      `${contractId}::${tokenId} is not from a supported collection; ` +
        'it is not a playable character.',
    );
    this.name = 'UnsupportedCollectionError';
    this.contractId = contractId;
    this.tokenId = tokenId;
  }
}

/** The shop's class menu. */
export function classCatalog(): readonly {
  readonly classId: CharClass;
  readonly name: string;
  readonly emphasis: readonly StatKey[];
  readonly blurb: string;
}[] {
  return CLASS_IDS.map((classId) => ({
    classId,
    name: CLASS_DISPLAY_NAMES[classId],
    emphasis: CLASS_EMPHASIS[classId],
    blurb: CLASS_BLURBS[classId],
  }));
}

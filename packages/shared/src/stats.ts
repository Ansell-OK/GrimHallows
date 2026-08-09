/**
 * Stat derivation — deterministic, versioned, pure.
 *
 *   deriveStats(contractId, tokenId, metadata, holdDays, mintedClassId) -> BaseStats
 *   deriveCharacter({...}) -> DerivedCharacterCore   <- what the API actually wants
 *
 * Per 01-game-design.md#4c. Shared by the API and any verification tooling so
 * two implementations can never drift.
 *
 * ANTI-SPOOFING (01-game-design.md#4c): as of stats-v2, metadata is out of the
 * power path entirely. The three inputs that set a character's ceiling are the
 * identity digest (base spread), the contract principal (class), and the
 * current holder's hold duration (rarity multiplier) — all facts about chain
 * state that anyone can re-derive, none of them editable by the holder.
 * Metadata still contributes a small bounded per-stat bonus, which is the one
 * remaining holder-influenced input and is clamped to +/-4 for exactly that
 * reason. Any future change that lets metadata move a stat further should be
 * treated as reopening a closed question.
 *
 * NOT EVERY TOKEN HAS STATS. Both functions below throw
 * `UnsupportedCollectionError` for a token that is not from one of the eight
 * supported collections and is not one of our own mints — see `classes.ts`.
 * There is no default class, because a default class is a fallback, and a
 * fallback is what the curated-collection delta removed.
 *
 * Versioned: changing any rule below changes every historical character, so
 * add a new version rather than editing one in place.
 *
 * stats-v1 -> stats-v2 changed three things:
 *   - class was contract-keyed rather than hash-only         (classes.ts)
 *   - rarity became hold-duration-derived rather than a hash roll (rarity.ts)
 *   - the rarity multipliers were retuned to 01-game-design.md#4b's table
 *
 * stats-v2 -> stats-v3 (the curated-collection delta) changed one:
 *   - class comes from an eight-collection allowlist, and a token outside it
 *     has no class at all rather than a hashed one.
 *
 * That last is a version bump and not an edit for two reasons. It moves stats:
 * a token that hashed to `mage` and is listed as `warrior` gets a different
 * spread from the same identity. And `character_stats_cache` rows written under
 * v2 carry `classSource: 'fallback_hash'`, which is no longer a value this
 * build can produce — bumping the version leaves those rows unreachable rather
 * than deserialized into a class the game no longer believes in.
 *
 * stats-v3 -> stats-v4 adds the mint-rarity floor (01-game-design.md#4b, the
 * hold-to-improve rule). Our own `character-nft` mints roll a deterministic base
 * rarity (rarity.ts `mintFloorFromSeed`) that acts as a floor, so a token's
 * effective rarity becomes `max(mint-floor, tenure-tier)` rather than the tenure
 * tier alone. This moves derived stats and the published `rarityTier` ONLY for
 * `classSource === 'mint'` tokens; the eight supported collections have no floor
 * and derive byte-identically to v3. The floor is derived, never stored, so it
 * travels with the token and needs no contract change. Bumped rather than edited
 * so v3 cache rows retire cleanly and any minted-token row is recomputed under
 * the new rule.
 *
 * The roll is seeded with the hash of the block that confirmed the mint, which
 * the caller supplies as `mintSeed`. That is what keeps the floor from being
 * precomputable off a sequential token id — see the note on MINT_FLOOR_TIERS in
 * rarity.ts. It also makes the floor the one derived value that depends on
 * something outside `(contractId, tokenId, metadata, holdDays)`: a token whose
 * seed has not been resolved yet derives with no floor rather than a guessed
 * one, so a stats row must not be cached as final until the seed is known.
 */

import { sha256 } from '@noble/hashes/sha2';
import {
  deriveClass,
  UnsupportedCollectionError,
  type ClassSource,
  type DerivedClass,
} from './classes.js';
import { maxRarity, mintFloorFromSeed, rarityFromHoldDays, rarityMultiplier } from './rarity.js';
import type { BaseStats, CharClass, Rarity } from './types.js';

export const STATS_ALGO_VERSION = 'stats-v4' as const;

/** Bounded so metadata can flavor a character but never dominate the base. */
const MAX_METADATA_BONUS_PER_STAT = 4;

export interface NftMetadata {
  readonly name?: string;
  readonly image?: string;
  /** Hiro's cached https copy of `image`. Display only, like `name` and `image`. */
  readonly cached_image?: string;
  readonly attributes?: readonly { readonly trait_type?: string; readonly value?: unknown }[];
}

function identityDigest(contractId: string, tokenId: string): Uint8Array {
  return sha256(new TextEncoder().encode(`${contractId.toLowerCase()}::${tokenId}`));
}

function byteAt(digest: Uint8Array, i: number): number {
  return digest[i % digest.length];
}

/**
 * Per-class stat emphasis: [str, agi, int, vit].
 *
 * Weights are near-1.0 on average within each class on purpose. Class shapes a
 * character, it does not power one up — the design keeps raw power entirely on
 * rarity's side of the line so that no class is "the good one"
 * (01-game-design.md#4a). Skewing these to make a class stronger overall would
 * quietly break that separation.
 */
const CLASS_WEIGHTS: Record<CharClass, readonly [number, number, number, number]> = {
  warrior: [1.35, 0.9, 0.6, 1.25],
  paladin: [1.1, 0.75, 1.05, 1.4],
  rogue: [0.95, 1.6, 0.8, 0.85],
  mage: [0.55, 0.85, 1.75, 0.8],
};

/** Sum of bounded per-stat metadata bonuses, keyed by trait_type. */
function metadataBonus(metadata: NftMetadata | null | undefined): Record<keyof BaseStats, number> {
  const bonus: Record<keyof BaseStats, number> = { hp: 0, str: 0, agi: 0, int: 0, vit: 0 };
  if (!metadata?.attributes) return bonus;

  for (const attr of metadata.attributes) {
    const key = String(attr.trait_type ?? '').trim().toLowerCase();
    if (!(key in bonus)) continue;
    const value = Number(attr.value);
    if (!Number.isFinite(value)) continue;
    const clamped = Math.max(
      -MAX_METADATA_BONUS_PER_STAT,
      Math.min(MAX_METADATA_BONUS_PER_STAT, Math.trunc(value)),
    );
    bonus[key as keyof BaseStats] = clamped;
  }
  // HP bonus is scaled up since HP lives on a larger numeric range than STR/AGI/INT/VIT.
  bonus.hp *= 5;
  return bonus;
}

/**
 * A character's effective rarity: the higher of its mint floor and the tier its
 * current holder's tenure has earned (`max(floor, age)`).
 *
 * The floor applies ONLY to our own `character-nft` mints (`classSource ===
 * 'mint'`). For the eight supported collections there is no floor, so this is
 * exactly `rarityFromHoldDays(holdDays)` and their derivation is unchanged from
 * stats-v3. Taking `classSource` — already resolved by the caller — rather than
 * the raw mint id keeps this from re-running `deriveClass`, and routes both
 * public functions below through one code path so the published tier and the
 * stat multiplier can never disagree about a token's rarity.
 *
 * AN UNRESOLVED SEED MEANS NO FLOOR, NOT A GUESSED ONE. `mintSeed` is the hash
 * of the confirming block (rarity.ts), which the API resolves per token and can
 * fail to have yet — the mint is still in the mempool, or Hiro was unreachable.
 * The degrade is the same one 02-architecture.md#4 already applies to holder age:
 * serve the token at the rarity it can prove, never block the character list.
 * That understates a lucky mint's rarity until the lookup lands, which is a
 * visible correction upward and is the safe direction to be wrong in — inventing
 * a seed would be a floor that changes when the real one arrives, and caching a
 * seedless roll as final would make the degrade permanent.
 */
export function effectiveRarity(args: {
  readonly contractId: string;
  readonly tokenId: string;
  readonly holdDays: number;
  readonly classSource: ClassSource;
  readonly mintSeed?: string | null;
}): Rarity {
  const ageTier = rarityFromHoldDays(args.holdDays);
  return args.classSource === 'mint' && args.mintSeed
    ? maxRarity(mintFloorFromSeed(args.contractId, args.tokenId, args.mintSeed), ageTier)
    : ageTier;
}

/**
 * `mintSeed` is appended rather than slotted next to `mintedClassId` where it
 * belongs topically: `algoVersion` is already the last positional and several
 * callers pass it, so inserting ahead of it would silently shift a version
 * string into the seed slot. `deriveCharacter` below takes named input and is
 * what new callers should use.
 */
export function deriveStats(
  contractId: string,
  tokenId: string,
  metadata: NftMetadata | null = null,
  holdDays = 0,
  mintedClassId: string | null = null,
  algoVersion: string = STATS_ALGO_VERSION,
  mintSeed: string | null = null,
): BaseStats {
  if (algoVersion !== STATS_ALGO_VERSION) {
    throw new Error(
      `Unsupported stats algo version "${algoVersion}" (this build implements ${STATS_ALGO_VERSION})`,
    );
  }

  const d = identityDigest(contractId, tokenId);
  // Throws rather than defaults on an unsupported collection. A default class
  // here would be the hash fallback again under a shorter name: every NFT on
  // Stacks would once more have a stat block, and the only thing stopping it
  // reaching a player would be a filter in one caller.
  const cls = deriveClass(contractId, tokenId, mintedClassId);
  if (cls === null) throw new UnsupportedCollectionError(contractId, tokenId);
  const weights = CLASS_WEIGHTS[cls.classId];
  const scale = rarityMultiplier(
    effectiveRarity({ contractId, tokenId, holdDays, classSource: cls.classSource, mintSeed }),
  );

  // Base rolls in [8, 23] before class weighting and rarity scaling.
  const rollFor = (i: number) => 8 + (byteAt(d, i) % 16);
  const raw = [rollFor(2), rollFor(3), rollFor(4), rollFor(5)] as const;

  const bonus = metadataBonus(metadata);
  const shape = (value: number, weight: number, extra: number) =>
    Math.max(1, Math.round(value * weight * scale) + extra);

  const str = shape(raw[0], weights[0], bonus.str);
  const agi = shape(raw[1], weights[1], bonus.agi);
  const int = shape(raw[2], weights[2], bonus.int);
  const vit = shape(raw[3], weights[3], bonus.vit);

  // HP derives from VIT so the Defense DC (10 + VIT/2) and survivability move
  // together — but from the *base* VIT, deliberately excluding the metadata
  // bonus. Otherwise a spoofed +VIT would raise HP twice (once directly via
  // the HP trait, again through VIT), compounding past the intended bound.
  const baseVit = shape(raw[3], weights[3], 0);
  const hp = Math.max(1, Math.round((60 + baseVit * 2.5) * scale) + bonus.hp);

  return { hp, str, agi, int, vit };
}

/**
 * Everything derived about a character, from one computation.
 *
 * This exists so the API never has to call `deriveClass`, `rarityFromHoldDays`
 * and `deriveStats` separately and hope they were given consistent arguments.
 * `GET /characters` publishes `classId`/`charClass` and `rarityTier`/`rarity`
 * as pairs of names for one value (04-backend-api-spec.md#2); serving them from
 * a single result object is what makes that an alias rather than a second
 * derivation waiting to disagree.
 */
export interface DeriveCharacterInput {
  readonly contractId: string;
  readonly tokenId: string;
  readonly metadata?: NftMetadata | null;
  /** Current holder's tenure. 0 when the lookup hasn't completed — see 02-architecture.md#4. */
  readonly holdDays?: number;
  /** On-chain class, for `character-nft.clar` tokens only. */
  readonly mintedClassId?: string | null;
  /**
   * Hash of the block that confirmed the mint, for `character-nft.clar` tokens
   * only. Seeds the rarity floor; null or absent means the API has not resolved
   * it yet and the token derives with no floor — see `effectiveRarity`.
   */
  readonly mintSeed?: string | null;
  readonly algoVersion?: string;
}

export interface DerivedCharacterCore {
  readonly classId: CharClass;
  readonly className: string;
  readonly classSource: ClassSource;
  readonly holdDays: number;
  readonly rarityTier: Rarity;
  readonly stats: BaseStats;
  readonly algoVersion: string;
}

export function deriveCharacter(input: DeriveCharacterInput): DerivedCharacterCore {
  const {
    contractId,
    tokenId,
    metadata = null,
    holdDays = 0,
    mintedClassId = null,
    mintSeed = null,
    algoVersion = STATS_ALGO_VERSION,
  } = input;

  // Normalized once here rather than at each use: a negative or NaN holdDays
  // from a failed lookup must read as "freshly acquired", and the value we
  // publish has to be the same one the tier was computed from or a client
  // checking our arithmetic would be right to say we got it wrong.
  const safeHoldDays = Number.isFinite(holdDays) && holdDays > 0 ? holdDays : 0;

  const resolved = deriveClass(contractId, tokenId, mintedClassId);
  if (resolved === null) throw new UnsupportedCollectionError(contractId, tokenId);
  const cls: DerivedClass = resolved;

  return {
    classId: cls.classId,
    className: cls.className,
    classSource: cls.classSource,
    holdDays: safeHoldDays,
    rarityTier: effectiveRarity({
      contractId,
      tokenId,
      holdDays: safeHoldDays,
      classSource: cls.classSource,
      mintSeed,
    }),
    stats: deriveStats(
      contractId,
      tokenId,
      metadata,
      safeHoldDays,
      mintedClassId,
      algoVersion,
      mintSeed,
    ),
    algoVersion,
  };
}

/** D&D-style modifier: (stat - 10) / 2, rounded down. */
export function statModifier(stat: number): number {
  return Math.floor((stat - 10) / 2);
}

/** Defense DC per 01-game-design.md#7: `10 + VIT/2`. */
export function defenseDc(stats: BaseStats): number {
  return 10 + Math.floor(stats.vit / 2);
}

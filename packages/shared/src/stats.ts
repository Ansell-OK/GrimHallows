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
 */

import { sha256 } from '@noble/hashes/sha2';
import {
  deriveClass,
  UnsupportedCollectionError,
  type ClassSource,
  type DerivedClass,
} from './classes.js';
import { rarityFromHoldDays, rarityMultiplier } from './rarity.js';
import type { BaseStats, CharClass, Rarity } from './types.js';

export const STATS_ALGO_VERSION = 'stats-v3' as const;

/** Bounded so metadata can flavor a character but never dominate the base. */
const MAX_METADATA_BONUS_PER_STAT = 4;

export interface NftMetadata {
  readonly name?: string;
  readonly image?: string;
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

export function deriveStats(
  contractId: string,
  tokenId: string,
  metadata: NftMetadata | null = null,
  holdDays = 0,
  mintedClassId: string | null = null,
  algoVersion: string = STATS_ALGO_VERSION,
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
  const scale = rarityMultiplier(rarityFromHoldDays(holdDays));

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
    rarityTier: rarityFromHoldDays(safeHoldDays),
    stats: deriveStats(contractId, tokenId, metadata, safeHoldDays, mintedClassId, algoVersion),
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

/**
 * Seed commit-reveal primitives.
 *
 * INTERNAL. Nothing under `src/oracle/` is registered as a route, and nothing
 * in `src/routes/` may import from here — this module reaches the signing key
 * that can move sponsor-pool funds (04-backend-api-spec.md#5).
 *
 * The scheme, per 03-smart-contracts-spec.md#2:
 *
 *   1. Generate a 32-byte seed. Keep it secret.
 *   2. Publish `sha256(seed)` BEFORE the party takes a single action.
 *   3. Reveal the seed after the run resolves.
 *   4. Anyone re-hashes the seed, matches it against the published hash, and
 *      recomputes every roll from it with `@grimhallow/shared`.
 *
 * The 32 bytes matter: the on-chain `seed-hash`/`seed-reveal` fields are
 * `(buff 32)`, and the contract's own check is literally `sha256(seed)`. A seed
 * of another length would hash fine here and be unpostable there.
 *
 * On randomness — this is the one place a CSPRNG is correct and `deriveValue`
 * is not. `dice.ts`'s ban on non-derived entropy is about *outcomes*: those must
 * follow from the committed seed. The seed itself is the input to that process
 * and has to be unguessable, or a player could predict the run before entering.
 * `randomBytes` is the right tool, `Math.random()` still is not.
 */

import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2';

/** Bytes in a seed. Fixed by the contract's `(buff 32)` fields. */
export const SEED_BYTES = 32;

/** Version tag recorded alongside a resolution, so an attestation is dateable. */
export const COMMIT_SCHEME_VERSION = 'commit-v1' as const;

const HEX_64 = /^[0-9a-f]{64}$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Normalize a seed or hash to bare lowercase hex.
 *
 * Stored bare (no `0x`) because the DB columns are plain `text` and one spelling
 * beats two: a hash compared as a string must have exactly one representation,
 * or `seed_hash = $1` starts missing rows that are in fact equal. Callers that
 * need Clarity's `0x` form add it at the boundary.
 */
export function normalizeHex32(value: string, label = 'value'): string {
  const bare = (value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value)
    .trim()
    .toLowerCase();
  if (!HEX_64.test(bare)) {
    throw new Error(`${label} must be ${SEED_BYTES} bytes of hex; got "${value}"`);
  }
  return bare;
}

export interface SeedCommit {
  /**
   * The seed, bare lowercase hex.
   *
   * SECRET until the run resolves. Publishing it early would let a player derive
   * every remaining roll before choosing their next action, which is the one
   * thing commit-reveal exists to prevent.
   */
  readonly seed: string;
  /** `sha256(seed)`, bare lowercase hex. Safe to publish immediately. */
  readonly seedHash: string;
}

/** A fresh seed and its commitment. */
export function generateSeed(): SeedCommit {
  const seed = toHex(randomBytes(SEED_BYTES));
  return { seed, seedHash: commitHashFor(seed) };
}

/** `sha256(seed)` over the seed's raw bytes — the same bytes the contract hashes. */
export function commitHashFor(seed: string): string {
  return toHex(sha256(fromHex(normalizeHex32(seed, 'seed'))));
}

/**
 * Constant-time-ish check that a revealed seed matches its commitment.
 *
 * Both sides are public by the time this runs, so timing isn't a real attack
 * surface here; the point is that verification lives in exactly one function
 * rather than being re-spelled as `===` at each call site.
 */
export function seedMatchesHash(seed: string, seedHash: string): boolean {
  try {
    return commitHashFor(seed) === normalizeHex32(seedHash, 'seedHash');
  } catch {
    return false;
  }
}

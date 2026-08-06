/**
 * Character-collection fixtures.
 *
 * Since the curated-collection delta, a contract principal is not an arbitrary
 * string a test may invent: `deriveCharacter` throws
 * `UnsupportedCollectionError` for anything outside the eight-entry allowlist in
 * `packages/shared/src/classes.ts`, and the server maps that to a 400. So a test
 * that wants a playable character has to name a real listed collection, and one
 * that wants the refusal has to name something real that is definitely not
 * listed.
 *
 * Centralised here rather than repeated per file for the ordinary reason —
 * eleven copies of a principal is eleven places to miss when the allowlist
 * changes — and for one specific to these values. The eight principals are
 * *shipped data*: if a collection is ever delisted, every test hard-coding it
 * starts failing for a reason that has nothing to do with what it was testing.
 * One import means one edit.
 *
 * Deliberately re-exported from the shared table rather than retyped, so a
 * fixture cannot drift from the allowlist it is supposed to be an example of.
 */

import { SUPPORTED_CLASS_CONTRACTS, supportedCollections } from '@grimhallow/shared';
import type { CharClass } from '@grimhallow/shared';

/** The first listed collection for `classId`, as it appears in the allowlist. */
function firstFor(classId: CharClass): string {
  const found = supportedCollections().find((c) => c.classId === classId);
  // Not a soft failure: the allowlist covering all four classes is asserted in
  // the shared suite, so a miss here means this helper is out of step with it.
  if (!found) throw new Error(`no supported collection is mapped to "${classId}"`);
  return found.contractId;
}

/**
 * A playable character's collection, for tests whose subject is something else
 * — a run, a claim, a power-up. Rogue because it is the least ambiguous shape:
 * its AGI emphasis means a stat block from this collection cannot be confused
 * with a Warrior's if a fixture ever leaks between files.
 */
export const CHARACTER_COLLECTION = firstFor('rogue');

/** One per class, for tests asserting that class actually changes an outcome. */
export const COLLECTION_BY_CLASS: Readonly<Record<CharClass, string>> = {
  warrior: firstFor('warrior'),
  paladin: firstFor('paladin'),
  rogue: firstFor('rogue'),
  mage: firstFor('mage'),
};

/**
 * Real, well-formed, and not one of the eight — the "ordinary NFT" case.
 *
 * Asserted below rather than trusted: a fixture that quietly became listed would
 * turn every "refuses an unlisted collection" test into a tautology that passes
 * while proving the opposite of its name.
 */
export const UNLISTED_COLLECTION = 'SP2X0TZ59D5SZ8ACQ6YMCHHNR2ZN51Z32E2CJ173.the-explorer-guild';

if (UNLISTED_COLLECTION.toLowerCase() in SUPPORTED_CLASS_CONTRACTS) {
  throw new Error(
    `${UNLISTED_COLLECTION} is now a supported collection; pick another unlisted fixture.`,
  );
}

/** A character ref for the collection above, matching `CharacterRef`'s shape. */
export function characterRef(tokenId = '7', contractId = CHARACTER_COLLECTION) {
  return { contractId, tokenId };
}

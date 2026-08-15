/**
 * Per-archetype, per-tier art for loot items.
 *
 * A loot token's look is a pure function of `(archetype, tier)` — the two fields
 * `parseLootUri` recovers from the on-chain uri — so it resolves client-side from
 * a static bundle, exactly as `portraits.ts` resolves a character's. Nothing here
 * fetches the document at the token's uri; see that module's header for why a
 * number is never read off metadata, and why a *string the contract wrote once*
 * is a different thing from a document someone can host and later edit.
 *
 * ONE STEM, THREE PLACES. The filename comes from `lootFileStem` in `shared` —
 * the same function that names the pinned metadata document and the image it
 * points at. So `sword-tier-4` is the bundled JPG here, `sword-tier-4.json` on
 * IPFS, and `sword-tier-4.jpg` in the pinned image directory. One definition, so
 * the web app and the chain can never drift on what a file is called.
 *
 * THE ART IS OPTIONAL AT BUILD TIME. `import.meta.glob` binds whatever JPGs are
 * present in `../assets/loot/`; an empty folder yields an empty index and every
 * lookup returns `undefined`, so an item falls back to the existing `imgLoot`
 * placeholder. Dropping a correctly-named file in makes that item live with no
 * code change. See that folder's README for the 48 filenames.
 *
 * TIER 1 IS THE BASE LAYER, as a *miss* fallback rather than a clamp. All four
 * tiers have their own art, but until the full set exists an archetype with only
 * `-tier-1.jpg` present shows that one image at every tier. This differs from
 * `PORTRAIT_FLOOR`, which clamps the input domain because there is genuinely no
 * common/uncommon portrait; here every tier is a real file that may simply not
 * have been produced yet.
 */

import {
  DEFAULT_ARCHETYPE,
  archetypeSpec,
  lootFileStem,
  type LootArchetype,
} from '@grimhallow/shared';

/** The tier whose art stands in for an archetype whose own tier art is absent. */
export const LOOT_ART_FLOOR_TIER = 1;

/**
 * Archetypes that intentionally have no art of their own.
 *
 * `relic` is the legacy archetype every pre-archetype token parses to, and mainnet
 * loot token #1 is one of them. It keeps today's generic loot picture for the same
 * reason it keeps today's stat table: nothing a player already owns should change
 * look or behaviour because we shipped this feature. Encoded as a rule rather than
 * left to the folder being empty, so dropping a `relic-tier-1.jpg` in by accident
 * cannot retroactively restyle a token someone earned.
 */
export const LOOT_ART_EXEMPT: readonly LootArchetype[] = [DEFAULT_ARCHETYPE];

/**
 * Build a `{slug}-tier-{n}` -> bundled-URL index from a glob's module map.
 *
 * Split out from the glob call so it can be unit-tested with a synthetic map: the
 * real folder ships empty (wire it up, art lands later), so a test depending on
 * real files could never exercise the hit path. Same split, same reason, as
 * `indexPortraits`.
 *
 * Keyed by the bare filename stem rather than the glob's absolute-path keys, so a
 * lookup never has to know where the bundle put the file.
 */
export function indexLootArt(modules: Record<string, string>): Record<string, string> {
  const byStem: Record<string, string> = {};
  for (const [path, url] of Object.entries(modules)) {
    const file = path.split('/').pop();
    if (!file) continue;
    const stem = file.replace(/\.jpe?g$/i, '').toLowerCase();
    byStem[stem] = url;
  }
  return byStem;
}

/**
 * Resolve loot art against an already-built index.
 *
 * Total for any string: an unregistered slug normalises to `relic` through
 * `archetypeSpec` — the same degrade path `parseLootUri` and `lootDisplayName`
 * take — and `relic` is art-exempt, so garbage in yields `undefined` rather than
 * a wrong picture. An out-of-range tier is clamped inside `lootFileStem`.
 *
 * `undefined` means "use the caller's fallback", covering three cases the UI does
 * not need to tell apart: an art-exempt archetype, an archetype whose art has not
 * been produced yet, and an unreadable slug.
 */
export function resolveLootArt(
  index: Record<string, string>,
  slug: string,
  tier: number,
): string | undefined {
  const canonical = archetypeSpec(slug).slug;
  if (LOOT_ART_EXEMPT.includes(canonical)) return undefined;
  return (
    index[lootFileStem(canonical, tier)] ??
    index[lootFileStem(canonical, LOOT_ART_FLOOR_TIER)]
  );
}

// Bound once at module load. Vite resolves each match to its hashed bundle URL;
// zero matches (the folder is empty until art is produced) is a valid empty map.
// The pattern must be a static string literal for Vite to analyse it at build.
const LOOT_ART_INDEX = indexLootArt(
  import.meta.glob('../assets/loot/*.jpg', {
    eager: true,
    import: 'default',
  }) as Record<string, string>,
);

/**
 * The art URL for a loot item, or `undefined` to use the generic loot image.
 *
 * The one function the UI calls.
 */
export function lootArtFor(slug: string, tier: number): string | undefined {
  return resolveLootArt(LOOT_ART_INDEX, slug, tier);
}

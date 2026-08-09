/**
 * Class + rarity portraits for our own minted characters.
 *
 * A `character-nft` mint shows one of 16 portraits — 4 classes × 4 rarity tiers
 * (rare, epic, legendary, mythic) — and it SWAPS as the token's rarity climbs
 * with the holder's tenure (01-game-design.md#4b, the hold-to-improve rule the
 * stats-v4 floor delivers). Because rarity is holder-dependent, the portrait is
 * resolved on every render from the live `rarity` the API publishes, never cached
 * against the token id.
 *
 * RARE IS THE BASE LAYER. There is no `common` or `uncommon` portrait: those
 * lower tiers show the `rare` art. So the display tier is `max(rarity, 'rare')` —
 * a fresh Common mint looks Rare, and only epic/legendary/mythic have their own
 * distinct art. (Rarity still drives stats across all six tiers; this clamp is
 * purely which of the four portraits to show.)
 *
 * WHY THIS LIVES IN THE WEB APP, NOT THE API. The portrait is a pure function of
 * two fields already on every `GET /characters` row — `classSource` and
 * `rarity` — plus a static art bundle. Resolving it client-side keeps the art
 * out of the API's cached, holder-independent `CharacterIdentity` (where a
 * rarity-keyed URL would be a stale-portrait bug) and out of the request path
 * entirely. The eight supported collections are deliberately untouched: they
 * keep their native NFT art, so this only ever fires for `classSource === 'mint'`.
 *
 * THE ART IS OPTIONAL AT BUILD TIME. `import.meta.glob` binds whatever JPGs are
 * present in `../assets/portraits/`; an empty folder yields an empty index and
 * every lookup returns `undefined`, so a mint falls back to its existing image.
 * Dropping a correctly-named `{class}-{rarity}.jpg` in makes that portrait live
 * with no code change. See that folder's README for the 16 filenames.
 */

import { maxRarity, type CharClass, type ClassSource, type Rarity } from '@grimhallow/shared';

/**
 * The lowest tier that has its own portrait. Common and Uncommon mints show this
 * one; rare/epic/legendary/mythic show their own. `maxRarity` clamps up to it.
 */
export const PORTRAIT_FLOOR: Rarity = 'rare';

/** The rarity a portrait is shown for: the character's tier, floored at Rare. */
export function portraitRarity(rarity: Rarity): Rarity {
  return maxRarity(rarity, PORTRAIT_FLOOR);
}

/** The stem a portrait file is named by: `warrior-rare`, `mage-mythic`, … */
export function portraitStem(charClass: CharClass, rarity: Rarity): string {
  return `${charClass}-${portraitRarity(rarity)}`;
}

/**
 * Build a `{class}-{rarity}` -> bundled-URL index from a glob's module map.
 *
 * Split out from the glob call so it can be unit-tested with a synthetic map:
 * the real folder ships empty ("wire it up, art lands later"), so a test that
 * depended on real files could never exercise the hit path.
 *
 * Keyed by the bare filename stem rather than the glob's absolute-path keys, so
 * a lookup never has to know where the bundle put the file.
 */
export function indexPortraits(modules: Record<string, string>): Record<string, string> {
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
 * Resolve a portrait against an already-built index.
 *
 * `undefined` for anything that is not one of our mints — a supported-collection
 * token keeps its native art — and for a mint whose `{class}-{rarity}.jpg` is
 * not in the bundle yet. Both cases let the caller fall back cleanly.
 */
export function resolvePortrait(
  index: Record<string, string>,
  classSource: ClassSource,
  charClass: CharClass,
  rarity: Rarity,
): string | undefined {
  if (classSource !== 'mint') return undefined;
  return index[portraitStem(charClass, rarity)];
}

// Bound once at module load. Vite resolves each match to its hashed bundle URL;
// zero matches (the folder is empty until art is produced) is a valid empty map.
// The pattern must be a static string literal for Vite to analyse it at build.
const PORTRAIT_INDEX = indexPortraits(
  import.meta.glob('../assets/portraits/*.jpg', {
    eager: true,
    import: 'default',
  }) as Record<string, string>,
);

/**
 * The portrait URL for a character, or `undefined` to use its native image.
 *
 * The one function the UI calls. Only `classSource === 'mint'` tokens get a
 * portrait, and only when the matching art exists in the bundle.
 */
export function portraitFor(
  classSource: ClassSource,
  charClass: CharClass,
  rarity: Rarity,
): string | undefined {
  return resolvePortrait(PORTRAIT_INDEX, classSource, charClass, rarity);
}

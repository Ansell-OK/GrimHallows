#!/usr/bin/env node
/**
 * Generate the 52 loot metadata documents that get pinned to IPFS.
 *
 *   npm run loot-metadata -- --image-cid <IMAGE_CID> [--out <dir>] [--ext jpg]
 *
 * Writes one `<archetype>-tier-<n>.json` per (archetype, tier) — 13 archetypes ×
 * 4 tiers — into `--out` (default `build/loot-metadata/`). Pin that directory,
 * then set `LOOT_METADATA_CID` in `packages/shared/src/lootArchetypes.ts`.
 *
 * WHY 52 AND NOT 48. Twelve archetypes have art; `relic` does not (it is the
 * legacy archetype, and a token minted before this feature must keep the picture
 * it was earned with). But `relic` still gets a metadata document, so that if a
 * future mint ever writes a `relic-tier-N.json` uri, a wallet resolves it to a
 * real name instead of a dead link. Its `image` points at the generic loot art.
 *
 * ORDER MATTERS. The image directory must be pinned FIRST, because every document
 * here embeds `ipfs://<IMAGE_CID>/<stem>.<ext>`. Pinning metadata against a
 * placeholder image CID produces 52 documents that all point at nothing — and
 * once a token is minted against them, a token's uri is written inside `mint` and
 * is immutable for life (no setter, no base-uri, and `burn` is contract-caller-
 * gated so the holder cannot even destroy it). Hence `--image-cid` is required
 * and validated rather than defaulted.
 *
 * READ-ONLY WITH RESPECT TO THE CHAIN: no key is loaded and nothing is broadcast.
 * This writes local files. Pinning is the operator's step.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOOT_ARCHETYPES,
  LOOT_ARCHETYPE_VERSION,
  MAX_POWER_UP_TIER,
  archetypeBonusVector,
  archetypeTierName,
  lootDisplayName,
  lootFileStem,
} from '@grimhallow/shared';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Archetypes with no art of their own; see LOOT_ART_EXEMPT in apps/web. */
const ART_EXEMPT = new Set(['relic']);

/**
 * The image a metadata document points at when its archetype has no own art.
 *
 * Deliberately NOT `relic-tier-N` — the web bundle ignores files by that name
 * (`LOOT_ART_EXEMPT`), so a stem that looks tiered would suggest four relic images
 * exist when the point is that relic has one generic picture at every tier. The
 * operator puts a single `relic.jpg` in the image directory alongside the 48, for
 * 49 files total.
 */
const FALLBACK_IMAGE_STEM = 'relic';

function parseArgs(argv) {
  const out = { imageCid: '', outDir: resolve(ROOT, 'build/loot-metadata'), ext: 'jpg' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--image-cid') out.imageCid = (argv[++i] ?? '').trim();
    else if (arg === '--out') out.outDir = resolve(ROOT, argv[++i] ?? '');
    else if (arg === '--ext') out.ext = (argv[++i] ?? '').trim().replace(/^\./, '');
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return out;
}

/**
 * A CID is validated by shape, not merely by being non-empty.
 *
 * The failure this catches is a copy-paste of `ipfs://bafy…/` or of a gateway URL
 * into `--image-cid`, which would embed a doubled scheme in all 52 documents. A
 * shape check is not proof the directory is pinned — only the operator can know
 * that — but it rules out the mistake that is easy to make and expensive to find.
 */
function assertCidShape(cid) {
  if (!cid) {
    console.error(
      'Missing --image-cid. Pin the IMAGE directory first, then pass its CID:\n' +
        '  npm run loot-metadata -- --image-cid bafybei...\n\n' +
        'Every document embeds ipfs://<IMAGE_CID>/<stem>.jpg, so metadata pinned\n' +
        'against a placeholder points at nothing — permanently, once minted.',
    );
    process.exit(1);
  }
  if (/[:/]/.test(cid)) {
    console.error(
      `--image-cid looks like a URL, not a CID: "${cid}"\n` +
        'Pass the bare CID with no ipfs:// prefix, no gateway host, no trailing slash.',
    );
    process.exit(1);
  }
  if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/.test(cid)) {
    console.error(
      `--image-cid is not a v0 or v1 CID: "${cid}"\n` +
        'Expected Qm… (46 chars, base58) or bafy…/bafk… (base32).',
    );
    process.exit(1);
  }
}

/**
 * SIP-16 `attributes`, one entry per non-zero mechanical axis.
 *
 * Wallets show these, so they are written in the player's language ("+2 Defense")
 * rather than in the engine's ("defenseBonus: 2"). Zero axes are omitted rather
 * than listed as 0 — twelve rows of mostly zeros reads as noise and buries the
 * one or two that make the item what it is.
 *
 * NOTHING IN THE GAME READS THIS. The engine derives every number from
 * `archetypeBonusVector(archetype, tier)`, keyed off the uri STRING the contract
 * stores. These attributes are display copy for wallets and explorers; a document
 * edited on a pinning service can change what a wallet shows and cannot change a
 * single die. That asymmetry is the whole reason archetype is parsed from the uri
 * rather than fetched from the document at it.
 */
function attributesFor(vector) {
  const attrs = [];
  const add = (trait_type, value) => attrs.push({ trait_type, value });
  if (vector.dieSizeSteps) add('Damage Die', `+${vector.dieSizeSteps} step${vector.dieSizeSteps > 1 ? 's' : ''}`);
  if (vector.extraDice) add('Extra Damage Dice', `+${vector.extraDice}`);
  if (vector.flatDamage) add('Flat Damage', `+${vector.flatDamage}`);
  if (vector.defenseBonus) add('Defense', `+${vector.defenseBonus}`);
  if (vector.maxHp) add('Max HP', `+${vector.maxHp}`);
  if (vector.grantsPowerId) add('Grants Power', vector.grantsPowerId);
  return attrs;
}
/**
 * One-line flavour, keyed by family rather than by archetype.
 *
 * Per-archetype prose would be 13 strings to maintain in a script whose output is
 * pinned immutably; the family tells a wallet reader what the item is *for*,
 * which is the part that changes their decision. The mechanical detail is in
 * `attributes`, generated from the real table rather than described in prose that
 * could drift from it.
 */
const FAMILY_BLURB = {
  blade: 'A weapon of the Grim Hallow. Equip it to sharpen what you swing.',
  armour: 'Plate drawn from the Hallow. Equip it to endure what swings back.',
  trinket: 'A small worn thing with a long memory. Equip it for what it quietly adds.',
  potion: 'A flask that refills between descents. Equip it to carry a way out.',
  sigil: 'Bound words that answer when read aloud. Equip it to carry a spell.',
  legacy: 'An early relic of the Hallow, from before the vaults were catalogued.',
};

/** One metadata document: SIP-16 shaped, wallet-facing, mechanically inert. */
function documentFor(spec, tier) {
  const vector = archetypeBonusVector(spec.slug, tier);
  const stem = lootFileStem(spec.slug, tier);
  const imageStem = ART_EXEMPT.has(spec.slug) ? FALLBACK_IMAGE_STEM : stem;
  return {
    // No token id: one document is shared by every token of this (archetype,
    // tier), because the uri is chosen before `mint` assigns an id and cannot be
    // rewritten afterwards. `lootDisplayName` adds "#17" in our own UI, where the
    // id is known; a wallet shows the shared name.
    name: lootDisplayName(spec.slug, tier),
    description: FAMILY_BLURB[spec.family] ?? FAMILY_BLURB.legacy,
    image: `ipfs://${IMAGE_CID}/${imageStem}.${EXT}`,
    attributes: [
      { trait_type: 'Archetype', value: spec.noun },
      { trait_type: 'Family', value: spec.family },
      { trait_type: 'Rarity', value: archetypeTierName(tier) },
      { trait_type: 'Tier', value: tier },
      ...attributesFor(vector),
    ],
    properties: {
      // The parse key. A reader wanting to know what this token IS should take it
      // from the uri (`parseLootUri`), exactly as the game does; this field is a
      // convenience for explorers, and is generated from the same stem so the two
      // cannot disagree.
      archetype: spec.slug,
      tier,
      collection: 'GrimHallow Loot',
      archetypeVersion: LOOT_ARCHETYPE_VERSION,
    },
  };
}

const { imageCid, outDir, ext } = parseArgs(process.argv.slice(2));
assertCidShape(imageCid);
const IMAGE_CID = imageCid;
const EXT = ext || 'jpg';

await mkdir(outDir, { recursive: true });

let written = 0;
const stems = new Set();
for (const spec of LOOT_ARCHETYPES) {
  for (let tier = 1; tier <= MAX_POWER_UP_TIER; tier++) {
    const stem = lootFileStem(spec.slug, tier);
    if (stems.has(stem)) {
      // Two archetypes resolving to one filename would silently overwrite, and
      // the loser's tokens would all resolve to the winner's document — after
      // being minted against uris that can never be corrected.
      console.error(`Duplicate stem "${stem}" — two archetypes share a filename. Aborting.`);
      process.exit(1);
    }
    stems.add(stem);
    const path = resolve(outDir, `${stem}.json`);
    await writeFile(path, `${JSON.stringify(documentFor(spec, tier), null, 2)}\n`, 'utf8');
    written++;
  }
}

const artBearing = LOOT_ARCHETYPES.filter((s) => !ART_EXEMPT.has(s.slug)).length;
console.log(`Wrote ${written} documents to ${outDir}`);
console.log(`  images referenced: ipfs://${IMAGE_CID}/<stem>.${EXT}`);
console.log(`  the image directory must contain ${artBearing * MAX_POWER_UP_TIER} tiered files`);
console.log(`  plus ${FALLBACK_IMAGE_STEM}.${EXT} for the legacy archetype`);
console.log('');
console.log('Next: pin this directory, then set LOOT_METADATA_CID in');
console.log('  packages/shared/src/lootArchetypes.ts');
console.log('Until then lootUriFor() throws by design and nothing can mint.');


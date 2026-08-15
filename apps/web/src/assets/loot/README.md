# Loot art (`{archetype}-tier-{n}.jpg`)

Item art for loot NFTs (`character-loot-nft`). One image per `(archetype, tier)`
pair — **48 files total**. The web app binds whatever JPGs are present here at
build time (`src/lib/lootArt.ts` via `import.meta.glob`), so:

- **Adding a correctly-named file makes that item live** — no code change.
- **A missing file falls back cleanly** — the item shows the generic loot
  placeholder until the art lands. The folder may ship empty.

## The filename is not just a filename

Unlike portraits, these stems are **also on chain**. A loot token's uri is
`ipfs://<CID>/{archetype}-tier-{n}.json`, and that document's `image` field points
at `{archetype}-tier-{n}.jpg` in the pinned image directory. So the same stem names
three things:

| where | file |
|---|---|
| this folder (bundled into the web app) | `sword-tier-4.jpg` |
| the pinned **image** directory on IPFS | `sword-tier-4.jpg` |
| the pinned **metadata** directory on IPFS | `sword-tier-4.json` |

All three come from `lootFileStem()` in `packages/shared/src/lootArchetypes.ts`.
**Do not rename a file here without renaming it everywhere** — the pinned copies
are what a wallet reads, and a token's uri is written once inside `mint` and is
**immutable for life** (no setter, no base-uri, and `burn` is `contract-caller`-
gated so the holder cannot even destroy a broken token).

## Tier 1 is the fallback, but every tier is a real file

There are four tiers: `1` rare, `2` epic, `3` mythic, `4` legendary. All four get
their own art. While the set is incomplete, an archetype that has only
`-tier-1.jpg` shows that image at every tier (`LOOT_ART_FLOOR_TIER`), so a partly
produced set looks like a sword at the wrong rarity rather than like a generic
placeholder. The fallback is **per archetype** — an axe with no art will never
borrow the sword's.

## `relic` has no art, on purpose

`relic` is the legacy archetype. Every loot token minted before this feature —
including mainnet loot token #1, held by a real player — parses to `relic`, and it
keeps **today's generic loot picture** for the same reason it keeps today's stat
table: nothing already in someone's wallet changes because we shipped a feature.

This is enforced in code (`LOOT_ART_EXEMPT`), not by the folder being empty. A
`relic-tier-*.jpg` dropped in here is ignored.

## Filenames (exact — lowercase, hyphen, `.jpg`)

Twelve art-bearing archetypes × four tiers:

```
sword-tier-1.jpg       axe-tier-1.jpg         dagger-tier-1.jpg      warhammer-tier-1.jpg
sword-tier-2.jpg       axe-tier-2.jpg         dagger-tier-2.jpg      warhammer-tier-2.jpg
sword-tier-3.jpg       axe-tier-3.jpg         dagger-tier-3.jpg      warhammer-tier-3.jpg
sword-tier-4.jpg       axe-tier-4.jpg         dagger-tier-4.jpg      warhammer-tier-4.jpg

helm-tier-1.jpg        chestplate-tier-1.jpg  boots-tier-1.jpg       ring-tier-1.jpg
helm-tier-2.jpg        chestplate-tier-2.jpg  boots-tier-2.jpg       ring-tier-2.jpg
helm-tier-3.jpg        chestplate-tier-3.jpg  boots-tier-3.jpg       ring-tier-3.jpg
helm-tier-4.jpg        chestplate-tier-4.jpg  boots-tier-4.jpg       ring-tier-4.jpg

amulet-tier-1.jpg      talisman-tier-1.jpg    elixir-tier-1.jpg      tome-tier-1.jpg
amulet-tier-2.jpg      talisman-tier-2.jpg    elixir-tier-2.jpg      tome-tier-2.jpg
amulet-tier-3.jpg      talisman-tier-3.jpg    elixir-tier-3.jpg      tome-tier-3.jpg
amulet-tier-4.jpg      talisman-tier-4.jpg    elixir-tier-4.jpg      tome-tier-4.jpg
```

The stem is matched case-insensitively and both `.jpg` and `.jpeg` are accepted,
but keep filenames lowercase `.jpg` to match the rest of the repo. Any file not
matching a `{archetype}-tier-{n}` stem is ignored.

## What each archetype is

| archetype | family | reads as |
|---|---|---|
| `sword` | blade | bigger dice — a clean, escalating blade |
| `axe` | blade | more dice — heavy, chopping, brutal |
| `dagger` | blade | damage + evasion — quick, light, poisoned |
| `warhammer` | blade | pure die-size — massive, crushing, slow |
| `helm` | armour | defense + a little health |
| `chestplate` | armour | health above all — the tank piece |
| `boots` | armour | defense/evasion — speed, not bulk |
| `ring` | trinket | flat damage + defense |
| `amulet` | trinket | health + damage — worn, arcane |
| `talisman` | trinket | die-size + defense — a ward, a charm |
| `elixir` | potion | **grants a heal** — a flask, visibly drinkable |
| `tome` | sigil | **grants an attack spell** — a book, a scroll, a sigil |

`elixir` and `tome` are consumable-*looking* but are **not consumed**: they carry
per-run charges and recharge between runs. Art should read as reusable — a corked
flask that refills, a book that stays on the belt — rather than as a single-use
item, so the mechanic is not misread from the picture.

## Art direction notes

- Loot renders as a **square card** on the reward screen and as a small square
  thumbnail in the inventory and loadout picker. Compose for a centred subject on
  a dark ground — there is no gradient overlay to hide behind, unlike portraits.
- The card border is **tier-coloured** (`src/lib/tierStyle.ts`): rare→blue,
  epic→void-purple, mythic→blood-red, legendary→gold. Art that escalates with the
  border reads best — more ornament, more glow, more gold at higher tiers.
- The reward screen shows this image **immediately after a win**, at the largest
  size it is ever displayed. It is the payoff frame; treat tier 4 accordingly.
- Keep the twelve archetypes silhouette-distinct at thumbnail size. A player
  scanning an inventory should tell a talisman from an amulet without reading.

## Pinning (operator)

Both directories are pinned as **directories**, so every URI shares one CID
prefix. Order matters:

1. Pin the **image** directory → gives you `<IMAGE_CID>`.

   That directory needs **49 files**: the 48 tiered ones listed above, plus one
   `relic.jpg`. The extra file is not art for this folder — the web bundle ignores
   `relic` art (`LOOT_ART_EXEMPT`) — it exists because all four `relic-tier-N.json`
   documents point their `image` at `ipfs://<IMAGE_CID>/relic.jpg`. Omit it and a
   legacy-shaped token resolves to a real document with a dead image. Use today's
   generic loot picture, so a `relic` keeps the image it was earned with.
2. Generate the 52 metadata documents with
   `npm run loot-metadata -- --image-cid <IMAGE_CID>` (add `--out <dir>` to override
   the default `build/loot-metadata/`). 52, not 48: `relic` gets metadata so
   legacy-shaped tokens resolve, but no new art.
3. Pin the **metadata** directory → gives you `<METADATA_CID>`.
4. Set `LOOT_METADATA_CID` in `packages/shared/src/lootArchetypes.ts`.

Until step 4, `lootUriFor()` **throws by design** — nothing can mint an archetype
URI against an unpinned CID, because that token would be permanently broken.

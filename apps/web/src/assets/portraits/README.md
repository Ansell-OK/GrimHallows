# Character portraits (`{class}-{rarity}.jpg`)

Portrait art for our own **minted** characters (`character-nft`). One image per
`(class, portrait-tier)` pair — **16 files total**. The web app binds whatever
JPGs are present here at build time (`src/lib/portraits.ts` via
`import.meta.glob`), so:

- **Adding a correctly-named file makes that portrait live** — no code change.
- **A missing file falls back cleanly** — the mint shows its existing NFT image
  or the class-icon placeholder until the art lands. The folder may ship empty.

## Rare is the base layer

There are only **four portrait tiers**: `rare`, `epic`, `legendary`, `mythic`.
There is **no `common` or `uncommon` portrait** — those lower tiers show the
**`rare`** art. So the displayed tier is `max(rarity, 'rare')`: a fresh Common
mint looks Rare, and only epic/legendary/mythic have their own distinct art.

Rarity still drives stats across all six tiers (`common`…`mythic`); this clamp is
purely *which of the four portraits to show*. See `portraitRarity()` in
`src/lib/portraits.ts`.

## Why only mints

The eight supported collections (Bitcoin Pepe, Leo Cats, …) keep their own native
NFT art. Portraits are resolved **only** for `classSource === 'mint'`, because
those are the characters whose class we control and whose look should track
rarity. A `character-nft` mint's portrait **swaps as its rarity climbs** with the
holder's tenure (the stats-v4 hold-to-improve rule), which is why the art is keyed
on rarity and resolved per render rather than baked into the token.

## Filenames (exact — lowercase, hyphen, `.jpg`)

Classes: `warrior`, `paladin`, `rogue`, `mage`
Portrait tiers: `rare`, `epic`, `legendary`, `mythic`

```
warrior-rare.jpg       paladin-rare.jpg       rogue-rare.jpg       mage-rare.jpg
warrior-epic.jpg       paladin-epic.jpg       rogue-epic.jpg       mage-epic.jpg
warrior-legendary.jpg  paladin-legendary.jpg  rogue-legendary.jpg  mage-legendary.jpg
warrior-mythic.jpg     paladin-mythic.jpg     rogue-mythic.jpg     mage-mythic.jpg
```

The stem is matched case-insensitively and both `.jpg` and `.jpeg` are accepted,
but keep filenames lowercase `.jpg` to match the rest of the repo. Any file not
matching a `{class}-{rarity}` stem is ignored.

## Art direction notes

- Card art renders at **256×384** (`w-64 h-96`) behind a bottom-up obsidian
  gradient and at ~70% opacity, so the **lower third is largely obscured** by the
  name/stats overlay — keep the focal point in the upper two-thirds.
- Higher rarities read against warmer/brighter card borders
  (rare→blue, epic→void-purple, legendary→gold, mythic→blood-red — Common and
  Uncommon reuse the rare portrait); portraits that escalate visually with rarity
  reinforce the progression.

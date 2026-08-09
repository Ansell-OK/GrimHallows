/**
 * Character derivation service.
 *
 * Turns "what does this wallet hold on chain?" into "what characters can this
 * player field?", by applying the shared, versioned `deriveCharacter` to each
 * *eligible* token the wallet holds.
 *
 * ELIGIBILITY IS A HARD FILTER, NOT A PREFERENCE. Exactly two kinds of token
 * survive it:
 *
 *   - one of the eight curated collections in `SUPPORTED_CLASS_CONTRACTS`
 *     (`packages/shared/src/classes.ts`), which is where its class comes from;
 *   - one of our own `character-nft` mints, whose class was chosen by the player
 *     and written on chain.
 *
 * Everything else in the wallet is simply not returned. There is no fallback
 * class and no "unlisted but playable" tier: an unrecognised collection is
 * absent from `GET /characters`, not present with a generic archetype. This
 * replaced the earlier rule (any SIP-009 token was playable, with a hashed
 * class for unlisted ones), and the two are not layered — the hash path is
 * deleted, so there is nothing left to fall back to.
 *
 * Two things it still does not do, both deliberate:
 *
 *   - It does not treat metadata as authoritative. Under stats-v3 metadata is
 *     out of the power path entirely: class comes from a curated allowlist or
 *     the chain (for minted characters), rarity from the current holder's tenure,
 *     and the base spread from hash(contractId || tokenId). Metadata adds only a
 *     small bounded per-stat bonus (01-game-design.md#4c), so a rewritten JSON
 *     file cannot mint a god character.
 *   - It does not cache rarity or stats. Those depend on who holds the token and
 *     reset on transfer, so they are computed per request — see the header of
 *     `repos/characters.ts` for why caching them under a holder-independent key
 *     would be a correctness bug rather than an optimisation.
 *
 * Power-up NFTs from our own collection are excluded — they are equippable
 * items, not characters (01-game-design.md#8). That exclusion is now implied by
 * the allowlist (loot is not in it), and kept explicit because "loot is not a
 * character" should not depend on a table it was never in.
 */

import {
  CONTRACT_NAMES,
  STATS_ALGO_VERSION,
  contractId as buildContractId,
  deriveCharacter as deriveCharacterCore,
  isSupportedCollection,
  UnsupportedCollectionError,
  type CharacterIdentity,
  type DerivedCharacter,
  type HolderAge,
  type NetworkConfig,
} from '@grimhallow/shared';
import { gatewayUrl } from '../lib/contentUrl.js';
import type { ChainClient, NftHolding, TokenMetadata } from '../lib/hiro.js';
import type { CharacterCache } from '../repos/characters.js';
import type { CharacterMintService } from './characterMintService.js';
import type { MintSeedService } from './mintSeedService.js';
import { UNKNOWN_HOLDER_AGE, holdingKey, type HolderAgeService } from './holderAgeService.js';

/** Bound on concurrent metadata fetches, to stay friendly to Hiro's limits. */
const METADATA_CONCURRENCY = 6;

function displayName(metadata: TokenMetadata | null, holding: NftHolding): string {
  const fromMetadata = metadata?.name?.trim();
  if (fromMetadata) return fromMetadata;
  // Fall back to something recognisable rather than an empty card.
  const collection = holding.assetName.replace(/[-_]+/g, ' ').trim();
  return `${collection || 'Character'} #${holding.tokenId}`;
}

/**
 * The URL a browser should load for a token's art, or null if there isn't one.
 *
 * NULL RATHER THAN THE RAW VALUE is the point of this function. Handing back a
 * scheme no browser can fetch produces an `<img>` that fails after the page has
 * already committed to showing one — the card renders empty and the player is
 * told nothing. A null is a decision: the caller shows the class-icon
 * placeholder instead, which at least looks deliberate.
 *
 * Preference order, and why `cached_image` wins: Hiro only populates it when its
 * metadata service successfully fetched and cached the art, so it is https, on a
 * CDN, and known-good. `image` is the collection's own value and is usually a
 * gateway round trip away from being loadable. The trade is that Hiro's copy can
 * lag a token whose art was replaced — acceptable for display, and the frontend
 * now falls back loudly if it ever 404s.
 */
export function resolveImage(metadata: TokenMetadata | null): string | null {
  const cached = metadata?.cached_image?.trim();
  if (cached && cached.toLowerCase().startsWith('https://')) return cached;

  const raw = metadata?.image?.trim();
  if (!raw) return null;

  // Already bytes — no host, no gateway, nothing to resolve. Checked before
  // `gatewayUrl`, which has no notion of `data:` and would refuse it. Safe in an
  // <img>: script inside an SVG does not execute when loaded as an image.
  if (raw.toLowerCase().startsWith('data:image/')) return raw;

  return gatewayUrl(raw);
}

/**
 * The holder-independent half: name, image, class.
 *
 * `mintedClassId` is the on-chain class for our own `character-nft` tokens. It
 * is holder-independent too — the player chose it at mint and it does not move
 * with the token — so it belongs on this side of the split.
 */
export function deriveIdentity(
  holding: NftHolding,
  metadata: TokenMetadata | null,
  mintedClassId: string | null = null,
): CharacterIdentity {
  const core = deriveCharacterCore({
    contractId: holding.contractId,
    tokenId: holding.tokenId,
    metadata,
    mintedClassId,
  });

  return {
    contractId: holding.contractId,
    tokenId: holding.tokenId,
    name: displayName(metadata, holding),
    imageUrl: resolveImage(metadata),
    classId: core.classId,
    className: core.className,
    classSource: core.classSource,
    algoVersion: STATS_ALGO_VERSION,
  };
}

/**
 * Identity + this holder's tenure -> the full character.
 *
 * `charClass`/`rarity` are published alongside `classId`/`rarityTier` as
 * deprecated aliases for the web app (04-backend-api-spec.md#2). They are read
 * off the same `deriveCharacter` result, so they are two names for one value and
 * cannot disagree — which is the only version of an alias worth shipping.
 *
 * `mintSeed` is the mint block's hash for one of our own tokens, and null for
 * everything else — including one of ours whose mint has not confirmed yet. Null
 * means no rarity floor at all rather than a guessed one (stats.ts
 * `effectiveRarity`), so a token briefly reads at its tenure tier and then
 * corrects upward once the seed resolves.
 */
export function withHolderAge(
  identity: CharacterIdentity,
  metadata: TokenMetadata | null,
  age: HolderAge,
  mintedClassId: string | null = null,
  mintSeed: string | null = null,
): DerivedCharacter {
  const core = deriveCharacterCore({
    contractId: identity.contractId,
    tokenId: identity.tokenId,
    metadata,
    holdDays: age.holdDays,
    mintedClassId,
    mintSeed,
  });

  return {
    contractId: identity.contractId,
    tokenId: identity.tokenId,
    name: identity.name,
    imageUrl: identity.imageUrl,

    classId: core.classId,
    className: core.className,
    classSource: core.classSource,

    holdDays: core.holdDays,
    rarityTier: core.rarityTier,

    charClass: core.classId,
    rarity: core.rarityTier,

    stats: core.stats,
    algoVersion: core.algoVersion,
  };
}

export interface CharacterServiceDeps {
  readonly chain: ChainClient;
  readonly cache: CharacterCache;
  readonly stacks: NetworkConfig;
  readonly holderAge: HolderAgeService;
  /**
   * Resolves the on-chain class of our own `character-nft` tokens. Optional so
   * existing callers and tests that never mint one need not supply it — but
   * without it those tokens have no class at all, since they are deliberately
   * not in the curated allowlist, and are dropped from the character list
   * rather than given a made-up one. Any deployment that sells mints must
   * supply it.
   */
  readonly characterMint?: CharacterMintService;
  /**
   * Resolves the mint block hash that seeds a minted token's rarity floor.
   *
   * Optional on the same terms as `characterMint`, and with a gentler failure: a
   * deployment without it derives our own mints with no floor rather than dropping
   * them, since a floor is a bonus on top of tenure and its absence is the degrade
   * the derivation already handles. Any deployment that sells mints should supply
   * it, or every mint reads as Common on day one.
   */
  readonly mintSeeds?: MintSeedService;
}

export class CharacterService {
  constructor(private readonly deps: CharacterServiceDeps) {}

  /** Our own loot collection — items, not characters. */
  private get lootContractId(): string {
    return buildContractId(this.deps.stacks, 'characterLootNft');
  }

  /** Our own character collection — the one whose class is stored, not derived. */
  private get characterContractId(): string {
    return buildContractId(this.deps.stacks, 'characterNft');
  }

  /**
   * Is this holding something we can build a character from at all?
   *
   * The whole eligibility rule, in one place. `isSupportedCollection` covers the
   * eight curated collections; our own mints are checked separately because
   * their class is on chain rather than in that table, and the loot exclusion is
   * kept explicit even though the allowlist already implies it.
   */
  private isEligible(holding: NftHolding): boolean {
    if (holding.contractId === this.lootContractId) return false;
    return (
      isSupportedCollection(holding.contractId) || holding.contractId === this.characterContractId
    );
  }

  async listForAddress(address: string): Promise<DerivedCharacter[]> {
    const holdings = await this.deps.chain.getNftHoldings(address);
    const characterHoldings = holdings.filter((h) => this.isEligible(h));

    // Resolved for the whole wallet at once so block-timestamp lookups dedupe
    // across tokens acquired in the same transaction. A total failure here still
    // yields a map of `fallback_pending`, never an exception.
    const ages = await this.deps.holderAge
      .forHoldings(address, characterHoldings)
      .catch(() => new Map<string, HolderAge>());

    const results: DerivedCharacter[] = [];
    for (let i = 0; i < characterHoldings.length; i += METADATA_CONCURRENCY) {
      const batch = characterHoldings.slice(i, i + METADATA_CONCURRENCY);
      results.push(
        ...(await Promise.all(batch.map((h) => this.deriveOne(h, ages)))).filter(
          (c): c is DerivedCharacter => c !== null,
        ),
      );
    }

    // Stable ordering so the character grid doesn't reshuffle between reloads.
    return results.sort(
      (a, b) => a.contractId.localeCompare(b.contractId) || Number(a.tokenId) - Number(b.tokenId),
    );
  }

  /**
   * Derive one holding, or null if it turns out to have no class after all.
   *
   * The only way past `isEligible` and still null is one of our own mints whose
   * on-chain class could not be read — no `characterMint` dependency, or a chain
   * call that failed. Dropping the token is the honest answer there: we know it
   * is a character but not which one, and inventing a class to fill the gap is
   * the fallback this delta removed.
   */
  private async deriveOne(
    holding: NftHolding,
    ages: ReadonlyMap<string, HolderAge>,
  ): Promise<DerivedCharacter | null> {
    try {
      return await this.deriveOneOrThrow(holding, ages);
    } catch (err) {
      if (err instanceof UnsupportedCollectionError) return null;
      throw err;
    }
  }

  private async deriveOneOrThrow(
    holding: NftHolding,
    ages: ReadonlyMap<string, HolderAge>,
  ): Promise<DerivedCharacter> {
    const age = ages.get(holdingKey(holding.contractId, holding.tokenId)) ?? UNKNOWN_HOLDER_AGE;

    // Resolved on both the cache-hit and cache-miss paths, and deliberately NOT
    // stored in `character_stats_cache`. That table's rows are shared across
    // wallets and live for hours; the seed has its own permanent, write-once table
    // (`nft_mint_seeds`) whose whole point is that the value never moves. Reading
    // it here costs one indexed query per minted token once resolved, and keeps
    // the two caches answering the questions they are each keyed for.
    const mintSeed = await this.resolveMintSeed(holding);

    const cached = await this.deps.cache
      .get(holding.contractId, holding.tokenId, STATS_ALGO_VERSION)
      .catch(() => null);
    // The cached identity already carries the resolved class, including a minted
    // one — a token's class is fixed at mint and does not move with the token,
    // so it is as cacheable as its name. It has to be handed back to
    // `withHolderAge` explicitly, though: that function re-derives from
    // (contract, token) rather than trusting the identity it is given, so
    // dropping it here would leave a bought class with nothing to resolve from.
    if (cached) {
      const cachedMintedClass =
        cached.identity.classSource === 'mint' ? cached.identity.classId : null;
      return withHolderAge(cached.identity, cached.metadata, age, cachedMintedClass, mintSeed);
    }

    // Only our own collection has a class to look up; a curated-collection token
    // resolves from the allowlist and should not cost a chain call to find that
    // out. Returns null on any failure, which drops the token — see `deriveOne`.
    const mintedClassId =
      holding.contractId === this.characterContractId
        ? await (this.deps.characterMint?.mintedClass(holding.tokenId) ?? Promise.resolve(null))
        : null;

    const metadata = await this.deps.chain.getTokenMetadata(holding.contractId, holding.tokenId);
    const identity = deriveIdentity(holding, metadata, mintedClassId);

    // A cache write failure must not fail the request: the derivation is pure,
    // so the answer is already correct without it.
    await this.deps.cache.put({ identity, metadata }).catch(() => {});
    return withHolderAge(identity, metadata, age, mintedClassId, mintSeed);
  }

  /**
   * The mint-block seed for one of our own tokens, or null.
   *
   * Null for a curated-collection token by construction — they have no floor —
   * and null for one of ours whose mint the indexer has not surfaced yet, which
   * derives at its tenure tier until it does. Swallows failures for the same
   * reason `deriveOne` degrades rather than throwing: no floor is a character
   * served slightly weak, while an exception here is a character-select screen
   * that does not render at all.
   */
  private async resolveMintSeed(holding: NftHolding): Promise<string | null> {
    if (holding.contractId !== this.characterContractId) return null;
    if (!this.deps.mintSeeds) return null;
    return this.deps.mintSeeds
      .forToken(holding.contractId, holding.tokenId)
      .catch(() => null);
  }
}

/** Names of contracts this service considers "ours" rather than a character. */
export const OWN_COLLECTIONS = [CONTRACT_NAMES.characterLootNft] as const;

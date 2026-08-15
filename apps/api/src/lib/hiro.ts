/**
 * Hiro Stacks API client — chain reads only.
 *
 * This module never signs and never writes. It answers three questions:
 * which NFTs an address holds, what a token's metadata says, and what a
 * read-only contract function returns. Everything it returns is a fact about
 * the chain, restated; nothing it returns is a claim this backend originated.
 *
 * Note on trust: NFT holdings come from Hiro's index, which can lag a block or
 * be temporarily unavailable. That is acceptable for *display* (which character
 * cards to show). It is NOT acceptable as an ownership gate on anything that
 * moves money — those checks live in the contracts, where they cannot lag.
 */

import {
  ClarityType,
  hexToCV,
  cvToValue,
  serializeCV,
  uintCV,
  type ClarityValue,
} from '@stacks/transactions';
import { gatewayUrl, substituteTokenId } from './contentUrl.js';
import { upstreamUnavailable } from './errors.js';
import { assertProxyableUrl } from './imageProxy.js';

export interface NftHolding {
  /** e.g. `SP2X0T....my-nfts::my-nft` */
  readonly assetIdentifier: string;
  /** e.g. `SP2X0T....my-nfts` */
  readonly contractId: string;
  /** Asset (token class) name after the `::`. */
  readonly assetName: string;
  readonly tokenId: string;
  readonly blockHeight: number | null;
  readonly txId: string | null;
}

export interface TokenMetadata {
  readonly name?: string;
  readonly image?: string;
  /**
   * Hiro's own https copy of `image`, present when its metadata service managed
   * to fetch and cache the art.
   *
   * Worth preferring over `image` for display: `image` is routinely `ipfs://` or
   * `ar://`, which no browser can fetch, and the public gateways those rewrite to
   * are slow and rate-limited. This is already https, already on a CDN, and
   * already known-good — Hiro only fills it in if the fetch succeeded.
   *
   * Snake_case because it is Hiro's wire field passed straight through, the same
   * way `trait_type` is SIP-16's.
   */
  readonly cached_image?: string;
  readonly attributes?: readonly { readonly trait_type?: string; readonly value?: unknown }[];
}

/**
 * A contract-call transaction as the chain reports it.
 *
 * Deliberately narrow: only the fields needed to decide whether a claimed
 * `enter-dungeon` really happened, who really paid, and what run id the
 * contract really assigned. Everything here is the chain's account of events,
 * not the client's — a claim arrives with a txid and nothing else, and every
 * fact about it is read back from here.
 */
export interface ChainTransaction {
  readonly txId: string;
  /** `pending` | `success` | `abort_by_response` | `abort_by_post_condition` | … */
  readonly txStatus: string;
  readonly txType: string;
  readonly senderAddress: string;
  readonly contractId: string | null;
  readonly functionName: string | null;
  /** Hex-encoded Clarity repr of each argument, in order. */
  readonly functionArgsRepr: readonly string[];
  /** Clarity repr of the call's return value, e.g. `(ok u7)`. Null while pending. */
  readonly resultRepr: string | null;
  /**
   * Events the transaction emitted, in order.
   *
   * Carried because a `print` is how a Clarity function reports what it actually
   * did, and for `enter-dungeon` that includes the gate fee it charged. Reading
   * the fee from a later `get-dungeon` call instead would record whatever the fee
   * is *now* against a payment made under the old one — a wrong number in a
   * column whose whole purpose is to say what the operator was paid.
   */
  readonly events: readonly ChainEvent[];
  readonly blockHeight: number | null;
}

/** One emitted event. Only `print` logs and STX moves are modelled. */
export interface ChainEvent {
  /** e.g. `smart_contract_log`, `stx_asset`. */
  readonly eventType: string;
  readonly contractId: string | null;
  /**
   * Hex-encoded Clarity value of a `print`, decodable with `hexToCV`.
   *
   * Hex rather than the repr string beside it: a repr has to be parsed with a
   * regex, and a regex over a tuple of money is a bug waiting for an unexpected
   * field ordering. Null for an event that carries no Clarity value.
   */
  readonly valueHex: string | null;
  /**
   * The STX that actually moved, on an `stx_asset` transfer event.
   *
   * Carried alongside the print rather than instead of it because the two answer
   * different questions. The print says what the contract *charged*; this says
   * what the operator was *paid*. They agree on every ordinary entry, and
   * disagree on one real case: `transfer-gate-fee` skips the transfer when the
   * entrant is the contract owner (`stx-transfer?` rejects paying yourself), so
   * an owner's own entry prints the full gate fee and moves nothing. Recording
   * the printed number there would credit the operator with revenue that never
   * left their wallet.
   *
   * Null for any event that is not an STX transfer.
   */
  readonly stxTransfer: StxTransfer | null;
}

/** An STX movement within a transaction, as the chain reports it. */
export interface StxTransfer {
  /** `transfer` | `mint` | `burn`. */
  readonly assetEventType: string;
  readonly sender: string | null;
  readonly recipient: string | null;
  /** microSTX, as a decimal string — money never goes through a JS number. */
  readonly amountUstx: string;
}

/**
 * The block a token was minted in.
 *
 * Both fields are permanent facts about a token, which is what makes this
 * cacheable forever (`nft_mint_seeds`). The hash is the value the rarity floor is
 * seeded with; the height is carried alongside it so a stored seed can be traced
 * back to a block a human can look up, and so a bad row is recognisable rather
 * than being an opaque hex string.
 */
export interface MintBlock {
  readonly height: number;
  /** `0x`-prefixed, as Hiro serializes it. Normalized again before it is hashed. */
  readonly hash: string;
}

export interface ChainClient {
  getPrimaryName?(address: string): Promise<string | null>;
  /** Spendable STX balance in microSTX, as a decimal string. */
  getStxBalance?(address: string): Promise<string>;
  getNftHoldings(address: string): Promise<NftHolding[]>;
  /**
   * Burn-block timestamp for a height, in unix seconds. Null if unknown.
   *
   * The half of the rarity calculation that is permanently cacheable: a mined
   * block's timestamp never changes, and every token acquired in that block
   * shares it. See `block_timestamps` in 05-data-model.md.
   */
  getBlockTimestamp(blockHeight: number): Promise<number | null>;
  /**
   * The block at which `owner` most recently acquired a token — the fallback
   * path for when a holdings entry arrives without `block_height`.
   *
   * "Most recently" is the whole point. Rarity measures the *current* holder's
   * tenure and resets on transfer (01-game-design.md#4b), so a wallet that
   * bought, sold and re-bought the same token must date from the re-buy. Walking
   * to the earliest matching event instead would hand it back the tenure it
   * gave up when it sold.
   *
   * Null when no acquiring event is found, which the caller degrades to
   * `fallback_pending` rather than treating as an error.
   */
  getNftAcquisitionBlock(params: {
    assetIdentifier: string;
    tokenId: string;
    owner: string;
  }): Promise<number | null>;
  /**
   * The block that MINTED a token, with its hash — the seed for the mint-rarity
   * floor (`packages/shared/src/rarity.ts`, `mintFloorFromSeed`).
   *
   * The mirror image of `getNftAcquisitionBlock` in the one way that matters:
   * that one wants the NEWEST event because tenure belongs to the current holder,
   * and this one wants the OLDEST because a mint happens once. They are separate
   * methods rather than one with a flag because they also cache differently —
   * this answer is immutable and permanently cacheable, while an acquisition block
   * moves on every transfer.
   *
   * WHY THE HASH AND NOT THE HEIGHT OR THE TXID. All three identify the mint, and
   * only the hash is unguessable when the mint is signed. Heights are enumerable
   * ahead of time, and a txid is chosen by the minter — they build and sign the
   * transaction, so they can grind its nonce until the resulting floor comes up
   * Rare, which is the precompute this seed exists to close. A block hash is
   * fixed by whoever mines the block, after the transaction is already committed.
   *
   * Null when the mint cannot be established — an unconfirmed mint, a token that
   * does not exist, an unreachable Hiro. The caller serves the token with no floor
   * and retries later (stats.ts `effectiveRarity`); it must never substitute a
   * seed of its own, because a guessed floor is one that changes when the real
   * seed arrives.
   */
  getNftMintBlock(params: {
    assetIdentifier: string;
    tokenId: string;
  }): Promise<MintBlock | null>;
  getTokenMetadata(contractId: string, tokenId: string): Promise<TokenMetadata | null>;
  callReadOnly(params: {
    contractId: string;
    functionName: string;
    functionArgsHex?: readonly string[];
    sender?: string;
  }): Promise<ClarityValue>;
  /** Null when the node has never heard of the txid. */
  getTransaction(txId: string): Promise<ChainTransaction | null>;
  /**
   * Transactions against a contract, newest first.
   *
   * This is the indexer's window onto chain history, and the reason it exists is
   * that a forge is a *user-signed* transaction: the player builds it from
   * `POST /forge`, signs it in their wallet and broadcasts it themselves, so the
   * backend never sees it happen. Asking the player's client to report its own
   * forges afterwards would make `highestForgeTier` a self-reported number —
   * exactly the "trusted database claim" that 01-game-design.md#8 says the
   * leaderboard must not be. So it is read back off chain instead.
   *
   * `functionName` filters client-side after fetching, because the Hiro endpoint
   * has no such filter; it narrows what the caller handles, not what is fetched.
   *
   * Events may be absent or truncated on list responses — Hiro paginates them
   * separately. Anything that needs a transaction's events must re-read it with
   * `getTransaction`.
   */
  listContractCalls(params: {
    contractId: string;
    functionName?: string;
    /** Stop paging once this many matching transactions have been collected. */
    limit?: number;
    /**
     * Stop paging as soon as one of these txids is seen.
     *
     * The indexer's watermark. Without it every pass would walk the contract's
     * entire history to rediscover rows it already has.
     */
    stopAtTxIds?: ReadonlySet<string>;
  }): Promise<ChainTransaction[]>;
  /** Broadcast a pre-signed transaction. Returns the txid. */
  broadcastRawTx(rawTxHex: string): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const HOLDINGS_PAGE_SIZE = 50;
/** Bound on pagination, so a whale wallet can't wedge a request handler. */
const MAX_HOLDINGS = 400;
const TX_PAGE_SIZE = 50;
/** One page is enough: the acquiring event we want is the newest matching one. */
const NFT_HISTORY_PAGE_SIZE = 50;
/** Bound on the indexer's backward walk through a contract's history. */
const MAX_TX_PAGES = 20;

/**
 * Deadline for the token-uri fallback's gateway fetch.
 *
 * Shorter than `DEFAULT_TIMEOUT_MS` on purpose. This is a best-effort second
 * attempt at *display* metadata, and it runs once per token in a wallet — a
 * public IPFS gateway that has decided to be slow must not be able to add ten
 * seconds per card to a character list that is already correct without it.
 */
const TOKEN_URI_FETCH_TIMEOUT_MS = 5_000;

/** Cap on a metadata JSON body. SIP-16 metadata is a few hundred bytes. */
const MAX_METADATA_BYTES = 256 * 1024;

/** `SP...contract::asset` → its parts, or null if it isn't that shape. */
export function parseAssetIdentifier(
  assetIdentifier: string,
): { contractId: string; assetName: string } | null {
  const [contractId, assetName] = assetIdentifier.split('::');
  if (!contractId || !assetName) return null;
  return { contractId, assetName };
}

/** Clarity `u123` repr → `123`. Returns null for anything else. */
export function parseTokenIdRepr(repr: string): string | null {
  const match = /^u(\d+)$/.exec(repr.trim());
  return match ? match[1] : null;
}

/**
 * A token id as the `?value=` filter on Hiro's NFT routes wants it: the
 * hex-serialized Clarity uint.
 *
 * Null for a non-numeric id. Both callers below query the same history route for
 * the same token, so they build the filter through one function — two spellings
 * of "serialize this token id" is two chances to query a different token than
 * the one asked about.
 */
function tokenIdValueHex(tokenId: string): string | null {
  try {
    return `0x${serializeCV(uintCV(BigInt(tokenId)))}`;
  } catch {
    return null;
  }
}

/** A transaction exactly as Hiro serializes it, on either the single or list route. */
interface HiroTxResponse {
  tx_id: string;
  tx_status: string;
  tx_type: string;
  sender_address: string;
  block_height?: number;
  contract_call?: {
    contract_id: string;
    function_name: string;
    function_args?: { hex: string; repr: string }[];
  };
  tx_result?: { repr: string };
  events?: {
    event_type: string;
    contract_log?: { contract_id: string; value?: { hex?: string } };
    asset?: {
      asset_event_type?: string;
      sender?: string;
      recipient?: string;
      amount?: string;
    };
  }[];
}

/**
 * Hiro's JSON → the narrow shape this codebase reasons about.
 *
 * One decoder for both `getTransaction` and `listContractCalls`, because the two
 * routes serve the same object and a second parser would be a second chance to
 * read a fee, a sender or a result differently from the first.
 */
function toChainTransaction(body: HiroTxResponse): ChainTransaction {
  return {
    txId: body.tx_id,
    txStatus: body.tx_status,
    txType: body.tx_type,
    senderAddress: body.sender_address,
    contractId: body.contract_call?.contract_id ?? null,
    functionName: body.contract_call?.function_name ?? null,
    functionArgsRepr: (body.contract_call?.function_args ?? []).map((a) => a.repr),
    resultRepr: body.tx_result?.repr ?? null,
    events: (body.events ?? []).map((e) => ({
      eventType: e.event_type,
      contractId: e.contract_log?.contract_id ?? null,
      valueHex: e.contract_log?.value?.hex ?? null,
      // Only STX events carry an amount worth reading here. A missing amount
      // on an event that claims to be one is left as null rather than
      // defaulted to zero: "no transfer" and "a transfer of nothing" are
      // different facts, and only one of them is a number.
      stxTransfer:
        e.event_type === 'stx_asset' && e.asset?.amount !== undefined
          ? {
              assetEventType: e.asset.asset_event_type ?? 'transfer',
              sender: e.asset.sender ?? null,
              recipient: e.asset.recipient ?? null,
              amountUstx: String(e.asset.amount),
            }
          : null,
    })),
    blockHeight: body.block_height ?? null,
  };
}

export class HiroChainClient implements ChainClient {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string = '',
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  private async fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.apiUrl.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    // Hiro rate-limits anonymous traffic hard; the key just raises the ceiling.
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw upstreamUnavailable(
        `Stacks API unreachable (${url}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.status === 404) {
      throw upstreamUnavailable(`Stacks API 404 for ${path}`);
    }
    if (!response.ok) {
      throw upstreamUnavailable(`Stacks API ${response.status} for ${path}`);
    }
    return (await response.json()) as T;
  }

  async getStxBalance(address: string): Promise<string> {
    const body = await this.fetchJson<{ stx?: { balance?: string } }>(
      `/extended/v1/address/${encodeURIComponent(address)}/balances`,
    );
    const balance = body.stx?.balance;
    if (typeof balance !== 'string' || !/^\d+$/.test(balance)) {
      throw upstreamUnavailable('Stacks API returned an invalid STX balance');
    }
    return balance;
  }

  async getPrimaryName(address: string): Promise<string | null> {
    const body = await this.fetchJson<{ names?: unknown }>(`/v1/addresses/stacks/${encodeURIComponent(address)}`);
    const names = Array.isArray(body.names) ? body.names.filter((name): name is string => typeof name === 'string') : [];
    return names[0] ?? null;
  }

  async getNftHoldings(address: string): Promise<NftHolding[]> {
    interface HoldingsPage {
      total: number;
      results: {
        asset_identifier: string;
        value: { repr: string; hex: string };
        block_height?: number;
        tx_id?: string;
      }[];
    }

    const holdings: NftHolding[] = [];
    let offset = 0;

    while (holdings.length < MAX_HOLDINGS) {
      const page = await this.fetchJson<HoldingsPage>(
        `/extended/v1/tokens/nft/holdings?principal=${encodeURIComponent(address)}` +
          `&limit=${HOLDINGS_PAGE_SIZE}&offset=${offset}`,
      );

      for (const entry of page.results ?? []) {
        const parsed = parseAssetIdentifier(entry.asset_identifier);
        const tokenId = parseTokenIdRepr(entry.value?.repr ?? '');
        // Non-uint token ids exist in the wild (some collections key by string
        // or tuple). They can't be fed to a uint-typed stat derivation, so skip
        // them rather than coerce something meaningless.
        if (!parsed || !tokenId) continue;

        holdings.push({
          assetIdentifier: entry.asset_identifier,
          contractId: parsed.contractId,
          assetName: parsed.assetName,
          tokenId,
          blockHeight: entry.block_height ?? null,
          txId: entry.tx_id ?? null,
        });
      }

      offset += HOLDINGS_PAGE_SIZE;
      if (!page.results?.length || offset >= (page.total ?? 0)) break;
    }

    return holdings;
  }

  async getBlockTimestamp(blockHeight: number): Promise<number | null> {
    if (!Number.isInteger(blockHeight) || blockHeight < 0) return null;

    interface BlockResponse {
      burn_block_time?: number;
      block_time?: number;
    }

    try {
      const body = await this.fetchJson<BlockResponse>(
        `/extended/v1/block/by_height/${blockHeight}`,
      );
      // `burn_block_time` is the Bitcoin anchor's timestamp and is the one that
      // exists on every Stacks version; `block_time` is a Nakamoto addition.
      // Prefer the anchor: it is what the chain agrees on.
      const seconds = body.burn_block_time ?? body.block_time;
      return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null;
    } catch {
      // A missing or unreachable block degrades the token to `fallback_pending`
      // (holdDays 0) rather than failing the character list — 02-architecture.md#4.
      return null;
    }
  }

  async getNftAcquisitionBlock(params: {
    assetIdentifier: string;
    tokenId: string;
    owner: string;
  }): Promise<number | null> {
    interface HistoryPage {
      results?: {
        recipient?: string;
        asset_event_type?: string;
        block_height?: number;
      }[];
    }

    const valueHex = tokenIdValueHex(params.tokenId);
    if (!valueHex) return null;

    try {
      const body = await this.fetchJson<HistoryPage>(this.nftHistoryPath(params.assetIdentifier, valueHex));

      // Hiro returns this newest-first, so the first match is the most recent
      // acquisition — see the interface note on why "most recent" is required
      // and not merely convenient.
      const acquiring = (body.results ?? []).find((e) => e.recipient === params.owner);
      return typeof acquiring?.block_height === 'number' ? acquiring.block_height : null;
    } catch {
      return null;
    }
  }

  /** One spelling of the history query, shared by both readers of it. */
  private nftHistoryPath(assetIdentifier: string, valueHex: string, offset = 0): string {
    const limit = offset === 0 ? NFT_HISTORY_PAGE_SIZE : 1;
    return (
      `/extended/v1/tokens/nft/history?asset_identifier=${encodeURIComponent(assetIdentifier)}` +
      `&value=${encodeURIComponent(valueHex)}&limit=${limit}&offset=${offset}`
    );
  }

  async getNftMintBlock(params: {
    assetIdentifier: string;
    tokenId: string;
  }): Promise<MintBlock | null> {
    const valueHex = tokenIdValueHex(params.tokenId);
    if (!valueHex) return null;

    try {
      const height = await this.findMintHeight(params.assetIdentifier, valueHex);
      if (height === null) return null;

      const hash = await this.getBlockHash(height);
      // A height with no readable hash is the same outcome as no mint at all:
      // there is no seed, so there is no floor yet. Returning the height alone
      // would invite a caller to seed the roll with something enumerable.
      return hash ? { height, hash } : null;
    } catch {
      return null;
    }
  }

  /**
   * The height of a token's mint event, walking to the OLDEST entry in its history.
   *
   * Hiro serves this route newest-first with a `total`, so the mint is the last
   * row rather than the first. When the history fits in one page that row is
   * already in hand; when it does not, `offset = total - 1` jumps straight to it
   * rather than paging through every transfer. Two requests at worst, whatever the
   * token's transfer count.
   *
   * The event is checked to actually BE a mint. A token whose history has been
   * truncated, or whose oldest visible event is a transfer, yields null — the
   * degrade — instead of seeding the floor from a transfer block, which would be
   * re-rollable by sending the token to yourself.
   */
  private async findMintHeight(assetIdentifier: string, valueHex: string): Promise<number | null> {
    interface HistoryPage {
      total?: number;
      results?: { asset_event_type?: string; block_height?: number }[];
    }

    const first = await this.fetchJson<HistoryPage>(this.nftHistoryPath(assetIdentifier, valueHex));
    const results = first.results ?? [];
    if (results.length === 0) return null;

    const total = typeof first.total === 'number' ? first.total : results.length;
    let oldest = results[results.length - 1];

    if (total > results.length) {
      const last = await this.fetchJson<HistoryPage>(
        this.nftHistoryPath(assetIdentifier, valueHex, total - 1),
      );
      const row = (last.results ?? [])[0];
      if (!row) return null;
      oldest = row;
    }

    if (oldest.asset_event_type !== 'mint') return null;
    return typeof oldest.block_height === 'number' ? oldest.block_height : null;
  }

  /**
   * The hash of a block, or null.
   *
   * `burn_block_hash` is preferred for the same reason `getBlockTimestamp` prefers
   * `burn_block_time`: it is the Bitcoin anchor, present on every Stacks version,
   * and the value the chain agrees on across a Stacks-side micro-reorg.
   * `index_block_hash` is accepted as a second choice because it is equally
   * unguessable at signing time — the security property holds on either — and a
   * resolved seed is stored permanently, so whichever field answered first for a
   * token keeps answering for it forever.
   */
  private async getBlockHash(blockHeight: number): Promise<string | null> {
    interface BlockResponse {
      burn_block_hash?: string;
      index_block_hash?: string;
    }

    const body = await this.fetchJson<BlockResponse>(`/extended/v1/block/by_height/${blockHeight}`);
    const hash = body.burn_block_hash ?? body.index_block_hash;
    return typeof hash === 'string' && /^(0x)?[0-9a-fA-F]{16,}$/.test(hash.trim()) ? hash.trim() : null;
  }

  /**
   * A token's display metadata, from Hiro's index or — failing that — the chain.
   *
   * WHY THERE IS A FALLBACK AT ALL. Hiro's metadata index is incomplete, and it
   * does not say so: an unindexed token answers `200 {}`, not 404. That is not a
   * rare edge either. Of the collections this game supports, `giga-pepe` is
   * absent entirely and `giga-pepe-v2` is indexed only up to roughly token 2000,
   * so a holder of #2135 got a card with no art and no explanation — which is
   * what sent this function looking for a second source.
   *
   * The second source is the chain itself, which is authoritative and complete:
   * `get-token-uri` is SIP-009 and every one of these collections implements it.
   * It costs a read-only call plus one gateway fetch, both of which land in
   * `character_stats_cache` behind the caller, so it happens once per token per
   * cache lifetime rather than once per page load.
   *
   * Still null on failure, in every path. Metadata is display-only here — stat
   * derivation is deliberately metadata-independent (`stats.ts`, anti-spoofing)
   * — so a token with none is a complete, playable character, and failing the
   * character list because a gateway was slow would be strictly worse than a
   * placeholder image.
   */
  async getTokenMetadata(contractId: string, tokenId: string): Promise<TokenMetadata | null> {
    interface MetadataResponse {
      token_uri?: string;
      metadata?: {
        name?: string;
        image?: string;
        cached_image?: string;
        attributes?: { trait_type?: string; value?: unknown }[];
      };
    }

    let indexed: TokenMetadata | null = null;
    try {
      const body = await this.fetchJson<MetadataResponse>(
        `/metadata/v1/nft/${encodeURIComponent(contractId)}/${encodeURIComponent(tokenId)}`,
      );
      indexed = body.metadata ?? null;
    } catch {
      // Unreachable or 404 — indistinguishable from unindexed at this point, and
      // both are answered the same way: try the chain.
      indexed = null;
    }

    // Present but imageless counts as a miss. The whole reason a caller wants
    // this is the picture, and an indexed row carrying only a name is exactly
    // the half-populated state Hiro leaves behind when its own fetch failed.
    if (indexed?.image || indexed?.cached_image) return indexed;

    const onChain = await this.metadataFromTokenUri(contractId, tokenId);
    if (!onChain) return indexed;
    // Hiro's row wins on the fields it has; the chain fills the gaps. Nothing is
    // discarded, because an indexed `name` is as valid as a fetched one. The
    // image can only come from the chain here — the early return above already
    // took every case where Hiro had one.
    return indexed ? { ...onChain, ...indexed, image: onChain.image } : onChain;
  }

  /**
   * Read `get-token-uri` off chain, fetch the JSON it points at, return it.
   *
   * Three things here are the actual work, and each was a way this silently
   * returned nothing before it was handled:
   *
   *   - SIP-16's literal `{id}`. Collections return ONE uri for the whole
   *     collection with a placeholder in it. Fetched unchanged it 404s.
   *   - The scheme. `get-token-uri` returns `ipfs://ipfs/Qm…` as often as https;
   *     `gatewayUrl` is what makes it fetchable, and returns null rather than a
   *     guess for anything it has no gateway for.
   *   - `assertProxyableUrl`. This is the API fetching a URL named by an
   *     arbitrary contract — the same SSRF primitive `/image-proxy` guards, minus
   *     the browser. Anyone can deploy a contract whose `get-token-uri` returns
   *     `https://169.254.169.254/…`; the response body would not reach the
   *     player, but the *request* would still be made from inside our network,
   *     by a process holding `ORACLE_PRIVATE_KEY`. So it goes through the same
   *     allowlist, and its 400 is swallowed into null rather than surfaced.
   *
   * `data:application/json` token uris are not handled. None of the eight
   * supported collections uses one, and the ones that do are on-chain-art
   * collections whose images are SVGs the proxy refuses anyway.
   */
  private async metadataFromTokenUri(
    contractId: string,
    tokenId: string,
  ): Promise<TokenMetadata | null> {
    const uri = await this.readTokenUri(contractId, tokenId);
    if (!uri) return null;

    const url = gatewayUrl(substituteTokenId(uri, tokenId));
    if (!url) return null;

    try {
      assertProxyableUrl(url);
    } catch {
      // A contract pointing at a private address, a non-https scheme, or an odd
      // port. Not our problem to report — the token simply has no metadata.
      return null;
    }

    interface TokenUriJson {
      name?: unknown;
      image?: unknown;
      attributes?: unknown;
    }

    let body: TokenUriJson;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TOKEN_URI_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) return null;
      const text = await response.text();
      // Checked after reading as well as before: `content-length` is optional and
      // can lie, and this parses whatever arrives.
      if (text.length > MAX_METADATA_BYTES) return null;
      body = JSON.parse(text) as TokenUriJson;
    } catch {
      // Gateway timeout, 404, non-JSON body, or a body over the cap. All the
      // same answer.
      return null;
    }

    if (!body || typeof body !== 'object') return null;

    const image = typeof body.image === 'string' ? body.image : undefined;
    const name = typeof body.name === 'string' ? body.name : undefined;
    if (!image && !name) return null;

    // `attributes` is passed through only in SIP-16's own shape. Collections use
    // `trait`/`type`/`key` for the same field, but `metadataBonus` matches on
    // `trait_type` alone, so remapping them would start moving stats — and the
    // one holder-influenced input into stat derivation is not something to widen
    // as a side effect of a display fix (stats.ts, ANTI-SPOOFING).
    const attributes = Array.isArray(body.attributes)
      ? (body.attributes as { trait_type?: string; value?: unknown }[]).filter(
          (a) => a && typeof a === 'object',
        )
      : undefined;

    return { name, image, attributes };
  }

  /**
   * `get-token-uri` for a token, or null if the contract has no readable one.
   *
   * SIP-009 types this as `(response (optional (string-ascii 256)) uint)`, so
   * there are two wrappers to unpick before the string, and a `none` is a
   * legitimate answer meaning the collection publishes no metadata.
   */
  private async readTokenUri(contractId: string, tokenId: string): Promise<string | null> {
    let id: bigint;
    try {
      id = BigInt(tokenId);
    } catch {
      return null; // Non-numeric token id — nothing to ask the contract about.
    }

    try {
      const result = await this.callReadOnly({
        contractId,
        functionName: 'get-token-uri',
        functionArgsHex: [`0x${serializeCV(uintCV(id))}`],
      });
      const inner = result.type === ClarityType.ResponseOk ? result.value : result;
      if (inner.type !== ClarityType.OptionalSome) return null;
      if (inner.value.type !== ClarityType.StringASCII) return null;
      return inner.value.value;
    } catch {
      // A contract without `get-token-uri` at all, or a node that refused the
      // call. Neither is worth failing a character list over.
      return null;
    }
  }

  async callReadOnly(params: {
    contractId: string;
    functionName: string;
    functionArgsHex?: readonly string[];
    sender?: string;
  }): Promise<ClarityValue> {
    const [address, name] = params.contractId.split('.');
    if (!address || !name) {
      throw new Error(`Malformed contract id: ${params.contractId}`);
    }

    interface ReadOnlyResponse {
      okay: boolean;
      result?: string;
      cause?: string;
    }

    const body = await this.fetchJson<ReadOnlyResponse>(
      `/v2/contracts/call-read/${address}/${name}/${params.functionName}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: params.sender ?? address,
          arguments: params.functionArgsHex ?? [],
        }),
      },
    );

    if (!body.okay || !body.result) {
      throw upstreamUnavailable(
        `Read-only call ${params.contractId}.${params.functionName} failed: ${body.cause ?? 'unknown'}`,
      );
    }
    return hexToCV(body.result);
  }

  async getTransaction(txId: string): Promise<ChainTransaction | null> {
    let body: HiroTxResponse;
    try {
      body = await this.fetchJson<HiroTxResponse>(
        `/extended/v1/tx/${encodeURIComponent(normalizeTxId(txId))}`,
      );
    } catch {
      // An unknown txid is the normal case for a transaction the mempool has
      // not seen yet, not an outage. Callers treat null as "not confirmed",
      // which is the safe reading either way.
      return null;
    }

    return toChainTransaction(body);
  }

  async listContractCalls(params: {
    contractId: string;
    functionName?: string;
    limit?: number;
    stopAtTxIds?: ReadonlySet<string>;
  }): Promise<ChainTransaction[]> {
    interface TxPage {
      total?: number;
      // `/address/:principal/transactions` returns bare transactions; the
      // `_with_transfers` variant wraps each in `{ tx }`. Accept either rather
      // than depending on which one a given Hiro version serves.
      results?: (HiroTxResponse | { tx: HiroTxResponse })[];
    }

    const limit = params.limit ?? 200;
    const stop = params.stopAtTxIds ?? new Set<string>();
    const found: ChainTransaction[] = [];

    for (let page = 0; page < MAX_TX_PAGES && found.length < limit; page++) {
      const body = await this.fetchJson<TxPage>(
        `/extended/v1/address/${encodeURIComponent(params.contractId)}/transactions` +
          `?limit=${TX_PAGE_SIZE}&offset=${page * TX_PAGE_SIZE}`,
      );

      const results = body.results ?? [];
      if (results.length === 0) break;

      for (const entry of results) {
        const raw = 'tx' in entry ? entry.tx : entry;
        const tx = toChainTransaction(raw);

        // The watermark. Results are newest-first, so the first already-known
        // transaction means everything past it is already known too.
        if (stop.has(tx.txId)) return found;

        if (params.functionName && tx.functionName !== params.functionName) continue;
        found.push(tx);
        if (found.length >= limit) break;
      }

      if (results.length < TX_PAGE_SIZE) break;
    }

    return found;
  }

  async broadcastRawTx(rawTxHex: string): Promise<string> {
    const hex = rawTxHex.startsWith('0x') ? rawTxHex.slice(2) : rawTxHex;
    const url = `${this.apiUrl.replace(/\/$/, '')}/v2/transactions`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
        },
        body: Buffer.from(hex, 'hex'),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw upstreamUnavailable(
        `Broadcast failed (${url}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = (await response.text()).trim();
    if (!response.ok) {
      throw upstreamUnavailable(`Broadcast rejected (${response.status}): ${text}`);
    }
    // The node answers with a bare JSON string containing the txid.
    return text.replace(/^"|"$/g, '');
  }
}

/** Strip a leading `0x` and lowercase — the form Hiro's tx routes expect. */
export function normalizeTxId(txId: string): string {
  const hex = txId.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Malformed transaction id: "${txId}"`);
  }
  return hex;
}

/** Unwrap a Clarity value into a plain JS value. */
export function unwrapCV(value: ClarityValue): unknown {
  return cvToValue(value, true);
}

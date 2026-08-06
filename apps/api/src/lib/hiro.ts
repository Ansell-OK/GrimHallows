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

import { hexToCV, cvToValue, serializeCV, uintCV, type ClarityValue } from '@stacks/transactions';
import { upstreamUnavailable } from './errors.js';

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

export interface ChainClient {
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

    let valueHex: string;
    try {
      valueHex = `0x${serializeCV(uintCV(BigInt(params.tokenId)))}`;
    } catch {
      return null;
    }

    try {
      const body = await this.fetchJson<HistoryPage>(
        `/extended/v1/tokens/nft/history?asset_identifier=${encodeURIComponent(params.assetIdentifier)}` +
          `&value=${encodeURIComponent(valueHex)}&limit=${NFT_HISTORY_PAGE_SIZE}`,
      );

      // Hiro returns this newest-first, so the first match is the most recent
      // acquisition — see the interface note on why "most recent" is required
      // and not merely convenient.
      const acquiring = (body.results ?? []).find((e) => e.recipient === params.owner);
      return typeof acquiring?.block_height === 'number' ? acquiring.block_height : null;
    } catch {
      return null;
    }
  }

  async getTokenMetadata(contractId: string, tokenId: string): Promise<TokenMetadata | null> {
    interface MetadataResponse {
      token_uri?: string;
      metadata?: {
        name?: string;
        image?: string;
        attributes?: { trait_type?: string; value?: unknown }[];
      };
    }

    try {
      const body = await this.fetchJson<MetadataResponse>(
        `/metadata/v1/nft/${encodeURIComponent(contractId)}/${encodeURIComponent(tokenId)}`,
      );
      return body.metadata ?? null;
    } catch {
      // Missing or unindexed metadata is normal, not an error: stat derivation
      // treats it as absent, and the anti-spoofing design means a character
      // with no metadata is still a complete, playable character.
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

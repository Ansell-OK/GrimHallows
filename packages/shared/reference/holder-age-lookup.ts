/**
 * Reference implementation: determining how long the CURRENT holder has held a specific
 * Stacks SIP-009 NFT, for the rarity model in 01-game-design.md §4b.
 *
 * Belongs in /packages/shared per 02-architecture.md and 06-mvp-roadmap.md Phase 2.
 * Two-cache design: an owner-scoped, volatile cache (per token) and a block-height-to-timestamp
 * cache (permanent, shared across all tokens) — see 05-data-model.md `nft_holder_age_cache`.
 *
 * REFERENCE ONLY. The shipping implementation is `apps/api/src/services/holderAgeService.ts`,
 * which goes through `ChainClient` and the Postgres caches instead of raw `fetch` and Maps.
 * This file stays as the readable statement of the algorithm — but the tier table is imported
 * from `../src/rarity.ts` rather than restated, so it cannot drift from what actually runs.
 */

import { rarityFromHoldDays, rarityMultiplier } from "../src/rarity.js";
import type { Rarity } from "../src/types.js";

const HIRO_API_BASE = "https://api.hiro.so";

interface NftHolding {
  asset_identifier: string;
  value: { hex: string; repr: string };
  block_height?: number;
  tx_id: string;
}

interface NftHoldingsResponse {
  limit: number;
  offset: number;
  total: number;
  results: NftHolding[];
}

interface NftHistoryEvent {
  sender: string | null;
  recipient: string;
  event_index: number;
  asset_event_type: "transfer" | "mint" | "burn";
  tx_id: string;
  block_height: number;
}

interface NftHistoryResponse {
  results: NftHistoryEvent[];
  total: number;
}

/** Permanent cache: block_height never changes its timestamp. Safe to cache forever. */
const blockTimestampCache = new Map<number, number>(); // block_height -> unix seconds

async function getBlockTimestamp(blockHeight: number): Promise<number> {
  const cached = blockTimestampCache.get(blockHeight);
  if (cached !== undefined) return cached;

  const res = await fetch(`${HIRO_API_BASE}/extended/v1/block/by_height/${blockHeight}`);
  if (!res.ok) throw new Error(`Block lookup failed for height ${blockHeight}: ${res.status}`);
  const block = await res.json();
  const timestamp: number = block.burn_block_time; // unix seconds

  blockTimestampCache.set(blockHeight, timestamp);
  return timestamp;
}

/**
 * Fallback path: walk full transfer history for one token and find the most recent event
 * where `recipient` matches the current owner. Used only when `block_height` is missing
 * from the holdings response (nonstandard/older collections).
 */
async function getAcquiredBlockFromHistory(
  contractPrincipal: string,
  assetName: string,
  tokenValueHex: string,
  currentOwner: string
): Promise<number> {
  const assetIdentifier = `${contractPrincipal}::${assetName}`;
  const url = `${HIRO_API_BASE}/extended/v1/tokens/nft/history?asset_identifier=${encodeURIComponent(
    assetIdentifier
  )}&value=${tokenValueHex}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`History lookup failed: ${res.status}`);
  const data: NftHistoryResponse = await res.json();

  // Events are typically returned newest-first; find the first (most recent) event
  // where this address became the recipient.
  const acquiringEvent = data.results.find((e) => e.recipient === currentOwner);
  if (!acquiringEvent) {
    throw new Error(`No acquiring event found for ${currentOwner} on ${assetIdentifier}`);
  }
  return acquiringEvent.block_height;
}

export interface HolderAgeResult {
  contractId: string;
  tokenId: string; // clarity repr, e.g. "u1"
  holdDays: number;
  source: "holdings_block_height" | "history_fallback" | "fallback_pending";
}

/**
 * Given a wallet address, returns holding-duration data for every SIP-009 NFT it currently
 * holds. Never throws on a per-token lookup failure — degrades that single token to
 * `fallback_pending` (holdDays: 0) per the failure-mode guidance in 02-architecture.md §4,
 * rather than failing the whole character-select response.
 */
export async function getHolderAgesForWallet(
  ownerAddress: string
): Promise<HolderAgeResult[]> {
  const holdingsRes = await fetch(
    `${HIRO_API_BASE}/extended/v1/tokens/nft/holdings?principal=${ownerAddress}&limit=200`
  );
  if (!holdingsRes.ok) {
    throw new Error(`Holdings lookup failed for ${ownerAddress}: ${holdingsRes.status}`);
  }
  const holdings: NftHoldingsResponse = await holdingsRes.json();

  const now = Math.floor(Date.now() / 1000);

  return Promise.all(
    holdings.results.map(async (holding): Promise<HolderAgeResult> => {
      const [contractId, assetName] = holding.asset_identifier.split("::");

      try {
        let acquiredBlockHeight = holding.block_height;

        // Fallback path if block_height wasn't populated on this holding entry
        if (acquiredBlockHeight === undefined) {
          acquiredBlockHeight = await getAcquiredBlockFromHistory(
            contractId,
            assetName,
            holding.value.hex,
            ownerAddress
          );
        }

        const acquiredTimestamp = await getBlockTimestamp(acquiredBlockHeight);
        const holdDays = Math.floor((now - acquiredTimestamp) / 86400);

        return {
          contractId,
          tokenId: holding.value.repr,
          holdDays: Math.max(0, holdDays),
          source: holding.block_height !== undefined
            ? "holdings_block_height"
            : "history_fallback",
        };
      } catch (err) {
        // Non-blocking degrade per architecture doc — log for background retry, never
        // block the character-select response on a flaky lookup.
        console.warn(`Holder-age lookup failed for ${holding.asset_identifier}:`, err);
        return {
          contractId,
          tokenId: holding.value.repr,
          holdDays: 0,
          source: "fallback_pending",
        };
      }
    })
  );
}

/**
 * Rarity tier table — 01-game-design.md §4b.
 *
 * DELEGATES, does not re-implement. This file used to carry its own copy of the
 * thresholds and multipliers. They happened to agree with `../src/rarity.ts`,
 * which is exactly how a fork looks right up until someone retunes one of them —
 * and retuning is explicitly expected (07-glossary-and-open-questions.md #10).
 * Two implementations that agree today are still two implementations.
 */
export function rarityTierFromHoldDays(holdDays: number): {
  tier: Rarity;
  multiplier: number;
} {
  const tier = rarityFromHoldDays(holdDays);
  return { tier, multiplier: rarityMultiplier(tier) };
}

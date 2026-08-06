/**
 * World map — 04-backend-api-spec.md#3.
 *
 * Assembles two halves that have nothing to do with each other:
 *
 *   - Free-dungeon spawns, which are off-chain content in Postgres and need no
 *     chain access whatsoever (02-architecture.md#4).
 *   - The standing paid dungeon, whose gate fee and sponsor-pool balance are
 *     read live from `game-core` on every request.
 *
 * THE POOL NUMBER IS NOT REVENUE. `sponsorPoolUstx` is the owner-funded prize
 * budget from `get-sponsor-pool` — "this is the prize budget on offer, not fee
 * revenue collected". Entry fees go straight to the contract owner and never
 * touch this balance (03-smart-contracts-spec.md#2). The two figures are never
 * added, and this service has no access to a revenue total at all, which is the
 * simplest way to keep it that way.
 *
 * Neither number is ever cached, defaulted, or guessed. If the chain can't be
 * read, `paidDungeon` comes back null and the UI says so — showing a stale or
 * zeroed pool would misrepresent, in the player's favour or against it, exactly
 * the number the whole trust story rests on.
 */

import {
  PAID_DUNGEON_ID,
  PAID_DUNGEON_LOCATION,
  PAID_DUNGEON_NAME,
  contractId as buildContractId,
  type FreeDungeonSpawn,
  type MapResponse,
  type NetworkConfig,
  type PaidDungeonSummary,
} from '@grimhallow/shared';
import { ClarityType, serializeCV, uintCV, type ClarityValue } from '@stacks/transactions';
import { upstreamUnavailable } from '../lib/errors.js';
import type { ChainClient } from '../lib/hiro.js';
import type { SpawnRecord, SpawnStore } from '../repos/spawns.js';

export interface MapServiceDeps {
  readonly chain: ChainClient;
  readonly spawns: SpawnStore;
  readonly stacks: NetworkConfig;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

export function toSpawnResponse(record: SpawnRecord): FreeDungeonSpawn {
  return {
    id: record.id,
    location: { x: record.x, y: record.y },
    monsterTableId: record.monsterTableId,
    expiresAt: record.expiresAt.toISOString(),
  };
}

/** Read a Clarity uint as a decimal string, whatever representation it arrived in. */
export function uintToString(value: ClarityValue): string {
  if (value.type !== ClarityType.UInt) {
    throw new Error(`Expected a Clarity uint, got ${value.type}`);
  }
  return BigInt(value.value).toString();
}

export class MapService {
  constructor(private readonly deps: MapServiceDeps) {}

  private get gameCoreId(): string {
    return buildContractId(this.deps.stacks, 'gameCore');
  }

  async getMap(now: Date = new Date()): Promise<MapResponse> {
    // Deliberately sequenced so a chain problem cannot stop the spawn read:
    // the free half of the map is fully independent of the chain.
    const spawns = (await this.deps.spawns.listActive(now)).map(toSpawnResponse);
    return { spawns, paidDungeon: await this.readPaidDungeon() };
  }

  /**
   * The paid dungeon, or a thrown error — the entry-path counterpart to the map
   * read.
   *
   * The map tolerates a null because a map missing one tile is still a useful
   * map. An entry quote does not: the gate fee is the number the player is about
   * to sign a transaction for, so an unreadable chain must stop the flow rather
   * than let a fee be guessed, defaulted, or carried over from a previous read.
   */
  async requirePaidDungeon(): Promise<PaidDungeonSummary> {
    const dungeon = await this.readPaidDungeon();
    if (!dungeon) {
      throw upstreamUnavailable(
        'The paid dungeon could not be read from chain right now, so its entry ' +
          'fee cannot be quoted. Nothing was charged. Try again shortly.',
      );
    }
    return dungeon;
  }

  /**
   * Live gate fee + sponsor pool, or null if either read fails.
   *
   * Both are fetched together because a page showing one without the other is
   * not a usable decision: "1 STX to enter" means nothing without "and here is
   * what is actually up for grabs".
   */
  private async readPaidDungeon(): Promise<PaidDungeonSummary | null> {
    try {
      const [dungeon, pool] = await Promise.all([
        this.deps.chain.callReadOnly({
          contractId: this.gameCoreId,
          functionName: 'get-dungeon',
          functionArgsHex: [`0x${serializeCV(uintCV(PAID_DUNGEON_ID))}`],
        }),
        this.deps.chain.callReadOnly({
          contractId: this.gameCoreId,
          functionName: 'get-sponsor-pool',
        }),
      ]);

      // `get-dungeon` returns an optional tuple; `none` means the dungeon has
      // not been seeded yet, which is not an error, just nothing to show.
      if (dungeon.type !== ClarityType.OptionalSome) {
        this.deps.log?.('paid dungeon not seeded on chain', {
          dungeonId: PAID_DUNGEON_ID,
        });
        return null;
      }
      if (dungeon.value.type !== ClarityType.Tuple) {
        throw new Error(`get-dungeon returned ${dungeon.value.type}, expected a tuple`);
      }

      const fee = dungeon.value.value['gate-fee'];
      const active = dungeon.value.value['active'];
      if (!fee || !active) {
        throw new Error('get-dungeon tuple is missing gate-fee or active');
      }
      if (active.type !== ClarityType.BoolTrue) {
        // Owner has deactivated it; entries would be rejected on chain, so
        // don't advertise it as enterable.
        this.deps.log?.('paid dungeon is inactive on chain', {
          dungeonId: PAID_DUNGEON_ID,
        });
        return null;
      }

      return {
        dungeonId: PAID_DUNGEON_ID,
        name: PAID_DUNGEON_NAME,
        location: PAID_DUNGEON_LOCATION,
        gateFeeUstx: uintToString(fee),
        sponsorPoolUstx: uintToString(pool),
      };
    } catch (err) {
      // Logged at the call site's discretion rather than thrown: the rest of
      // the map is still true, and a null here renders as "unavailable", not
      // as a pool of zero.
      this.deps.log?.('could not read paid dungeon from chain', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

/**
 * Parsing and resolving an equipped power-up loadout.
 *
 * Shared by both entry paths — the free `POST /dungeons/:id/enter` and the paid
 * `POST /dungeons/:id/claim` — because a loadout means the same thing on both
 * and two copies of the rule would be free to drift. A player who could equip
 * four power-ups on the paid path because only the free path counted them would
 * have found a real balance hole.
 *
 * TOKEN IDS IN, ITEMS OUT. What a power-up grants is decided by its on-chain
 * `{uri, tier}` pair, so a request never carries either half of it: it names
 * tokens, and both the tier and the archetype parsed out of the uri are read
 * from the chain after the wallet is confirmed to hold the token. A request that
 * could carry a tier could carry a better one — and now that archetype moves the
 * dice too, the same is true of a slug.
 */

import { MAX_EQUIPPED_POWER_UPS, type EquippedItem } from '@grimhallow/shared';
import { badRequest } from './errors.js';
import { PowerUpOwnershipError, type PowerUpService } from '../services/powerUpService.js';

/**
 * Validate the shape of a submitted loadout.
 *
 * Absent or empty means an unequipped run, which is legitimate and common —
 * every run before the player owns their first drop looks like this.
 */
export function parsePowerUpTokenIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    throw badRequest('INVALID_POWER_UPS', 'powerUpTokenIds must be an array of token ids');
  }

  const ids = value.map((raw) => {
    const id =
      typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
    if (!/^\d+$/.test(id)) {
      throw badRequest(
        'INVALID_POWER_UPS',
        'Every power-up token id must be a non-negative integer',
      );
    }
    return id;
  });

  if (new Set(ids).size !== ids.length) {
    // The same NFT cannot be equipped twice. Deduplicating silently would grant
    // one bonus where the player believes they stacked two.
    throw badRequest('DUPLICATE_POWER_UPS', 'The same power-up cannot be equipped twice');
  }

  if (ids.length > MAX_EQUIPPED_POWER_UPS) {
    throw badRequest(
      'TOO_MANY_POWER_UPS',
      `At most ${MAX_EQUIPPED_POWER_UPS} power-ups can be equipped for one run`,
    );
  }

  return ids;
}

/**
 * Shape-check a loadout, then resolve it into equipped items against the chain.
 *
 * An ownership failure surfaces as a 400 rather than a 500: a wallet that does
 * not hold what it asked to equip is a bad request, not a server fault.
 */
export async function resolveLoadout(
  powerUps: PowerUpService,
  address: string,
  value: unknown,
): Promise<EquippedItem[]> {
  const tokenIds = parsePowerUpTokenIds(value);
  try {
    return await powerUps.resolveEquippedItems(address, tokenIds);
  } catch (err) {
    if (err instanceof PowerUpOwnershipError) {
      throw badRequest('POWER_UP_NOT_HELD', err.message);
    }
    throw err;
  }
}

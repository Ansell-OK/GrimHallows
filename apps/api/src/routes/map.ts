/**
 * World map — 04-backend-api-spec.md#3.
 *
 *   GET /map -> free-dungeon spawns + the standing paid dungeon
 *
 * Public and unauthenticated, like `/characters`: everything it returns is
 * either off-chain content anyone can see or a chain fact anyone can read for
 * themselves. Requiring a session to look at the map would be security theatre.
 */

import type { FastifyInstance } from 'fastify';
import type { MapService } from '../services/mapService.js';

export interface MapRouteDeps {
  readonly map: MapService;
}

export async function registerMapRoutes(
  app: FastifyInstance,
  deps: MapRouteDeps,
): Promise<void> {
  app.get('/map', async () => deps.map.getMap());
}

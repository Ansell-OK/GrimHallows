import { dungeonsCompleted, leaderboardScore } from '@grimhallow/shared';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../lib/authGuard.js';
import type { ChainClient } from '../lib/hiro.js';
import type { PlayerStatsStore } from '../repos/playerStats.js';

export interface ProfileRouteDeps {
  readonly chain: ChainClient;
  readonly playerStats: PlayerStatsStore;
  readonly jwtSecret: string;
}

export async function registerProfileRoutes(
  app: FastifyInstance,
  deps: ProfileRouteDeps,
): Promise<void> {
  app.get('/profile', async (request) => {
    const { sub: address } = requireSession(request, deps.jwtSecret);
    const rows = await deps.playerStats.aggregate(null);
    const ranked = rows
      .map((row) => ({ ...row, score: leaderboardScore(row) }))
      .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
    const index = ranked.findIndex((row) => row.address === address);
    const row = index >= 0 ? ranked[index] : null;
    const balanceUstx = deps.chain.getStxBalance
      ? await deps.chain.getStxBalance(address)
      : null;

    return {
      address,
      balanceUstx,
      rank: index >= 0 ? index + 1 : null,
      score: row?.score ?? 0,
      dungeonsCompleted: row ? dungeonsCompleted(row) : 0,
      freeDungeonsCompleted: row?.freeDungeonsCompleted ?? 0,
      paidDungeonsCompleted: row?.paidDungeonsCompleted ?? 0,
      jackpotsWon: row?.jackpotsWon ?? 0,
      highestForgeTier: row?.highestForgeTier ?? 0,
    };
  });
}

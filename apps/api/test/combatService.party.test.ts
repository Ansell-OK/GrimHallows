import { describe, expect, it, vi } from 'vitest';
import { CombatService } from '../src/services/combatService.js';
import { CHARACTER_COLLECTION } from './helpers/collections.js';
import type { ChainClient } from '../src/lib/hiro.js';
import type { RunOracle } from '../src/oracle/runOracle.js';
import type { HolderAgeService } from '../src/services/holderAgeService.js';

describe('CombatService party setup', () => {
  it('freezes members in order and derives each NFT against its owner', async () => {
    const forToken = vi.fn(async (address: string) => ({ holdDays: address === 'STALICE' ? 1 : 10, source: 'confirmed' as const }));
    const chain = { getTokenMetadata: async (_contractId: string, tokenId: string) => ({ name: `Hero ${tokenId}` }) } as unknown as ChainClient;
    const combat = new CombatService({ oracle: {} as RunOracle, chain, holderAge: { forToken } as unknown as HolderAgeService });
    const setup = await combat.buildPartySetup('crypt', [
      { address: 'STALICE', character: { contractId: CHARACTER_COLLECTION, tokenId: '7' } },
      { address: 'STBOB', character: { contractId: CHARACTER_COLLECTION, tokenId: '8' } },
    ]);
    expect(setup.party.map((member) => ({ id: member.id, address: member.address, name: member.name }))).toEqual([
      { id: 'p0', address: 'STALICE', name: 'Hero 7' },
      { id: 'p1', address: 'STBOB', name: 'Hero 8' },
    ]);
    expect(forToken.mock.calls.map((call) => call[0])).toEqual(['STALICE', 'STBOB']);
  });
});

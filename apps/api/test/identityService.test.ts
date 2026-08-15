import { describe, expect, it } from 'vitest';
import { IdentityService } from '../src/services/identityService.js';
import type { ChainClient } from '../src/lib/hiro.js';

const ADDRESS = 'SP000000000000000000002Q6VF78';

describe('IdentityService', () => {
  it('caches positive and negative BNS results for 24 hours', async () => {
    let now = 0;
    let calls = 0;
    const chain = { getPrimaryName: async () => { calls += 1; return calls === 1 ? 'hero.btc' : null; } } as unknown as ChainClient;
    const service = new IdentityService(chain, () => now);
    expect((await service.resolve(ADDRESS)).displayName).toBe('hero.btc');
    expect((await service.resolve(ADDRESS)).displayName).toBe('hero.btc');
    expect(calls).toBe(1);
    now += 24 * 60 * 60 * 1000 + 1;
    expect((await service.resolve(ADDRESS)).displayName).toContain('SP0000');
    expect(calls).toBe(2);
  });

  it('falls back without failing the owning response when Hiro is unavailable', async () => {
    const service = new IdentityService({ getPrimaryName: async () => { throw new Error('down'); } } as unknown as ChainClient);
    await expect(service.resolve(ADDRESS)).resolves.toEqual({
      address: ADDRESS,
      bnsName: null,
      displayName: 'SP0000...VF78',
    });
  });
});

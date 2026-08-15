import type { ChainClient } from '../lib/hiro.js';

export interface Identity {
  readonly address: string;
  readonly displayName: string;
  readonly bnsName: string | null;
}

interface CacheEntry { value: string | null; expiresAt: number; }

/** Best-effort BNS identity with positive and negative 24-hour caching. */
export class IdentityService {
  private readonly cache = new Map<string, CacheEntry>();
  constructor(private readonly chain: ChainClient, private readonly now = () => Date.now()) {}

  async resolve(address: string): Promise<Identity> {
    const cached = this.cache.get(address);
    let bnsName = cached && cached.expiresAt > this.now() ? cached.value : null;
    if (!cached || cached.expiresAt <= this.now()) {
      try { bnsName = this.chain.getPrimaryName ? await this.chain.getPrimaryName(address) : null; }
      catch { bnsName = null; }
      this.cache.set(address, { value: bnsName, expiresAt: this.now() + 24 * 60 * 60 * 1000 });
    }
    return { address, bnsName, displayName: bnsName ?? `${address.slice(0, 6)}...${address.slice(-4)}` };
  }
}

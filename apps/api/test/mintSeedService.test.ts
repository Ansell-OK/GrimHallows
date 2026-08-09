/**
 * `MintSeedService` — the one place a rarity floor's seed comes from.
 *
 * The service is thin, and every one of its decisions is a security decision, so
 * this file is mostly about the refusals rather than the happy path:
 *
 *   - IT ANSWERS FOR ONE CONTRACT. A curated-collection token is specified to have
 *     no floor at all, so resolving a seed for one would produce a value whose only
 *     possible use is giving eight collections a bonus they should not have.
 *   - A RESOLVED SEED IS NEVER RE-RESOLVED. The floor is published to the player
 *     the moment their card renders; a seed that could come back different later
 *     is a floor that moves under someone who has already seen it. The cache is
 *     therefore trusted without revalidation and written write-once.
 *   - A MISS IS CACHED AS NOTHING. An unconfirmed mint is the ordinary case, not a
 *     fault, and it fixes itself in a block or two. Storing a negative would need a
 *     TTL and a sweeper to express what an absent row already says.
 *   - NOTHING THROWS. No seed means no floor, which is a slightly weak character.
 *     An exception here is a character-select screen that does not render.
 */

import { describe, expect, it } from 'vitest';
import { MintSeedService } from '../src/services/mintSeedService.js';
import { MemoryMintSeedRepo, type MintSeedEntry, type MintSeedRepo } from '../src/repos/mintSeeds.js';
import type { ChainClient, MintBlock } from '../src/lib/hiro.js';

const CHARACTERS = 'SP1MNXD30JHNT2Y0P8KZ06J43ACCH27N3BTBZ90AR.character-nft';
const ASSET = `${CHARACTERS}::grimhallow-character`;
const CURATED = 'SP2RNHHQDTHGHPEVX83291K4AQZVGWEJ7WCQQDA9R.giga-pepe-v2';
const HASH = '0x00000000000000000001b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607';
const OTHER_HASH = '0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';

interface FakeChainOptions {
  readonly block?: MintBlock | null;
  readonly throws?: boolean;
}

/**
 * A chain that answers only `getNftMintBlock`, recording what it was asked.
 *
 * Everything else throws rather than returning a benign default: this service is
 * specified to make exactly one chain call, and a second one appearing would be a
 * cost per character card that no test would otherwise notice.
 */
function fakeChain(options: FakeChainOptions = {}): ChainClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getNftMintBlock(params: { assetIdentifier: string; tokenId: string }) {
      calls.push(`${params.assetIdentifier}#${params.tokenId}`);
      if (options.throws) throw new Error('hiro is down');
      return options.block ?? null;
    },
  } as unknown as ChainClient & { calls: string[] };
}

function service(chain: ChainClient, repo: MintSeedRepo = new MemoryMintSeedRepo()): MintSeedService {
  return new MintSeedService({ chain, repo, assetIdentifier: ASSET });
}

describe('MintSeedService — resolving a seed', () => {
  it('returns the mint block hash for one of our own tokens', async () => {
    const chain = fakeChain({ block: { height: 100, hash: HASH } });

    expect(await service(chain).forToken(CHARACTERS, '7')).toBe(HASH);
    // The asset identifier, not the contract id: Hiro's NFT routes key on
    // `contract::asset` and a contract id alone matches nothing.
    expect(chain.calls).toEqual([`${ASSET}#7`]);
  });

  it('caches the resolved seed, so a second read costs no chain call', async () => {
    // Per character card, per page load. Without this the floor would cost a Hiro
    // request for every minted token in a wallet on every render.
    const chain = fakeChain({ block: { height: 100, hash: HASH } });
    const svc = service(chain);

    await svc.forToken(CHARACTERS, '7');
    expect(await svc.forToken(CHARACTERS, '7')).toBe(HASH);
    expect(chain.calls).toHaveLength(1);
  });

  it('trusts the cached row over anything chain would answer now', async () => {
    // Reorg, re-index, changed field preference — whatever the reason a second
    // lookup could differ, the published floor wins. A floor that moves after a
    // player has been shown their card is the failure this permanence prevents.
    const repo = new MemoryMintSeedRepo();
    await repo.put({ contractId: CHARACTERS, tokenId: '7', mintBlockHeight: 100, mintSeed: HASH });
    const chain = fakeChain({ block: { height: 999, hash: OTHER_HASH } });

    expect(await service(chain, repo).forToken(CHARACTERS, '7')).toBe(HASH);
    expect(chain.calls).toHaveLength(0);
  });
});

describe('MintSeedService — what it refuses', () => {
  it('returns null for a curated-collection token without asking chain', async () => {
    // Those eight collections have no floor by specification, and v4 is meant to
    // agree with v3 byte for byte on them. A seed resolved here is a value whose
    // only use would be breaking that.
    const chain = fakeChain({ block: { height: 100, hash: HASH } });

    expect(await service(chain).forToken(CURATED, '7')).toBeNull();
    expect(chain.calls).toHaveLength(0);
  });

  it('returns null for a token id that is not a number', async () => {
    // Ids are Clarity uints. Anything else cannot be serialized into the query, so
    // asking would spend a request to be told nothing.
    const chain = fakeChain({ block: { height: 100, hash: HASH } });

    expect(await service(chain).forToken(CHARACTERS, '7; drop')).toBeNull();
    expect(await service(chain).forToken(CHARACTERS, '')).toBeNull();
    expect(chain.calls).toHaveLength(0);
  });
});

describe('MintSeedService — degrading', () => {
  it('returns null when the mint is not visible yet, and caches nothing', async () => {
    // The ordinary case for a token minted seconds ago. The next request must be
    // able to resolve it for real, which a cached negative would prevent.
    const repo = new MemoryMintSeedRepo();
    const chain = fakeChain({ block: null });

    expect(await service(chain, repo).forToken(CHARACTERS, '7')).toBeNull();
    expect(await repo.get(CHARACTERS, '7')).toBeNull();
  });

  it('returns null rather than throwing when the index is down', async () => {
    // 02-architecture.md#4: a failed lookup never fails the response. The player
    // gets their character at its tenure tier, which is the safe direction.
    const chain = fakeChain({ throws: true });

    expect(await service(chain).forToken(CHARACTERS, '7')).toBeNull();
  });

  it('returns the resolved seed even when the cache write fails', async () => {
    // The seed in hand is already correct — it came from chain, not from storage.
    // Losing the request over a failed cache write would trade a correct answer
    // for a saving that only ever mattered to the *next* request.
    const failingRepo: MintSeedRepo = {
      async get(): Promise<MintSeedEntry | null> {
        return null;
      },
      async put(): Promise<void> {
        throw new Error('database is down');
      },
    };
    const chain = fakeChain({ block: { height: 100, hash: HASH } });

    expect(await service(chain, failingRepo).forToken(CHARACTERS, '7')).toBe(HASH);
  });

  it('resolves from chain when the cache read fails', async () => {
    // A cache is an optimisation in this direction only. If it cannot answer, the
    // authority still can.
    const failingRepo: MintSeedRepo = {
      async get(): Promise<MintSeedEntry | null> {
        throw new Error('database is down');
      },
      async put(): Promise<void> {},
    };
    const chain = fakeChain({ block: { height: 100, hash: HASH } });

    expect(await service(chain, failingRepo).forToken(CHARACTERS, '7')).toBe(HASH);
  });
});

describe('MemoryMintSeedRepo — write-once', () => {
  it('keeps the first seed written for a token', async () => {
    // Mirrors the Postgres repo's `on conflict do nothing`. Two writers for one
    // token are either racing with the same answer or one of them is wrong, and
    // letting the later one win would silently re-roll a published floor.
    const repo = new MemoryMintSeedRepo();

    await repo.put({ contractId: CHARACTERS, tokenId: '7', mintBlockHeight: 100, mintSeed: HASH });
    await repo.put({
      contractId: CHARACTERS,
      tokenId: '7',
      mintBlockHeight: 999,
      mintSeed: OTHER_HASH,
    });

    expect((await repo.get(CHARACTERS, '7'))?.mintSeed).toBe(HASH);
  });
});

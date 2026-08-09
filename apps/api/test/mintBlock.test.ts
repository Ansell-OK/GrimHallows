/**
 * `getNftMintBlock` — the lookup that makes the rarity floor unguessable.
 *
 * WHAT THIS FILE IS ABOUT is that the mint floor used to be a pure function of
 * `(contractId, tokenId)`, and `character-nft` hands out sequential ids behind a
 * public `get-last-token-id`. So anyone could hash `lastId + 1` off-chain, learn
 * the floor before paying, and mint only when it rolled Rare — leaving the
 * published 60/30/10 table describing nobody's real odds. The fix mixes in the
 * hash of the block that confirmed the mint, which the minter cannot know when
 * they sign and cannot change afterwards.
 *
 * That makes the properties under test security properties rather than plumbing:
 *
 *   - the seed comes from the OLDEST event in the token's history, and Hiro
 *     serves that route newest-first, so the naive read is the wrong end;
 *   - a token whose oldest visible event is not a mint yields null. Seeding from
 *     a transfer block would let a holder re-roll their own floor for the price
 *     of sending the token to themselves;
 *   - a long history still costs two requests, because `total` locates the last
 *     row directly — an implementation that paged would eventually stop paging
 *     and start guessing;
 *   - a height with no readable hash is null, not the height. A height is
 *     enumerable ahead of time, which is the property being bought here;
 *   - every failure is null. No seed means no floor, which serves a slightly weak
 *     character — never a character-select screen that fails to render.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cl, serializeCV } from '@stacks/transactions';
import { HiroChainClient } from '../src/lib/hiro.js';

const API = 'https://api.example.test';
const CHARACTERS = 'SP1MNXD30JHNT2Y0P8KZ06J43ACCH27N3BTBZ90AR.character-nft::grimhallow-character';
const BURN_HASH = '0x00000000000000000001b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607';
const INDEX_HASH = '0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';

interface Route {
  readonly match: string;
  readonly status?: number;
  readonly body?: unknown;
}

/**
 * Route `fetch` by URL substring, recording every URL asked for.
 *
 * The recording carries real weight here: the request-count assertions are how
 * "two requests at worst" is expressed, and no response value can say it.
 */
function stubFetch(routes: readonly Route[]): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: URL | string) => {
    const url = String(input);
    urls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { urls };
}

function client(): HiroChainClient {
  return new HiroChainClient(API, '', 1_000);
}

/** A history row in the shape the route returns. */
function event(type: string, blockHeight: number) {
  return { asset_event_type: type, block_height: blockHeight };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getNftMintBlock — finding the mint', () => {
  it('reads the oldest event, not the newest', async () => {
    // Hiro serves this newest-first. A token that has been traded twice has a
    // transfer at results[0], and seeding from that would move the floor every
    // time the token changed hands — the exact re-rollability this replaced.
    stubFetch([
      {
        match: '/tokens/nft/history',
        body: { total: 3, results: [event('transfer', 300), event('transfer', 200), event('mint', 100)] },
      },
      { match: '/block/by_height/100', body: { burn_block_hash: BURN_HASH } },
    ]);

    const block = await client().getNftMintBlock({ assetIdentifier: CHARACTERS, tokenId: '7' });

    expect(block).toEqual({ height: 100, hash: BURN_HASH });
  });

  it('encodes the token id as a Clarity uint, since the route matches on the serialized value', async () => {
    // `value` is not the decimal id — it is a hex-serialized `uint`. A wrong
    // encoding is not an error but an empty result set, which reads exactly like
    // a token with no history and would silently disable the floor collection-wide.
    const { urls } = stubFetch([
      { match: '/tokens/nft/history', body: { total: 1, results: [event('mint', 100)] } },
      { match: '/block/by_height/100', body: { burn_block_hash: BURN_HASH } },
    ]);

    await client().getNftMintBlock({ assetIdentifier: CHARACTERS, tokenId: '7' });

    const expected = encodeURIComponent(`0x${serializeCV(Cl.uint(7))}`);
    expect(urls[0]).toContain(`value=${expected}`);
    expect(urls[0]).toContain(encodeURIComponent(CHARACTERS));
  });

  it('jumps straight to the last row of a long history, in two requests', async () => {
    // A heavily traded token must not cost a page walk, and must not give up
    // partway and seed from whatever page it stopped on. `total - 1` addresses
    // the mint directly however many transfers precede it.
    const many = Array.from({ length: 50 }, (_, i) => event('transfer', 1_000 - i));
    const { urls } = stubFetch([
      { match: 'offset=199', body: { total: 200, results: [event('mint', 42)] } },
      { match: '/tokens/nft/history', body: { total: 200, results: many } },
      { match: '/block/by_height/42', body: { burn_block_hash: BURN_HASH } },
    ]);

    const block = await client().getNftMintBlock({ assetIdentifier: CHARACTERS, tokenId: '7' });

    expect(block).toEqual({ height: 42, hash: BURN_HASH });
    expect(urls.filter((u) => u.includes('/tokens/nft/history'))).toHaveLength(2);
  });

  it('accepts index_block_hash when the burn hash is absent', async () => {
    // Either field is equally unguessable at signing time, so the security
    // property holds on both. Worth pinning because a resolved seed is stored
    // permanently: whichever field answered for a token answers for it forever.
    stubFetch([
      { match: '/tokens/nft/history', body: { total: 1, results: [event('mint', 100)] } },
      { match: '/block/by_height/100', body: { index_block_hash: INDEX_HASH } },
    ]);

    const block = await client().getNftMintBlock({ assetIdentifier: CHARACTERS, tokenId: '7' });

    expect(block?.hash).toBe(INDEX_HASH);
  });
});

describe('getNftMintBlock — refusing to guess', () => {
  it('returns null when the oldest visible event is a transfer', async () => {
    // The truncated-history case, and the sharpest one. A floor seeded from a
    // transfer block is a floor its holder can re-roll by sending the token to
    // themselves, so an incomplete history must produce no floor rather than a
    // cheap one.
    stubFetch([
      {
        match: '/tokens/nft/history',
        body: { total: 2, results: [event('transfer', 300), event('transfer', 200)] },
      },
    ]);

    expect(await client().getNftMintBlock({ assetIdentifier: CHARACTERS, tokenId: '7' })).toBeNull();
  });

  it('returns null for a height whose hash cannot be read', async () => {
    // Never the height alone. Heights are enumerable well ahead of time, so a
    // caller handed one could reconstruct the very precomputation the hash exists
    // to prevent.
    stubFetch([
      { match: '/tokens/nft/history', body: { total: 1, results: [event('mint', 100)] } },
      { match: '/block/by_height/100', body: { burn_block_time: 1_700_000_000 } },
    ]);

    expect(await client().getNftMintBlock({ assetIdentifier: CHARACTERS, tokenId: '7' })).toBeNull();
  });

  it('returns null for a hash too short to be one', async () => {
    // A truncated or placeholder value would still hash to *something*, giving a
    // floor derived from a value an attacker might reproduce. Cheaper to reject.
    stubFetch([
      { match: '/tokens/nft/history', body: { total: 1, results: [event('mint', 100)] } },
      { match: '/block/by_height/100', body: { burn_block_hash: '0xdead' } },
    ]);

    expect(await client().getNftMintBlock({ assetIdentifier: CHARACTERS, tokenId: '7' })).toBeNull();
  });

  it('returns null, never throws, when the index is unreachable or empty', async () => {
    // The degrade this whole path is built around (02-architecture.md#4): no seed
    // means the character derives at its tenure tier, which is a slightly weak
    // card. A throw here would be a character list that does not render at all.
    stubFetch([{ match: '/tokens/nft/history', status: 503, body: { error: 'upstream' } }]);
    expect(await client().getNftMintBlock({ assetIdentifier: CHARACTERS, tokenId: '7' })).toBeNull();

    vi.unstubAllGlobals();
    stubFetch([{ match: '/tokens/nft/history', body: { total: 0, results: [] } }]);
    expect(await client().getNftMintBlock({ assetIdentifier: CHARACTERS, tokenId: '9' })).toBeNull();
  });

  it('returns null for a non-numeric token id without asking Hiro anything', async () => {
    // An id that cannot be a Clarity uint cannot be serialized, and querying with
    // a malformed `value` would spend a request to be told nothing.
    const { urls } = stubFetch([]);

    expect(await client().getNftMintBlock({ assetIdentifier: CHARACTERS, tokenId: 'abc' })).toBeNull();
    expect(urls).toHaveLength(0);
  });
});

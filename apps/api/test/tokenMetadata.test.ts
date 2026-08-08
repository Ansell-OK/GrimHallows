/**
 * `getTokenMetadata` — the Hiro-index-then-chain fallback.
 *
 * WHAT THIS FILE IS ABOUT is that Hiro's metadata index is incomplete and does
 * not admit it: an unindexed token answers `200 {}`, which is
 * indistinguishable-by-status from a token that genuinely has no metadata. Of
 * the collections this game supports, `giga-pepe` is absent from the index
 * entirely and `giga-pepe-v2` stops around token 2000 — so a holder of #2135 got
 * a blank card while the metadata sat on IPFS, reachable, addressed by the
 * contract's own `get-token-uri`.
 *
 * So the properties under test are:
 *
 *   - an indexed token costs NO chain call (the fallback is a fallback)
 *   - an unindexed one falls through to `get-token-uri`, and the SIP-16 `{id}`
 *     placeholder is substituted before the fetch — unsubstituted is a 404 that
 *     looks exactly like unpinned art
 *   - an indexed-but-imageless row also falls through, because the picture is
 *     the entire reason a caller wants this
 *   - EVERY failure is null, never a throw. Metadata is display-only here (stat
 *     derivation is deliberately metadata-independent), so a slow gateway must
 *     not be able to fail a character list that is already correct without it.
 *
 * The one case that is a security property rather than a display one: the URL
 * being fetched is named by an *arbitrary contract*, and anyone can deploy a
 * contract. That makes this an SSRF sink inside a process that holds
 * `ORACLE_PRIVATE_KEY`, so a token uri pointing at the cloud metadata endpoint
 * must not produce a request at all — not merely a discarded response.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cl, serializeCV } from '@stacks/transactions';
import { HiroChainClient } from '../src/lib/hiro.js';

const API = 'https://api.example.test';
const COLLECTION = 'SP2RNHHQDTHGHPEVX83291K4AQZVGWEJ7WCQQDA9R.giga-pepe-v2';

/** A `get-token-uri` answer in SIP-009's `(ok (some "…"))` shape, hex-encoded. */
function tokenUriOk(uri: string): string {
  return `0x${serializeCV(Cl.ok(Cl.some(Cl.stringAscii(uri))))}`;
}

/** A collection that publishes no metadata: `(ok none)`. */
function tokenUriNone(): string {
  return `0x${serializeCV(Cl.ok(Cl.none()))}`;
}

interface Route {
  /** Substring of the request URL this route answers. */
  readonly match: string;
  readonly status?: number;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly contentLength?: string;
  /** Raw text, for bodies that are deliberately not JSON. */
  readonly text?: string;
}

/**
 * Route `fetch` by URL substring, recording every URL asked for.
 *
 * The recording is half the point: several assertions below are about a request
 * NOT being made, which no response value can express.
 */
function stubFetch(routes: readonly Route[]): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: URL | string) => {
    const url = String(input);
    urls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return new Response('not found', { status: 404 });
    const body = route.text ?? JSON.stringify(route.body ?? {});
    const headers: Record<string, string> = {
      'content-type': route.contentType ?? 'application/json',
    };
    if (route.contentLength) headers['content-length'] = route.contentLength;
    return new Response(body, { status: route.status ?? 200, headers });
  });
  return { urls };
}

function client(): HiroChainClient {
  return new HiroChainClient(API, '', 1_000);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getTokenMetadata — the indexed path', () => {
  it('returns Hiros row and never touches the chain', async () => {
    // The fallback costs a read-only call plus a gateway fetch. Paying that for
    // a token Hiro already knows about would add two round trips per card.
    const { urls } = stubFetch([
      {
        match: '/metadata/v1/nft/',
        body: { metadata: { name: 'GIGA PEPE V2 #1', image: 'ipfs://Qm/1.jpg' } },
      },
    ]);

    const metadata = await client().getTokenMetadata(COLLECTION, '1');

    expect(metadata).toEqual({ name: 'GIGA PEPE V2 #1', image: 'ipfs://Qm/1.jpg' });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/metadata/v1/nft/');
  });

  it('accepts a row carrying only a cached_image', async () => {
    // Hiro's cached copy is the *preferred* image (resolveImage picks it first),
    // so a row with that and no `image` is complete, not half-populated.
    const { urls } = stubFetch([
      {
        match: '/metadata/v1/nft/',
        body: { metadata: { name: 'x', cached_image: 'https://assets.hiro.so/x.png' } },
      },
    ]);

    const metadata = await client().getTokenMetadata(COLLECTION, '1');

    expect(metadata?.cached_image).toBe('https://assets.hiro.so/x.png');
    expect(urls).toHaveLength(1);
  });
});

describe('getTokenMetadata — falling through to the chain', () => {
  it('reads get-token-uri and fetches the metadata a 200-with-no-metadata hides', async () => {
    // The user's actual bug. Hiro answers 200 with an empty object — not a 404 —
    // so nothing upstream of here can tell this from "no art exists".
    const { urls } = stubFetch([
      { match: '/metadata/v1/nft/', body: {} },
      {
        match: '/v2/contracts/call-read/',
        body: { okay: true, result: tokenUriOk('ipfs://ipfs/Qme1zBPY/json/{id}.json') },
      },
      {
        match: 'ipfs.io/ipfs/Qme1zBPY/json/2135.json',
        body: { name: 'GIGA PEPE V2 #2135', image: 'ipfs://ipfs/QmV315/images/2135.jpg' },
      },
    ]);

    const metadata = await client().getTokenMetadata(COLLECTION, '2135');

    expect(metadata).toEqual({
      name: 'GIGA PEPE V2 #2135',
      image: 'ipfs://ipfs/QmV315/images/2135.jpg',
      attributes: undefined,
    });
    // The substitution and the doubled-segment strip, both visible in one URL.
    expect(urls[2]).toBe('https://ipfs.io/ipfs/Qme1zBPY/json/2135.json');
  });

  it('falls through for an indexed row that has a name but no image, and keeps the name', async () => {
    // Hiro leaves this behind when its own art fetch failed. The picture is why
    // the caller is here, so a name alone is a miss — but it is still a real
    // name and discarding it would trade one gap for another.
    stubFetch([
      { match: '/metadata/v1/nft/', body: { metadata: { name: 'Indexed name' } } },
      { match: '/v2/contracts/call-read/', body: { okay: true, result: tokenUriOk('https://m.example.test/{id}.json') } },
      { match: 'm.example.test/9.json', body: { name: 'On-chain name', image: 'ipfs://Qm/9.jpg' } },
    ]);

    const metadata = await client().getTokenMetadata(COLLECTION, '9');

    expect(metadata?.name).toBe('Indexed name');
    expect(metadata?.image).toBe('ipfs://Qm/9.jpg');
  });

  it('falls through when the metadata endpoint is unreachable, not just empty', async () => {
    // An outage and an unindexed token get the same answer, because from here
    // they are the same thing: no metadata from Hiro.
    stubFetch([
      { match: '/metadata/v1/nft/', status: 500 },
      { match: '/v2/contracts/call-read/', body: { okay: true, result: tokenUriOk('https://m.example.test/1.json') } },
      { match: 'm.example.test/1.json', body: { image: 'ipfs://Qm/1.jpg' } },
    ]);

    expect((await client().getTokenMetadata(COLLECTION, '1'))?.image).toBe('ipfs://Qm/1.jpg');
  });

  it('passes SIP-16 attributes through in their own shape only', async () => {
    // `metadataBonus` matches on `trait_type` and nothing else. Remapping a
    // collection's `trait` key onto it here would start moving stats — and the
    // single holder-influenced input into derivation is not something to widen
    // as a side effect of a display fix (stats.ts, ANTI-SPOOFING).
    stubFetch([
      { match: '/metadata/v1/nft/', body: {} },
      { match: '/v2/contracts/call-read/', body: { okay: true, result: tokenUriOk('https://m.example.test/1.json') } },
      {
        match: 'm.example.test/1.json',
        body: {
          image: 'ipfs://Qm/1.jpg',
          attributes: [
            { trait: 'vit', value: 99 },
            { trait_type: 'str', value: 2 },
          ],
        },
      },
    ]);

    const metadata = await client().getTokenMetadata(COLLECTION, '1');

    expect(metadata?.attributes).toEqual([
      { trait: 'vit', value: 99 },
      { trait_type: 'str', value: 2 },
    ]);
  });
});

describe('getTokenMetadata — the fallback is an SSRF sink, and is guarded', () => {
  it('makes no request at all for a token uri naming the cloud metadata endpoint', async () => {
    // Anyone can deploy a contract whose `get-token-uri` returns this. The
    // response body would never reach a player, but the REQUEST would still be
    // issued from inside the network by a process holding ORACLE_PRIVATE_KEY —
    // so the assertion is on the request not existing, not on the result.
    const { urls } = stubFetch([
      { match: '/metadata/v1/nft/', body: {} },
      {
        match: '/v2/contracts/call-read/',
        body: { okay: true, result: tokenUriOk('http://169.254.169.254/latest/meta-data/') },
      },
    ]);

    expect(await client().getTokenMetadata(COLLECTION, '1')).toBeNull();
    expect(urls.some((u) => u.includes('169.254.169.254'))).toBe(false);
  });

  it('makes no request for a token uri on localhost', async () => {
    // The http->https upgrade in `gatewayUrl` turns this into a *valid* https
    // URL, which is exactly why the host check has to run after it rather than
    // relying on the scheme to filter it out.
    const { urls } = stubFetch([
      { match: '/metadata/v1/nft/', body: {} },
      { match: '/v2/contracts/call-read/', body: { okay: true, result: tokenUriOk('http://localhost:8080/x.json') } },
    ]);

    expect(await client().getTokenMetadata(COLLECTION, '1')).toBeNull();
    expect(urls.some((u) => u.includes('localhost:8080'))).toBe(false);
  });

  it('makes no request for a file:// token uri', async () => {
    const { urls } = stubFetch([
      { match: '/metadata/v1/nft/', body: {} },
      { match: '/v2/contracts/call-read/', body: { okay: true, result: tokenUriOk('file:///etc/passwd') } },
    ]);

    expect(await client().getTokenMetadata(COLLECTION, '1')).toBeNull();
    expect(urls.some((u) => u.includes('passwd'))).toBe(false);
  });
});

describe('getTokenMetadata — every failure is null, never a throw', () => {
  it('is null when the contract publishes no uri', async () => {
    // `(ok none)` is a legitimate answer, not an error.
    stubFetch([
      { match: '/metadata/v1/nft/', body: {} },
      { match: '/v2/contracts/call-read/', body: { okay: true, result: tokenUriNone() } },
    ]);
    expect(await client().getTokenMetadata(COLLECTION, '1')).toBeNull();
  });

  it('is null when the contract has no get-token-uri to call', async () => {
    stubFetch([
      { match: '/metadata/v1/nft/', body: {} },
      { match: '/v2/contracts/call-read/', body: { okay: false, cause: 'NoSuchContract' } },
    ]);
    expect(await client().getTokenMetadata(COLLECTION, '1')).toBeNull();
  });

  it('is null when the gateway 404s the metadata json', async () => {
    stubFetch([
      { match: '/metadata/v1/nft/', body: {} },
      { match: '/v2/contracts/call-read/', body: { okay: true, result: tokenUriOk('https://m.example.test/1.json') } },
      { match: 'm.example.test/1.json', status: 404 },
    ]);
    expect(await client().getTokenMetadata(COLLECTION, '1')).toBeNull();
  });

  it('is null when the body is not JSON', async () => {
    // A gateway serving an HTML error page with a 200, which happens.
    stubFetch([
      { match: '/metadata/v1/nft/', body: {} },
      { match: '/v2/contracts/call-read/', body: { okay: true, result: tokenUriOk('https://m.example.test/1.json') } },
      { match: 'm.example.test/1.json', text: '<html>rate limited</html>', contentType: 'text/html' },
    ]);
    expect(await client().getTokenMetadata(COLLECTION, '1')).toBeNull();
  });

  it('is null for a body over the size cap even when content-length lied about it', async () => {
    // SIP-16 metadata is a few hundred bytes. The declared length is checked
    // first because it lets us bail early, and the real length is checked after
    // because the header is optional and can be wrong.
    stubFetch([
      { match: '/metadata/v1/nft/', body: {} },
      { match: '/v2/contracts/call-read/', body: { okay: true, result: tokenUriOk('https://m.example.test/1.json') } },
      {
        match: 'm.example.test/1.json',
        text: `{"image":"ipfs://Qm/1.jpg","pad":"${'a'.repeat(300_000)}"}`,
        contentLength: '42',
      },
    ]);
    expect(await client().getTokenMetadata(COLLECTION, '1')).toBeNull();
  });

  it('is null for JSON carrying neither a name nor an image', async () => {
    // Nothing display-worthy in it; returning `{}` would only make a caller
    // check the same emptiness again.
    stubFetch([
      { match: '/metadata/v1/nft/', body: {} },
      { match: '/v2/contracts/call-read/', body: { okay: true, result: tokenUriOk('https://m.example.test/1.json') } },
      { match: 'm.example.test/1.json', body: { description: 'a pepe' } },
    ]);
    expect(await client().getTokenMetadata(COLLECTION, '1')).toBeNull();
  });

  it('is null for a token uri in a scheme with no gateway', async () => {
    stubFetch([
      { match: '/metadata/v1/nft/', body: {} },
      { match: '/v2/contracts/call-read/', body: { okay: true, result: tokenUriOk('data:application/json,{}') } },
    ]);
    expect(await client().getTokenMetadata(COLLECTION, '1')).toBeNull();
  });

  it('is null for a non-numeric token id, without asking the contract', async () => {
    // `get-token-uri` takes a uint. Some collections key tokens by string, and
    // those never reach a uint-typed read-only call.
    const { urls } = stubFetch([{ match: '/metadata/v1/nft/', body: {} }]);
    expect(await client().getTokenMetadata(COLLECTION, 'not-a-number')).toBeNull();
    expect(urls.some((u) => u.includes('call-read'))).toBe(false);
  });

  it('keeps an indexed name when the chain fallback finds nothing', async () => {
    // A half-populated Hiro row is still better than no card title.
    stubFetch([
      { match: '/metadata/v1/nft/', body: { metadata: { name: 'Indexed name' } } },
      { match: '/v2/contracts/call-read/', body: { okay: true, result: tokenUriNone() } },
    ]);
    expect(await client().getTokenMetadata(COLLECTION, '1')).toEqual({ name: 'Indexed name' });
  });
});

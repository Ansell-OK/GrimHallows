/**
 * Content URI -> fetchable URL tests.
 *
 * One property: WHAT COMES OUT IS EITHER FETCHABLE OR NULL. The input is a
 * string written by a collection we do not control, in a scheme that is usually
 * a content address rather than a location, so "pass it through and hope" is
 * always wrong — it produces an `<img>` that fails after the card has committed
 * to rendering one, or a server-side fetch of something that was never a URL.
 *
 * The interesting cases are the ones where a naive prepend produces a URL that
 * looks right and 404s: the doubled `ipfs/` segment, and a base58 CID run
 * through a lowercasing rewrite. Both fail at the gateway, where the error is
 * indistinguishable from art that was never pinned.
 */

import { describe, expect, it } from 'vitest';
import { gatewayUrl, substituteTokenId } from '../src/lib/contentUrl.js';

describe('gatewayUrl — content-addressed schemes', () => {
  it('rewrites ipfs:// to a gateway', () => {
    expect(gatewayUrl('ipfs://QmExample/9.png')).toBe('https://ipfs.io/ipfs/QmExample/9.png');
  });

  it('does not double the /ipfs/ segment when the value already carries one', () => {
    // The spelling giga-pepe-v2 actually uses. A plain prepend yields
    // `/ipfs/ipfs/Qm…`, which the gateway answers 404 to.
    expect(gatewayUrl('ipfs://ipfs/QmExample/9.png')).toBe('https://ipfs.io/ipfs/QmExample/9.png');
  });

  it('rewrites ar:// to an Arweave gateway', () => {
    expect(gatewayUrl('ar://Z4ygyXm-fERGzKEB2bvE7gx98SHcoaP8qdZQo0Kxm6Y/1.png')).toBe(
      'https://arweave.net/Z4ygyXm-fERGzKEB2bvE7gx98SHcoaP8qdZQo0Kxm6Y/1.png',
    );
  });

  it('preserves CID case, which a lowercasing rewrite would corrupt', () => {
    // Base58 CIDs are mixed-case and case-significant; folding one produces a
    // gateway 404 that reads like a missing file.
    const cid = 'QmZ4ygYXmFERGzKEB2bvE7gx98SHcoaP8qdZQo0KxM6Y';
    expect(gatewayUrl(`ipfs://${cid}/1.png`)).toBe(`https://ipfs.io/ipfs/${cid}/1.png`);
  });

  it('matches the scheme case-insensitively', () => {
    expect(gatewayUrl('IPFS://QmExample/9.png')).toBe('https://ipfs.io/ipfs/QmExample/9.png');
    expect(gatewayUrl('AR://abc/1.png')).toBe('https://arweave.net/abc/1.png');
  });
});

describe('gatewayUrl — http(s)', () => {
  it('passes an https URL through untouched', () => {
    expect(gatewayUrl('https://cdn.example.com/9.png')).toBe('https://cdn.example.com/9.png');
  });

  it('upgrades http to https', () => {
    // Cannot lose a working image: an http URL is blocked as mixed content on an
    // https page, and the proxy refuses to fetch one. It only rescues hosts that
    // serve TLS but wrote the URL without the 's'.
    expect(gatewayUrl('http://cdn.example.com/9.png')).toBe('https://cdn.example.com/9.png');
  });
});

describe('gatewayUrl — refusals', () => {
  it('returns null for a scheme it has no gateway for', () => {
    // Null rather than the raw string, because the caller either renders this or
    // fetches it — and both are worse with an unfetchable value than with none.
    expect(gatewayUrl('ftp://example.com/a.png')).toBeNull();
    expect(gatewayUrl('file:///etc/passwd')).toBeNull();
    expect(gatewayUrl('data:image/png;base64,iVBORw0KGgo=')).toBeNull();
  });

  it('returns null for a bare CID with no scheme', () => {
    // No way to tell this from a relative path or a typo, and guessing IPFS
    // would send a server-side fetch somewhere on the strength of a guess.
    expect(gatewayUrl('QmBareCidWithNoScheme')).toBeNull();
  });

  it('returns null for absent or blank input', () => {
    expect(gatewayUrl(null)).toBeNull();
    expect(gatewayUrl(undefined)).toBeNull();
    expect(gatewayUrl('')).toBeNull();
    expect(gatewayUrl('   ')).toBeNull();
  });

  it('trims surrounding whitespace rather than failing on it', () => {
    expect(gatewayUrl('  ipfs://QmExample/9.png  ')).toBe('https://ipfs.io/ipfs/QmExample/9.png');
  });
});

describe('substituteTokenId', () => {
  it('replaces SIP-16s {id} placeholder', () => {
    // The reason this function exists: collections return ONE uri for the whole
    // collection. Fetched with the literal `{id}` still in it, every token 404s.
    expect(substituteTokenId('ipfs://ipfs/Qme1zBPY/json/{id}.json', '2135')).toBe(
      'ipfs://ipfs/Qme1zBPY/json/2135.json',
    );
  });

  it('replaces every occurrence, not just the first', () => {
    // Some collections put the id in the directory as well as the filename.
    expect(substituteTokenId('https://x.example/{id}/meta/{id}.json', '7')).toBe(
      'https://x.example/7/meta/7.json',
    );
  });

  it('leaves a uri with no placeholder alone', () => {
    expect(substituteTokenId('https://x.example/7.json', '7')).toBe('https://x.example/7.json');
  });
});

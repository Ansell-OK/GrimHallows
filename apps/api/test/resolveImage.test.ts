/**
 * Image URL resolution tests.
 *
 * One property carries this: WHAT REACHES THE BROWSER MUST BE FETCHABLE BY ONE.
 * NFT metadata is written by collections, not by us, and `image` is routinely a
 * scheme no browser implements. Returning such a value produces an `<img>` that
 * fails after the card has already committed to rendering one; returning null
 * lets the card show its placeholder instead. So every case below is really the
 * same question — is this a URL a browser can load, and if not, did we either
 * convert it or refuse it?
 *
 * The interesting cases are the schemes a naive `startsWith('ipfs://')` check
 * lets through unchanged: `ar://` is as common as `ipfs://` on Stacks, and it
 * was the one that shipped broken.
 */

import { describe, expect, it } from 'vitest';
import { resolveImage } from '../src/services/characterService.js';
import type { TokenMetadata } from '../src/lib/hiro.js';

/** Metadata carrying only the image fields under test. */
function meta(fields: Partial<TokenMetadata>): TokenMetadata {
  return fields as TokenMetadata;
}

describe('resolveImage — schemes a browser cannot fetch', () => {
  it('rewrites ar:// to an Arweave gateway', () => {
    // The bug this file was written for. Explorer Guild and most Arweave-hosted
    // Stacks collections write exactly this, and it used to pass through raw.
    expect(resolveImage(meta({ image: 'ar://Z4ygyXm-fERGzKEB2bvE7gx98SHcoaP8qdZQo0Kxm6Y/1.png' }))).toBe(
      'https://arweave.net/Z4ygyXm-fERGzKEB2bvE7gx98SHcoaP8qdZQo0Kxm6Y/1.png',
    );
  });

  it('rewrites ipfs:// to a gateway', () => {
    expect(resolveImage(meta({ image: 'ipfs://QmExample/9.png' }))).toBe(
      'https://ipfs.io/ipfs/QmExample/9.png',
    );
  });

  it('does not double the /ipfs/ segment when the value already carries one', () => {
    expect(resolveImage(meta({ image: 'ipfs://ipfs/QmExample/9.png' }))).toBe(
      'https://ipfs.io/ipfs/QmExample/9.png',
    );
  });

  it('preserves CID case, which a lowercasing rewrite would corrupt', () => {
    // Base58 CIDs are mixed-case and case-significant — folding one silently
    // produces a gateway 404 that looks like a missing file.
    const cid = 'QmZ4ygYXmFERGzKEB2bvE7gx98SHcoaP8qdZQo0KxM6Y';
    expect(resolveImage(meta({ image: `ipfs://${cid}/1.png` }))).toBe(
      `https://ipfs.io/ipfs/${cid}/1.png`,
    );
  });

  it('returns null for a scheme it has no gateway for', () => {
    // Null, not the raw string: the caller shows a placeholder rather than
    // rendering an <img> that is guaranteed to fail.
    expect(resolveImage(meta({ image: 'ftp://example.com/a.png' }))).toBeNull();
    expect(resolveImage(meta({ image: 'file:///etc/passwd' }))).toBeNull();
    expect(resolveImage(meta({ image: 'QmBareCidWithNoScheme' }))).toBeNull();
  });
});

describe('resolveImage — http(s)', () => {
  it('passes an https URL through untouched', () => {
    expect(resolveImage(meta({ image: 'https://cdn.example.com/9.png' }))).toBe(
      'https://cdn.example.com/9.png',
    );
  });

  it('upgrades http to https', () => {
    // An http image is blocked as mixed content on an https page regardless, so
    // the upgrade cannot lose a working image — it only rescues hosts that
    // serve TLS but wrote the URL without the 's'.
    expect(resolveImage(meta({ image: 'http://cdn.example.com/9.png' }))).toBe(
      'https://cdn.example.com/9.png',
    );
  });

  it('matches the scheme case-insensitively', () => {
    expect(resolveImage(meta({ image: 'HTTPS://cdn.example.com/9.png' }))).toBe(
      'HTTPS://cdn.example.com/9.png',
    );
    expect(resolveImage(meta({ image: 'IPFS://QmExample/9.png' }))).toBe(
      'https://ipfs.io/ipfs/QmExample/9.png',
    );
  });

  it('keeps a data: image, which is already bytes', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgo=';
    expect(resolveImage(meta({ image: uri }))).toBe(uri);
  });

  it('refuses a non-image data: URI', () => {
    expect(resolveImage(meta({ image: 'data:text/html,<script>alert(1)</script>' }))).toBeNull();
  });
});

describe('resolveImage — cached_image preference', () => {
  it('prefers Hiro cached copy over an unfetchable image', () => {
    // The whole reason this field is read: Hiro already did the gateway fetch
    // and put the result on a CDN, so this skips a slow, rate-limited hop.
    const resolved = resolveImage(
      meta({
        image: 'ar://Z4ygyXm/1.png',
        cached_image: 'https://assets.hiro.so/api/mainnet/token-metadata-api/SP1.col/1.png',
      }),
    );
    expect(resolved).toBe('https://assets.hiro.so/api/mainnet/token-metadata-api/SP1.col/1.png');
  });

  it('ignores a cached copy that is not https and falls back to image', () => {
    const resolved = resolveImage(
      meta({ image: 'ipfs://QmExample/9.png', cached_image: 'ar://nope' }),
    );
    expect(resolved).toBe('https://ipfs.io/ipfs/QmExample/9.png');
  });
});

describe('resolveImage — absent', () => {
  it('is null when there is no metadata at all', () => {
    // Normal, not an error — an unindexed token is still a playable character.
    expect(resolveImage(null)).toBeNull();
  });

  it('is null for missing or blank image fields', () => {
    expect(resolveImage(meta({}))).toBeNull();
    expect(resolveImage(meta({ image: '   ' }))).toBeNull();
  });

  it('trims surrounding whitespace rather than failing on it', () => {
    expect(resolveImage(meta({ image: '  ipfs://QmExample/9.png  ' }))).toBe(
      'https://ipfs.io/ipfs/QmExample/9.png',
    );
  });
});

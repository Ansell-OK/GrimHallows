/**
 * Display-image resolver tests.
 *
 * Two properties carry this:
 *   - REMOTE ART GOES THROUGH THE PROXY. A wallet-held token's image lives on a
 *     host we don't control, and loading it straight from the browser fails on
 *     CORS or a gateway rate-limit — both of which render as an empty card. The
 *     URL has to come back pointing at our own API.
 *   - LOCAL ART DOES NOT. Bundled portraits and `data:`/`blob:` URIs are already
 *     ours; proxying them would add a network hop to something that had none and
 *     the proxy would refuse them anyway.
 *
 * The interesting cases are the ones where a sloppier check would send the wrong
 * thing to the proxy: a root-relative bundled path, a protocol-relative URL, a
 * `data:` URI that happens to contain "http".
 */

import { describe, expect, it } from 'vitest';
import { API_URL } from '../src/lib/api';
import { displayImageUrl, isRemoteImage } from '../src/lib/images';

describe('isRemoteImage', () => {
  it('is true for absolute http(s) URLs, whatever the case', () => {
    expect(isRemoteImage('https://ipfs.io/ipfs/Qm/9.png')).toBe(true);
    expect(isRemoteImage('http://example.com/a.png')).toBe(true);
    expect(isRemoteImage('HTTPS://Example.com/a.png')).toBe(true);
  });

  it('is false for a bundled portrait path', () => {
    // What Vite's glob import hands back — same origin, already hashed.
    expect(isRemoteImage('/assets/warrior-epic.a1b2c3.jpg')).toBe(false);
  });

  it('is false for inline and object URIs', () => {
    expect(isRemoteImage('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
    expect(isRemoteImage('blob:http://localhost:5173/8b3f')).toBe(false);
  });

  it('is false for a protocol-relative URL', () => {
    // `//host/a.png` is remote in a browser, but nothing in this app produces
    // one, and treating it as local means it fails visibly rather than being
    // handed to a proxy that would reject it as MALFORMED_URL anyway.
    expect(isRemoteImage('//ipfs.io/ipfs/Qm/9.png')).toBe(false);
  });

  it('ignores surrounding whitespace rather than deciding on it', () => {
    expect(isRemoteImage('  https://ipfs.io/a.png ')).toBe(true);
  });
});

describe('displayImageUrl', () => {
  it('routes a remote image through the API proxy', () => {
    const out = displayImageUrl('https://ipfs.io/ipfs/Qm/9.png');
    expect(out).toBe(`${API_URL}/image-proxy?url=${encodeURIComponent('https://ipfs.io/ipfs/Qm/9.png')}`);
  });

  it('encodes the target so its query string cannot become ours', () => {
    // A raw `&` here would split into a second parameter and the proxy would
    // fetch a truncated URL — a 404 that looks like a broken collection.
    const target = 'https://cdn.example.com/img?id=9&size=full';
    const out = displayImageUrl(target);
    expect(out).toContain(encodeURIComponent(target));
    expect(out).not.toContain('&size=full');
  });

  it('leaves a bundled portrait exactly as it was', () => {
    const portrait = '/assets/mage-mythic.a1b2c3.jpg';
    expect(displayImageUrl(portrait)).toBe(portrait);
  });

  it('leaves a data URI alone', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgo=';
    expect(displayImageUrl(uri)).toBe(uri);
  });

  it('returns undefined for nothing, so the caller shows the placeholder', () => {
    // `undefined` rather than '' — an empty src makes a browser re-request the
    // page itself, which is how a missing image turns into a broken-image icon.
    expect(displayImageUrl(null)).toBeUndefined();
    expect(displayImageUrl(undefined)).toBeUndefined();
    expect(displayImageUrl('')).toBeUndefined();
    expect(displayImageUrl('   ')).toBeUndefined();
  });

  it('trims before proxying, so a padded URL is not double-encoded', () => {
    const out = displayImageUrl('  https://ipfs.io/a.png  ');
    expect(out).toBe(`${API_URL}/image-proxy?url=${encodeURIComponent('https://ipfs.io/a.png')}`);
  });
});

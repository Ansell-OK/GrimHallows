/**
 * Image-proxy guard tests.
 *
 * This route takes a URL from anyone and fetches it server-side, in a process
 * whose environment holds `ORACLE_PRIVATE_KEY` — a key that can move sponsor-pool
 * funds. So these tests are almost entirely about what it REFUSES. The
 * happy-path case is one test; the rest are the SSRF payloads, each written as
 * the specific bypass it represents rather than as a generic "bad input", because
 * a guard that blocks `127.0.0.1` and not `::ffff:127.0.0.1` reads as passing.
 *
 * `fetchProxiedImage` takes an injected fetch, so every case runs without a
 * network — including the redirect chain, which is the one behaviour that cannot
 * be tested by inspecting a URL.
 */

import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import {
  MAX_IMAGE_BYTES,
  assertProxyableUrl,
  isAllowedImageType,
  isBlockedHost,
} from '../src/lib/imageProxy.js';
import { fetchProxiedImage } from '../src/routes/imageProxy.js';

/** The code an ApiError carried, or the failure itself if it was something else. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }
  throw new Error('Expected a rejection, got none.');
}

function imageResponse(
  body: Uint8Array | string = 'PNGDATA',
  contentType = 'image/png',
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === 'string' ? new TextEncoder().encode(body) : body, {
    status: 200,
    headers: { 'content-type': contentType, ...headers },
  });
}

describe('assertProxyableUrl — scheme and shape', () => {
  it('accepts an ordinary https image URL', () => {
    const url = assertProxyableUrl('https://ipfs.io/ipfs/QmExample/9.png');
    expect(url.hostname).toBe('ipfs.io');
  });

  it('rejects an empty url instead of fetching something arbitrary', async () => {
    expect(await codeOf(async () => assertProxyableUrl('  '))).toBe('MISSING_URL');
  });

  it('rejects a string that is not a URL', async () => {
    expect(await codeOf(async () => assertProxyableUrl('not-a-url'))).toBe('MALFORMED_URL');
  });

  it('rejects http, which an in-path attacker could rewrite', async () => {
    expect(await codeOf(async () => assertProxyableUrl('http://example.com/a.png'))).toBe(
      'UNSUPPORTED_SCHEME',
    );
  });

  it('rejects file://, which would read the API host disk', async () => {
    expect(await codeOf(async () => assertProxyableUrl('file:///etc/passwd'))).toBe(
      'UNSUPPORTED_SCHEME',
    );
  });

  it('rejects embedded credentials rather than replaying them to a host', async () => {
    expect(await codeOf(async () => assertProxyableUrl('https://u:p@example.com/a.png'))).toBe(
      'CREDENTIALS_IN_URL',
    );
  });

  it('rejects a non-default port, which turns a fetch into a port scanner', async () => {
    expect(await codeOf(async () => assertProxyableUrl('https://example.com:22/a.png'))).toBe(
      'UNSUPPORTED_PORT',
    );
  });

  it('allows an explicit :443, which is the default written out', () => {
    expect(assertProxyableUrl('https://example.com:443/a.png').hostname).toBe('example.com');
  });
});

describe('isBlockedHost — the SSRF payloads', () => {
  it('blocks the cloud metadata address', () => {
    // The single highest-value SSRF target on any hosted platform.
    expect(isBlockedHost('169.254.169.254')).toBe(true);
  });

  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.0.0.5', 'private class A'],
    ['172.16.0.1', 'private class B, low end'],
    ['172.31.255.255', 'private class B, high end'],
    ['192.168.1.1', 'private class C'],
    ['100.64.0.1', 'CGNAT'],
    ['0.0.0.0', 'this-host'],
    ['255.255.255.255', 'broadcast'],
  ])('blocks %s (%s)', (host) => {
    expect(isBlockedHost(host)).toBe(true);
  });

  it('blocks localhost and local-only suffixes', () => {
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('db.internal')).toBe(true);
    expect(isBlockedHost('printer.local')).toBe(true);
  });

  it('blocks a trailing-dot FQDN spelling of localhost', () => {
    // `localhost.` resolves the same and would slip a naive equality check.
    expect(isBlockedHost('localhost.')).toBe(true);
  });

  it('blocks IPv6 loopback and unique-local', () => {
    expect(isBlockedHost('::1')).toBe(true);
    expect(isBlockedHost('[::1]')).toBe(true);
    expect(isBlockedHost('fd00::1')).toBe(true);
    expect(isBlockedHost('fe80::1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6, the spelling a dotted-quad check misses', () => {
    // ::ffff:127.0.0.1 IS 127.0.0.1. A guard that only understands dotted quads
    // passes this straight through, which is why it gets its own test.
    expect(isBlockedHost('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedHost('[::ffff:169.254.169.254]')).toBe(true);
  });

  it('allows ordinary public hosts', () => {
    expect(isBlockedHost('ipfs.io')).toBe(false);
    expect(isBlockedHost('arweave.net')).toBe(false);
    expect(isBlockedHost('gateway.pinata.cloud')).toBe(false);
    expect(isBlockedHost('8.8.8.8')).toBe(false);
  });

  it('reports the block through assertProxyableUrl as BLOCKED_HOST', async () => {
    expect(
      await codeOf(async () => assertProxyableUrl('https://169.254.169.254/latest/meta-data/')),
    ).toBe('BLOCKED_HOST');
  });
});

describe('isAllowedImageType', () => {
  it('accepts the common raster types, with or without a charset', () => {
    expect(isAllowedImageType('image/png')).toBe(true);
    expect(isAllowedImageType('image/jpeg; charset=binary')).toBe(true);
    expect(isAllowedImageType('IMAGE/WEBP')).toBe(true);
  });

  it('refuses SVG, which is a scriptable document, not a picture', () => {
    // Returned from our own origin, a proxied SVG would be stored XSS against
    // this domain. No collection's art is worth that.
    expect(isAllowedImageType('image/svg+xml')).toBe(false);
  });

  it('refuses non-images, which is what stops this being a general URL fetcher', () => {
    expect(isAllowedImageType('text/html')).toBe(false);
    expect(isAllowedImageType('application/json')).toBe(false);
    expect(isAllowedImageType(null)).toBe(false);
  });
});

describe('fetchProxiedImage', () => {
  it('returns the bytes and normalised type for a real image', async () => {
    const fetchImpl = vi.fn(async () => imageResponse('PNGDATA', 'image/png; charset=binary'));
    const image = await fetchProxiedImage('https://ipfs.io/ipfs/Qm/9.png', fetchImpl as never);

    expect(image.contentType).toBe('image/png');
    expect(image.body.toString()).toBe('PNGDATA');
  });

  it('never calls fetch at all for a blocked host', async () => {
    // The guard has to run BEFORE the request, or the SSRF already happened.
    const fetchImpl = vi.fn(async () => imageResponse());
    await expect(
      fetchProxiedImage('https://169.254.169.254/latest/meta-data/', fetchImpl as never),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows a redirect between public hosts', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://cf-ipfs.com/a.png' } }),
      )
      .mockResolvedValueOnce(imageResponse('REDIRECTED'));

    const image = await fetchProxiedImage('https://ipfs.io/a.png', fetchImpl as never);
    expect(image.body.toString()).toBe('REDIRECTED');
  });

  it('re-validates each redirect, so a public host cannot bounce us onto a private one', async () => {
    // The bypass this whole manual-redirect dance exists for: the URL passes
    // every check, and the allowed host answers with a Location pointing at the
    // metadata service.
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );

    expect(
      await codeOf(() => fetchProxiedImage('https://evil.example/a.png', fetchImpl as never)),
    ).toBe('UNSUPPORTED_SCHEME');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative redirect against the URL that issued it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: '/canonical/a.png' } }),
      )
      .mockResolvedValueOnce(imageResponse('MOVED'));

    const image = await fetchProxiedImage('https://ipfs.io/orig/a.png', fetchImpl as never);
    expect(image.body.toString()).toBe('MOVED');
    expect(String(fetchImpl.mock.calls[1][0])).toBe('https://ipfs.io/canonical/a.png');
  });

  it('gives up on a redirect loop rather than following forever', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://ipfs.io/loop.png' } }),
    );
    expect(
      await codeOf(() => fetchProxiedImage('https://ipfs.io/loop.png', fetchImpl as never)),
    ).toBe('TOO_MANY_REDIRECTS');
  });

  it('rejects a non-image body even when the host and scheme are fine', async () => {
    const fetchImpl = vi.fn(async () => imageResponse('<html>', 'text/html'));
    expect(
      await codeOf(() => fetchProxiedImage('https://example.com/page', fetchImpl as never)),
    ).toBe('NOT_AN_IMAGE');
  });

  it('rejects an oversized body declared in content-length', async () => {
    const fetchImpl = vi.fn(async () =>
      imageResponse('x', 'image/png', { 'content-length': String(MAX_IMAGE_BYTES + 1) }),
    );
    expect(
      await codeOf(() => fetchProxiedImage('https://example.com/big.png', fetchImpl as never)),
    ).toBe('IMAGE_TOO_LARGE');
  });

  it('rejects an oversized body that lied about its content-length', async () => {
    // The cap has to hold on the bytes actually received, not on the header —
    // a host that under-declares is the only one that matters here.
    const fetchImpl = vi.fn(async () =>
      imageResponse(new Uint8Array(MAX_IMAGE_BYTES + 10), 'image/png', { 'content-length': '10' }),
    );
    expect(
      await codeOf(() => fetchProxiedImage('https://example.com/liar.png', fetchImpl as never)),
    ).toBe('IMAGE_TOO_LARGE');
  });

  it('reports an upstream error status as a 502, not as our own 500', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    expect(
      await codeOf(() => fetchProxiedImage('https://example.com/gone.png', fetchImpl as never)),
    ).toBe('IMAGE_FETCH_FAILED');
  });

  it('turns a network failure into a 502 rather than leaking the cause', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED 10.0.0.1:443');
    });
    expect(
      await codeOf(() => fetchProxiedImage('https://example.com/a.png', fetchImpl as never)),
    ).toBe('IMAGE_FETCH_FAILED');
  });
});

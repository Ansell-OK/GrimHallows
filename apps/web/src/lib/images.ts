/**
 * Where a character card's picture is actually loaded from.
 *
 * The API hands back `imageUrl` pointing at whatever host a collection chose —
 * an IPFS gateway, Arweave, someone's S3 bucket. Loading those straight from the
 * browser fails two ways that both render as an empty card: the host refuses the
 * cross-origin request, or `ipfs.io` rate-limits a screen full of cards at once.
 * Routing them through the API's `/image-proxy` makes both our problem, which is
 * the only place either can be fixed. See `apps/api/src/lib/imageProxy.ts` for
 * what that route will and will not fetch.
 *
 * WHAT IS NOT PROXIED, and why the check is "is this remote" rather than "is this
 * a URL": bundled portraits (`portraits.ts`) resolve to a hashed path on our own
 * origin, and `data:`/`blob:` URIs are already local bytes. Sending either
 * through the proxy would add a network hop to something that had none, and the
 * proxy would refuse it anyway. Only absolute http(s) URLs are remote.
 *
 * WHY THIS IS CLIENT-SIDE rather than the API returning a pre-proxied URL: the
 * API caches `CharacterIdentity` rows in Postgres, so a stored URL carrying the
 * API's own origin would outlive a domain change and break every cached card.
 * Same reasoning that keeps portrait resolution out of the API — see the header
 * of `portraits.ts`.
 */

import { API_URL } from './api';

/** True for a URL that points at some other origin and needs the proxy. */
export function isRemoteImage(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * The URL to put in an `<img src>` for a character's picture.
 *
 * `undefined` for a missing image, so a caller can fall back to the class-icon
 * placeholder rather than rendering an empty frame.
 */
export function displayImageUrl(raw: string | null | undefined): string | undefined {
  const url = raw?.trim();
  if (!url) return undefined;
  if (!isRemoteImage(url)) return url;
  return `${API_URL}/image-proxy?url=${encodeURIComponent(url)}`;
}

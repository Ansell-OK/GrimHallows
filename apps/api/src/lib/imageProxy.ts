/**
 * The guard in front of `GET /image-proxy` — 9-bugfixes-and-additions-prompt.md A1
 * step 3.
 *
 * WHY A PROXY EXISTS AT ALL. Wallet-held NFT art lives on hosts we do not
 * control: IPFS gateways, Arweave, a collection's own S3 bucket. Loading those
 * straight from the browser fails in two ways that look identical to the player
 * (an empty card) and different to a developer: the host refuses the
 * cross-origin load, or `ipfs.io` rate-limits a burst of a dozen cards. Fetching
 * server-side turns both into our problem, which is the only place they can be
 * fixed.
 *
 * WHY IT IS THE MOST DANGEROUS ROUTE IN THIS CODEBASE. "Fetch the URL in this
 * query parameter and return the body" is a server-side request forgery
 * primitive. Pointed at `http://169.254.169.254/latest/meta-data/` it reads the
 * host's cloud credentials; pointed at a private address it port-scans the
 * network the API sits inside. That matters more here than in most apps, because
 * this API's environment holds `ORACLE_PRIVATE_KEY` — a key that can move
 * sponsor-pool funds (08-deployment.md#7). So this module is a deny-by-default
 * allowlist, and every rule below is load-bearing:
 *
 *   - **https only.** Plain http would let an in-path attacker swap the bytes,
 *     and the API's own `ipfs://` rewrite already emits https. A collection
 *     reachable only over http loses its art rather than downgrading everyone.
 *   - **No credentials in the URL.** `https://user:pass@host/` would have us
 *     replay someone's basic-auth to an arbitrary host.
 *   - **Default port only.** An arbitrary port is how a fetch primitive becomes
 *     a port scanner; :443 is where public image hosts already are.
 *   - **No private, loopback, link-local, or CGNAT host.** The SSRF payload
 *     itself. Covers IPv4, IPv6, and IPv4-mapped IPv6 (`::ffff:127.0.0.1`),
 *     because a check that only understands dotted quads is a check that can be
 *     spelled around.
 *   - **Redirects re-validated, never blindly followed.** A URL on a perfectly
 *     public host is allowed to answer `302 Location: http://169.254.169.254/`.
 *     Following that would undo every rule above, so each hop goes back through
 *     `assertProxyableUrl`.
 *
 * KNOWN RESIDUAL, STATED RATHER THAN PAPERED OVER: this validates a *hostname*,
 * and the connection resolves that name again afterwards. A DNS entry that
 * answers public on the first lookup and private on the second (rebinding)
 * survives these checks. Closing it properly means resolving to an IP here and
 * connecting to the literal with a `Host` header, which Node's fetch will not do
 * without a custom agent. Documented as an accepted limitation in the same shape
 * as the oracle-centralization trade-off, not treated as handled.
 */

import { badRequest } from './errors.js';

/** Hard cap on a proxied body. Card art an order of magnitude over this is a mistake. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Upstream fetch deadline. Also what bounds a host that streams forever. */
export const IMAGE_FETCH_TIMEOUT_MS = 8_000;

/** Redirect hops followed, each re-validated. Enough for a gateway's canonical redirect. */
export const MAX_IMAGE_REDIRECTS = 3;

/**
 * Content types served back to the browser.
 *
 * `image/svg+xml` is deliberately absent. An SVG is a document that can carry
 * script, and this route returns it from the API's own origin — so proxying one
 * would be stored XSS against this domain rather than a picture. No NFT needs it
 * badly enough to be worth that.
 */
const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/apng',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
] as const;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Hostnames that never name a public host, whatever DNS says. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function isPrivateIpv4(host: string): boolean {
  const m = IPV4.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const octets = [a, b, Number(m[3]), Number(m[4])];
  if (octets.some((o) => o > 255)) return true; // Not a valid address; refuse it.

  if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
  if (a === 169 && b === 254) return true; // link-local — the cloud metadata range
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // protocol assignments (incl. 192.0.0.0/24)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes(':')) return false;

  // An IPv4-mapped or -embedded form is an IPv4 address wearing a costume.
  const tail = h.slice(h.lastIndexOf(':') + 1);
  if (IPV4.test(tail)) return isPrivateIpv4(tail);

  const bare = h.split('%')[0]; // strip any zone id
  if (bare === '::1' || bare === '::') return true; // loopback, unspecified
  if (/^f[cd]/.test(bare)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(bare)) return true; // fe80::/10 link-local
  if (bare.startsWith('ff')) return true; // multicast
  return false;
}

/** True when a hostname can never legitimately serve public NFT art. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost') return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}

/**
 * Parse and vet a candidate image URL, or throw the 400 explaining which rule it
 * broke.
 *
 * Every rejection names its reason. A silent "no" here would land as an unloadable
 * card with no way to tell a blocked host from a typo — the exact silent failure
 * A1 step 4 exists to remove.
 */
export function assertProxyableUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) throw badRequest('MISSING_URL', 'url query parameter is required.');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw badRequest('MALFORMED_URL', `${trimmed} is not a URL.`);
  }

  if (url.protocol !== 'https:') {
    throw badRequest('UNSUPPORTED_SCHEME', `Only https image URLs are proxied, not ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw badRequest('CREDENTIALS_IN_URL', 'An image URL must not carry credentials.');
  }
  if (url.port && url.port !== '443') {
    throw badRequest('UNSUPPORTED_PORT', `Only the default https port is proxied, not ${url.port}`);
  }
  if (isBlockedHost(url.hostname)) {
    throw badRequest('BLOCKED_HOST', `${url.hostname} is not a public host.`);
  }
  return url;
}

/** True when an upstream content-type is an image we are willing to pass through. */
export function isAllowedImageType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(type);
}

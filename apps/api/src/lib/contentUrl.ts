/**
 * Content-addressed URI -> a URL a browser (or `fetch`) can actually load.
 *
 * This exists because the same conversion is needed in two places that must
 * never disagree: `resolveImage`, which decides what a card's `<img src>` gets,
 * and the on-chain token-uri fallback in `hiro.ts`, which has to fetch a
 * collection's metadata JSON from whatever scheme `get-token-uri` returned. Two
 * copies of "strip `ipfs://`, prepend a gateway" is two chances to fix a bug in
 * only one of them — `ar://` shipped broken in exactly that way once already.
 *
 * WHAT MAKES THIS NON-OBVIOUS is that the input is not ours. `image` and
 * `get-token-uri` are written by collections, and the schemes they use are
 * content addresses rather than locations: `ipfs://`, `ipfs://ipfs/` (the
 * doubled segment, which a naive prepend turns into `/ipfs/ipfs/`), and `ar://`,
 * which is as common as IPFS on Stacks. None of them is fetchable as written.
 *
 * NULL RATHER THAN THE RAW STRING for anything else, deliberately. A caller that
 * receives null can show a placeholder or skip a fetch; a caller handed back
 * `ftp://…` learns it was unfetchable only after committing to load it. That
 * also makes this the first line of defence in front of a URL the API is about
 * to fetch server-side: `file:///etc/passwd` leaves here as null, and what does
 * survive is re-vetted by `assertProxyableUrl` before any request is made.
 */

/**
 * Public gateways for the two content-addressed schemes NFT metadata uses.
 *
 * Both are slow and rate-limit a burst, which is why images fetched through
 * these go via `/image-proxy` (cached, one hop per URL) rather than from a wall
 * of cards in the browser.
 */
export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
export const ARWEAVE_GATEWAY = 'https://arweave.net/';

/**
 * The https URL for a content URI, or null when there is no gateway for it.
 *
 * Scheme matching is case-insensitive; the rest of the value is never
 * lowercased, because a base58 CID is case-significant and folding one produces
 * a gateway 404 that reads like a missing file.
 */
export function gatewayUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;

  const scheme = value.toLowerCase();

  if (scheme.startsWith('https://')) return value;
  // An http URL is blocked as mixed content on an https page anyway, and the
  // proxy refuses to fetch one, so the upgrade cannot lose a working image — it
  // only rescues hosts that serve TLS but wrote the URL without the 's'.
  if (scheme.startsWith('http://')) return `https://${value.slice('http://'.length)}`;
  if (scheme.startsWith('ipfs://')) {
    // `ipfs://ipfs/Qm…` is a real spelling in the wild; the gateway path already
    // carries `/ipfs/`, so the leading segment has to come off or the path
    // doubles.
    return `${IPFS_GATEWAY}${value.slice('ipfs://'.length).replace(/^ipfs\//i, '')}`;
  }
  if (scheme.startsWith('ar://')) return `${ARWEAVE_GATEWAY}${value.slice('ar://'.length)}`;

  return null;
}

/**
 * Substitute SIP-16's `{id}` placeholder in a token URI.
 *
 * SIP-16 lets `get-token-uri` return one URI for the whole collection with a
 * literal `{id}` in it, and most Stacks collections do — giga-pepe-v2 returns
 * `ipfs://ipfs/Qme1zBPY…/json/{id}.json` for every token. Fetching that string
 * unchanged gets a 404 from the gateway, which looks identical to a collection
 * that simply has no metadata. Every occurrence is replaced, since the id
 * appears in both the directory and the filename in some collections.
 */
export function substituteTokenId(uri: string, tokenId: string): string {
  return uri.replace(/\{id\}/g, tokenId);
}

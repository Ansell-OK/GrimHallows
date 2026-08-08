/**
 * Image proxy — 9-bugfixes-and-additions-prompt.md A1 step 3.
 *
 *   GET /image-proxy?url=https://... -> the image bytes, from our origin
 *
 * Public and unauthenticated, like `/map` and `/characters`: it returns bytes
 * that are already public at their source, and a session requirement would only
 * stop the case that matters least. What keeps it from being an open relay is
 * `lib/imageProxy.ts`'s allowlist, not authentication — read that module's header
 * before changing anything here, including the residual DNS-rebinding note.
 *
 * The response deliberately carries none of the upstream's headers except a
 * validated `content-type`. Passing an arbitrary host's `set-cookie` or CSP
 * through on our own origin would let whatever served the picture speak as us.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { ApiError, badRequest } from '../lib/errors.js';
import {
  IMAGE_FETCH_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_REDIRECTS,
  assertProxyableUrl,
  isAllowedImageType,
} from '../lib/imageProxy.js';

export interface ImageProxyRouteDeps {
  /** Injected in tests so the guard can be exercised without a network. */
  readonly fetchImpl?: typeof fetch;
}

export interface ProxiedImage {
  readonly contentType: string;
  readonly body: Buffer;
}

/**
 * Read a response body, refusing anything over the cap.
 *
 * Streamed with a running total rather than `arrayBuffer()`, because the cap has
 * to hold against a host that never stops sending. `arrayBuffer()` would buffer
 * the whole thing first and only then let us measure it — which is the one moment
 * the limit needed to apply. A missing or lying `content-length` changes nothing.
 */
async function readCapped(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw badRequest('IMAGE_TOO_LARGE', `Image exceeds the ${MAX_IMAGE_BYTES}-byte cap.`);
  }

  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw badRequest('IMAGE_TOO_LARGE', `Image exceeds the ${MAX_IMAGE_BYTES}-byte cap.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch one vetted image, following up to `MAX_IMAGE_REDIRECTS` hops.
 *
 * `redirect: 'manual'` is the point: each `Location` is resolved against the URL
 * that issued it and then re-validated from scratch, so a public host cannot
 * redirect us onto a private one.
 */
export async function fetchProxiedImage(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProxiedImage> {
  let url = assertProxyableUrl(rawUrl);

  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop += 1) {
    const signal = AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: 'manual',
        signal,
        headers: { accept: 'image/*' },
      });
    } catch {
      // A DNS failure, a refused connection and a timeout are all the same
      // answer to the caller, and none of them is the browser's fault.
      throw new ApiError(502, 'IMAGE_FETCH_FAILED', `Could not fetch ${url.hostname}.`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new ApiError(502, 'IMAGE_FETCH_FAILED', 'Upstream redirected with no location.');
      }
      // Re-validated, not trusted — see this function's header.
      url = assertProxyableUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      throw new ApiError(
        502,
        'IMAGE_FETCH_FAILED',
        `Upstream answered ${response.status} for ${url.hostname}.`,
      );
    }

    const contentType = response.headers.get('content-type');
    if (!isAllowedImageType(contentType)) {
      // The check that keeps this from being a general-purpose URL fetcher: a
      // host that answers with HTML or JSON was not serving a picture.
      throw badRequest(
        'NOT_AN_IMAGE',
        `${url.hostname} answered with ${contentType ?? 'no content type'}, not a supported image.`,
      );
    }

    return {
      contentType: contentType!.split(';')[0].trim().toLowerCase(),
      body: await readCapped(response),
    };
  }

  throw new ApiError(502, 'TOO_MANY_REDIRECTS', 'Upstream redirected too many times.');
}

function sendImage(reply: FastifyReply, image: ProxiedImage): FastifyReply {
  return reply
    .header('content-type', image.contentType)
    // NFT art at a given URL is immutable in practice, and the whole reason this
    // route exists is to stop a wall of cards hammering a rate-limited gateway.
    .header('cache-control', 'public, max-age=86400, immutable')
    // The content type was allowlisted above; forbid the browser second-guessing
    // it, since a sniffed type is how a non-image gets executed as one.
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .send(image.body);
}

export async function registerImageProxyRoutes(
  app: FastifyInstance,
  deps: ImageProxyRouteDeps = {},
): Promise<void> {
  app.get('/image-proxy', async (request, reply) => {
    const url = String((request.query as { url?: unknown } | undefined)?.url ?? '');
    const image = await fetchProxiedImage(url, deps.fetchImpl ?? fetch);
    return sendImage(reply, image);
  });
}

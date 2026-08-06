/**
 * Error convention — 04-backend-api-spec.md#10.
 *
 *   { "error": { "code": "STRING_CODE", "message": "..." } }
 *
 * Money-related failures map straight back to the underlying contract error
 * where possible, so a player sees the same reason the chain gave rather than a
 * paraphrase invented by this layer.
 */

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

export const badRequest = (code: string, message: string) =>
  new ApiError(400, code, message);

export const unauthorized = (code: string, message: string) =>
  new ApiError(401, code, message);

export const forbidden = (code: string, message: string) =>
  new ApiError(403, code, message);

export const notFound = (code: string, message: string) =>
  new ApiError(404, code, message);

export const conflict = (code: string, message: string) =>
  new ApiError(409, code, message);

/**
 * A route that exists in the spec but is not built yet.
 *
 * Deliberately loud. The alternative — returning a plausible-looking payload
 * for an unfinished money path — is how a fake transaction gets signed.
 */
export const notImplemented = (code: string, message: string) =>
  new ApiError(501, code, message);

/** Upstream chain/indexer failure — ours to retry, not the caller's to fix. */
export const upstreamUnavailable = (message: string) =>
  new ApiError(503, 'UPSTREAM_UNAVAILABLE', message);

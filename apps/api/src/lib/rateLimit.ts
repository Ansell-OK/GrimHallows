import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';

export interface RateLimitRule {
  readonly max: number;
  readonly windowMs: number;
  readonly key?: (request: FastifyRequest) => string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Small, dependency-free request limiter for the API process.
 *
 * This is deliberately a first line of defence, not a claim of global
 * coordination across Vercel instances. Production still needs an edge/WAF
 * limit; this protects warm instances and makes abuse behavior testable in the
 * application itself.
 */
export class MemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly rules: Readonly<Record<string, RateLimitRule>>) {}

  check(request: FastifyRequest, reply: FastifyReply): void {
    const route = request.routeOptions.url;
    if (!route) return;
    const rule = this.rules[route];
    if (!rule) return;

    const now = Date.now();
    const key = `${route}:${rule.key?.(request) ?? request.ip}`;
    const current = this.buckets.get(key);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + rule.windowMs }
      : current;

    bucket.count += 1;
    this.buckets.set(key, bucket);
    if (bucket.count > rule.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      reply.header('retry-after', String(retryAfter));
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
    }

    // Bound memory when a long-lived process sees many one-off addresses.
    if (this.buckets.size > 10_000) {
      for (const [bucketKey, value] of this.buckets) {
        if (value.resetAt <= now) this.buckets.delete(bucketKey);
      }
    }
  }
}

export const DEFAULT_RATE_LIMIT_RULES: Readonly<Record<string, RateLimitRule>> = {
  '/auth/challenge': { max: 10, windowMs: 60_000 },
  '/auth/verify': {
    max: 5,
    windowMs: 60_000,
    key: (request) => {
      const body = request.body as { address?: unknown } | undefined;
      return typeof body?.address === 'string' ? `${request.ip}:${body.address}` : request.ip;
    },
  },
  '/image-proxy': { max: 60, windowMs: 60_000 },
  '/characters': { max: 30, windowMs: 60_000 },
  '/jobs/loot-mint': { max: 5, windowMs: 60_000 },
  '/admin/fund-pool': { max: 5, windowMs: 60_000, key: credentialKey },
  '/characters/mint': { max: 60, windowMs: 60_000, key: credentialKey },
  '/dungeons/:id/enter': { max: 60, windowMs: 60_000, key: credentialKey },
  '/dungeons/:id/claim': { max: 60, windowMs: 60_000, key: credentialKey },
  '/forge': { max: 60, windowMs: 60_000, key: credentialKey },
  '/runs/:runId/actions': { max: 60, windowMs: 60_000, key: credentialKey },
};

/**
 * Bucket authenticated writes without parsing or trusting JWT claims here.
 * The route still performs authoritative verification. Hashing avoids retaining
 * bearer credentials verbatim in a long-lived process heap.
 */
function credentialKey(request: FastifyRequest): string {
  const authorization = request.headers.authorization?.trim();
  const runHeader = request.headers['x-run-token'];
  const runToken = Array.isArray(runHeader) ? runHeader[0] : runHeader;
  const credential = authorization || runToken?.trim();
  return credential
    ? createHash('sha256').update(credential).digest('hex')
    : request.ip;
}

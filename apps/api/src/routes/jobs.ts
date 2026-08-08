/**
 * Scheduled-job endpoints — an external clock for a host that has no timers.
 *
 *   GET  /jobs/loot-mint
 *   POST /jobs/loot-mint
 *
 * WHY THIS EXISTS AT ALL (docs/09 B7)
 *
 * The free-run loot minter is the one background job in this API that cannot be
 * driven either of the two ways the others are. A `setInterval` is inert on
 * serverless — the instance is frozen the moment it responds, so the callback
 * never fires again. And it cannot hang off a read the way `onDemand.ts` drives
 * the spawner and the indexer, because that file's rule is explicit: no payment,
 * attestation, or on-chain settlement may be scheduled by request traffic. This
 * job broadcasts oracle-signed transactions that mint an NFT a player has already
 * been shown on their reward screen. A drop that only advances while somebody
 * happens to be browsing is a drop that never arrives for the player who earned it
 * and then closed the tab.
 *
 * That leaves one option on a platform like Vercel: let the platform's own clock
 * make an HTTP request. This is that request.
 *
 * WHY A SHARED SECRET AND NOT A SESSION
 *
 * Every other guarded route in this API authenticates a *wallet* — a session token
 * is proof someone signed a challenge with the key for an address. A cron has no
 * wallet and no address, so there is nothing for `requireSession` to check. A
 * shared secret is the honest shape for "the caller is the operator's scheduler".
 * `CRON_SECRET` is the name Vercel looks for: when a variable by that name exists,
 * the platform sends `Authorization: Bearer $CRON_SECRET` on every cron invocation
 * of its own accord. Gating on anything else would mean gating on a header the
 * platform does not send.
 *
 * WHAT THE SECRET IS WORTH, PRECISELY
 *
 * It starts a pass. It cannot choose what the pass does: the work list is runs the
 * reward table already resolved and recorded, and the ceremony only ever advances
 * one of those by one step. So a leaked secret cannot mint a drop nobody drew,
 * cannot move sponsor-pool STX, and cannot reach any other route. What it can do is
 * spend the oracle account's STX on transaction fees by racing legitimate passes
 * into double-broadcasting a step — a real cost, and the reason the gate is here
 * rather than the endpoint being open.
 *
 * The pass runs through `LootMinterLoop.tick()` rather than `runOnce()` directly,
 * so this shares the loop's in-flight guard with the timer. An operator who leaves
 * both drivers on gets a skipped pass, not two ceremonies broadcasting the same
 * step.
 *
 * GET IS THE ODD ONE, AND IT IS NOT A CHOICE. A state-changing GET is normally a
 * mistake, but Vercel Cron issues GET and nothing else. POST is registered
 * alongside it for anything with a say in the matter — a hosted timer, or an
 * operator running a pass by hand.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bearerToken } from '../lib/jwt.js';
import { notImplemented, unauthorized } from '../lib/errors.js';
import type { LootMinterLoop } from '../oracle/lootMinterLoop.js';

/**
 * Below this, warn at boot.
 *
 * Not enforced. Refusing to serve would turn a weak secret into a silent cron
 * failure at 3am, which is worse than the weakness — and the endpoint cannot be
 * made to do anything but the work it was already going to do. A log line the
 * operator sees on their first deploy is the proportionate answer.
 */
const SHORT_SECRET_CHARS = 16;

export interface JobRouteDeps {
  /**
   * The shared secret, or null when `CRON_SECRET` is unset.
   *
   * Null disables the route rather than opening it — same stance as the admin
   * surface's unset owner address. An unconfigured gate is never "no gate".
   */
  readonly cronSecret: string | null;
  /**
   * The driver for one pass, or null when no secret is configured.
   *
   * Typed as the loop rather than the minter because `tick()` is what carries the
   * overlap guard; `runOnce()` would hand this route a way around it.
   */
  readonly lootMinter: LootMinterLoop | null;
}

/**
 * Constant-time secret comparison over SHA-256 digests.
 *
 * Digests rather than the raw strings so the compare is over two fixed 32-byte
 * buffers. `timingSafeEqual` throws on a length mismatch, and the usual guard for
 * that — comparing lengths first — leaks the secret's length to anyone who can
 * time the endpoint. That does not matter much for a JWT signature, whose length
 * is fixed and public anyway (lib/jwt.ts), but this secret is operator-chosen and
 * long-lived, and its length is the first thing a guesser wants.
 */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export async function registerJobRoutes(
  app: FastifyInstance,
  deps: JobRouteDeps,
): Promise<void> {
  if (deps.cronSecret && deps.cronSecret.length < SHORT_SECRET_CHARS) {
    app.log.warn(
      { minimumChars: SHORT_SECRET_CHARS },
      'CRON_SECRET is short — a guessable one lets anyone spend oracle fees; ' +
        'generate it with `openssl rand -hex 32`',
    );
  }

  const runPass = async (request: FastifyRequest, reply: FastifyReply) => {
    // A GET that is not a read. Nothing in front of this function is configured
    // to cache it, but a cached 200 here would be a cron that reports success
    // every minute while the ceremony never advances — the exact silent failure
    // this endpoint exists to prevent. Cheap to make impossible.
    reply.header('cache-control', 'no-store');

    if (!deps.cronSecret || !deps.lootMinter) {
      // Fail closed, and say which of the two knobs is missing. A 404 here would
      // read as a wrong path and send an operator hunting for a typo.
      throw notImplemented(
        'CRON_NOT_CONFIGURED',
        'CRON_SECRET is not configured, so the scheduled-job surface is disabled.',
      );
    }

    const presented = bearerToken(request.headers.authorization);
    if (!presented || !secretMatches(presented, deps.cronSecret)) {
      // One error for missing and for wrong, so a caller probing with guesses
      // learns nothing from which one they got — same rule as `requireSession`.
      throw unauthorized(
        'CRON_AUTH_FAILED',
        'This endpoint is driven by the operator’s scheduler.',
      );
    }

    const report = await deps.lootMinter.tick();

    if (!report) {
      // Not an error, and deliberately still a 2xx: a cron dashboard marks any
      // non-2xx as a failed invocation, and "the previous pass is still going" is
      // the guard working, not the job breaking.
      return { ran: false, reason: 'a pass is already in flight on this instance' };
    }

    return {
      ran: true,
      considered: report.considered,
      advanced: report.advanced,
      minted: report.minted,
      waiting: report.waiting,
      failed: report.failed,
      // Per-run failures, verbatim. The only caller holds the secret, so there is
      // nothing here to withhold — and a pass that errored on three runs and
      // returned 200 would otherwise look identical to a quiet one.
      errors: report.errors,
    };
  };

  app.get('/jobs/loot-mint', runPass);
  app.post('/jobs/loot-mint', runPass);
}

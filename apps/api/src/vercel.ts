/**
 * Vercel serverless entrypoint.
 *
 * `server.ts` is still the only place routes and dependencies are wired; this
 * file adapts that same app to a platform that hands you one request at a time
 * instead of letting you own a port. Two things differ from `npm start`, and
 * both are deliberate:
 *
 *   1. NO TIMERS, ON-DEMAND INSTEAD. `spawner`/`indexer` schedule `setInterval`,
 *      and a serverless instance is frozen the moment it responds — the callback
 *      never runs again. Passing them here would not be merely wasteful, it
 *      would be inert, and inert in the silent way: the map would thin out as
 *      spawns expired and the leaderboard would stop advancing, with no error
 *      anywhere. `onDemand` hangs the same two jobs off the reads that need them.
 *
 *   2. BUILT ONCE PER INSTANCE, NOT PER REQUEST. `buildServer` constructs a
 *      Postgres pool and a chain client; doing that per invocation would open a
 *      new pool for every request and exhaust the database's connection budget
 *      almost immediately. The promise is cached at module scope, which persists
 *      across invocations on a warm instance, so the cost is paid on cold start
 *      only. Caching the *promise* rather than the resolved app also means two
 *      concurrent cold requests share one build instead of racing to make two.
 *
 * WHAT THIS DOES NOT CHANGE: the backend still never signs for a player and
 * still never custodies funds. Note though that `ORACLE_PRIVATE_KEY` must be
 * present in this environment for the app to build at all — on Vercel that means
 * it lives in the platform's environment store, readable by anyone with access
 * to the project. That key can move sponsor-pool funds via `reveal-and-resolve`.
 * See docs/08-deployment.md.
 *
 * ROUTING. `vercel.json` rewrites every path to this one function, and Fastify
 * still sees the original path in `req.url` — the rewrite picks the handler, it
 * does not rewrite what the handler reads. That is what makes a single
 * entrypoint work for an app with real routes, and it is load-bearing: if it
 * were ever untrue, every route would 404 at once. Any route check after a
 * deploy catches it, which is why the runbook's first smoke step is `/config`
 * and not just `/health`.
 *
 * THIS FILE IS BUNDLED, NOT SHIPPED AS-IS. `npm run build` esbuilds it into
 * `api/index.js`, which is what Vercel actually runs. The bundle is not a
 * packaging preference: `@grimhallow/shared` publishes raw TypeScript
 * (`"exports": {".": "./src/index.ts"}`) and is never compiled, so a deployment
 * that merely traced node_modules would ship a `.ts` file that Node cannot
 * import. Bundling inlines it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

let appPromise: Promise<FastifyInstance> | null = null;

function getApp(): Promise<FastifyInstance> {
  appPromise ??= buildServer({ onDemand: true }).then(async (app) => {
    // Fastify will not route until the plugin tree is resolved, and `emit` below
    // bypasses the usual `listen()` path that would have awaited it.
    await app.ready();
    return app;
  });
  return appPromise;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let app: FastifyInstance;
  try {
    app = await getApp();
  } catch (err: unknown) {
    // A build failure is almost always a missing env var — JWT_SECRET and
    // ORACLE_PRIVATE_KEY both refuse rather than fall back to a default, by
    // design. Reset the cache so the next request retries instead of serving
    // this error forever from a poisoned promise.
    appPromise = null;
    const message = err instanceof Error ? err.message : String(err);
    console.error('failed to build server', message);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    // The message can name a missing variable but never its value.
    res.end(
      JSON.stringify({ error: { code: 'SERVER_UNAVAILABLE', message: 'Server misconfigured' } }),
    );
    return;
  }

  // Hand the raw request to Fastify's own HTTP server object without binding a
  // port — the documented way to drive Fastify from a platform-owned listener.
  app.server.emit('request', req, res);
}

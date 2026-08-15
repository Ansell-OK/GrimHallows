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
 *      The free-run loot minter is the exception, and it is not passed either:
 *      it broadcasts oracle-signed transactions, which `onDemand` forbids
 *      attaching to request traffic, so it runs on the platform's clock instead.
 *      Setting `CRON_SECRET` opens `GET /jobs/loot-mint` for that (routes/jobs.ts),
 *      and `scripts/build-vercel.mjs` schedules it. Without both, a free run's
 *      drop stays queued in the store — recorded and resumable, not minted.
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
 * ROUTING. The Build Output API's `config.json` routes every path to this one
 * function, and Fastify still sees the original path in `req.url` — the route
 * picks the handler, it does not rewrite what the handler reads. That is what
 * makes a single entrypoint work for an app with real routes, and it is
 * load-bearing: if it were ever untrue, every route would 404 at once. Any route
 * check after a deploy catches it, which is why the runbook's first smoke step is
 * `/config` and not just `/health`.
 *
 * THIS FILE IS BUNDLED, NOT SHIPPED AS-IS. `npm run build` esbuilds it into
 * `.vercel/output/functions/index.func/index.mjs`, the prebuilt function Vercel
 * actually runs. The bundle is not a packaging preference: `@grimhallow/shared`
 * publishes raw TypeScript (`"exports": {".": "./src/index.ts"}`) and is never
 * compiled, so a deployment that merely traced node_modules would ship a `.ts`
 * file that Node cannot import. Bundling inlines it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';

let appPromise: Promise<FastifyInstance> | null = null;

function getApp(): Promise<FastifyInstance> {
  // Dynamic import, deliberately not a top-level one. `server.js` pulls in
  // `config.ts`, whose `export const config = {…}` validates the environment at
  // module-load time — `parseNetwork()` rejects a bad STACKS_NETWORK, and
  // `getNetworkConfig()` rejects a deployer address whose prefix disagrees with
  // the network. A static import would run that validation when this bundle is
  // first imported, before `handler` exists, so those throws would crash the
  // function opaquely (Vercel's FUNCTION_INVOCATION_FAILED) with nothing in the
  // response to say why. Importing here defers the whole module graph into the
  // try/catch below, so a misconfig surfaces as the logged 500 this file already
  // knows how to produce — and the real message lands in the platform's logs.
  appPromise ??= import('./config.js')
    .then(({ assertHostedApiKeySeparation }) => assertHostedApiKeySeparation())
    .then(() => import('./server.js'))
    .then(({ buildServer }) => buildServer({ onDemand: true }))
    .then(async (app) => {
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

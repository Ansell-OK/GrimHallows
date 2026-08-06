/**
 * Postgres pool.
 *
 * Everything in this database is a cache (05-data-model.md). If it were wiped,
 * the game would lose convenience data — parties, spawn rows, dice logs — but
 * not a single satoshi of truth about who paid what or who owns what. That
 * lives on chain. Keep it that way: no code path should ever read a balance
 * from here and treat it as authoritative.
 *
 * TWO DEPLOYMENT SHAPES, ONE POOL. Under `npm run dev` or any long-running host
 * this is a normal pool: one process, a handful of connections, held open. On
 * Vercel it is not — every warm function instance builds its own pool, and there
 * can be many instances at once. Ten connections each against Supabase's ~15-60
 * direct-connection budget exhausts the database long before it exhausts the
 * platform, and the symptom is `too many clients already` on a request that has
 * nothing to do with whoever actually used them up. Hence `max: 1` there, and
 * hence the pooler below.
 *
 * USE SUPABASE'S TRANSACTION POOLER (port 6543), NOT THE DIRECT PORT (5432).
 * The direct port gives one real Postgres backend per connection; the pooler
 * multiplexes them, which is what makes a fleet of short-lived function
 * instances survivable at all. This codebase is compatible with transaction
 * mode by construction rather than by luck, and both facts are load-bearing:
 *
 *   - No `pool.connect()` and no multi-statement transactions. Every write is a
 *     single `query()`, so nothing depends on two statements landing on the same
 *     backend — which transaction mode does not guarantee across checkouts.
 *   - No named prepared statements. `query(text, params)` sends an unnamed
 *     portal, which pgBouncer transaction mode supports; a `name` field on any
 *     query here would start failing intermittently under load, when the second
 *     execution lands on a backend that never saw the parse.
 *
 * Adding either would work locally and in every test, and break only in
 * production under concurrency. If you need a real transaction, take it up with
 * the session pooler (5432) on a connection reserved for that path.
 */

import pg from 'pg';
import { config } from './config.js';

let pool: pg.Pool | null = null;

/**
 * True on Vercel, which sets this itself.
 *
 * Deliberately platform-detected rather than a config flag: getting this wrong
 * is invisible until the database starts refusing connections under load, and a
 * flag is a thing an operator can forget to set. `VERCEL` is present in every
 * Vercel runtime and absent everywhere else.
 */
const isServerless = !!process.env.VERCEL;

/**
 * TLS settings for the connection.
 *
 * Supabase requires TLS and a plain `postgres://` string without it simply
 * fails, so this defaults to on for any non-local host and off for localhost —
 * where `docker compose` Postgres has no certificate and enabling it would break
 * the dev loop.
 *
 * `rejectUnauthorized` is the honest part. Node does not ship Supabase's root CA,
 * so full verification needs the CA supplied via `DATABASE_SSL_CA`. Without it
 * the connection is encrypted but the server is unauthenticated — that stops
 * passive interception, not an active man-in-the-middle. Everything crossing
 * this wire is cache data plus session rows, and no signing key or player fund
 * is reachable through it, but set `DATABASE_SSL_CA` in production if you can:
 * the session table is what a login is checked against.
 */
export function sslConfig(connectionString: string): pg.ConnectionConfig['ssl'] {
  const explicit = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (explicit === 'false' || explicit === 'off') return undefined;

  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
  if (explicit !== 'true' && explicit !== 'on' && isLocal) return undefined;

  const ca = process.env.DATABASE_SSL_CA?.trim();
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

export function getPool(): pg.Pool {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set — the API cannot start without Postgres.');
  }
  pool ??= new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: sslConfig(config.databaseUrl),
    // One per instance in serverless; a normal pool on a normal host.
    max: isServerless ? 1 : 10,
    // Short in serverless so a frozen instance is not holding a pooler slot it
    // cannot use. Long enough elsewhere to keep connections warm.
    idleTimeoutMillis: isServerless ? 10_000 : 30_000,
    // Fail the request rather than hang until the platform's own timeout kills
    // the function, which produces no usable error at all.
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}

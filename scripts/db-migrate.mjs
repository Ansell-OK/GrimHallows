#!/usr/bin/env node
/**
 * Apply db/schema.sql to DATABASE_URL.
 *
 * The schema is written to be idempotent (create ... if not exists), so this is
 * safe to re-run; it is a "converge to the declared schema" step rather than a
 * numbered-migration system. That is enough while the schema still tracks
 * docs/05-data-model.md directly. Once real player data exists on testnet,
 * destructive changes need versioned migrations instead of edits here.
 *
 * IMPORTANT LIMIT of that idempotence: `create table if not exists` converges a
 * MISSING table, never a CHANGED one. Add a column to an existing table in
 * schema.sql and this script reports success while the database keeps the old
 * shape — the failure then surfaces as a confusing "column does not exist" from
 * an unrelated statement much later in the file. So after applying, we diff the
 * live columns against the schema and report the drift instead of trusting the
 * exit code.
 *
 *   node scripts/db-migrate.mjs
 *   node scripts/db-migrate.mjs --dry-run
 *   node scripts/db-migrate.mjs --check    # diff only, apply nothing
 */

import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: resolve(ROOT, '.env'), quiet: true });

const schemaPath = resolve(ROOT, 'db/schema.sql');
const sql = readFileSync(schemaPath, 'utf8');

if (process.argv.includes('--dry-run')) {
  const statements = sql.split(';').filter((s) => s.trim() && !/^\s*--/.test(s));
  console.log(`${schemaPath}\n${statements.length} statements, nothing applied.`);
  process.exit(0);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const CHECK_ONLY = process.argv.includes('--check');

const COLUMNS_QUERY = `select table_name, column_name from information_schema.columns
   where table_schema = 'public'`;

/**
 * TLS settings, mirroring apps/api/src/db.ts.
 *
 * A managed host (Supabase and every other one) refuses a plaintext connection
 * outright, and local docker Postgres has no certificate to offer, so this turns
 * on for remote hosts and off for localhost. `DATABASE_SSL_CA` gets full
 * verification; without it the connection is encrypted but the server is
 * unauthenticated. Kept deliberately identical to the API's rule — a migration
 * that can reach a database the API cannot is a confusing way to find out.
 */
function sslConfig(url) {
  const explicit = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (explicit === 'false' || explicit === 'off') return undefined;
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  if (explicit !== 'true' && explicit !== 'on' && isLocal) return undefined;
  const ca = process.env.DATABASE_SSL_CA?.trim();
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

const ssl = sslConfig(connectionString);

/**
 * What `schema.sql` describes, obtained by applying it to a throwaway database.
 *
 * Parsing the DDL ourselves would mean reimplementing enough of Postgres to be
 * wrong eventually; letting Postgres do it is exact by construction. The scratch
 * database is dropped either way.
 *
 * NOT AVAILABLE ON A MANAGED HOST. Supabase and friends do not grant CREATEDB,
 * and the connection pooler cannot reach a database that isn't the project's
 * own. Returns null there rather than failing, because the apply above is still
 * worth doing — but the caller must then say the check was skipped instead of
 * printing "no drift", which would be an unearned all-clear on the exact class
 * of failure this function exists to catch.
 */
async function declaredColumns(adminClient) {
  const scratch = `grimhallow_schemadiff_${process.pid}`;
  try {
    await adminClient.query(`drop database if exists ${scratch}`);
    await adminClient.query(`create database ${scratch}`);
  } catch (err) {
    if (/permission denied|must be superuser|not allowed|CREATEDB/i.test(err.message)) {
      return null;
    }
    throw err;
  }
  const scratchClient = new pg.Client({
    connectionString: connectionString.replace(/\/[^/?]+(\?|$)/, `/${scratch}$1`),
    ssl,
  });
  try {
    await scratchClient.connect();
    await scratchClient.query(sql);
    const { rows } = await scratchClient.query(COLUMNS_QUERY);
    return rows;
  } finally {
    await scratchClient.end().catch(() => {});
    await adminClient.query(`drop database if exists ${scratch}`).catch(() => {});
  }
}

const client = new pg.Client({ connectionString, ssl });
try {
  await client.connect();

  if (!CHECK_ONLY) {
    // One transaction: a half-applied schema is worse than none.
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
  }

  const key = (r) => `${r.table_name}.${r.column_name}`;
  const declaredRows = await declaredColumns(client);
  const live = new Set((await client.query(COLUMNS_QUERY)).rows.map(key));
  const missing = declaredRows
    ? [...new Set(declaredRows.map(key))].filter((k) => !live.has(k)).sort()
    : [];

  const { rows } = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`,
  );
  console.log(CHECK_ONLY ? `Checked against ${schemaPath}` : `Applied ${schemaPath}`);
  console.log(`${rows.length} tables: ${rows.map((r) => r.table_name).join(', ')}`);

  if (missing.length) {
    // Exit non-zero: this is the case the plain apply reports as success.
    const tables = [...new Set(missing.map((k) => k.split('.')[0]))];
    console.error(
      `\nSCHEMA DRIFT — ${missing.length} column(s) in schema.sql are not in the database:`,
    );
    for (const k of missing) console.error(`  - ${k}`);
    console.error(
      `\n\`create table if not exists\` cannot add a column to a table that already\n` +
        `exists. Affected table(s): ${tables.join(', ')}.\n` +
        `If they hold no data you care about, drop them and re-run this script.\n` +
        `If they do, write an \`alter table\` migration — do not drop.`,
    );
    process.exit(1);
  }

  if (declaredRows === null) {
    console.warn(
      '\nDRIFT CHECK SKIPPED — this host does not allow creating the scratch database\n' +
        'the check needs (managed hosts such as Supabase do not grant CREATEDB).\n' +
        'The schema was applied, but a column ADDED to an existing table would not\n' +
        'have been caught here. To verify, run this against a local Postgres with the\n' +
        'same schema, or diff information_schema.columns by hand.',
    );
  } else {
    console.log('No drift: every column in schema.sql exists in the database.');
  }
} catch (err) {
  await client.query('rollback').catch(() => {});
  console.error(`Migration failed: ${err.message}`);
  if (/ECONNREFUSED|does not exist|timeout/i.test(err.message)) {
    console.error('Is the container up?  npm run db:up');
  }
  if (/no pg_hba.conf entry|SSL|self.signed/i.test(err.message)) {
    console.error(
      'TLS problem. A managed host needs SSL; set DATABASE_SSL=true, or\n' +
        'DATABASE_SSL_CA=<pem> to verify the server properly.',
    );
  }
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}

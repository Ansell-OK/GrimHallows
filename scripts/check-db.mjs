// Phase 0 connectivity check: proves DATABASE_URL from the root .env reaches the
// Postgres container via the same `pg` client the API will use.
//   node scripts/check-db.mjs
import { config as loadDotenv } from 'dotenv';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env'),
  quiet: true,
});

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const { rows } = await client.query('select current_database() db, version() v');
  console.log(`OK  db=${rows[0].db}`);
  console.log(`    ${rows[0].v.split(',')[0]}`);
} catch (err) {
  console.error(`FAILED to connect: ${err.message}`);
  console.error('Is the container up?  docker compose up -d');
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}

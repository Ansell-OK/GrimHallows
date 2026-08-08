#!/usr/bin/env node
/**
 * Bundle the API into a single Vercel serverless function, emitted through the
 * Build Output API (`.vercel/output`).
 *
 * WHY BUILD OUTPUT API AND NOT A `functions` GLOB IN vercel.json. `vercel build`
 * validates a `functions` pattern against the checked-out source *before* it
 * runs this build command. The bundle that pattern points at is generated here
 * and is gitignored, so on a clean clone the glob matches nothing and the deploy
 * aborts before esbuild ever runs — the failure is "doesn't match any Serverless
 * Functions", seconds into the build, with no install step. Emitting a prebuilt
 * function under `.vercel/output` instead hands Vercel the finished artifact and
 * its routing directly: no source inference, nothing to race the build command.
 *
 * WHY A BUNDLE AND NOT A `tsc` BUILD. `@grimhallow/shared` is consumed as raw
 * TypeScript — its package.json points `exports` straight at `src/index.ts` and
 * nothing ever compiles it, because `tsx` and Vite both read `.ts` directly. That
 * is fine everywhere except a deployment, where Node is asked to import the file
 * and cannot. `tsc` would not fix it either: it would emit an import of a
 * workspace package that still resolves to TypeScript at runtime. esbuild
 * inlines the dependency, which removes the problem rather than moving it.
 *
 * WHAT STAYS EXTERNAL: nothing. A fully self-contained bundle means the deployed
 * function has no node_modules resolution to get wrong, and no chance of picking
 * up a different version of a dependency than the one this repo tests against.
 * `pg` and `fastify` bundle cleanly; if a future dependency ships a native
 * binding, it will need adding to `external` here and to the deployment's
 * installed packages — a native module cannot be inlined.
 *
 *   node scripts/build-vercel.mjs
 */

import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Build Output API layout, relative to the Vercel Root Directory (apps/api):
//   .vercel/output/config.json                     — routing
//   .vercel/output/functions/index.func/index.mjs  — the bundle
//   .vercel/output/functions/index.func/.vc-config.json
const OUTPUT_ROOT = resolve(API_ROOT, '.vercel/output');
const FUNC_DIR = resolve(OUTPUT_ROOT, 'functions/index.func');

mkdirSync(FUNC_DIR, { recursive: true });

const result = await build({
  entryPoints: [resolve(API_ROOT, 'src/vercel.ts')],
  // `.mjs` so Node loads it as ESM regardless of any package.json above it.
  outfile: resolve(FUNC_DIR, 'index.mjs'),
  bundle: true,
  platform: 'node',
  // Matches the `engines: node >= 22` the repo already declares, and the
  // `nodejs22.x` runtime set in .vc-config.json below. Lower would silently
  // down-level top-level await.
  target: 'node22',
  format: 'esm',
  // Some dependencies in the Stacks/Fastify trees are CommonJS and reference
  // `require`, `__dirname`, or `__filename`, which do not exist in an ESM
  // bundle. Without this shim they fail at runtime, not at build time.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  // Keep it readable in a stack trace: this runs on someone else's machine and a
  // minified frame is the difference between diagnosing a production fault and
  // guessing at it. The size cost is irrelevant for a serverless function.
  minify: false,
  sourcemap: true,
  logLevel: 'info',
  metafile: true,
});

// How the Node runtime invokes the bundle. `handler` is the default export of
// index.mjs (src/vercel.ts's `export default handler`). `maxDuration` and
// `memory` carry over from what the old vercel.json `functions` block set —
// 30s because some chain reads are slow, and losing it would cap requests at the
// platform's 10s default.
writeFileSync(
  resolve(FUNC_DIR, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      // The handler drives Fastify with raw (req, res); it does not use Vercel's
      // body/helper sugar, so leave it off.
      shouldAddHelpers: false,
      maxDuration: 30,
      memory: 1024,
    },
    null,
    2,
  ) + '\n',
);

// Route every path to the one function. Fastify still reads the original path
// from req.url, so the catch-all picks the handler without rewriting what the
// handler sees — the property §4.1 of the runbook calls load-bearing.
//
// `crons` lives HERE AND NOT IN vercel.json. This build writes config.json
// itself, and that file is the whole configuration Vercel reads for a prebuilt
// deployment — a `crons` block in vercel.json would be the source of truth for a
// project that let the platform infer its own output, and silently nothing for
// this one. The failure mode is the exact one this schedule exists to fix: the
// job never runs and nothing reports that it never ran.
//
// WHAT IT DRIVES. `/jobs/loot-mint` advances the free-run loot ceremony by one
// step per pass (docs/09 B7). It is a no-op — one indexed query, no chain traffic
// — when nothing is owed, and it refuses every request until CRON_SECRET is set,
// so scheduling it before configuring it is safe but useless. Vercel supplies the
// secret as an Authorization header on its own; there is nothing to pass here.
//
// DAILY, WHICH IS A BACKSTOP AND NOT THE DRIVER. Vercel's Hobby plan permits one
// invocation per day per cron and REJECTS ANYTHING FINER AT DEPLOY TIME — the
// whole deployment fails, so an every-minute schedule here does not merely run
// slowly, it ships nothing at all. That is how this was found: production sat on
// an older bundle with no /jobs/loot-mint in it, 404-ing the route while the code
// looked deployed.
//
// One pass advances one run by one step, so at this interval alone a drop takes
// four days to reach a wallet. That is a floor on delivery, not a target: the
// cadence comes from `.github/workflows/loot-mint.yml`, a scheduled GitHub
// Actions workflow calling the same endpoint every five minutes (free and
// unmetered on a public repo). This daily pass is what guarantees a drop still
// lands when that workflow is delayed, was never configured, or has been
// auto-disabled — GitHub switches off scheduled workflows on a public repo after
// 60 days without a commit. Both go through LootMinterLoop.tick(), so overlapping
// them skips rather than double-broadcasts. On a plan that allows minute-level
// schedules, change this to `* * * * *` and delete the workflow.
// See docs/08-deployment.md §4.5.
writeFileSync(
  resolve(OUTPUT_ROOT, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [{ src: '/(.*)', dest: '/index' }],
      crons: [{ path: '/jobs/loot-mint', schedule: '17 3 * * *' }],
    },
    null,
    2,
  ) + '\n',
);

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(
  `\n.vercel/output/functions/index.func/index.mjs — ${(bytes / 1024 / 1024).toFixed(2)} MB bundled`,
);

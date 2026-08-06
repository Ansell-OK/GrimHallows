#!/usr/bin/env node
/**
 * Bundle the API into a single Vercel serverless function.
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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
  entryPoints: [resolve(API_ROOT, 'src/vercel.ts')],
  outfile: resolve(API_ROOT, 'api/index.js'),
  bundle: true,
  platform: 'node',
  // Matches the `engines: node >= 22` the repo already declares, and Vercel's
  // current Node runtime. Lower would silently down-level top-level await.
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

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`\napi/index.js — ${(bytes / 1024 / 1024).toFixed(2)} MB bundled`);

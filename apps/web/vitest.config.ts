import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Test config for the web app's non-visual logic — the session store and the
 * API client. Deliberately does not load vite.config.ts: these tests need no
 * React, no Tailwind, and no DOM, so pulling in the full plugin chain would
 * only make them slower and more fragile.
 *
 * Component rendering is not covered here; that would need a DOM environment,
 * which is a dependency this repo doesn't carry yet.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

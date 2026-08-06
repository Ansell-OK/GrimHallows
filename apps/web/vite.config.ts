import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

// A single .env at the monorepo root serves both apps/api and apps/web, so the
// network + deployer address can never drift between them. Only VITE_-prefixed
// vars from it are exposed to the browser.
const ENV_DIR = path.resolve(__dirname, '../..');

/**
 * Refuse to produce a hosted build that points at the developer's own machine.
 *
 * `lib/api.ts` falls back to `http://localhost:8080` when VITE_API_URL is unset,
 * which is right for `npm run dev` and catastrophic for a deployment: the bundle
 * builds cleanly, deploys cleanly, loads cleanly, and then every request fails
 * against a port on the visitor's laptop. Whoever configured it sees it working,
 * because they *do* have an API on 8080.
 *
 * The check is scoped to Vercel builds (the platform sets VERCEL itself) so that
 * `npm run build && npm run preview` against a local API keeps working — that is
 * a real workflow and not the one this guards against. Vite bakes env vars into
 * the bundle at build time, so this is the last moment the mistake is cheap.
 */
function assertHostedApiUrl(mode: string): void {
  if (!process.env.VERCEL) return;

  // loadEnv reads the root .env *and* VITE_-prefixed vars already in
  // process.env, which is how Vercel's environment store reaches the build.
  const { VITE_API_URL: apiUrl } = loadEnv(mode, ENV_DIR, 'VITE_');
  const where = 'Set it in the Vercel project settings → Environment Variables.';

  if (!apiUrl) {
    throw new Error(
      'VITE_API_URL is not set. Building without it ships a frontend that calls ' +
        `http://localhost:8080. ${where}`,
    );
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(apiUrl)) {
    throw new Error(
      `VITE_API_URL is "${apiUrl}", which resolves to the visitor's own machine, ` +
        `not to the API. ${where}`,
    );
  }
  if (!/^https:\/\//i.test(apiUrl)) {
    // A page served over https cannot fetch http: the browser blocks it as mixed
    // content, and the only trace is a console warning the player never sees.
    throw new Error(
      `VITE_API_URL must be an https:// URL for a hosted build; got "${apiUrl}". ${where}`,
    );
  }
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build') assertHostedApiUrl(mode);

  return {
    plugins: [react(), tailwindcss()],
    envDir: ENV_DIR,
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 3000,
    },
  };
});

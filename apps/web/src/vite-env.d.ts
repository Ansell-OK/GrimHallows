/// <reference types="vite/client" />

/**
 * Only VITE_-prefixed vars from the root .env reach the browser (see
 * vite.config.ts `envDir`). Declaring them here keeps a typo in an env name a
 * compile error rather than a silent `undefined` at runtime.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_STACKS_NETWORK?: 'devnet' | 'testnet' | 'mainnet';
  readonly VITE_STACKS_DEPLOYER_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

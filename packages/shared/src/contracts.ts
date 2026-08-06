/**
 * Single source of truth for deployed contract addresses.
 *
 * Both `apps/api` and `apps/web` read addresses from here — never hardcode a
 * deployer principal or contract name anywhere else. Per 06-mvp-roadmap.md
 * Phase 1, testnet addresses are recorded here once deployment lands.
 */

export type StacksNetworkName = 'devnet' | 'testnet' | 'mainnet';

/** Contract names as deployed. Deploy order matters — see 03-smart-contracts-spec.md#7. */
export const CONTRACT_NAMES = {
  characterLootNft: 'character-loot-nft',
  gameCore: 'game-core',
  forge: 'forge',
  characterNft: 'character-nft',
  forgeV2: 'forge-v2',
} as const;

export type ContractKey = keyof typeof CONTRACT_NAMES;

/**
 * Deploy order per 03-smart-contracts-spec.md#7. Do not reorder.
 *
 * The first three are already on mainnet and cannot move. The two additions go
 * last: `character-nft` has no dependencies at all, and `forge-v2` needs
 * `character-loot-nft` to exist so its `contract-call?` resolves.
 */
export const DEPLOY_ORDER: readonly ContractKey[] = [
  'characterLootNft',
  'gameCore',
  'forge',
  'characterNft',
  'forgeV2',
] as const;

/**
 * Contracts already deployed to mainnet, which must never be re-deployed.
 *
 * Clarity contracts are immutable and a name can only be claimed once per
 * principal, so a deploy script that includes these fails outright — an
 * expensive way to discover a config mistake. `forge` is listed even though
 * `forge-v2` supersedes it: it is still on chain, and the migration is a
 * `set-minter` revocation, not a removal.
 */
export const MAINNET_DEPLOYED: readonly ContractKey[] = [
  'characterLootNft',
  'gameCore',
  'forge',
] as const;

export interface NetworkConfig {
  readonly network: StacksNetworkName;
  /** Principal that deployed the contracts. */
  readonly deployer: string;
  /** Base URL of the Stacks API node used for reads. */
  readonly apiUrl: string;
  /** Explorer base URL, used for the UI's "view on-chain" links. */
  readonly explorerUrl: string;
}

/**
 * Devnet deployer is Clarinet's standard first test wallet, which is stable
 * across `clarinet devnet start` runs.
 */
const DEVNET_DEPLOYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';

const NETWORKS: Record<StacksNetworkName, NetworkConfig> = {
  devnet: {
    network: 'devnet',
    deployer: DEVNET_DEPLOYER,
    apiUrl: 'http://localhost:3999',
    explorerUrl: 'http://localhost:8000',
  },
  testnet: {
    network: 'testnet',
    // Populated at Phase 1 deploy time from STACKS_DEPLOYER_ADDRESS.
    deployer: '',
    apiUrl: 'https://api.testnet.hiro.so',
    explorerUrl: 'https://explorer.hiro.so',
  },
  mainnet: {
    network: 'mainnet',
    // Deployed Phase 1. The deployer principal is also `contract-owner`: it
    // receives every paid entry fee and is the only principal `fund-pool`
    // accepts. Kept separate from the oracle key, which signs commit/reveal.
    deployer: 'SP1MNXD30JHNT2Y0P8KZ06J43ACCH27N3BTBZ90AR',
    apiUrl: 'https://api.hiro.so',
    explorerUrl: 'https://explorer.hiro.so',
  },
};

/**
 * Address version prefixes, by network. Mainnet principals start `SP`/`SM`;
 * testnet and devnet share `ST`/`SN`.
 *
 * Checked because a deployer override that belongs to the wrong chain is a
 * silent, expensive failure: every `contractId()` still returns a
 * well-formed-looking identifier, so reads just come back empty and money-moving
 * txs are built against a contract that does not exist on the target chain.
 * Cheaper to refuse to boot.
 */
const ADDRESS_PREFIXES: Record<StacksNetworkName, readonly string[]> = {
  devnet: ['ST', 'SN'],
  testnet: ['ST', 'SN'],
  mainnet: ['SP', 'SM'],
};

export function getNetworkConfig(
  network: StacksNetworkName,
  overrides: Partial<Pick<NetworkConfig, 'deployer' | 'apiUrl'>> = {},
): NetworkConfig {
  const base = NETWORKS[network];
  if (!base) throw new Error(`Unknown network: ${network}`);

  const deployer = overrides.deployer?.trim() || base.deployer;
  if (!deployer) {
    throw new Error(
      `No deployer address configured for network "${network}". ` +
        `Set STACKS_DEPLOYER_ADDRESS (api) or VITE_STACKS_DEPLOYER_ADDRESS (web).`,
    );
  }

  const prefixes = ADDRESS_PREFIXES[network];
  if (!prefixes.some((p) => deployer.startsWith(p))) {
    throw new Error(
      `Deployer address "${deployer}" is not a ${network} principal ` +
        `(expected it to start with ${prefixes.join(' or ')}). ` +
        `Check STACKS_NETWORK and STACKS_DEPLOYER_ADDRESS agree with each other.`,
    );
  }

  return { ...base, deployer, apiUrl: overrides.apiUrl?.trim() || base.apiUrl };
}

/** Fully-qualified contract identifier, e.g. `ST1...GZGM.game-core`. */
export function contractId(cfg: NetworkConfig, key: ContractKey): string {
  return `${cfg.deployer}.${CONTRACT_NAMES[key]}`;
}

/** Explorer link for a transaction — used by Screen 9's "view on-chain" links. */
export function explorerTxUrl(cfg: NetworkConfig, txId: string): string {
  const id = txId.startsWith('0x') ? txId : `0x${txId}`;
  return `${cfg.explorerUrl}/txid/${id}?chain=${cfg.network === 'mainnet' ? 'mainnet' : 'testnet'}`;
}

/** Explorer link for an address. */
export function explorerAddressUrl(cfg: NetworkConfig, address: string): string {
  return `${cfg.explorerUrl}/address/${address}?chain=${cfg.network === 'mainnet' ? 'mainnet' : 'testnet'}`;
}

/** 1 STX = 1_000_000 microSTX. The paid-dungeon gate fee is exactly 1 STX. */
export const MICROSTX_PER_STX = 1_000_000n;
export const PAID_DUNGEON_GATE_FEE_USTX = 1_000_000n;

/** Max party size — Clarity list bound in game-core's `runs` map. */
export const MAX_PARTY_SIZE = 4;

// ---------------------------------------------------------------------------
// Post-deploy seed configuration
//
// The three contracts are inert until the owner wires them together and seeds
// the dungeons and recipes. `scripts/seed-contracts.mjs` performs exactly these
// calls, in this order, so the on-chain ids below are stable and can be relied
// on by the API and the UI.
//
// Deliberately NOT included here: `fund-pool`. Crediting the sponsor pool moves
// real STX out of the owner's wallet and is an explicit, separate, deliberate
// action (`scripts/fund-pool.mjs`) — never a side effect of deployment.
// ---------------------------------------------------------------------------

export interface SeedDungeon {
  readonly id: number;
  readonly gateFeeUstx: bigint;
  readonly isPaid: boolean;
  readonly label: string;
}

/**
 * `create-dungeon` assigns ids from a nonce starting at 1, so seeding in this
 * order fixes the ids.
 *
 * Free dungeons are on-chain runs (resolved open question). Every free spawn on
 * the map screen maps to this single on-chain dungeon via `runs.spawn_id`,
 * rather than each spawn getting its own `create-dungeon` call.
 */
export const SEED_DUNGEONS: readonly SeedDungeon[] = [
  {
    id: 1,
    gateFeeUstx: PAID_DUNGEON_GATE_FEE_USTX,
    isPaid: true,
    label: 'Paid dungeon (1 STX gate fee)',
  },
  { id: 2, gateFeeUstx: 0n, isPaid: false, label: 'Free dungeon' },
];

export const PAID_DUNGEON_ID = 1;
export const FREE_DUNGEON_ID = 2;

/** Power-up tiers, 1..4 (resolved open question: forge is 3-for-1, 4 tiers). */
export const MAX_POWER_UP_TIER = 4;

/** Inputs burned per forge (resolved open question: 3-for-1, guaranteed). */
export const FORGE_INPUT_COUNT = 3;

export interface SeedRecipe {
  readonly id: number;
  readonly inputTier: number;
  readonly inputCount: number;
  readonly outputTier: number;
  readonly outputUri: string;
  /**
   * What `forge-v2.forge` charges for this recipe, in uSTX. Ignored by the
   * deployed `forge.clar`, which takes no fee and whose `create-recipe` has no
   * parameter for one.
   */
  readonly stxFeeUstx: bigint;
}

/**
 * The forge fee ladder, keyed by OUTPUT tier: 0.5 / 1 / 2 STX.
 *
 * Higher tiers cost more because they are worth more — a tier-4 forge consumes
 * 27 tier-1 tokens' worth of inputs, so a flat fee would be trivial at the top
 * and punitive at the bottom.
 *
 * TUNABLE, and expected to be tuned. These are the values the owner passes to
 * `create-recipe`; the contract stores whatever it is given rather than
 * hardcoding this table, so retuning is a new recipe, not a redeploy.
 */
export const FORGE_FEE_BY_OUTPUT_TIER: Readonly<Record<number, bigint>> = {
  2: 500_000n,
  3: 1_000_000n,
  4: 2_000_000n,
};

/**
 * What `character-nft.mint-character` charges, in uSTX.
 *
 * The third revenue line. Set as the contract's initial `mint-price` at deploy
 * and changeable afterwards via `set-mint-price` — this constant is what the UI
 * displays and what the deploy script writes, not the authority. On a live
 * chain the contract's `get-mint-price` is the authority; the UI reads it.
 */
export const CHARACTER_MINT_PRICE_USTX = 1_000_000n;

/** The full tier ladder: 1->2, 2->3, 3->4. Ids assigned in this order. */
export const SEED_RECIPES: readonly SeedRecipe[] = [1, 2, 3].map((inputTier) => ({
  id: inputTier,
  inputTier,
  inputCount: FORGE_INPUT_COUNT,
  outputTier: inputTier + 1,
  outputUri: `ipfs://grimhallow/power-up/tier-${inputTier + 1}.json`,
  stxFeeUstx: FORGE_FEE_BY_OUTPUT_TIER[inputTier + 1],
}));

export function ustxToStx(ustx: bigint | number): number {
  return Number(BigInt(ustx)) / Number(MICROSTX_PER_STX);
}

export function formatStx(ustx: bigint | number, decimals = 2): string {
  return ustxToStx(ustx).toFixed(decimals);
}

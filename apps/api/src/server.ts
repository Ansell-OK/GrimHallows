/**
 * Fastify server entrypoint.
 *
 * The backend is the oracle + convenience layer, never the source of truth for
 * money or ownership (04-backend-api-spec.md#intro). Dependencies are injected
 * rather than imported by each route so tests can drive the real routes against
 * in-memory doubles — no live chain, no live database, same code path.
 */

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { pathToFileURL } from 'node:url';
import {
  CONTRACT_NAMES,
  UnsupportedCollectionError,
  contractId,
  assetIdentifier as buildAssetIdentifier,
  type NetworkConfig,
} from '@grimhallow/shared';
import { config, loadOracleKey, ownerAddressOrNull } from './config.js';
import { ApiError } from './lib/errors.js';
import { HiroChainClient, type ChainClient } from './lib/hiro.js';
import { StacksOracleSigner, type OracleSigner } from './oracle/attestation.js';
import { PaidRunOracle } from './oracle/paidRunOracle.js';
import { RunOracle } from './oracle/runOracle.js';
import {
  MemoryAuthStore,
  PostgresAuthStore,
  type AuthStore,
} from './repos/auth.js';
import {
  NullCharacterCache,
  PostgresCharacterCache,
  type CharacterCache,
} from './repos/characters.js';
import {
  NullHolderAgeRepo,
  PostgresHolderAgeRepo,
  type HolderAgeRepo,
} from './repos/holderAge.js';
import {
  NullMintSeedRepo,
  PostgresMintSeedRepo,
  type MintSeedRepo,
} from './repos/mintSeeds.js';
import {
  MemoryForgeHistoryStore,
  PostgresForgeHistoryStore,
  type ForgeHistoryStore,
} from './repos/forgeHistory.js';
import {
  MemoryPlayerStatsStore,
  PostgresPlayerStatsStore,
  type PlayerStatsStore,
} from './repos/playerStats.js';
import {
  MemoryJobLeaseStore,
  PostgresJobLeaseStore,
  type JobLeaseStore,
} from './repos/jobLeases.js';
import { MemoryRunStore, PostgresRunStore, type RunStore } from './repos/runs.js';
import { MemorySpawnStore, PostgresSpawnStore, type SpawnStore } from './repos/spawns.js';
import { Indexer } from './indexer/indexer.js';
import { DEFAULT_INDEXER_CONFIG, IndexerLoop, type IndexerLoopConfig } from './indexer/loop.js';
import {
  FreeRunLootMinter,
  type FreeRunLootMinterConfig,
} from './oracle/freeRunLootMinter.js';
import { LootMinterLoop, type LootMinterLoopConfig } from './oracle/lootMinterLoop.js';
import { OnDemandTicker } from './services/onDemand.js';
import { CharacterMintService } from './services/characterMintService.js';
import { CharacterService } from './services/characterService.js';
import { MintSeedService } from './services/mintSeedService.js';
import { CombatService } from './services/combatService.js';
import { HolderAgeService } from './services/holderAgeService.js';
import { ForgeService } from './services/forgeService.js';
import { MapService } from './services/mapService.js';
import { PaidEntryService } from './services/paidEntryService.js';
import { PowerUpService } from './services/powerUpService.js';
import { IdentityService } from './services/identityService.js';
import { DEFAULT_SPAWNER_CONFIG, DungeonSpawner, type SpawnerConfig } from './services/spawner.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerCharacterRoutes } from './routes/characters.js';
import { registerDungeonRoutes } from './routes/dungeons.js';
import { registerForgeRoutes } from './routes/forge.js';
import { registerImageProxyRoutes } from './routes/imageProxy.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerLeaderboardRoutes } from './routes/leaderboard.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerMapRoutes } from './routes/map.js';
import { registerPaidClaimRoutes } from './routes/paidDungeonClaim.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { MemoryNotificationStore, PostgresNotificationStore, type NotificationStore } from './repos/notifications.js';
import { MemoryPartyStore, PostgresPartyStore, type PartyStore } from './repos/parties.js';
import { registerPartyRoutes } from './routes/parties.js';
import { DEFAULT_RATE_LIMIT_RULES, MemoryRateLimiter } from './lib/rateLimit.js';

export interface ServerDeps {
  readonly chain?: ChainClient;
  readonly authStore?: AuthStore;
  readonly characterCache?: CharacterCache;
  readonly holderAgeRepo?: HolderAgeRepo;
  readonly mintSeedRepo?: MintSeedRepo;
  readonly spawnStore?: SpawnStore;
  readonly runStore?: RunStore;
  /**
   * Cross-instance guard for the loot ceremony (docs/09 B7).
   *
   * Injectable so a test can share one store between two loop objects and stand
   * in for two warm instances — which is the only way to exercise the guard that
   * matters in production, since `LootMinterLoop`'s own flag covers one process.
   */
  readonly jobLeaseStore?: JobLeaseStore;
  readonly forgeHistoryStore?: ForgeHistoryStore;
  readonly playerStatsStore?: PlayerStatsStore;
  readonly partyStore?: PartyStore;
  /**
   * The oracle's signing capability. Injected in tests so the combat loop can be
   * exercised without a real key on disk; loaded from `ORACLE_PRIVATE_KEY`
   * otherwise. This is the only wallet the backend ever signs with, besides the
   * separately-held owner key.
   */
  readonly oracleSigner?: OracleSigner;
  /**
   * The oracle's private key, used by `PaidRunOracle` to sign transactions.
   * Injected in tests alongside `oracleSigner`; loaded from `ORACLE_PRIVATE_KEY`
   * otherwise. When both the signer and the key are injected, they must agree.
   */
  readonly oraclePrivateKey?: string;
  /**
   * Settles paid runs on chain. Injected in tests so the claim and combat paths
   * can be driven without building and fee-estimating a real transaction, which
   * would need a live node. Built from `oraclePrivateKey` otherwise.
   */
  readonly paidOracle?: PaidRunOracle;
  readonly stacks?: NetworkConfig;
  readonly jwtSecret?: string;
  /**
   * The operator's principal, gating `/admin/*`. Falls back to `OWNER_ADDRESS`,
   * and when neither is set the admin surface refuses every request rather than
   * accepting any session as the owner.
   */
  readonly ownerAddress?: string | null;
  readonly logger?: boolean;
  /** Disable only in focused tests that intentionally exceed public limits. */
  readonly rateLimit?: boolean;
  /**
   * Run the free-dungeon spawner in-process. Off by default so tests control
   * spawn state exactly; `npm run dev` and production turn it on.
   */
  readonly spawner?: boolean | Partial<SpawnerConfig>;
  /**
   * Run the chain-event indexer in-process.
   *
   * Off by default for the same reason as the spawner — a test wants to call
   * `runOnce()` when it chooses, not have a timer rewrite `player_stats`
   * underneath its assertions. `npm run dev` and production turn it on.
   */
  readonly indexer?: boolean | Partial<IndexerLoopConfig>;
  /**
   * Run the free-run loot mint ceremony in-process (docs/09 B7).
   *
   * Off by default, and for a stronger reason than the other two: this one signs
   * and broadcasts with the oracle key. A test that left it on would have a timer
   * putting mainnet transactions on the wire underneath its assertions.
   *
   * Deliberately absent from `onDemand`. That path is for work that produces
   * content; this mints an NFT a player has already been shown, and it must
   * happen whether or not anybody is looking at the site.
   */
  readonly lootMinter?: boolean | (Partial<LootMinterLoopConfig> & Partial<FreeRunLootMinterConfig>);
  /**
   * Shared secret gating `POST|GET /jobs/loot-mint`. Falls back to `CRON_SECRET`.
   *
   * This is the other driver for the job above, and the only one that works on a
   * host where a timer cannot fire — see routes/jobs.ts. Setting it switches the
   * endpoint on; leaving it unset means the endpoint refuses every request rather
   * than accepting any caller.
   *
   * Not mutually exclusive with `lootMinter`, unlike the timer/on-demand pair:
   * both drivers go through the same `LootMinterLoop`, so an operator running
   * both gets skipped passes rather than two ceremonies broadcasting one step.
   */
  readonly cronSecret?: string | null;
  /**
   * Drive the spawner and indexer from reads instead of timers.
   *
   * For serverless, where `deps.spawner`/`deps.indexer` are not merely wasteful
   * but inert: the platform freezes a function once it responds, so a
   * `setInterval` scheduled during one request never fires again. With this on,
   * `GET /map` tops up spawns and `GET /leaderboard` refreshes ranks, each
   * throttled to the interval its timer would have used. See services/onDemand.ts
   * for what that trades away.
   *
   * Mutually exclusive with the timer flags — when this is set the timers stay
   * off, so the two never stack.
   */
  readonly onDemand?: boolean;
}

export async function buildServer(deps: ServerDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 256 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 15_000,
    trustProxy: false,
    logger: deps.logger === false
      ? false
      : {
          level: process.env.LOG_LEVEL ?? 'info',
          // Never log signing keys or seeds-before-reveal.
          redact: [
            'req.headers.authorization',
            '*.privateKey',
            '*.seed',
            '*.signature',
          ],
        },
  });

  await app.register(cors, { origin: config.webOrigins, credentials: true });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    // The API serves JSON/bytes only; deny script, framing, and cross-origin
    // embedding by default. The web app has its own CSP at its origin.
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (config.network === 'mainnet') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
  });

  if (deps.rateLimit !== false) {
    const limiter = new MemoryRateLimiter(DEFAULT_RATE_LIMIT_RULES);
    // preHandler runs after body parsing, which is required for the
    // address-scoped /auth/verify bucket.
    app.addHook('preHandler', async (request, reply) => limiter.check(request, reply));
  }

  const stacks = deps.stacks ?? config.stacks;
  const chain =
    deps.chain ?? new HiroChainClient(stacks.apiUrl, config.hiroApiKey);
  const identity = new IdentityService(chain);
  // Postgres-backed by default; in-memory when there is no DATABASE_URL, so a
  // fresh clone can boot and exercise the flow before docker compose is up.
  const authStore =
    deps.authStore ?? (config.databaseUrl ? new PostgresAuthStore() : new MemoryAuthStore());
  const notificationStore: NotificationStore = config.databaseUrl
    ? new PostgresNotificationStore()
    : new MemoryNotificationStore();
  const characterCache =
    deps.characterCache ??
    (config.databaseUrl ? new PostgresCharacterCache() : new NullCharacterCache());
  // Without Postgres this degrades to "no cache", not "no rarity": every lookup
  // goes to Hiro. Correct, just chattier — the null repo is for the fresh-clone
  // boot path, not for production.
  const holderAgeRepo =
    deps.holderAgeRepo ??
    (config.databaseUrl ? new PostgresHolderAgeRepo() : new NullHolderAgeRepo());
  // Permanent and write-once — see `nft_mint_seeds`. Without Postgres this is the
  // null repo, so a fresh-clone boot re-reads the mint block per request rather
  // than caching it: correct, just chattier, exactly like the holder-age repo.
  const mintSeedRepo =
    deps.mintSeedRepo ?? (config.databaseUrl ? new PostgresMintSeedRepo() : new NullMintSeedRepo());
  const spawnStore =
    deps.spawnStore ?? (config.databaseUrl ? new PostgresSpawnStore() : new MemorySpawnStore());
  const runStore =
    deps.runStore ?? (config.databaseUrl ? new PostgresRunStore() : new MemoryRunStore());
  // Postgres is what makes this a *cross-instance* guard; the memory store is a
  // single-process stand-in that keeps one code path instead of two, so the lease
  // is exercised by the whole test suite rather than first executing on mainnet.
  const jobLeaseStore =
    deps.jobLeaseStore ??
    (config.databaseUrl ? new PostgresJobLeaseStore() : new MemoryJobLeaseStore());
  const forgeHistoryStore =
    deps.forgeHistoryStore ??
    (config.databaseUrl ? new PostgresForgeHistoryStore() : new MemoryForgeHistoryStore());
  // The in-memory stats store derives from whatever runs exist, which means it
  // needs the memory run store's `all()` — deliberately not on `RunStore`. When
  // a caller injects some other RunStore without a DATABASE_URL, there is
  // nothing to enumerate and the leaderboard is honestly empty rather than
  // wrong.
  const playerStatsStore =
    deps.playerStatsStore ??
    (config.databaseUrl
      ? new PostgresPlayerStatsStore()
      : new MemoryPlayerStatsStore(
          () => (runStore instanceof MemoryRunStore ? runStore.all() : []),
          forgeHistoryStore,
        ));
  const partyStore = deps.partyStore ?? (config.databaseUrl ? new PostgresPartyStore() : new MemoryPartyStore());

  const jwtSecret = deps.jwtSecret ?? config.jwtSecret;
  if (!jwtSecret) {
    // Refuse rather than fall back to a default secret: a predictable signing
    // key would let anyone mint a session for any address.
    throw new Error('JWT_SECRET is not set — refusing to start with unsigned sessions.');
  }

  // Same reasoning, one step further: an ephemeral or default oracle key would
  // produce attestations that stop verifying the moment the process restarts,
  // which is worse than none at all — a player would be handed a signature that
  // looks checkable and isn't.
  const oracleSigner =
    deps.oracleSigner ?? new StacksOracleSigner(loadOracleKey(), config.network);

  const oraclePrivateKey = deps.oraclePrivateKey ?? loadOracleKey();

  // Separate oracle for paid runs. Uses the same key as the free oracle but
  // calls different contract functions: `commit-seed` and `reveal-and-resolve`
  // rather than off-chain signatures. Kept as a distinct object so the one that
  // can move sponsor-pool funds stays unreachable from player-facing routes.
  const paidOracle =
    deps.paidOracle ??
    new PaidRunOracle({
      chain,
      stacks,
      oraclePrivateKey,
      log: (message, detail) => app.log.info(detail ?? {}, message),
    });

  const oracle = new RunOracle({
    runs: runStore,
    signer: oracleSigner,
    paidOracle,
    log: (message, detail) => app.log.info(detail ?? {}, message),
  });

  // One HolderAgeService for both the character list and combat setup, so a
  // character's rarity on its card and its stats in a fight come from the same
  // cached answer rather than two lookups that could disagree.
  const holderAge = new HolderAgeService({ chain, repo: holderAgeRepo });

  // One CharacterMintService for the shop routes, the character list's class
  // lookup, and combat setup. All three ask the same contract the same question
  // — what class was this token minted as, and what does one cost — and two
  // readers would be two chances to answer differently. Built before `combat`
  // because a minted character has no class without it: our own collection is
  // deliberately not in the curated allowlist.
  const characterMint = new CharacterMintService({
    chain,
    stacks,
    log: (message, detail) => app.log.info(detail ?? {}, message),
  });

  // One MintSeedService for the character list and combat setup, for the reason
  // the two above are shared: the seed decides a minted character's rarity floor,
  // so two resolvers would be two chances to show a Rare on the card and field a
  // Common in the fight.
  const mintSeeds = new MintSeedService({
    chain,
    repo: mintSeedRepo,
    assetIdentifier: buildAssetIdentifier(stacks, 'characterNft'),
    log: (message, detail) => app.log.info(detail ?? {}, message),
  });

  const combat = new CombatService({ oracle, chain, holderAge, characterMint, mintSeeds });

  // One PowerUpService for every route that reads or verifies a loadout: the
  // inventory listing, a free entry and a paid claim must never disagree about
  // what the wallet holds or what tier a token is. Same reasoning as `map`
  // below — these are chain reads, and two readers is two answers.
  const powerUps = new PowerUpService({
    chain,
    stacks,
    log: (message, detail) => app.log.info(detail ?? {}, message),
  });

  app.get('/health', async () => ({ status: 'ok', network: config.network }));

  /**
   * Contract addresses the web app should use. Served from the shared config so
   * addresses have exactly one source of truth (Phase 1 requirement).
   */
  app.get('/config', async () => ({
    network: config.network,
    explorerUrl: stacks.explorerUrl,
    contracts: Object.fromEntries(
      (Object.keys(CONTRACT_NAMES) as (keyof typeof CONTRACT_NAMES)[]).map((k) => [
        k,
        contractId(stacks, k),
      ]),
    ),
  }));

  await registerAuthRoutes(app, {
    store: authStore,
    network: config.network,
    jwtSecret,
  });

  await registerCharacterRoutes(app, {
    characters: new CharacterService({
      chain,
      cache: characterCache,
      stacks,
      holderAge,
      characterMint,
      mintSeeds,
    }),
    powerUps,
    characterMint,
    stacks,
    jwtSecret,
  });

  // One MapService for every route that needs a live gate fee or pool balance:
  // the map, a paid-entry quote, and an owner top-up must never disagree about
  // what the chain currently says.
  const map = new MapService({
    chain,
    spawns: spawnStore,
    stacks,
    log: (message, detail) => app.log.warn(detail ?? {}, message),
  });

  await registerMapRoutes(app, { map });

  // Serves wallet-held NFT art from our own origin, so a gateway that refuses a
  // cross-origin load or rate-limits a wall of cards stops being the browser's
  // problem. Unauthenticated by design; `lib/imageProxy.ts` is what keeps it from
  // being an open relay.
  await registerImageProxyRoutes(app, {});

  // One ForgeService for the player-facing route and for the indexer's recipe
  // mirror. Two readers of `get-recipe` would be two chances to map a tier
  // differently, and the tier is what `highestForgeTier` scores.
  const forge = new ForgeService({
    chain,
    stacks,
    log: (message, detail) => app.log.info(detail ?? {}, message),
  });

  await registerForgeRoutes(app, { forge, stacks, jwtSecret });

  await registerLeaderboardRoutes(app, { playerStats: playerStatsStore, identity });
  await registerProfileRoutes(app, { chain, playerStats: playerStatsStore, jwtSecret, identity });
  await registerNotificationRoutes(app, { notifications: notificationStore, jwtSecret });
  const charactersService = new CharacterService({ chain, cache: characterCache, stacks, holderAge, characterMint, mintSeeds });
  await registerPartyRoutes(app, { parties: partyStore, notifications: notificationStore, characters: charactersService, jwtSecret });

  await registerDungeonRoutes(app, {
    spawns: spawnStore,
    runs: runStore,
    oracle,
    combat,
    map,
    powerUps,
    stacks,
    jwtSecret,
  });

  const paidEntry = new PaidEntryService({
    chain,
    runs: runStore,
    oracle: paidOracle,
    combat,
    powerUps,
    stacks,
    log: (message, detail) => app.log.info(detail ?? {}, message),
  });

  await registerPaidClaimRoutes(app, {
    paidEntry,
    oracle,
    powerUps,
    jwtSecret,
  });

  await registerAdminRoutes(app, {
    ownerAddress: deps.ownerAddress ?? ownerAddressOrNull(),
    map,
    stacks,
    jwtSecret,
  });

  await registerRunRoutes(app, {
    combat,
    runs: runStore,
    jwtSecret,
  });

  // Background content jobs, and the two ways to drive them.
  //
  // Timers (`deps.spawner` / `deps.indexer`) are what `npm run dev` and any
  // long-running host use: the job runs whether or not anyone is looking.
  // Read-triggered (`deps.onDemand`) is what serverless uses, because a timer
  // there is silently inert. Exactly one applies, so a deployment cannot end up
  // running every pass twice.
  //
  // Both jobs are built here when either mode wants them. Neither touches money:
  // one invents map content, the other recomputes a leaderboard cache from chain
  // history. Nothing that must happen on a schedule regardless of traffic — a
  // settlement, an attestation, a payout — may be attached to either.
  const spawner =
    deps.spawner || deps.onDemand
      ? new DungeonSpawner({
          spawns: spawnStore,
          config: typeof deps.spawner === 'object' ? deps.spawner : undefined,
          log: (message, detail) => app.log.info(detail ?? {}, message),
        })
      : null;

  const indexer =
    deps.indexer || deps.onDemand
      ? new Indexer({
          chain,
          stacks,
          runs: runStore,
          forgeHistory: forgeHistoryStore,
          playerStats: playerStatsStore,
          forge,
          log: (message, detail) => app.log.info(detail ?? {}, message),
        })
      : null;

  if (deps.onDemand) {
    const log = (message: string, detail?: Record<string, unknown>) =>
      app.log.info(detail ?? {}, message);

    // Same intervals the timers would have used, so switching hosts changes
    // where the work is triggered from and not how often it happens.
    const spawnTicker = new OnDemandTicker({
      name: 'spawner',
      tick: () => spawner!.tick(),
      minIntervalMs: DEFAULT_SPAWNER_CONFIG.tickIntervalMs,
      log,
    });
    const indexTicker = new OnDemandTicker({
      name: 'indexer',
      tick: () => indexer!.runOnce(),
      minIntervalMs: DEFAULT_INDEXER_CONFIG.tickIntervalMs,
      log,
    });

    app.addHook('onRequest', async (request) => {
      switch (request.routeOptions.url) {
        case '/map':
          // Awaited. The response *is* the spawn list this pass tops up, so
          // firing and forgetting would show the thin map to the one visitor who
          // triggered the refill and the full one to whoever came next.
          await spawnTicker.runIfDue();
          break;
        case '/leaderboard':
          // Not awaited. A pass walks chain history over the network and can take
          // seconds; the response already carries `computedAt`, so a reader who
          // arrives mid-pass gets openly-stamped stale ranks rather than a slow
          // request. Staleness is disclosed here, latency would not be.
          indexTicker.startIfDue();
          break;
      }
    });
  } else {
    if (spawner) {
      spawner.start();
      // Tied to the server's lifecycle so a closed test server leaves no timer.
      app.addHook('onClose', async () => spawner.stop());
    }

    if (indexer) {
      const loop = new IndexerLoop(
        indexer,
        typeof deps.indexer === 'object' ? deps.indexer : undefined,
        (message, detail) => app.log.info(detail ?? {}, message),
      );
      loop.start();
      app.addHook('onClose', async () => loop.stop());
    }
  }

  // Outside the on-demand branch entirely, unlike the two above. This one signs
  // with the oracle key to mint a drop the player has already been shown, so it
  // cannot be traffic-driven (see oracle/lootMinterLoop.ts) — and it also must not
  // be silently skipped just because a host chose that mode.
  //
  // One ceremony, at most two drivers. `deps.lootMinter` is the in-process timer a
  // long-running host uses; `cronSecret` opens the endpoint an external scheduler
  // calls, which is the only thing that works where a `setInterval` never fires
  // twice. Both go through this same loop object so they share its in-flight
  // guard: an operator with both on gets a skipped pass, not two ceremonies
  // broadcasting the same step.
  //
  // That guard is per process, and the deployment this runs on has two schedulers
  // pointed at a fleet of them (docs/08-deployment.md §4.5), so the loop also gets
  // the shared lease. Without it two instances read the same run at the same
  // recorded step and both broadcast it — the loser aborts, and an aborted txid
  // that gets recorded parks a run as failed after the player saw their drop.
  const cronSecret = deps.cronSecret ?? config.cronSecret ?? null;
  const lootMinterOptions = typeof deps.lootMinter === 'object' ? deps.lootMinter : {};
  const lootMinter =
    deps.lootMinter || cronSecret
      ? new LootMinterLoop(
          new FreeRunLootMinter(
            {
              runs: runStore,
              oracle: paidOracle,
              chain,
              log: (message, detail) => app.log.info(detail ?? {}, message),
            },
            lootMinterOptions,
          ),
          lootMinterOptions,
          (message, detail) => app.log.info(detail ?? {}, message),
          jobLeaseStore,
        )
      : null;

  // Registered unconditionally, so an unconfigured deployment answers "the job
  // surface is off" instead of 404-ing and sending the operator after a typo.
  await registerJobRoutes(app, { cronSecret: cronSecret || null, lootMinter });

  if (deps.lootMinter && lootMinter) {
    lootMinter.start();
    // Tied to the server's lifecycle so a closed test server leaves no timer
    // holding an oracle key.
    app.addHook('onClose', async () => lootMinter.stop());
  }

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof ApiError) {
      // Expected, caller-facing failures: log at warn, return the spec'd shape.
      app.log.warn({ code: err.code, message: err.message }, 'request rejected');
      reply.status(err.statusCode).send(err.toJSON());
      return;
    }

    // A token that is not from a supported collection is a bad request, not a
    // server fault: the caller named an NFT that is not a playable character.
    // Mapped centrally rather than at each call site because every path that
    // derives a character can raise it, and a 500 here would read as "we broke"
    // when the honest answer is "that is not a character".
    if (err instanceof UnsupportedCollectionError) {
      app.log.warn(
        { contractId: err.contractId, tokenId: err.tokenId },
        'unsupported collection rejected',
      );
      reply.status(400).send({
        error: { code: 'UNSUPPORTED_COLLECTION', message: err.message },
      });
      return;
    }

    app.log.error(err);
    const status = err.statusCode ?? 500;
    reply.status(status).send({
      error: {
        code: err.code ?? 'INTERNAL_ERROR',
        message: status >= 500 ? 'Internal server error' : err.message,
      },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  return app;
}

// Windows paths and file:// URLs don't compare directly, so normalise through
// pathToFileURL rather than string-matching.
const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // The loot minter runs on a timer here, which is the driver a host that owns
  // its own process can use. On the serverless entry point the timer is inert and
  // the same loop is driven by `GET /jobs/loot-mint` on the platform's clock
  // instead — see routes/jobs.ts and docs/08-deployment.md §4.5 (docs/09 B7).
  const app = await buildServer({ spawner: true, indexer: true, lootMinter: true });
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

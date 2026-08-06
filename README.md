# GrimHallow

Co-op, turn-based dungeon crawler on Stacks (Bitcoin L2). Your existing NFTs
become playable characters with stats derived deterministically from their
identity; parties raid dungeons resolved by verifiable on-chain dice.

`/docs` is the source of truth for systems, economics, and data shape.
`/apps/web` is the source of truth for visual design and screen structure.

---

## The two money flows (read this before touching contract or backend code)

These are **separate and must never mix**:

| | Flow A — player payments | Flow B — sponsor pool |
|---|---|---|
| Credited by | any of the **three revenue lines** below | **only** the owner calling `fund-pool` |
| Goes to | the contract owner principal (operator revenue) | the sponsor pool balance |
| Debited by | n/a | jackpot payouts on reveal-and-resolve |

Flow A has three sources, and they are the same kind of thing in every respect —
paid buyer → owner in one hop, never escrowed, never refunded:

| Revenue line | Contract | Amount |
|---|---|---|
| Gate fee | `game-core.enter-dungeon` | 1 STX, per paid entry |
| Character mint price | `character-nft.mint-character` | owner-settable, `set-mint-price` |
| Forge fee | `forge-v2.forge` | per recipe, set at `create-recipe` |

**If any code path lets one of these increase the pool balance, that is a
critical bug.** See `docs/02-architecture.md` §3 and
`docs/03-smart-contracts-spec.md` §2–3. All three are asserted through one shared
test helper (`expectRevenueNotPool`) rather than three hand-written balance
checks — a rule proved three different ways can drift three different ways.

**Every amount that enters a post-condition is read live from chain**, never from
a seeding constant like `FORGE_FEE_BY_OUTPUT_TIER` or `CHARACTER_MINT_PRICE_USTX`.
Those are what the owner *seeds*; they are not what the chain *charges*, and the
two diverge the moment a price is retuned. A stale quote is not a display bug —
it becomes a post-condition, and the player pays a network fee to have their own
transaction aborted (`docs/04-backend-api-spec.md` §7b).

There is **no escrow and no refunds** anywhere. Once a paid entry is submitted,
that STX is gone regardless of outcome. Do not add a refund path.

## Other non-negotiables

- **Commit-reveal is the only randomness.** Every dice roll and the reward-table
  draw derives from the committed/revealed seed as `hash(seed || i) % range`
  (`docs/03-smart-contracts-spec.md` §5). Never `Math.random()`, never a
  client-supplied value, never block-time entropy, for anything affecting an
  outcome or payout. (The one permitted exception is cosmetic: `Dice.tsx` uses
  `Math.random()` for the tumbling animation frames *before* it settles on the
  real value passed in.)
- **Stat and dice derivation live in exactly one place** — `/packages/shared`,
  versioned (`stats-v3`, `dice-v1`) and imported by backend and tooling alike.
  Never re-implement them; drift between two copies breaks the independent
  verifiability the whole architecture rests on. Golden-vector tests pin both.
- **The backend never custodies or signs for a player.** It prepares unsigned tx
  payloads. The only keys it holds are the **oracle key** (commit-seed /
  reveal-and-resolve) and the **owner key** (admin actions like `fund-pool`),
  kept in separate env vars and loaded through separate functions in
  `apps/api/src/config.ts` — deliberately not reachable from the general
  `config` object, since the oracle key can move pool funds.

---

## Layout

```
contracts/          Clarity contracts + Clarinet tests
apps/web/           Vite + React frontend
apps/api/           Fastify backend (oracle + convenience layer)
packages/shared/    Versioned pure functions: stat + dice derivation, types,
                    and the single source of truth for contract addresses
docs/               Specification
```

## Prerequisites

- Node.js >= 22 (developed on v22.19.0), npm 10
- Docker Desktop — for Postgres
- Clarinet **>= 3.23** — see the version note under "Local devnet"

> **Check which `clarinet` you are running: `clarinet --version`.** If it says
> 3.15.1 you have winget's build on PATH, which cannot parse `epoch: '4.0'` and
> silently rewrites deployment plans to `3.3`. Use
> `%LOCALAPPDATA%\GrimHallow\tools\clarinet\clarinet.exe` (3.23.1) explicitly, or
> put it ahead of winget on PATH.

> **`clarinet deployments apply` has no dry-run mode.** It prints the plan, then
> signs and broadcasts. There is no preview flag — `-d` only stops it recomputing
> the plan. On `--mainnet` that spends real STX the moment you run it.


## Setup

```bash
npm install                 # installs all workspaces
npm --prefix contracts install
cp .env.example .env        # then fill in keys
npm run db:up               # Postgres in Docker
npm run db:check            # verifies DATABASE_URL end to end
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev:web` | frontend on :3000 |
| `npm run dev:api` | backend on :8080 |
| `npm run lint` | typecheck every workspace |
| `npm test` | shared-package unit tests (incl. golden vectors) |
| `npm run test:contracts` | Clarity tests via simnet — **no Docker needed** |
| `npm run test:all` | both of the above |
| `npm run check:contracts` | `clarinet check` |
| `npm run devnet` | full local Stacks devnet (see caveat below) |
| `npm run db:up` / `db:down` / `db:check` | Postgres lifecycle |
| `npm run db:migrate` | apply `db/schema.sql`, then fail on any schema drift |
| `npm run seed` | owner-signed post-deploy wiring (`-- --dry-run` first) |
| `npm run verify-seed` | read the seeded state back off chain |
| `npm run fund-pool -- <stx> --confirm` | the **only** thing that credits the sponsor pool |

## Environment

One `.env` at the repo root serves both apps — `apps/api` loads it by path and
Vite reads it via `envDir`, so the network and deployer address cannot drift
between them. Only `VITE_`-prefixed vars reach the browser.

Contract addresses have a single source of truth in
`packages/shared/src/contracts.ts`, re-exported to the frontend by the API's
`GET /config`. Do not hardcode an address anywhere else.

---

## Local devnet

`npm run test:contracts` runs against **simnet** and needs no Docker, so contract
development and the full test suite work without a devnet. Devnet is only needed
for integration against a real chain, and testnet covers that too.

### Known blocker: Clarinet devnet vs Docker Engine 29

On this machine `clarinet devnet start` fails at the first container:

```
ERRO Fatal: unable to create bitcoind container:
     JsonSerdeError { err: Error("expected value", line: 1, column: 1) }
```

**Root cause** (confirmed by probing the Docker Engine API directly over the
named pipe): Engine 29 packs multiple JSON objects into a single HTTP chunk on
`POST /images/create`, e.g.

```
a0\r\n{"status":"Digest: sha256:..."}\r\n{"status":"Status: Image is up to date..."}\r\n
```

Clarinet's Docker client deserializes one chunk as one JSON value, so the
trailing object is left unconsumed and the next parse begins on whitespace —
producing exactly `expected value, line 1, column 1`. Older engines emitted one
object per chunk. Because the image is already cached locally the pull returns
fast enough that both messages always land in the same chunk, so this fails
deterministically rather than intermittently.

Verified *not* the cause: daemon reachability (both named pipes answer),
`docker create` with the same image/network/port config (succeeds via CLI),
container-create over the raw API at v1.41/v1.44/v1.55 (all 201), the image
itself (`lncm/bitcoind:v27.2` pulls fine), and the Clarinet version (fails
identically on 3.15.1 and 3.23.1).

This is upstream — not a project bug and not fixable in this repo. Options if
you need devnet: downgrade Docker Desktop to an Engine 28.x release, or wait for
a Clarinet release that updates its Docker client. Until then, use simnet for
tests and testnet for integration.

Clarinet itself is installed at
`%LOCALAPPDATA%\GrimHallow\tools\clarinet` (3.23.1, checksum-verified against
the upstream release). The older winget package was removed so `clarinet` on
PATH is unambiguous.

---

## Running it locally for a playtest

```bash
npm install && npm --prefix contracts install
cp .env.example .env         # fill in keys — see Environment above
npm run db:up && npm run db:migrate
npm run dev:api              # :8080
npm run dev:web              # :3000, in a second terminal
```

`db:migrate` is idempotent and safe to re-run. It also **diffs the live schema
against `db/schema.sql` and exits non-zero on drift** — `create table if not
exists` converges a missing table but never a *changed* one, so without that
check a stale column set reports success and then fails much later somewhere
unrelated. `npm run db:migrate -- --check` diffs without applying.

### Filling in the keys

The deployer's key is not something to retype. It lives as a seed phrase in
`contracts/settings/Mainnet.toml` (that is what clarinet signs deploys with),
and `CONTRACT-OWNER` is bound to whoever deployed, so the seeding and admin
scripts must sign as that same account:

```bash
node scripts/derive-deployer-key.mjs            # prints only the address
node scripts/derive-deployer-key.mjs --write    # writes OWNER_* to .env
node scripts/set-env.mjs --network mainnet      # network + JWT_SECRET
```

The first derives `m/44'/5757'/0'/0/0` from the phrase and never prints the key.
Check the address it reports against `expected-sender` in
`contracts/deployments/default.mainnet-plan.yaml` before writing anything — a
mismatch means every owner-only call will fail on chain.

`set-env.mjs --oracle-is-owner` additionally points the oracle key at that same
account. That collapses the key separation in `docs/02-architecture.md` §7 into
one key that signs reveals, receives all revenue, and can `fund-pool` — a single
compromise costs all three. It is opt-in for that reason. Both scripts print the
warning every run.

### Seeding

```bash
npm run seed -- --dry-run    # itemises the transactions, broadcasts nothing
npm run seed                 # real transactions, real fees
npm run verify-seed          # read the result back off chain
```

`verify-seed` exists because eight successful receipts do not mean the contracts
are in the state the game needs — a `set-minter` that confirmed against the
wrong principal looks identical from the receipt. It asks the contracts, and it
treats **v1 `forge` holding minter rights as a failure**, since minter rights
are the only thing keeping that fee-less contract inert.

Seeding deliberately does **not** fund the sponsor pool. Until you run
`npm run fund-pool -- <stx> --confirm`, a paid run resolves to no payout. That
is the designed behaviour, not a bug.

Then open `http://localhost:3000` and connect a wallet
([Leather](https://leather.io) or [Xverse](https://www.xverse.app), browser
extension). A wallet holding no NFT is a supported starting state: the character
screen funnels to `/shop`, where minting one is the way in.

### Getting STX to play with

**Which network you point at decides whether you spend real money.** Set
`STACKS_NETWORK` / `VITE_STACKS_NETWORK` in `.env`.

- **`mainnet` — real STX.** This is where the contracts are actually deployed
  (`docs/06-mvp-roadmap.md` Phase 1). Every gate fee, mint price, and forge fee
  is a real, non-refundable payment. There is no faucet, by definition. Tell
  playtesters this in plain words before they connect a wallet; the in-app
  disclosures say it too, but a friend doing you a favour should not first learn
  it from a wallet prompt.
- **`testnet` — free STX from a faucet.** Fund an address at
  [`explorer.hiro.so/sandbox/faucet?chain=testnet`](https://explorer.hiro.so/sandbox/faucet?chain=testnet)
  (500 STX per request, repeatable; the wallet extension also has a "request
  testnet STX" button once switched to testnet). **The contracts are not on
  testnet yet** — you would need to publish them there first, and
  `packages/shared/src/contracts.ts` would need the testnet deployer address.
  Worth doing before any playtest that involves someone else's money, which is
  every playtest on mainnet.
- **`devnet` — pre-funded local accounts**, no faucet needed: the wallets in
  `contracts/settings/Devnet.toml` start with a balance. Blocked on this machine,
  though — see the Docker Engine 29 note above.

For contract work specifically, neither faucet nor devnet is needed:
`npm run test:contracts` runs against simnet, which is instant and free.

---

## Deploying

Supabase for Postgres, two Vercel projects for the API and the web app. The
runbook is `docs/08-deployment.md`; the three things most likely to bite are all
in there, so read it rather than inferring the setup from the config files:

- Supabase's **transaction pooler** (port 6543), not the direct port — and the
  three things this codebase must keep not doing for that to stay safe.
- The API's spawner and indexer **cannot run on timers** in serverless. They tick
  on demand instead, which means no traffic → no background work. Fine for the
  two jobs that do it; never attach anything that moves money.
- `ORACLE_PRIVATE_KEY` has to live in Vercel's environment store, and it can move
  sponsor-pool funds. `OWNER_PRIVATE_KEY` must **not** go there — the API never
  uses it.

Locally, `node apps/api/scripts/smoke-vercel.mjs` (after
`npm run build --workspace @grimhallow/api`) serves the real deployment bundle and
is the check that catches an artifact which builds but cannot import.

---

## Deviations from `/docs`

Flagged rather than silently reconciled, per the project's conflict-resolution
rule (docs win on systems/economics/data; the frontend wins on visual design).

1. **Vite + React Router, not Next.js.** `docs/02-architecture.md` §1 and the
   Phase 0 checklist specify Next.js App Router. The frontend was already built
   on Vite 6 + `react-router-dom` 7 and moved to `apps/web` as-is, per the
   instruction to integrate with the existing frontend rather than regenerate
   it. Nothing in the game's systems or economics depends on the framework
   choice.
2. **No Phaser.** It was declared as a dependency with zero imports — Map and
   Combat are DOM + `motion`. Removed rather than adopted.
3. **Missing spec docs.** `docs/00-overview.md` and
   `docs/09-frontend-implementation-prompt.md` are referenced but absent from
   the repo. The acceptance bar and screen list were taken from the project
   instructions and `App.tsx`'s router respectively.

## Open questions

Tracked in `docs/07-glossary-and-open-questions.md`. Resolved so far: **class**
comes from a static eight-collection allowlist (`SUPPORTED_CLASS_CONTRACTS` in
`packages/shared/src/classes.ts`), or from the chain for our own mints — never
from metadata and never hashed, and a token from any other collection is not a
playable character at all; **rarity** comes from the current holder's tenure
(`packages/shared/src/rarity.ts`); party size cap **4**; forge is **3-for-1,
guaranteed, 4 tiers**; free dungeons **are** on-chain runs.

Still unanswered and needed before the phases that consume them:

- **Reward table odds and prize sizing** (needed for Phase 5).
- **UI elements with no spec data source:** TopBar's Soul Shards and Gold;
  `Inventory.tsx`'s weapons/armor/consumables and Equip/Use/Discard; `Profile`'s
  Total Kills / Total Earnings / Achievements / "Member since"; display
  usernames like `Arcanist#9172` (docs key everything by wallet address); the
  Leaderboard's `maxForge: 'Epic IV'` (contract stores a numeric tier; the
  tier→name mapping is undefined).

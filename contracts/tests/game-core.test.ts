import { Cl } from '@stacks/transactions';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * game-core tests.
 *
 * Covers the docs/03-smart-contracts-spec.md §8 checklist:
 *   - enter-dungeon on a paid dungeon fails on wrong STX amount
 *   - enter-dungeon sends the fee to contract-owner AND leaves sponsor-pool
 *     completely unchanged  <- the most important test in this suite
 *   - fund-pool is owner-only and the only function that increases sponsor-pool
 *   - no code path refunds a paid entry
 *   - reveal-and-resolve fails on seed/hash mismatch, on double-resolve, and on
 *     a jackpot exceeding sponsor-pool
 *   - full happy-path integration test
 */

const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer')!; // CONTRACT-OWNER
const oracle = accounts.get('wallet_1')!; // oracle key, deliberately not the owner
const alice = accounts.get('wallet_2')!;
const bob = accounts.get('wallet_3')!;
const carol = accounts.get('wallet_4')!;
const mallory = accounts.get('wallet_5')!;

const CORE = 'game-core';
const NFT = 'character-loot-nft';

const ERR_NOT_OWNER = Cl.uint(200);
const ERR_NOT_ORACLE = Cl.uint(201);
const ERR_DUNGEON_NOT_FOUND = Cl.uint(202);
const ERR_DUNGEON_INACTIVE = Cl.uint(203);
const ERR_EMPTY_PARTY = Cl.uint(204);
const ERR_RUN_NOT_FOUND = Cl.uint(205);
const ERR_WRONG_STATE = Cl.uint(206);
const ERR_SEED_MISMATCH = Cl.uint(207);
const ERR_INSUFFICIENT_POOL = Cl.uint(208);
const ERR_BAD_OUTCOME = Cl.uint(209);
const ERR_BAD_REWARD = Cl.uint(210);
const ERR_AMOUNT_ZERO = Cl.uint(212);
const ERR_BAD_GATE_FEE = Cl.uint(213);

const ONE_STX = 1_000_000n; // uSTX
const GATE_FEE = Number(ONE_STX); // the MVP paid dungeon costs 1 STX

const SEED = Buffer.alloc(32, 7);
const SEED_HASH = createHash('sha256').update(SEED).digest();
const OTHER_SEED = Buffer.alloc(32, 9);

// --- helpers ---

function stxBalance(who: string): bigint {
  return simnet.getAssetsMap().get('STX')?.get(who) ?? 0n;
}

function sponsorPool(): bigint {
  const { result } = simnet.callReadOnlyFn(CORE, 'get-sponsor-pool', [], deployer);
  // `result` is a ClarityValue uint; `.value` is a bigint.
  return (result as { value: bigint }).value;
}

function createDungeon(gateFee: number, isPaid: boolean) {
  const { result } = simnet.callPublicFn(
    CORE,
    'create-dungeon',
    [Cl.uint(gateFee), Cl.bool(isPaid)],
    deployer,
  );
  return result;
}

function fundPool(amount: bigint | number, sender = deployer) {
  return simnet.callPublicFn(CORE, 'fund-pool', [Cl.uint(amount)], sender);
}

function enter(dungeonId: number, party: string[], sender: string) {
  return simnet.callPublicFn(
    CORE,
    'enter-dungeon',
    [Cl.uint(dungeonId), Cl.list(party.map(Cl.principal))],
    sender,
  );
}

function commit(runId: number, hash: Buffer = SEED_HASH, sender = oracle) {
  return simnet.callPublicFn(
    CORE,
    'commit-seed',
    [Cl.uint(runId), Cl.buffer(hash)],
    sender,
  );
}

type Reward =
  | { kind: 'none' }
  | { kind: 'jackpot'; amount: bigint | number }
  | { kind: 'loot'; uri: string; tier: number }
  | { kind: string };

function rewardCv(reward: Reward | null) {
  if (reward === null) return Cl.none();
  const r = reward as {
    kind: string;
    amount?: bigint | number;
    uri?: string;
    tier?: number;
  };
  return Cl.some(
    Cl.tuple({
      kind: Cl.stringAscii(r.kind),
      amount: r.amount === undefined ? Cl.none() : Cl.some(Cl.uint(r.amount)),
      'loot-uri': r.uri === undefined ? Cl.none() : Cl.some(Cl.stringAscii(r.uri)),
      tier: r.tier === undefined ? Cl.none() : Cl.some(Cl.uint(r.tier)),
    }),
  );
}

function resolve(
  runId: number,
  {
    seed = SEED,
    outcome = 'win',
    reward = null as Reward | null,
    sender = oracle,
  } = {},
) {
  return simnet.callPublicFn(
    CORE,
    'reveal-and-resolve',
    [Cl.uint(runId), Cl.buffer(seed), Cl.stringAscii(outcome), rewardCv(reward)],
    sender,
  );
}

/** Standard fixture: oracle wired up, dungeon 1 paid (1 STX), dungeon 2 free. */
function setupDungeons() {
  simnet.callPublicFn(CORE, 'set-oracle', [Cl.principal(oracle)], deployer);
  createDungeon(GATE_FEE, true);
  createDungeon(0, false);
}

// ---------------------------------------------------------------------------

describe('game-core: THE critical invariant - entry fees never touch the pool', () => {
  beforeEach(setupDungeons);

  it('sends the gate fee to the contract owner and leaves sponsor-pool at zero', () => {
    expect(sponsorPool()).toBe(0n);
    const ownerBefore = stxBalance(deployer);
    const aliceBefore = stxBalance(alice);

    const { result } = enter(1, [alice, bob], alice);
    expect(result).toBeOk(Cl.uint(1));

    // Fee landed in the owner's wallet, exactly once, exactly the gate fee.
    expect(stxBalance(deployer)).toBe(ownerBefore + ONE_STX);
    expect(stxBalance(alice)).toBe(aliceBefore - ONE_STX);

    // ...and the pool did not move. This is the whole economic model.
    expect(sponsorPool()).toBe(0n);
  });

  it('leaves an already-funded sponsor-pool untouched by an entry', () => {
    fundPool(50n * ONE_STX);
    const poolBefore = sponsorPool();
    const ownerBefore = stxBalance(deployer);

    enter(1, [alice], alice);
    enter(1, [bob], bob);
    enter(1, [carol], carol);

    expect(sponsorPool()).toBe(poolBefore);
    expect(stxBalance(deployer)).toBe(ownerBefore + 3n * ONE_STX);
  });

  it('holds no entry-fee STX in the contract itself - nothing is escrowed', () => {
    const contract = `${deployer}.${CORE}`;
    expect(stxBalance(contract)).toBe(0n);

    enter(1, [alice, bob], alice);

    // The contract's balance is still zero: the fee went straight past it to
    // the owner. Nothing is held, so nothing can be refunded or clawed back.
    expect(stxBalance(contract)).toBe(0n);
  });

  it('keeps the contract balance equal to the pool after funding and entries', () => {
    const contract = `${deployer}.${CORE}`;
    fundPool(10n * ONE_STX);
    enter(1, [alice], alice);
    enter(1, [bob], bob);

    // Only fund-pool money is held by the contract. Entries added nothing.
    expect(stxBalance(contract)).toBe(10n * ONE_STX);
    expect(sponsorPool()).toBe(10n * ONE_STX);
  });

  it('does not refund the fee when the run resolves as a loss with no reward', () => {
    const aliceBefore = stxBalance(alice);
    const ownerBefore = stxBalance(deployer);

    enter(1, [alice], alice);
    commit(1);
    expect(resolve(1, { outcome: 'loss', reward: { kind: 'none' } }).result).toBeOk(
      Cl.bool(true),
    );

    // Alice is down exactly the gate fee, permanently. The owner keeps it.
    expect(stxBalance(alice)).toBe(aliceBefore - ONE_STX);
    expect(stxBalance(deployer)).toBe(ownerBefore + ONE_STX);
  });
});

describe('game-core: sponsor pool is owner-funded only', () => {
  beforeEach(setupDungeons);

  it('lets the owner fund the pool', () => {
    expect(fundPool(5n * ONE_STX).result).toBeOk(Cl.bool(true));
    expect(sponsorPool()).toBe(5n * ONE_STX);
  });

  it('rejects fund-pool from anyone but the owner', () => {
    expect(fundPool(5n * ONE_STX, mallory).result).toBeErr(ERR_NOT_OWNER);
    expect(fundPool(5n * ONE_STX, oracle).result).toBeErr(ERR_NOT_OWNER);
    expect(sponsorPool()).toBe(0n);
  });

  it('rejects a zero-amount funding', () => {
    expect(fundPool(0).result).toBeErr(ERR_AMOUNT_ZERO);
  });

  it('is not increased by any other entrypoint', () => {
    // Exercise every public function that could plausibly touch value, and
    // assert the pool only ever moved when fund-pool was called.
    expect(sponsorPool()).toBe(0n);

    createDungeon(GATE_FEE, true);
    expect(sponsorPool()).toBe(0n);

    enter(1, [alice, bob], alice); // paid entry
    expect(sponsorPool()).toBe(0n);

    enter(2, [alice, bob], alice); // free entry
    expect(sponsorPool()).toBe(0n);

    commit(1);
    expect(sponsorPool()).toBe(0n);

    resolve(1, { reward: { kind: 'none' } });
    expect(sponsorPool()).toBe(0n);

    simnet.callPublicFn(CORE, 'set-oracle', [Cl.principal(bob)], deployer);
    expect(sponsorPool()).toBe(0n);

    fundPool(ONE_STX);
    expect(sponsorPool()).toBe(ONE_STX); // only here
  });
});

describe('game-core: dungeons', () => {
  beforeEach(setupDungeons);

  it('only the owner can create a dungeon', () => {
    const { result } = simnet.callPublicFn(
      CORE,
      'create-dungeon',
      [Cl.uint(GATE_FEE), Cl.bool(true)],
      mallory,
    );
    expect(result).toBeErr(ERR_NOT_OWNER);
  });

  it('rejects a paid dungeon with a zero fee and a free dungeon with a fee', () => {
    expect(createDungeon(0, true)).toBeErr(ERR_BAD_GATE_FEE);
    expect(createDungeon(GATE_FEE, false)).toBeErr(ERR_BAD_GATE_FEE);
  });

  it('exposes the dungeon record', () => {
    const { result } = simnet.callReadOnlyFn(CORE, 'get-dungeon', [Cl.uint(1)], alice);
    expect(result).toBeSome(
      Cl.tuple({
        'gate-fee': Cl.uint(GATE_FEE),
        'is-paid': Cl.bool(true),
        active: Cl.bool(true),
      }),
    );
  });

  it('rejects entry to a nonexistent or deactivated dungeon', () => {
    expect(enter(99, [alice], alice).result).toBeErr(ERR_DUNGEON_NOT_FOUND);

    simnet.callPublicFn(
      CORE,
      'set-dungeon-active',
      [Cl.uint(1), Cl.bool(false)],
      deployer,
    );
    expect(enter(1, [alice], alice).result).toBeErr(ERR_DUNGEON_INACTIVE);
  });

  it('rejects an empty party', () => {
    expect(enter(1, [], alice).result).toBeErr(ERR_EMPTY_PARTY);
  });
});

describe('game-core: entering', () => {
  beforeEach(setupDungeons);

  it('charges exactly the gate fee - no more, no less', () => {
    // The amount is read from the dungeon record rather than supplied by the
    // caller, so an incorrect amount is not representable. This asserts the
    // resulting transfer is exactly gate-fee in both directions.
    const aliceBefore = stxBalance(alice);
    const ownerBefore = stxBalance(deployer);

    enter(1, [alice], alice);

    expect(aliceBefore - stxBalance(alice)).toBe(ONE_STX);
    expect(stxBalance(deployer) - ownerBefore).toBe(ONE_STX);
  });

  it('fails when the entrant cannot cover the gate fee', () => {
    // Drain mallory to just under the fee, then try to enter.
    const balance = stxBalance(mallory);
    simnet.transferSTX(Number(balance - ONE_STX / 2n), deployer, mallory);
    const { result } = enter(1, [mallory], mallory);
    expect(result).toBeErr(Cl.uint(1)); // stx-transfer? insufficient funds
  });

  it('takes no STX at all on a free dungeon', () => {
    const aliceBefore = stxBalance(alice);
    const ownerBefore = stxBalance(deployer);

    expect(enter(2, [alice, bob], alice).result).toBeOk(Cl.uint(1));

    expect(stxBalance(alice)).toBe(aliceBefore);
    expect(stxBalance(deployer)).toBe(ownerBefore);
    expect(sponsorPool()).toBe(0n);
  });

  it('records the run as pending with no seed and no outcome', () => {
    enter(1, [alice, bob], alice);
    const { result } = simnet.callReadOnlyFn(CORE, 'get-run', [Cl.uint(1)], alice);
    expect(result).toBeSome(
      Cl.tuple({
        'dungeon-id': Cl.uint(1),
        party: Cl.list([Cl.principal(alice), Cl.principal(bob)]),
        state: Cl.stringAscii('pending'),
        'seed-hash': Cl.bufferFromHex(''),
        'seed-reveal': Cl.none(),
        'combat-outcome': Cl.none(),
      }),
    );
  });

  it('issues sequential run ids', () => {
    expect(enter(1, [alice], alice).result).toBeOk(Cl.uint(1));
    expect(enter(2, [bob], bob).result).toBeOk(Cl.uint(2));
    expect(enter(1, [carol], carol).result).toBeOk(Cl.uint(3));
  });
});

describe('game-core: commit-reveal', () => {
  beforeEach(() => {
    setupDungeons();
    enter(1, [alice, bob], alice);
  });

  it('only the oracle can commit', () => {
    expect(commit(1, SEED_HASH, mallory).result).toBeErr(ERR_NOT_ORACLE);
    // Not even the owner - the two keys are deliberately separate.
    expect(commit(1, SEED_HASH, deployer).result).toBeErr(ERR_NOT_ORACLE);
    expect(commit(1).result).toBeOk(Cl.bool(true));
  });

  it('rejects a commit on an unknown run or a run already committed', () => {
    expect(commit(99).result).toBeErr(ERR_RUN_NOT_FOUND);
    commit(1);
    expect(commit(1).result).toBeErr(ERR_WRONG_STATE);
  });

  it('only the oracle can resolve', () => {
    commit(1);
    expect(resolve(1, { sender: mallory }).result).toBeErr(ERR_NOT_ORACLE);
    expect(resolve(1, { sender: deployer }).result).toBeErr(ERR_NOT_ORACLE);
  });

  it('rejects a resolve before commit', () => {
    expect(resolve(1).result).toBeErr(ERR_WRONG_STATE);
  });

  it('rejects a seed that does not hash to the commitment', () => {
    commit(1);
    expect(resolve(1, { seed: OTHER_SEED }).result).toBeErr(ERR_SEED_MISMATCH);

    // ...and the run is still resolvable with the correct seed afterwards.
    expect(resolve(1, { reward: { kind: 'none' } }).result).toBeOk(Cl.bool(true));
  });

  it('rejects a double resolve', () => {
    commit(1);
    expect(resolve(1, { reward: { kind: 'none' } }).result).toBeOk(Cl.bool(true));
    expect(resolve(1, { reward: { kind: 'none' } }).result).toBeErr(ERR_WRONG_STATE);
  });

  it('rejects a combat outcome other than win or loss', () => {
    commit(1);
    expect(resolve(1, { outcome: 'draw' }).result).toBeErr(ERR_BAD_OUTCOME);
  });

  it('rejects an unknown reward kind', () => {
    commit(1);
    expect(resolve(1, { reward: { kind: 'bonus' } }).result).toBeErr(ERR_BAD_REWARD);
  });

  it('rejects a jackpot with no amount and loot with no tier', () => {
    commit(1);
    expect(resolve(1, { reward: { kind: 'jackpot' } }).result).toBeErr(ERR_BAD_REWARD);
    expect(resolve(1, { reward: { kind: 'loot' } }).result).toBeErr(ERR_BAD_REWARD);
  });

  it('stores the revealed seed and outcome so anyone can recompute the rolls', () => {
    commit(1);
    resolve(1, { outcome: 'win', reward: { kind: 'none' } });

    const { result } = simnet.callReadOnlyFn(CORE, 'get-run', [Cl.uint(1)], alice);
    expect(result).toBeSome(
      Cl.tuple({
        'dungeon-id': Cl.uint(1),
        party: Cl.list([Cl.principal(alice), Cl.principal(bob)]),
        state: Cl.stringAscii('resolved'),
        'seed-hash': Cl.buffer(SEED_HASH),
        'seed-reveal': Cl.some(Cl.buffer(SEED)),
        'combat-outcome': Cl.some(Cl.stringAscii('win')),
      }),
    );
  });

  it('emits a leaderboard-credit event on every resolve, reward or not', () => {
    commit(1);
    const { events } = resolve(1, { outcome: 'loss', reward: { kind: 'none' } });
    const printed = events.filter((e) => e.event === 'print_event');
    const serialized = JSON.stringify(printed);
    expect(serialized).toContain('leaderboard-credit');
  });
});

describe('game-core: jackpot payouts draw only from the pool', () => {
  beforeEach(() => {
    setupDungeons();
    enter(1, [alice, bob], alice);
    commit(1);
  });

  it('rejects a jackpot larger than the pool - the hard backstop', () => {
    fundPool(2n * ONE_STX);
    const aliceBefore = stxBalance(alice);

    expect(
      resolve(1, { reward: { kind: 'jackpot', amount: 3n * ONE_STX } }).result,
    ).toBeErr(ERR_INSUFFICIENT_POOL);

    // Nothing moved and the run is still resolvable at a smaller amount.
    expect(sponsorPool()).toBe(2n * ONE_STX);
    expect(stxBalance(alice)).toBe(aliceBefore);
    expect(
      resolve(1, { reward: { kind: 'jackpot', amount: 2n * ONE_STX } }).result,
    ).toBeOk(Cl.bool(true));
  });

  it('rejects a jackpot when the pool is empty', () => {
    expect(sponsorPool()).toBe(0n);
    expect(resolve(1, { reward: { kind: 'jackpot', amount: 1 } }).result).toBeErr(
      ERR_INSUFFICIENT_POOL,
    );
  });

  it('splits the jackpot equally across the party and debits the pool once', () => {
    fundPool(10n * ONE_STX);
    const aliceBefore = stxBalance(alice);
    const bobBefore = stxBalance(bob);

    expect(
      resolve(1, { reward: { kind: 'jackpot', amount: 4n * ONE_STX } }).result,
    ).toBeOk(Cl.bool(true));

    expect(stxBalance(alice)).toBe(aliceBefore + 2n * ONE_STX);
    expect(stxBalance(bob)).toBe(bobBefore + 2n * ONE_STX);
    expect(sponsorPool()).toBe(6n * ONE_STX);
  });

  it('gives an indivisible remainder to the first party member', () => {
    fundPool(10n * ONE_STX);
    const aliceBefore = stxBalance(alice);
    const bobBefore = stxBalance(bob);

    // 7 uSTX across 2 members: 3 each, 1 left over.
    resolve(1, { reward: { kind: 'jackpot', amount: 7 } });

    expect(stxBalance(alice)).toBe(aliceBefore + 4n);
    expect(stxBalance(bob)).toBe(bobBefore + 3n);
  });

  it('rejects a zero-amount jackpot', () => {
    fundPool(ONE_STX);
    expect(resolve(1, { reward: { kind: 'jackpot', amount: 0 } }).result).toBeErr(
      ERR_AMOUNT_ZERO,
    );
  });

  it('never pays out more than the pool even across several runs', () => {
    fundPool(3n * ONE_STX);
    resolve(1, { reward: { kind: 'jackpot', amount: 3n * ONE_STX } });
    expect(sponsorPool()).toBe(0n);

    enter(1, [carol], carol);
    commit(2);
    expect(resolve(2, { reward: { kind: 'jackpot', amount: 1 } }).result).toBeErr(
      ERR_INSUFFICIENT_POOL,
    );
  });
});

describe('game-core: loot rewards', () => {
  beforeEach(() => {
    setupDungeons();
    // game-core must be an authorized minter on the NFT contract. On a real
    // deployment this is a post-deploy owner transaction driven from
    // packages/shared/src/contracts.ts.
    simnet.callPublicFn(
      NFT,
      'set-minter',
      [Cl.principal(`${deployer}.${CORE}`), Cl.bool(true)],
      deployer,
    );
    enter(1, [alice, bob], alice);
    commit(1);
  });

  it('mints a power-up NFT to the first party member without touching the pool', () => {
    fundPool(5n * ONE_STX);

    const { result } = resolve(1, {
      reward: { kind: 'loot', uri: 'ipfs://loot/rare.json', tier: 2 },
    });
    expect(result).toBeOk(Cl.bool(true));

    const owner = simnet.callReadOnlyFn(NFT, 'get-owner', [Cl.uint(1)], alice);
    expect(owner.result).toBeOk(Cl.some(Cl.principal(alice)));

    const tier = simnet.callReadOnlyFn(NFT, 'get-token-tier', [Cl.uint(1)], alice);
    expect(tier.result).toBeOk(Cl.some(Cl.uint(2)));

    expect(sponsorPool()).toBe(5n * ONE_STX);
  });

  it('fails the whole resolve if the mint fails, leaving the run unresolved', () => {
    // Revoke game-core's minter rights to force the inner call to fail.
    simnet.callPublicFn(
      NFT,
      'set-minter',
      [Cl.principal(`${deployer}.${CORE}`), Cl.bool(false)],
      deployer,
    );

    const { result } = resolve(1, {
      reward: { kind: 'loot', uri: 'ipfs://loot/rare.json', tier: 2 },
    });
    expect(result).toBeErr(Cl.uint(101)); // ERR-NOT-AUTHORIZED-MINTER from the NFT

    const run = simnet.callReadOnlyFn(CORE, 'get-run', [Cl.uint(1)], alice);
    expect(run.result).toBeSome(
      Cl.tuple({
        'dungeon-id': Cl.uint(1),
        party: Cl.list([Cl.principal(alice), Cl.principal(bob)]),
        state: Cl.stringAscii('committed'),
        'seed-hash': Cl.buffer(SEED_HASH),
        'seed-reveal': Cl.none(),
        'combat-outcome': Cl.none(),
      }),
    );
  });
});

describe('game-core: full happy path (spec §8 integration test)', () => {
  it('two parties enter, owner collects 2 STX, pool only moves on the jackpot', () => {
    setupDungeons();
    simnet.callPublicFn(
      NFT,
      'set-minter',
      [Cl.principal(`${deployer}.${CORE}`), Cl.bool(true)],
      deployer,
    );

    const ownerStart = stxBalance(deployer);

    // Owner funds the prize budget out of their own pocket.
    fundPool(10n * ONE_STX);
    expect(sponsorPool()).toBe(10n * ONE_STX);

    // Two different parties enter the paid dungeon.
    expect(enter(1, [alice, bob], alice).result).toBeOk(Cl.uint(1));
    expect(enter(1, [carol], carol).result).toBeOk(Cl.uint(2));

    // Owner is down the 10 STX they funded, up the 2 STX of entry revenue.
    expect(stxBalance(deployer)).toBe(ownerStart - 10n * ONE_STX + 2n * ONE_STX);
    // The two entries changed the pool by exactly nothing.
    expect(sponsorPool()).toBe(10n * ONE_STX);

    // Each run is committed and resolved independently.
    expect(commit(1).result).toBeOk(Cl.bool(true));
    expect(commit(2).result).toBeOk(Cl.bool(true));

    // Run 1 wins a jackpot: the pool debits by exactly that amount.
    const aliceBefore = stxBalance(alice);
    const bobBefore = stxBalance(bob);
    expect(
      resolve(1, { outcome: 'win', reward: { kind: 'jackpot', amount: 4n * ONE_STX } })
        .result,
    ).toBeOk(Cl.bool(true));
    expect(sponsorPool()).toBe(6n * ONE_STX);
    expect(stxBalance(alice)).toBe(aliceBefore + 2n * ONE_STX);
    expect(stxBalance(bob)).toBe(bobBefore + 2n * ONE_STX);

    // Run 2 rolls nothing: resolves fine, pool untouched.
    const carolBefore = stxBalance(carol);
    expect(
      resolve(2, { outcome: 'loss', reward: { kind: 'none' } }).result,
    ).toBeOk(Cl.bool(true));
    expect(sponsorPool()).toBe(6n * ONE_STX);
    expect(stxBalance(carol)).toBe(carolBefore);

    // Owner's revenue is untouched by the payouts - it was never at risk.
    expect(stxBalance(deployer)).toBe(ownerStart - 10n * ONE_STX + 2n * ONE_STX);

    // The contract still holds exactly the remaining pool, nothing more.
    expect(stxBalance(`${deployer}.${CORE}`)).toBe(6n * ONE_STX);
  });
});

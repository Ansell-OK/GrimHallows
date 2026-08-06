/**
 * Signing-failure classification.
 *
 * These tests are about honesty rather than coverage. `signingErrorMessage`
 * turns a wallet error into a sentence that makes a factual claim — "nothing was
 * charged" — so the thing worth pinning is not that it recognises the happy
 * cases but that it *refuses to guess*: an error it does not understand must
 * come through verbatim, because the fallback sentence is the one place a wrong
 * reassurance could be printed.
 *
 * The insufficient-funds match is a text heuristic (there is no JSON-RPC code
 * for it — see the note in `lib/tx.ts`). A heuristic that quietly stops matching
 * is the expected failure here, so the real node/wallet phrasings are pinned
 * literally rather than paraphrased.
 */

import { describe, expect, it } from 'vitest';
import { JsonRpcError, JsonRpcErrorCode } from '@stacks/connect';
import {
  WalletRejectedError,
  isInsufficientFunds,
  isWalletRejection,
  signingErrorMessage,
} from '../src/lib/tx';

describe('isWalletRejection', () => {
  it('recognises our own rejection type', () => {
    expect(isWalletRejection(new WalletRejectedError())).toBe(true);
  });

  it('recognises both wallet codes for "the player said no"', () => {
    // Two codes mean the same thing to a player; wallets differ on which they
    // send, and treating one as an unknown failure would be a worse message.
    expect(
      isWalletRejection(new JsonRpcError('rejected', JsonRpcErrorCode.UserRejection)),
    ).toBe(true);
    expect(
      isWalletRejection(new JsonRpcError('canceled', JsonRpcErrorCode.UserCanceled)),
    ).toBe(true);
  });

  it('does not treat an arbitrary wallet failure as a cancellation', () => {
    // The dangerous direction: reporting "you cancelled, nothing was charged"
    // for a failure that might have broadcast something.
    expect(
      isWalletRejection(new JsonRpcError('boom', JsonRpcErrorCode.InternalError)),
    ).toBe(false);
    expect(isWalletRejection(new Error('something else'))).toBe(false);
    expect(isWalletRejection('not an error')).toBe(false);
    expect(isWalletRejection(undefined)).toBe(false);
  });
});

describe('isInsufficientFunds', () => {
  it("matches the Stacks node's own rejection reason", () => {
    expect(isInsufficientFunds(new Error('NotEnoughFunds'))).toBe(true);
    expect(
      isInsufficientFunds(new Error('transaction rejected: NotEnoughFunds')),
    ).toBe(true);
  });

  it('matches the phrasings wallets surface for the same condition', () => {
    expect(isInsufficientFunds(new Error('Insufficient STX balance'))).toBe(true);
    expect(isInsufficientFunds(new Error('insufficient funds for transfer'))).toBe(true);
    expect(isInsufficientFunds(new Error('Not enough funds'))).toBe(true);
  });

  it('reads the JSON-RPC data field as well as the message', () => {
    // Wallets frequently put the node's reason in `data` and leave `message`
    // generic, so checking only the message would miss the common case.
    const err = new JsonRpcError(
      'Transaction failed',
      JsonRpcErrorCode.UnknownError,
      'NotEnoughFunds',
    );
    expect(isInsufficientFunds(err)).toBe(true);
  });

  it('does not claim a funds problem for an unrelated failure', () => {
    expect(isInsufficientFunds(new Error('BadNonce'))).toBe(false);
    expect(isInsufficientFunds(new Error('ContractAlreadyExists'))).toBe(false);
    expect(isInsufficientFunds(new Error(''))).toBe(false);
    expect(isInsufficientFunds(null)).toBe(false);
  });
});

describe('signingErrorMessage', () => {
  const fallback = 'raw wallet text';

  it('names the two cases it understands', () => {
    expect(signingErrorMessage(new WalletRejectedError(), fallback)).toContain(
      'You cancelled',
    );
    expect(signingErrorMessage(new Error('NotEnoughFunds'), fallback)).toContain(
      "doesn't have enough STX",
    );
  });

  it('passes an unrecognised error through untouched', () => {
    // The whole point: we would rather show an ugly true string than a tidy
    // sentence asserting an outcome we have not established.
    expect(signingErrorMessage(new Error('BadNonce'), fallback)).toBe(fallback);
  });

  it('states that nothing was charged, in both recognised cases', () => {
    for (const err of [new WalletRejectedError(), new Error('NotEnoughFunds')]) {
      expect(signingErrorMessage(err, fallback)).toContain('Nothing was charged.');
    }
  });

  it('lets a caller say what specifically was not lost', () => {
    // The forge needs "nothing was burned" as well — losing the input tokens is
    // the outcome a player actually fears there, and "nothing was charged"
    // alone does not answer it.
    const burned = 'Nothing was burned and nothing was charged.';
    expect(signingErrorMessage(new WalletRejectedError(), fallback, burned)).toBe(
      `You cancelled the transaction. ${burned}`,
    );
    expect(signingErrorMessage(new Error('NotEnoughFunds'), fallback, burned)).toContain(
      burned,
    );
  });

  it('never applies the reassurance to an error it did not recognise', () => {
    // A failure we cannot classify might have broadcast. Saying "nothing was
    // burned" there would be a guess about the chain's state.
    const message = signingErrorMessage(
      new Error('unknown wallet failure'),
      fallback,
      'Nothing was burned and nothing was charged.',
    );
    expect(message).toBe(fallback);
    expect(message).not.toContain('Nothing was burned');
  });
});

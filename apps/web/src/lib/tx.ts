/**
 * Submitting a backend-prepared transaction to the player's wallet.
 *
 * The division of labour, which is a ground rule and not a preference
 * (02-architecture.md): the backend builds an unsigned payload, the wallet signs
 * and broadcasts it, and nothing in between ever holds a key. This module is the
 * "in between" — so it is deliberately incapable of doing anything but pass the
 * payload along.
 *
 * WHAT THIS MODULE MUST NOT DO
 *
 * It must not construct, edit, or reorder a payload. `functionArgs` and
 * `postConditions` arrive as hex from the server and are handed to the wallet
 * byte-for-byte. Re-encoding them here would put the browser — the cheapest
 * place to tamper — between the amount the player was shown and the amount the
 * chain enforces. If a value needs to change, the server rebuilds the payload.
 *
 * The post-condition mode is `deny` and comes from the payload too. It is what
 * makes the wallet abort a transaction that tried to move anything the payload
 * did not state, and it is the player's protection against us specifically.
 */

import { request as walletRequest, JsonRpcError, JsonRpcErrorCode } from '@stacks/connect';
import type { UnsignedTxPayload } from '@grimhallow/shared';

/** The player dismissed the wallet prompt. A decision, not a failure. */
export class WalletRejectedError extends Error {
  constructor() {
    super('You cancelled the transaction. Nothing was sent and nothing was charged.');
    this.name = 'WalletRejectedError';
  }
}

export function isWalletRejection(err: unknown): boolean {
  return (
    err instanceof WalletRejectedError ||
    (err instanceof JsonRpcError &&
      (err.code === JsonRpcErrorCode.UserRejection ||
        err.code === JsonRpcErrorCode.UserCanceled))
  );
}

/**
 * The node refused the broadcast because the account cannot cover the transfer
 * plus the network fee.
 *
 * There is no error *code* for this — @stacks/connect defines codes for user
 * rejection and little else, so a funds failure arrives as `UnknownError` (or a
 * plain Error) carrying whatever text the node or wallet produced. Matching on
 * text is a heuristic and is treated as one: a miss costs a good error message,
 * never a wrong claim about what happened, because every caller falls back to
 * showing the raw message rather than inventing an outcome.
 *
 * `NotEnoughFunds` is the Stacks node's own rejection reason; the others are the
 * phrasings Leather and Xverse surface for the same condition.
 */
const INSUFFICIENT_FUNDS_PATTERNS = [
  /notenoughfunds/i,
  /insufficient\s*(stx|funds|balance)/i,
  /not\s+enough\s+(stx|funds|balance)/i,
];

export function isInsufficientFunds(err: unknown): boolean {
  const message =
    err instanceof Error ? `${err.message} ${(err as JsonRpcError).data ?? ''}` : '';
  return INSUFFICIENT_FUNDS_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Turn a signing failure into something a player can act on.
 *
 * Only two cases are named, because only two are both common and unambiguous:
 * the player said no, and the account is short. Everything else is passed
 * through verbatim rather than being softened into a guess — an unrecognised
 * wallet error means we do not know what happened, and saying so is more useful
 * than a reassuring sentence that might be false.
 *
 * `nothingLost` exists so each screen can name what specifically did not happen
 * — the forge has to say nothing was *burned* as well as nothing charged, since
 * losing the input tokens is the outcome a player fears there. Whatever it says
 * has to be true at the point of the failure, and it is: neither a rejection nor
 * a refused broadcast puts a transaction on chain, so nothing moved.
 *
 * Never reuse this for a failure that occurs *after* a txid exists. By then the
 * transaction is real, and the honest message is that it may still mine.
 */
export function signingErrorMessage(
  err: unknown,
  fallback: string,
  nothingLost = 'Nothing was charged.',
): string {
  if (isWalletRejection(err)) {
    return `You cancelled the transaction. ${nothingLost}`;
  }
  if (isInsufficientFunds(err)) {
    return (
      "Your wallet doesn't have enough STX to cover this and the network fee. " +
      `${nothingLost} Top up and try again.`
    );
  }
  return fallback;
}

/**
 * Ask the wallet to sign and broadcast a server-prepared contract call.
 *
 * Resolves with the broadcast txid. A txid means "submitted", not "succeeded" —
 * the transaction still has to be mined, and it can still abort on chain (which
 * is exactly what the post-conditions are for). Callers must treat this as the
 * start of a wait, never as confirmation.
 */
export async function signAndSubmit(payload: UnsignedTxPayload): Promise<string> {
  const result = await walletRequest('stx_callContract', {
    contract: `${payload.contractAddress}.${payload.contractName}`,
    functionName: payload.functionName,
    // Passed through untouched — see the module note.
    functionArgs: [...payload.functionArgs],
    postConditions: [...payload.postConditions],
    postConditionMode: payload.postConditionMode,
    network: payload.network,
  });

  if (!result.txid) {
    // Some wallets return a signed-but-unbroadcast transaction. We cannot
    // broadcast it ourselves without becoming a party to the transaction, and
    // reporting success without a txid would leave the player unable to check
    // anything. Fail visibly.
    throw new Error(
      'Your wallet signed the transaction but did not broadcast it, so there is no ' +
        'transaction id to track. Nothing has been charged yet.',
    );
  }
  return result.txid;
}

/**
 * Wallet connection + session.
 *
 * The login handshake is: connect the wallet → ask the API for a single-use
 * challenge → have the wallet sign it → hand the signature back for a session
 * token. The address the client sends is only a claim; the API recovers the
 * real signer from the signature and refuses the login unless they match
 * (04-backend-api-spec.md#2). So nothing here is a security boundary — the
 * boundary is `/auth/verify` on the server.
 *
 * This provider never holds or asks for a private key. Every signature comes
 * from the wallet, and later, every money-moving action will be a wallet-signed
 * transaction rather than anything the backend does on the player's behalf.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  connect as openWalletConnect,
  disconnect as clearWalletSelection,
  getLocalStorage,
  isConnected as walletIsConnected,
  request as walletRequest,
  JsonRpcError,
  JsonRpcErrorCode,
} from '@stacks/connect';
import { errorMessage, requestChallenge, verifySignature } from './api';
import { clearSession, loadSession, saveSession } from './session';

export type WalletStatus = 'disconnected' | 'connecting' | 'connected';

export interface WalletContextValue {
  readonly status: WalletStatus;
  /** The signed-in principal, or null when disconnected. */
  readonly address: string | null;
  /** Last failure, cleared when a new attempt starts. */
  readonly error: string | null;
  /** True when the player dismissed the wallet prompt rather than failing. */
  readonly cancelled: boolean;
  connect(): Promise<boolean>;
  disconnect(): void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

/** A Stacks principal — `SP`/`SM` on mainnet, `ST`/`SN` on testnet. */
const STACKS_ADDRESS = /^S[PTMN][0-9A-HJKMNP-TV-Z]{37,}$/;

function isUserRejection(err: unknown): boolean {
  return (
    err instanceof JsonRpcError &&
    (err.code === JsonRpcErrorCode.UserRejection ||
      err.code === JsonRpcErrorCode.UserCanceled)
  );
}

/**
 * The wallet's currently selected Stacks address, prompting for a connection
 * if we don't have one cached.
 */
async function resolveWalletAddress(): Promise<string> {
  const cached = getLocalStorage()?.addresses?.stx?.[0]?.address;
  if (cached && walletIsConnected()) return cached;

  const result = await openWalletConnect();
  // Prefer the library's own classification; fall back to matching the
  // principal format, since `getAddresses` also returns BTC entries.
  const address =
    getLocalStorage()?.addresses?.stx?.[0]?.address ??
    result.addresses.find((entry) => STACKS_ADDRESS.test(entry.address))?.address;

  if (!address) {
    throw new Error('The wallet did not return a Stacks address.');
  }
  return address;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(() => loadSession()?.address ?? null);
  const [status, setStatus] = useState<WalletStatus>(() =>
    loadSession() ? 'connected' : 'disconnected',
  );
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  // Guards against a second click opening a second wallet popup.
  const inFlight = useRef<Promise<boolean> | null>(null);

  // A session expires on a wall-clock deadline, so re-check it when the tab is
  // focused rather than leaving a stale "connected" state on screen.
  useEffect(() => {
    const recheck = () => {
      if (!loadSession()) {
        setAddress(null);
        setStatus('disconnected');
      }
    };
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, []);

  const disconnect = useCallback(() => {
    clearSession();
    clearWalletSelection();
    setAddress(null);
    setStatus('disconnected');
    setError(null);
    setCancelled(false);
  }, []);

  const connect = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;

    const attempt = (async () => {
      setStatus('connecting');
      setError(null);
      setCancelled(false);

      try {
        const walletAddress = await resolveWalletAddress();

        // Single-use, short-lived, and issued by the server — signing an
        // arbitrary client-chosen string would let a captured signature be
        // replayed as a login.
        const { challenge } = await requestChallenge();
        const { signature } = await walletRequest('stx_signMessage', { message: challenge });

        const session = await verifySignature({
          address: walletAddress,
          signature,
          challenge,
        });

        saveSession(session);
        setAddress(session.address);
        setStatus('connected');
        return true;
      } catch (err) {
        // Dismissing the wallet prompt is a decision, not a fault; don't shout
        // an error at the player for it.
        if (isUserRejection(err)) {
          setCancelled(true);
        } else {
          setError(errorMessage(err));
        }
        setStatus(loadSession() ? 'connected' : 'disconnected');
        return false;
      }
    })();

    inFlight.current = attempt;
    try {
      return await attempt;
    } finally {
      inFlight.current = null;
    }
  }, []);

  const value = useMemo<WalletContextValue>(
    () => ({ status, address, error, cancelled, connect, disconnect }),
    [status, address, error, cancelled, connect, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside <WalletProvider>.');
  return ctx;
}

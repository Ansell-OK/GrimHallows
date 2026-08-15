/**
 * Typed client for the GrimHallow backend.
 *
 * Paths and response shapes come from 04-backend-api-spec.md — this file is a
 * transcription of that contract, not a place to invent convenience shapes.
 *
 * The session token is attached to every request that has one. It is *not* what
 * authorises anything that costs money: money-moving actions are user-signed
 * transactions, so the worst a stolen token can do is read a roster.
 */

import type {
  ActionResponse,
  ApiError,
  CharClass,
  CharacterMintQuoteResponse,
  CharacterRef,
  DerivedCharacter,
  ForgeRecipe,
  ForgeTxResponse,
  FreeEntryResponse,
  LeaderboardResponse,
  LeaderboardWindow,
  MapResponse,
  MintCharacterTxResponse,
  PaidEntryResponse,
  PaidRunReadyResponse,
  PlayerAction,
  PowerUpNft,
  RunResponse,
} from "@grimhallow/shared";
import { loadSession } from "./session";

export const API_URL = (
  import.meta.env.VITE_API_URL ?? "http://localhost:8080"
).replace(/\/+$/, "");

/** An error the API reported in its documented `{ error: { code, message } }` shape. */
export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** Thrown when the API could not be reached at all (offline, CORS, DNS). */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super("Could not reach the GrimHallow server.");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

export class BackendValidationError extends Error {
  constructor(message: string) { super(message); this.name = "BackendValidationError"; }
}

interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  /** Send the stored session token, if there is one. Default true. */
  readonly authenticated?: boolean;
  /**
   * A run token, sent as `X-Run-Token`.
   *
   * Its own header rather than the bearer slot so it sits *alongside* the
   * session instead of replacing it: a player mid-run still has a session, and
   * a client that swapped one for the other would have to put it back.
   */
  readonly runToken?: string;
  readonly signal?: AbortSignal;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    method = "GET",
    body,
    authenticated = true,
    runToken,
    signal,
  } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (runToken) headers["x-run-token"] = runToken;
  if (authenticated) {
    const session = loadSession();
    if (session) headers.authorization = `Bearer ${session.token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    // Let an aborted request propagate as-is so callers can ignore it.
    if (cause instanceof DOMException && cause.name === "AbortError")
      throw cause;
    throw new NetworkError(cause);
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const err = (payload as ApiError | null)?.error;
    throw new ApiRequestError(
      err?.code ?? "UNKNOWN_ERROR",
      err?.message ?? `Request failed with status ${response.status}.`,
      response.status,
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// Auth — 04-backend-api-spec.md#2
// ---------------------------------------------------------------------------

export interface ChallengeResponse {
  readonly challenge: string;
  readonly expiresAt: string;
}

export interface VerifyResponse {
  readonly token: string;
  readonly address: string;
  readonly expiresAt: string;
}

/** Ask for a fresh nonce to sign. Single-use and short-lived server-side. */
export function requestChallenge(): Promise<ChallengeResponse> {
  return request("/auth/challenge", { method: "POST", authenticated: false });
}

/**
 * Exchange a signed challenge for a session token.
 *
 * The address is a *claim*: the server recovers the real signer from the
 * signature and rejects the request unless the two agree.
 */
export function verifySignature(input: {
  address: string;
  signature: string;
  challenge: string;
}): Promise<VerifyResponse> {
  return request("/auth/verify", {
    method: "POST",
    body: input,
    authenticated: false,
  });
}

// ---------------------------------------------------------------------------
// Characters — 04-backend-api-spec.md#3
// ---------------------------------------------------------------------------

export interface CharactersResponse {
  readonly address: string;
  readonly characters: readonly DerivedCharacter[];
}

export function getCharacters(
  address: string,
  signal?: AbortSignal,
): Promise<CharactersResponse> {
  return request(`/characters?address=${encodeURIComponent(address)}`, {
    signal,
  });
}

export interface ProfileResponse {
  readonly address: string;
  readonly identity: {
    readonly address: string;
    readonly displayName: string;
    readonly bnsName: string | null;
  };
  readonly balanceUstx: string | null;
  readonly rank: number | null;
  readonly score: number;
  readonly dungeonsCompleted: number;
  readonly freeDungeonsCompleted: number;
  readonly paidDungeonsCompleted: number;
  readonly jackpotsWon: number;
  readonly highestForgeTier: number;
}

export function getProfile(signal?: AbortSignal): Promise<ProfileResponse> {
  return request("/profile", { signal });
}

export interface NotificationRecord {
  readonly id: string;
  readonly address: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly read: boolean;
  readonly createdAt: string;
}

export function getNotifications(
  signal?: AbortSignal,
): Promise<{ notifications: NotificationRecord[] }> {
  return request("/notifications", { signal });
}

export interface PartyMemberRecord {
  readonly address: string;
  readonly identity: { readonly address: string; readonly displayName: string; readonly bnsName: string | null };
  readonly role: "leader" | "member";
  readonly ready: boolean;
  readonly nftContractId: string | null;
  readonly nftTokenId: string | null;
}
export interface PartyRecord {
  readonly id: string;
  readonly inviteCode: string;
  readonly createdBy: string;
  readonly members: readonly PartyMemberRecord[];
}
export interface PartyInvite {
  readonly id: string;
  readonly partyId: string;
  readonly inviterAddress: string;
  readonly expiresAt: string;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const string = (value: unknown): value is string => typeof value === "string";
function validateParty(value: unknown): PartyRecord {
  if (!object(value) || !string(value.id) || !string(value.inviteCode) || !string(value.createdBy) || !Array.isArray(value.members)) throw new BackendValidationError("The backend returned an invalid party record.");
  const members = value.members.map((member) => {
    if (!object(member) || !string(member.address) || (member.role !== "leader" && member.role !== "member") || typeof member.ready !== "boolean" || !(member.nftContractId === null || string(member.nftContractId)) || !(member.nftTokenId === null || string(member.nftTokenId)) || !object(member.identity) || !string(member.identity.address) || !string(member.identity.displayName) || !(member.identity.bnsName === null || string(member.identity.bnsName))) throw new BackendValidationError("The backend returned an invalid party member.");
    return member as unknown as PartyMemberRecord;
  });
  return { id: value.id, inviteCode: value.inviteCode, createdBy: value.createdBy, members };
}
function validateInvite(value: unknown): PartyInvite {
  if (!object(value) || !string(value.id) || !string(value.partyId) || !string(value.inviterAddress) || !string(value.expiresAt)) throw new BackendValidationError("The backend returned an invalid party invite.");
  return value as unknown as PartyInvite;
}
export async function getCurrentParty(): Promise<{ party: PartyRecord | null }> {
  const payload = await request<unknown>("/parties/current");
  if (!object(payload) || !(payload.party === null || object(payload.party))) throw new BackendValidationError("The backend returned an invalid current-party response.");
  return { party: payload.party === null ? null : validateParty(payload.party) };
}
export function createParty(): Promise<{ party: PartyRecord }> {
  return request("/parties", { method: "POST" });
}
export function leaveParty(id: string): Promise<{ outcome: string }> {
  return request(`/parties/${encodeURIComponent(id)}/leave`, {
    method: "POST",
  });
}
export function kickPartyMember(id: string, address: string): Promise<{ kicked: string }> {
  return request(`/parties/${encodeURIComponent(id)}/kick`, { method: "POST", body: { address } });
}
export function setPartyReady(
  id: string,
  ready: boolean,
): Promise<{ ready: boolean }> {
  return request(`/parties/${encodeURIComponent(id)}/ready`, {
    method: "POST",
    body: { ready },
  });
}
export function setPartyCharacter(
  id: string,
  contractId: string,
  tokenId: string,
): Promise<{
  character: { contractId: string; tokenId: string };
  ready: boolean;
}> {
  return request(`/parties/${encodeURIComponent(id)}/character`, {
    method: "POST",
    body: { contractId, tokenId },
  });
}
export function createPartyInvite(
  id: string,
  address: string,
): Promise<{ invite: PartyInvite }> {
  return request(`/parties/${encodeURIComponent(id)}/invites`, {
    method: "POST",
    body: { address },
  });
}
export function getPartyInvites(): Promise<{ invites: PartyInvite[] }> {
  return request<unknown>("/party-invites").then((payload) => {
    if (!object(payload) || !Array.isArray(payload.invites)) throw new BackendValidationError("The backend returned an invalid party-invite response.");
    return { invites: payload.invites.map(validateInvite) };
  });
}
export function respondPartyInvite(
  id: string,
  accept: boolean,
): Promise<{ outcome: string }> {
  return request(`/party-invites/${encodeURIComponent(id)}/respond`, {
    method: "POST",
    body: { accept },
  });
}
export async function preparePartyEntry(id: string): Promise<{ partyId: string; members: readonly { address: string; character: { contractId: string; tokenId: string } }[] }> {
  const payload = await request<unknown>(`/parties/${encodeURIComponent(id)}/prepare-entry`, { method: "POST" });
  if (!object(payload) || !string(payload.partyId) || !Array.isArray(payload.members)) throw new BackendValidationError("The backend returned an invalid party-entry response.");
  const members = payload.members.map((member) => {
    if (!object(member) || !string(member.address) || !object(member.character) || !string(member.character.contractId) || !string(member.character.tokenId)) throw new BackendValidationError("The backend returned an invalid prepared party member.");
    return { address: member.address, character: { contractId: member.character.contractId, tokenId: member.character.tokenId } };
  });
  return { partyId: payload.partyId, members };
}

export function getNotificationUnreadCount(
  signal?: AbortSignal,
): Promise<{ unreadCount: number }> {
  return request("/notifications/unread-count", { signal });
}

export function markNotificationRead(id: string): Promise<{ read: boolean }> {
  return request(`/notifications/${encodeURIComponent(id)}/read`, {
    method: "PATCH",
  });
}

export function markAllNotificationsRead(): Promise<{ markedRead: number }> {
  return request("/notifications/read-all", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Power-ups — 04-backend-api-spec.md#2
// ---------------------------------------------------------------------------

/**
 * A held power-up, with its bonus already resolved against one character.
 *
 * Both halves come from chain: `tier` from `get-token-tier`, `archetype` parsed
 * out of the URI STRING that `get-token-uri` returns. Every number below is
 * `archetypeBonusVector(archetype, tier)` from the shared table.
 *
 * `metadataUri` IS READ — for the archetype, and for nothing else. The rule in
 * 01-game-design.md#6 is that rewriting a JSON file cannot change what an item
 * does, and that still holds exactly: the archetype is parsed from the *uri
 * string the contract stores*, which is written once inside `mint` and has no
 * setter, and the document that string points at is never fetched. So the art
 * and the name a wallet shows can be re-pinned freely; the dice cannot move.
 */
export interface EquippablePowerUp extends PowerUpNft {
  readonly tierName: string;
  /** e.g. "Damage dice +1 size, +2 damage, +1 Defense". */
  readonly summary: string;
  readonly defenseBonus: number;
  /** Added to both max HP and starting HP. Zero for every `relic`. */
  readonly maxHpBonus: number;
}

export interface PowerUpsResponse {
  readonly address: string;
  readonly character: {
    readonly contractId: string;
    readonly tokenId: string;
    readonly charClass: string;
  };
  readonly powerUps: readonly EquippablePowerUp[];
}

/**
 * The power-ups a wallet holds, described against one character.
 *
 * The character is in the path and the holder in the query because they are two
 * different questions: which power-ups exist in the wallet, and what each would
 * do if equipped on *this* NFT. The same tier reads as `1d6->1d8` on a Rogue and
 * `1d8->1d10` on a Warrior — the bonus is identical, only the rendering differs.
 */
export function getPowerUps(
  character: CharacterRef,
  address: string,
  signal?: AbortSignal,
): Promise<PowerUpsResponse> {
  const path =
    `/characters/${encodeURIComponent(character.contractId)}` +
    `/${encodeURIComponent(character.tokenId)}/power-ups` +
    `?address=${encodeURIComponent(address)}`;
  return request(path, { signal });
}

// ---------------------------------------------------------------------------
// World map & dungeon entry — 04-backend-api-spec.md#3
// ---------------------------------------------------------------------------

/**
 * The world map: free-dungeon spawns plus the standing paid dungeon.
 *
 * Public, so it renders before the player connects a wallet.
 *
 * `paidDungeon` is null when the backend could not read the chain. That is a
 * genuine "unknown", not a zero — both numbers on it are money, and rendering a
 * fallback would misinform a player at the exact moment they are deciding
 * whether to spend. Show it as unavailable instead.
 */
export function getMap(signal?: AbortSignal): Promise<MapResponse> {
  return request("/map", { authenticated: false, signal });
}

/**
 * Enter a free dungeon with a chosen character.
 *
 * No fee, no wallet signature, no transaction — a free dungeon is off-chain
 * content, and the session token is the whole of what's required. The returned
 * `runToken` authorises submitting turns for *that run only*; it is not a
 * session token and the backend will not accept it as one.
 *
 * `spawnId` is a spawn uuid from `getMap`. Passing an on-chain dungeon id here
 * would be the paid flow, which is a signed transaction and does not live in
 * this function.
 *
 * `character` identifies the NFT being fielded. The backend derives its stats
 * from `(contractId, tokenId)` rather than taking a stat block from here — a
 * client that could send stats could send better ones.
 *
 * `powerUpTokenIds` is the loadout the player equipped, capped at
 * `MAX_EQUIPPED_POWER_UPS`. Token ids only, never tiers: the backend reads each
 * tier from chain after confirming the wallet holds the token, so the same
 * reasoning as `character` applies — a client that could send a tier could send
 * a better one. Omit or pass an empty array to enter unequipped.
 */
export function enterFreeDungeon(
  spawnId: string,
  character: CharacterRef,
  powerUpTokenIds: readonly string[] = [],
  signal?: AbortSignal,
): Promise<FreeEntryResponse> {
  return request(`/dungeons/${encodeURIComponent(spawnId)}/enter`, {
    method: "POST",
    body: { character, powerUpTokenIds },
    signal,
  });
}

/**
 * Quote a paid dungeon entry.
 *
 * Returns an **unsigned** `enter-dungeon` transaction for the player's wallet to
 * sign, plus the fee and a plain-language disclosure to show before the wallet
 * prompt. Nothing has happened when this resolves: no run exists, no seed is
 * committed, and no money has moved. The run begins when the signed transaction
 * is mined and the contract assigns it an id.
 *
 * The fee is quoted live from chain on every call, so this must be called
 * immediately before signing rather than cached — a stale fee produces a
 * post-condition that aborts the player's transaction and costs them a network
 * fee for our out-of-date copy.
 *
 * `tx.postConditions` are what actually bind. `feeUstx` and `tx.summary` are for
 * display; a UI that showed one number while the payload authorised another
 * would be lying with our own data, so show `feeUstx` and nothing derived.
 *
 * Takes no loadout, deliberately. The quote produces an unsigned transaction —
 * no run exists yet and no money has moved, so there is nothing for a loadout to
 * be attached to. It goes to `claimPaidRun` instead, once the entry is paid and
 * the wallet's holdings can be verified against something real.
 */
export function enterPaidDungeon(
  dungeonId: number,
  character: CharacterRef,
  signal?: AbortSignal,
): Promise<PaidEntryResponse> {
  return request(`/dungeons/${dungeonId}/enter`, {
    method: "POST",
    body: { character },
    signal,
  });
}

/**
 * Claim a paid run from a confirmed `enter-dungeon` transaction.
 *
 * Returns the run token and opening encounter state, so the player can act on
 * the run they paid for. Idempotent — the same txid can be claimed multiple
 * times (a retry after a dropped response, and later the indexer) without
 * creating duplicate runs.
 *
 * This is where a paid run's loadout is chosen, for the reason given on
 * `enterPaidDungeon`. A rejected loadout does not cost the entry: the claim is
 * idempotent, so correcting the selection and retrying reaches the same run.
 */
export function claimPaidRun(
  dungeonId: number,
  enterTxId: string,
  character: CharacterRef,
  powerUpTokenIds: readonly string[] = [],
  signal?: AbortSignal,
): Promise<PaidRunReadyResponse> {
  return request(`/dungeons/${dungeonId}/claim`, {
    method: "POST",
    body: { enterTxId, character, powerUpTokenIds },
    signal,
  });
}

// ---------------------------------------------------------------------------
// Combat loop — 04-backend-api-spec.md#5
// ---------------------------------------------------------------------------

/**
 * Read a run: its state, the whole dice log so far, and the live encounter.
 *
 * This is what a reloaded combat screen resumes from. `verification.seed` is
 * null until the run resolves — the server holds it back, and a client that
 * treated a null seed as "not sent yet" and retried would be asking for the one
 * thing commit-reveal exists to withhold.
 */
export function getRun(
  runId: string,
  runToken: string,
  signal?: AbortSignal,
): Promise<RunResponse> {
  return request(`/runs/${encodeURIComponent(runId)}`, { runToken, signal });
}

/**
 * Submit one action and get back the dice it produced.
 *
 * `turns` in the response is only what *this* submission caused: the player's
 * turn plus every monster that acted before control came back. The client
 * animates exactly those and appends them to the log it already has.
 *
 * There is no local resolution of any kind. The dice, the hits, the damage and
 * the outcome are all derived server-side from the committed seed; this request
 * sends an intent and the response is the entire result of it.
 */
export function submitAction(
  runId: string,
  runToken: string,
  action: PlayerAction,
  signal?: AbortSignal,
): Promise<ActionResponse> {
  return request(`/runs/${encodeURIComponent(runId)}/actions`, {
    method: "POST",
    body: action,
    runToken,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Forge — 04-backend-api-spec.md#7
// ---------------------------------------------------------------------------

export interface ForgeRecipesResponse {
  readonly recipes: readonly ForgeRecipe[];
}

/**
 * The forge ladder, mirrored from the on-chain `recipes` map.
 *
 * Public — recipes are public chain state. This call *fails* rather than
 * returning a fallback when the backend cannot read the chain, and this UI must
 * preserve that: a player planning which NFTs to burn against a hardcoded ladder
 * that no longer matches the contract would destroy real tokens on a recipe that
 * does not exist. Show the failure; never fill the gap with constants.
 */
export function getForgeRecipes(
  signal?: AbortSignal,
): Promise<ForgeRecipesResponse> {
  return request("/forge/recipes", { authenticated: false, signal });
}

/**
 * Build an **unsigned** `forge` transaction for the wallet to sign.
 *
 * Nothing has happened when this resolves: no NFT has been burned, no token
 * minted, and no STX moved. All of that happens when the signed transaction is
 * mined.
 *
 * AUTHENTICATED, unlike the recipe list. Since forge-v2 the payload carries an
 * STX post-condition, and a post-condition has to name the principal it binds.
 * The only address worth pinning is the one the caller authenticated as, so this
 * call needs a session even though it still signs nothing and moves nothing.
 *
 * `feeUstx` is quoted live from chain on every call, so this must be called
 * immediately before signing rather than cached — the same rule as
 * `enterPaidDungeon`, and for the same reason: a stale fee produces a
 * post-condition that aborts the player's transaction and costs them a network
 * fee for our out-of-date copy. Show `feeUstx` and nothing derived from it.
 *
 * The backend validates shape only — count, duplicates, integer ids. It
 * deliberately does *not* re-check that the inputs satisfy the recipe, because
 * the contract is the authority on that and a second implementation would be
 * free to drift from it. A payload that does not satisfy the recipe aborts on
 * chain, which is the correct outcome and the one that cannot be fooled.
 */
export function buildForge(
  recipeId: number,
  tokenIds: readonly string[],
  signal?: AbortSignal,
): Promise<ForgeTxResponse> {
  return request("/forge", {
    method: "POST",
    body: { recipeId, tokenIds },
    signal,
  });
}

// ---------------------------------------------------------------------------
// Character shop — 04-backend-api-spec.md#2
// ---------------------------------------------------------------------------

/**
 * What a character costs right now, and whether sales are open.
 *
 * Public — it is a price list. Both figures come from `character-nft` on every
 * request, so this must be re-read before showing a confirm button rather than
 * cached from page load.
 *
 * `classes` is the same four the contract accepts and the shared derivation
 * uses, published so a picker does not hardcode them a third time.
 */
export function getMintQuote(
  signal?: AbortSignal,
): Promise<CharacterMintQuoteResponse> {
  return request("/characters/mint", { authenticated: false, signal });
}

/**
 * Build an **unsigned** `mint-character` transaction for the wallet to sign.
 *
 * Nothing has happened when this resolves and nothing has been charged. The
 * token is minted, and the price paid, when the signed transaction is mined.
 *
 * The class is written on chain in the same transaction and **cannot be changed
 * afterwards** — this is the one irreversible part of the purchase, and the
 * confirm screen has to say so before the wallet prompt.
 *
 * The metadata URI is chosen by the server, not sent from here. Nothing in this
 * system reads a stat, class, or tier from metadata (01-game-design.md#4a), so a
 * client-chosen URI would be harmless — which is exactly why it is not offered:
 * "harmless" depends on that rule holding forever.
 */
export function buildMintCharacter(
  classId: CharClass,
  signal?: AbortSignal,
): Promise<MintCharacterTxResponse> {
  return request("/characters/mint", {
    method: "POST",
    body: { classId },
    signal,
  });
}

// ---------------------------------------------------------------------------
// Leaderboard — 04-backend-api-spec.md#8
// ---------------------------------------------------------------------------

/**
 * The ranking table.
 *
 * Public — every fact in it is already on a public chain or under a published
 * oracle signature, and ranks are keyed by wallet address rather than by NFT
 * (01-game-design.md#8). Sent unauthenticated so a visitor who has not connected
 * a wallet still sees it.
 *
 * The response carries the counts behind each score *and* a source per
 * contributing event, because the leaderboard is meant to be checkable rather
 * than believed. `leaderboardScore` from @grimhallow/shared is the same function
 * the backend used, so this client recomputes the number instead of displaying
 * the one it was handed — see `Leaderboard.tsx`.
 */
export function getLeaderboard(
  window: LeaderboardWindow = "all",
  signal?: AbortSignal,
): Promise<LeaderboardResponse> {
  return request(`/leaderboard?window=${encodeURIComponent(window)}`, {
    authenticated: false,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConfigResponse {
  readonly network: "devnet" | "testnet" | "mainnet";
  readonly explorerUrl: string;
  readonly contracts: Record<string, string>;
}

export function getConfig(signal?: AbortSignal): Promise<ConfigResponse> {
  return request("/config", { authenticated: false, signal });
}

/** Explorer link for a principal — contract or standard address. */
export function explorerAddressLink(
  config: ConfigResponse,
  principal: string,
): string {
  const chain = config.network === "mainnet" ? "mainnet" : "testnet";
  return `${config.explorerUrl}/address/${encodeURIComponent(principal)}?chain=${chain}`;
}

/**
 * Explorer link for a transaction.
 *
 * Worth surfacing wherever a txid exists: it is the one view of the payment the
 * player can check without taking our word for it, and it keeps working if this
 * app is down or wrong about what happened.
 */
export function explorerTxLink(config: ConfigResponse, txId: string): string {
  const chain = config.network === "mainnet" ? "mainnet" : "testnet";
  return `${config.explorerUrl}/txid/${encodeURIComponent(txId)}?chain=${chain}`;
}

/** Human-readable text for an error from any of the calls above. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError || err instanceof NetworkError)
    return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

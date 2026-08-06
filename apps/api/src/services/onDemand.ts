/**
 * Read-triggered background work.
 *
 * `DungeonSpawner` and `IndexerLoop` both keep a `setInterval` alive inside the
 * server process. That works under `npm run dev` and under any long-running
 * host, and it does not work on Vercel: a serverless function is frozen once it
 * has returned its response, so a timer scheduled during one request never fires
 * during the next. Deployed as-is, the map would empty out as spawns expired and
 * the leaderboard would stop advancing — both silently, since neither loop is on
 * a request path that could report the failure.
 *
 * So in serverless the same two jobs hang off the reads that care about them:
 * the spawner off `GET /map`, the indexer off `GET /leaderboard`. This is a
 * deliberate trade and it is worth naming what is given up — with no traffic
 * there is no background work at all. A map nobody looks at stops spawning, and
 * starts again on the next visit. That is acceptable here because both jobs
 * produce *content*, not money: no payment, attestation, or on-chain settlement
 * is scheduled this way, and none may be. Anything that must happen whether or
 * not somebody is watching does not belong behind this class.
 *
 * PER-INSTANCE, NOT GLOBAL. The throttle below is a field on an object living in
 * one warm function instance's memory. Vercel may run several concurrently, so
 * `minIntervalMs` bounds the ticks *per instance*, not across the deployment,
 * and N instances can each run a pass in the same window. Both jobs tolerate
 * that: the indexer's passes are idempotent, and a concurrent spawner pass can
 * at worst overshoot the live-spawn target by a couple of rows, which expire on
 * their own TTL. A job that could not tolerate a duplicate pass would need a
 * database lock, not this.
 */

export interface OnDemandTickerDeps {
  /** Names the job in log lines — `spawner`, `indexer`. */
  readonly name: string;
  /** One pass. May reject; the ticker swallows it. */
  readonly tick: () => Promise<unknown>;
  /** Minimum gap between passes on this instance. */
  readonly minIntervalMs: number;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Injected so tests can move time without waiting for it. */
  readonly now?: () => number;
}

export class OnDemandTicker {
  private readonly now: () => number;
  /**
   * Epoch ms of the last pass *finish*, not its start.
   *
   * Stamped on the way out so `minIntervalMs` is a true gap between passes. The
   * tempting alternative — stamping on entry — silently degrades into
   * back-to-back execution for exactly the job that can least afford it: a pass
   * that takes longer than the interval is already overdue the moment it lands,
   * so a slow indexer walk would immediately start another and burn Hiro quota
   * continuously under steady traffic.
   */
  private lastFinishedAt = 0;
  /** Guards a second pass on this instance while one is still in flight. */
  private running = false;

  constructor(private readonly deps: OnDemandTickerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Whether a pass would run right now. Exposed for tests and diagnostics. */
  isDue(): boolean {
    if (this.running) return false;
    // A cold instance has lastFinishedAt = 0, so the first read always ticks.
    return this.now() - this.lastFinishedAt >= this.deps.minIntervalMs;
  }

  /**
   * Run a pass and wait for it, if one is due.
   *
   * For work whose result the caller is about to serve — the spawner, where a
   * fire-and-forget pass would mean the visitor who triggered the top-up is
   * precisely the one who does not see it. Returns whether a pass ran.
   *
   * Never throws: a failed pass degrades the response's content, and turning
   * that into a 500 would replace a thinner map with no map.
   */
  async runIfDue(): Promise<boolean> {
    if (!this.isDue()) return false;
    this.running = true;
    try {
      await this.deps.tick();
      return true;
    } catch (err: unknown) {
      this.deps.log?.(`${this.deps.name} on-demand pass failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      // Stamped even on failure, so a persistently broken dependency is retried
      // at the throttle rate rather than on every single request.
      this.lastFinishedAt = this.now();
      this.running = false;
    }
  }

  /**
   * Start a pass without waiting for it, if one is due.
   *
   * For work the caller must not be held up by — the indexer, whose pass is a
   * walk of chain history over the network and can take seconds. The response it
   * refreshes already carries `computedAt`, so a reader who arrives mid-pass
   * gets openly-stamped stale data rather than a slow request.
   *
   * Returns whether a pass was started. Never throws, and the promise it drops
   * is terminally handled — an unhandled rejection here would take the instance
   * down over a cache refresh.
   */
  startIfDue(): boolean {
    if (!this.isDue()) return false;
    void this.runIfDue();
    return true;
  }
}

/**
 * The indexer's timer.
 *
 * Separated from `Indexer` itself so the jobs stay a plain object with a
 * `runOnce()` a test can await, rather than something that only ever happens on
 * a schedule. Same shape as `DungeonSpawner`, deliberately — a second scheduling
 * idiom in one process would be a second set of shutdown bugs.
 *
 * A failed pass is logged and swallowed. The leaderboard going stale is
 * survivable and visible (`computedAt` is in every response); an unhandled
 * rejection in a timer would take the process down over a cache refresh.
 */

import { Indexer, type IndexerReport } from './indexer.js';

export interface IndexerLoopConfig {
  readonly tickIntervalMs: number;
}

/**
 * Two minutes. Chosen against what a player actually experiences: a run resolves
 * and they look at the leaderboard, so the wait wants to be shorter than the
 * walk to that screen — and against what it costs, which is a handful of Hiro
 * reads per pass, since the forge walk stops at the watermark almost immediately
 * when nothing has happened.
 */
export const DEFAULT_INDEXER_CONFIG: IndexerLoopConfig = {
  tickIntervalMs: 2 * 60 * 1000,
};

export class IndexerLoop {
  private readonly config: IndexerLoopConfig;
  private timer: NodeJS.Timeout | null = null;
  /** Guards against a slow pass overlapping the next tick. */
  private running = false;

  constructor(
    private readonly indexer: Indexer,
    config: Partial<IndexerLoopConfig> = {},
    private readonly log?: (message: string, detail?: Record<string, unknown>) => void,
  ) {
    this.config = { ...DEFAULT_INDEXER_CONFIG, ...config };
  }

  /** One pass, skipped if the previous one is still going. Never throws. */
  async tick(): Promise<IndexerReport | null> {
    if (this.running) {
      // Two concurrent passes would both walk the same chain history and both
      // recompute the same table. Harmless — every job is idempotent — but it is
      // Hiro quota spent to arrive where one pass already was.
      this.log?.('indexer pass skipped; previous pass still running');
      return null;
    }
    this.running = true;
    try {
      const report = await this.indexer.runOnce();
      this.log?.('indexer pass complete', { ...report, errors: report.errors.length });
      return report;
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;

    const run = () => {
      this.tick().catch((err: unknown) => {
        this.log?.('indexer pass failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    // One pass immediately, so a restarted server serves fresh ranks rather than
    // whatever was materialized before it went down.
    run();
    this.timer = setInterval(run, this.config.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

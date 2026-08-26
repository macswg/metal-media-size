/**
 * Background supervisor for `POST /api/probe`, `POST /api/probe/cancel` and
 * `GET /api/probe/status`.
 *
 * Shaped deliberately like `ScanRunner`: the work takes hours, so the route
 * starts it and returns, and the browser polls. One difference that matters --
 * a probe is CANCELLABLE, and a scan is not. A scan is a single atomic walk
 * that is either a snapshot or nothing; a probe is tens of thousands of
 * independent lookups whose results are written in batches as they land, so
 * stopping halfway is a legitimate outcome that loses nothing. The next run
 * resumes from what is already on disk.
 *
 * Only one probe at a time. Two runs would take the same work item twice and
 * double the round trips to the mount for no benefit.
 *
 * Nothing here touches the archive: it delegates to `runProbe`, which reads
 * through the read-only chokepoint.
 */

import type { Database as Db } from 'better-sqlite3';
import type { AppConfig } from '../config.ts';
import { ReadOnlyFs } from '../fs/readonly.ts';
import { runProbe, DEFAULT_CONCURRENCY, type ProbeResult } from '../scan/probe.ts';
import { mediaCoverage } from '../db/index.ts';
import { conflict } from './errors.ts';

export interface ProbeStatus {
  running: boolean;
  /** Files this run has finished, and how many it set out to do. */
  done: number;
  total: number;
  withDimensions: number;
  /** Read cleanly but carrying no header -- interrupted renders. */
  noHeader: number;
  elapsedMs: number;
  /** Files per second over this run, once there is enough to divide by. */
  rate: number | null;
  /** Milliseconds left at the current rate, or null before one is known. */
  etaMs: number | null;
  startedAt?: number;
  finishedAt?: number;
  snapshotId?: number;
  error?: string;
  /** True when the last run was stopped by hand rather than finishing. */
  cancelled?: boolean;
  /** Whole-snapshot coverage, which outlives any single run. */
  coverage: { probed: number; withDimensions: number; total: number };
}

export class ProbeRunner {
  private readonly db: Db;
  private readonly cfg: AppConfig;

  private running = false;
  private stopRequested = false;
  private snapshotId: number | undefined;
  private startedAt: number | undefined;
  private finishedAt: number | undefined;
  private error: string | undefined;
  private cancelled: boolean | undefined;
  private progress = { done: 0, total: 0, withDimensions: 0, failed: 0 };
  private inFlight: Promise<ProbeResult | void> | undefined;

  constructor(db: Db, cfg: AppConfig) {
    this.db = db;
    this.cfg = cfg;
  }

  isRunning(): boolean {
    return this.running;
  }

  status(snapshotId?: number): ProbeStatus {
    const forCoverage = snapshotId ?? this.snapshotId;
    const elapsed = this.startedAt
      ? (this.running ? Date.now() : (this.finishedAt ?? Date.now())) - this.startedAt
      : 0;
    // Below a few seconds the rate is noise, and an ETA computed from noise is
    // worse than no ETA at all.
    const rate = this.running && elapsed > 3000 && this.progress.done > 0
      ? this.progress.done / (elapsed / 1000)
      : null;
    const left = this.progress.total - this.progress.done;

    const s: ProbeStatus = {
      running: this.running,
      done: this.progress.done,
      total: this.progress.total,
      withDimensions: this.progress.withDimensions,
      noHeader: this.progress.failed,
      elapsedMs: elapsed,
      rate,
      etaMs: rate && left > 0 ? Math.round((left / rate) * 1000) : null,
      coverage:
        forCoverage === undefined
          ? { probed: 0, withDimensions: 0, total: 0 }
          : mediaCoverage(this.db, forCoverage),
    };
    if (this.startedAt !== undefined) s.startedAt = this.startedAt;
    if (this.finishedAt !== undefined) s.finishedAt = this.finishedAt;
    if (this.snapshotId !== undefined) s.snapshotId = this.snapshotId;
    if (this.error !== undefined) s.error = this.error;
    if (this.cancelled !== undefined) s.cancelled = this.cancelled;
    return s;
  }

  /** Begin a run. Returns as soon as the work list is known. */
  start(snapshotId: number, opts: { concurrency?: number } = {}): ProbeStatus {
    if (this.running) {
      throw conflict(
        'probe_already_running',
        'A resolution scan is already in progress. Poll GET /api/probe/status, ' +
          'or stop it with POST /api/probe/cancel.',
      );
    }

    this.running = true;
    this.stopRequested = false;
    this.snapshotId = snapshotId;
    this.startedAt = Date.now();
    this.finishedAt = undefined;
    this.error = undefined;
    this.cancelled = undefined;
    this.progress = { done: 0, total: 0, withDimensions: 0, failed: 0 };

    // Deliberately NOT awaited: the request returns while this continues.
    this.inFlight = runProbe(
      this.db,
      new ReadOnlyFs({ allowedRoots: this.cfg.allowedRoots }),
      this.cfg.root,
      {
        snapshotId,
        concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
        shouldStop: () => this.stopRequested,
        onProgress: (p) => {
          this.progress = {
            done: p.done,
            total: p.total,
            withDimensions: p.withDimensions,
            failed: p.failed,
          };
        },
      },
    )
      .then((result) => {
        this.cancelled = result.cancelled;
        return result;
      })
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.running = false;
        this.finishedAt = Date.now();
      });

    return this.status(snapshotId);
  }

  /**
   * Ask the run to stop. Returns immediately; the workers finish the files
   * they already have open, and everything read so far is kept.
   */
  cancel(): ProbeStatus {
    if (this.running) this.stopRequested = true;
    return this.status();
  }

  /** Await the in-flight run. Test-only convenience; routes never call it. */
  async settle(): Promise<void> {
    await this.inFlight;
  }
}

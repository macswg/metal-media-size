/**
 * Background scan supervisor for `POST /api/scan` and `GET /api/scan/status`.
 *
 * `runScan` is an async function that takes tens of seconds against the real
 * archive, so the route must not await it. This class starts it, returns as
 * soon as the snapshot row exists, and exposes progress for polling.
 *
 * Only one scan may be in flight at a time: two concurrent walks of the same
 * object-storage mount would double the metadata traffic for no benefit, and
 * would produce two half-overlapping snapshots of a live tree.
 *
 * Nothing here touches the archive itself -- it delegates to `runScan`, which
 * goes through the read-only chokepoint.
 */

import type { Database as Db } from 'better-sqlite3';
import type { AppConfig } from '../config.ts';
import { runScan } from '../scan/run.ts';
import { conflict, HttpError } from './errors.ts';

export interface ScanStatus {
  running: boolean;
  snapshotId?: number;
  filesSeen?: number;
  elapsedMs?: number;
  /** Extra beyond the contract: which phase the scan is in. */
  stage?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Set when the last scan failed. */
  error?: string;
  /** Id of the most recent scan this process started, running or not. */
  lastSnapshotId?: number;
}

/** How long to wait for the scan to insert its snapshot row before giving up. */
const SNAPSHOT_ID_TIMEOUT_MS = 10_000;

export class ScanRunner {
  private readonly db: Db;
  private readonly cfg: AppConfig;
  private readonly onFinished: (snapshotId: number, ok: boolean) => void;

  private running = false;
  private snapshotId: number | undefined;
  private startedAt: number | undefined;
  private finishedAt: number | undefined;
  private filesSeen: number | undefined;
  private stage: string | undefined;
  private error: string | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    db: Db,
    cfg: AppConfig,
    onFinished: (snapshotId: number, ok: boolean) => void = () => {},
  ) {
    this.db = db;
    this.cfg = cfg;
    this.onFinished = onFinished;
  }

  isRunning(): boolean {
    return this.running;
  }

  status(): ScanStatus {
    const s: ScanStatus = { running: this.running };
    if (this.snapshotId !== undefined) {
      s.snapshotId = this.snapshotId;
      s.lastSnapshotId = this.snapshotId;
    }
    if (this.filesSeen !== undefined) s.filesSeen = this.filesSeen;
    if (this.startedAt !== undefined) {
      s.startedAt = this.startedAt;
      s.elapsedMs = (this.running ? Date.now() : (this.finishedAt ?? Date.now())) - this.startedAt;
    }
    if (this.finishedAt !== undefined) s.finishedAt = this.finishedAt;
    if (this.stage !== undefined) s.stage = this.stage;
    if (this.error !== undefined) s.error = this.error;
    return s;
  }

  /**
   * Kick off a scan and resolve with its snapshot id as soon as the row exists.
   * The scan itself keeps running after this resolves.
   */
  async start(name?: string): Promise<number> {
    if (this.running) {
      throw conflict(
        'scan_already_running',
        `A scan is already in progress (snapshot ${this.snapshotId ?? '?'}). ` +
          `Poll GET /api/scan/status and retry when it reports running: false.`,
      );
    }

    const cfg: AppConfig = name === undefined ? this.cfg : { ...this.cfg, name };

    const highWater = (
      this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM snapshot`).get() as { n: number }
    ).n;

    this.running = true;
    this.startedAt = Date.now();
    this.finishedAt = undefined;
    this.filesSeen = undefined;
    this.snapshotId = undefined;
    this.error = undefined;
    this.stage = 'starting';

    // Deliberately NOT awaited: the request returns while this continues.
    this.inFlight = runScan(this.db, cfg, {
      onProgress: (message) => this.note(message),
    })
      .then((result) => {
        this.snapshotId = result.snapshotId;
        this.filesSeen = result.walk.files.length;
        this.stage = 'complete';
        this.onFinished(result.snapshotId, true);
      })
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
        this.stage = 'failed';
        if (this.snapshotId !== undefined) this.onFinished(this.snapshotId, false);
      })
      .finally(() => {
        this.running = false;
        this.finishedAt = Date.now();
      });

    const id = await this.waitForSnapshotId(highWater);
    this.snapshotId = id;
    return id;
  }

  /** Await the in-flight scan. Test-only convenience; routes never call it. */
  async settle(): Promise<void> {
    await this.inFlight;
  }

  private note(message: string): void {
    const walked = /walked (\d+) files/.exec(message);
    if (walked?.[1]) {
      this.filesSeen = Number.parseInt(walked[1], 10);
      this.stage = 'deriving';
      return;
    }
    if (message.startsWith('walking')) {
      this.stage = 'walking';
      return;
    }
    if (message.startsWith('derived')) {
      this.stage = 'writing';
      return;
    }
    this.stage = message;
  }

  /**
   * `runScan` inserts its snapshot row before its first await, so in practice
   * this resolves on the first poll. The loop is here so a future refactor
   * that adds an await ahead of the insert degrades into a short wait rather
   * than a wrong answer.
   */
  private async waitForSnapshotId(highWater: number): Promise<number> {
    const deadline = Date.now() + SNAPSHOT_ID_TIMEOUT_MS;
    const stmt = this.db.prepare(
      `SELECT id FROM snapshot WHERE id > ? ORDER BY id ASC LIMIT 1`,
    );
    for (;;) {
      const row = stmt.get(highWater) as { id: number } | undefined;
      if (row) return row.id;
      if (this.error !== undefined) {
        throw new HttpError(500, 'scan_failed', `Scan failed to start: ${this.error}`);
      }
      if (Date.now() > deadline) {
        throw new HttpError(
          500,
          'scan_no_snapshot',
          'The scan did not create a snapshot row within 10s.',
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

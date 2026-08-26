/**
 * ============================================================================
 *  RESOLUTION PROBE  --  a separate pass, never part of a scan
 * ============================================================================
 *
 * A scan is metadata-only and stays that way. This pass exists because pixel
 * dimensions are not in the filename and not in the stat, and it is kept
 * separate for three reasons:
 *
 *   1. It is the only thing here that opens an archive file, so it should be
 *      the thing the operator runs on purpose, not a side effect of scanning.
 *   2. It is latency-bound, not bandwidth-bound. Each file is ~8 positioned
 *      reads of ~210 bytes total, but each read is a round trip to object
 *      storage, so the pass is slow in wall-clock and trivial in egress. On the
 *      real archive: ~6 MB and under an hour at the default concurrency.
 *   3. It is resumable. Results land in `file_media`, work is chosen by 'has
 *      no row there yet', and an interrupted run costs only the files in
 *      flight. Re-running it after a rescan re-probes nothing that did not
 *      change -- `carryForwardMedia` matches on (path, size, mtime) first.
 *
 * Concurrency is what makes it finish: at 1 file at a time the archive takes
 * ~10 hours, at 64 it takes under an hour. The reads are tiny, so the limit is
 * how many round trips the mount will service at once, not throughput.
 * ============================================================================
 */

import type { Database as Db } from 'better-sqlite3';
import type { ReadOnlyFs } from '../fs/readonly.ts';
import { readMovDimensions } from './media.ts';
import { carryForwardMedia, recordMedia, unprobedFiles, type MediaProbeRow } from '../db/index.ts';

/** In flight at once. Tuned on the real mount; see the module comment. */
export const DEFAULT_CONCURRENCY = 64;
/** Results are written in batches so an interrupted run keeps its progress. */
const BATCH = 200;

export interface ProbeOptions {
  snapshotId: number;
  /** Files to probe at once. */
  concurrency?: number;
  /** Stop after this many files. Useful for a first look at the cost. */
  limit?: number;
  /** Extension to probe. The grammar is .mov-only, and so is the parser. */
  ext?: string;
  /**
   * Also re-read files already recorded as having no dimensions. Off by
   * default -- a file with no header atom will not grow one -- but a fix to
   * the parser needs a way to revisit them.
   */
  retryEmpty?: boolean;
  /**
   * Checked before each file. When it returns true the workers stop, the
   * results already gathered are written, and the run reports `cancelled`.
   * A cancelled run loses nothing: the next one resumes from what is on disk.
   */
  shouldStop?: () => boolean;
  onProgress?: (p: ProbeProgress) => void;
}

export interface ProbeProgress {
  done: number;
  total: number;
  withDimensions: number;
  failed: number;
  elapsedMs: number;
}

export interface ProbeResult extends ProbeProgress {
  /** Rows filled in from an earlier snapshot instead of being read. */
  carriedForward: number;
  /** Paths that could not be read at all, with the reason. */
  errors: { relPath: string; reason: string }[];
  /**
   * Files that opened and read fine but carry no dimensions. Worth reporting
   * rather than swallowing: the usual cause is a file whose header atom was
   * never written, which means an interrupted render -- bytes on disk that no
   * player can open. The list is capped so a bad batch cannot fill memory.
   */
  noDimensions: { relPath: string; size: number }[];
  /** True when the run stopped early because it was asked to. */
  cancelled: boolean;
}

/** How many no-dimension paths to keep for the report. */
const MAX_REPORTED = 200;

export async function runProbe(
  db: Db,
  fs: ReadOnlyFs,
  root: string,
  opts: ProbeOptions,
): Promise<ProbeResult> {
  const started = Date.now();
  const report = opts.onProgress ?? (() => {});

  // Free wins first: anything unchanged since a previous probe keeps its
  // dimensions without a single read.
  const carriedForward = carryForwardMedia(db, opts.snapshotId);

  const queue = unprobedFiles(db, opts.snapshotId, {
    ext: opts.ext,
    limit: opts.limit,
    retryEmpty: opts.retryEmpty,
  });
  const total = queue.length;
  const errors: { relPath: string; reason: string }[] = [];
  const noDimensions: { relPath: string; size: number }[] = [];
  const pending: MediaProbeRow[] = [];
  let done = 0;
  let withDimensions = 0;
  let failed = 0;
  let next = 0;

  const flush = (force: boolean) => {
    if (pending.length === 0 || (!force && pending.length < BATCH)) return;
    recordMedia(db, pending.splice(0, pending.length));
  };

  let cancelled = false;
  const worker = async () => {
    while (next < queue.length) {
      if (opts.shouldStop?.()) {
        cancelled = true;
        return;
      }
      const item = queue[next++];
      if (!item) return;
      let dims = null;
      try {
        const handle = await fs.openRead(`${root}/${item.rel_path}`);
        try {
          dims = await readMovDimensions(handle, item.size);
        } finally {
          await handle.close();
        }
      } catch (err) {
        // A file that cannot be opened is recorded as probed-with-nothing, the
        // same as one with no dimensions. Retrying it on every future run
        // would spend the whole budget on the same handful of bad files.
        errors.push({ relPath: item.rel_path, reason: (err as Error).message });
      }
      if (dims) {
        withDimensions += 1;
      } else {
        failed += 1;
        if (noDimensions.length < MAX_REPORTED) {
          noDimensions.push({ relPath: item.rel_path, size: item.size });
        }
      }
      pending.push({ fileId: item.id, width: dims?.width ?? null, height: dims?.height ?? null });
      done += 1;
      flush(false);
      report({ done, total, withDimensions, failed, elapsedMs: Date.now() - started });
    }
  };

  const lanes = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, 256));
  await Promise.all(Array.from({ length: lanes }, worker));
  flush(true);

  return {
    done,
    total,
    withDimensions,
    failed,
    carriedForward,
    errors,
    noDimensions,
    cancelled,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Snapshot listing and diffing.
 *
 *   GET /api/snapshots
 *   GET /api/snapshots/:id
 *   GET /api/snapshots/:a/diff/:b
 *
 * The archive is LIVE -- it grew by 13 files during a single core-agent run --
 * so a diff between two snapshots is a first-class answer, not a debug tool.
 * A diff is pure SQL over `file.rel_path`, matched by relative path.
 */

import type { FastifyInstance } from 'fastify';
import { getSnapshot, listSnapshots, type SnapshotRow } from '../../db/index.ts';
import type { AppContext } from '../context.ts';
import { requireIntParam } from '../context.ts';
import { conflict, notFound } from '../errors.ts';
import { intParam, type Query } from '../query.ts';

/** Max rows returned per diff bucket unless the caller asks for fewer. */
const DEFAULT_DIFF_LIMIT = 1000;
const MAX_DIFF_LIMIT = 20_000;

export interface SnapshotView {
  id: number;
  root: string;
  name: string | null;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  elapsedMs: number | null;
  fileCount: number;
  totalBytes: number;
  dirCount: number | null;
  excludedCount: number;
  excludedBytes: number;
  unparsedCount: number;
  skipped: { path: string; reason: string }[];
}

export function toSnapshotView(r: SnapshotRow): SnapshotView {
  let skipped: { path: string; reason: string }[] = [];
  if (r.skipped_json) {
    try {
      const parsed: unknown = JSON.parse(r.skipped_json);
      if (Array.isArray(parsed)) skipped = parsed as { path: string; reason: string }[];
    } catch {
      skipped = [{ path: '<unparseable>', reason: 'skipped_json was not valid JSON' }];
    }
  }
  return {
    id: r.id,
    root: r.root,
    name: r.name,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    elapsedMs: r.elapsed_ms,
    fileCount: r.file_count,
    totalBytes: r.total_bytes,
    dirCount: r.dir_count,
    excludedCount: r.excluded_count,
    excludedBytes: r.excluded_bytes,
    unparsedCount: r.unparsed_count,
    skipped,
  };
}

interface DiffFileRow {
  rel_path: string;
  song_folder: string;
  size: number;
  mtime: number;
}

interface DiffPairRow extends DiffFileRow {
  b_size: number;
  b_mtime: number;
}

export function registerSnapshotRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/snapshots', () => listSnapshots(ctx.db).map(toSnapshotView));

  app.get('/api/snapshots/:id', (req) => {
    const id = requireIntParam((req.params as { id?: string }).id, 'id');
    const row = getSnapshot(ctx.db, id);
    if (!row) throw notFound('snapshot_not_found', `No snapshot with id ${id}`);
    return toSnapshotView(row);
  });

  /**
   * `DELETE /api/snapshots/:id` -- forget a scan.
   *
   * This removes an INDEX ENTRY, never a file. The archive is not touched and
   * is not even reachable from this route; what disappears is this tool's own
   * record of a walk. Re-running a scan rebuilds an equivalent one.
   *
   * It is nonetheless the only destructive route in the server, so:
   *
   *   - a scan in flight blocks it, because the runner is writing rows into a
   *     snapshot and cascading them out underneath it would be a race;
   *   - the response states exactly what went, so the UI can confirm against
   *     what it showed rather than against what it assumed;
   *   - the reclaim memo is invalidated, or a later query could be served
   *     verdicts computed from rows that no longer exist.
   *
   * Deleting the last snapshot is allowed. An empty index is a supported
   * state: every route answers `no_snapshot` with an instruction to scan.
   */
  app.delete('/api/snapshots/:id', (req) => {
    const id = requireIntParam((req.params as { id?: string }).id, 'id');
    const row = getSnapshot(ctx.db, id);
    if (!row) throw notFound('snapshot_not_found', `No snapshot with id ${id}`);

    const scan = ctx.scans.status();
    if (scan.running) {
      throw conflict(
        'scan_running',
        `A scan is in progress (snapshot ${scan.snapshotId ?? '?'}). Wait for it to finish before deleting anything.`,
      );
    }

    // Counted before the delete so the response can say what it removed.
    // ON DELETE CASCADE does the actual work; see src/db/schema.ts.
    const counts = ctx.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM file WHERE snapshot_id = ?) AS files,
                (SELECT COUNT(*) FROM asset WHERE snapshot_id = ?) AS assets,
                (SELECT COUNT(*) FROM v_asset_version WHERE snapshot_id = ?) AS versions`,
      )
      .get(id, id, id) as { files: number; assets: number; versions: number };

    ctx.db.prepare('DELETE FROM snapshot WHERE id = ?').run(id);
    ctx.reclaim.invalidate(id);

    const remaining = listSnapshots(ctx.db).map(toSnapshotView);
    return {
      deleted: { snapshotId: id, ...counts, totalBytes: row.total_bytes },
      remaining: remaining.length,
      snapshots: remaining,
      note: 'An index entry was removed. No file in the archive was touched.',
    };
  });

  app.get('/api/snapshots/:a/diff/:b', (req) => {
    const params = req.params as { a?: string; b?: string };
    const aId = requireIntParam(params.a, 'a');
    const bId = requireIntParam(params.b, 'b');
    const a = getSnapshot(ctx.db, aId);
    const b = getSnapshot(ctx.db, bId);
    if (!a) throw notFound('snapshot_not_found', `No snapshot with id ${aId}`);
    if (!b) throw notFound('snapshot_not_found', `No snapshot with id ${bId}`);

    const q = req.query as Query;
    const limitRaw = intParam(q, 'limit');
    const limit = Math.min(limitRaw ?? DEFAULT_DIFF_LIMIT, MAX_DIFF_LIMIT);

    // Present in B, absent from A.
    const addedRows = ctx.db
      .prepare(
        `SELECT fb.rel_path, fb.song_folder, fb.size, fb.mtime
           FROM file fb
          WHERE fb.snapshot_id = ?
            AND NOT EXISTS (SELECT 1 FROM file fa
                             WHERE fa.snapshot_id = ? AND fa.rel_path = fb.rel_path)
          ORDER BY fb.size DESC`,
      )
      .all(bId, aId) as DiffFileRow[];

    // Present in A, absent from B.
    const removedRows = ctx.db
      .prepare(
        `SELECT fa.rel_path, fa.song_folder, fa.size, fa.mtime
           FROM file fa
          WHERE fa.snapshot_id = ?
            AND NOT EXISTS (SELECT 1 FROM file fb
                             WHERE fb.snapshot_id = ? AND fb.rel_path = fa.rel_path)
          ORDER BY fa.size DESC`,
      )
      .all(aId, bId) as DiffFileRow[];

    // Present in both, different size.
    const changedRows = ctx.db
      .prepare(
        `SELECT fa.rel_path, fa.song_folder, fa.size, fa.mtime,
                fb.size AS b_size, fb.mtime AS b_mtime
           FROM file fa
           JOIN file fb ON fb.snapshot_id = ? AND fb.rel_path = fa.rel_path
          WHERE fa.snapshot_id = ? AND fb.size <> fa.size
          ORDER BY ABS(fb.size - fa.size) DESC`,
      )
      .all(bId, aId) as DiffPairRow[];

    const grownRows = changedRows.filter((r) => r.b_size > r.size);
    const shrunkRows = changedRows.filter((r) => r.b_size < r.size);

    const plain = (r: DiffFileRow) => ({
      relPath: r.rel_path,
      songFolder: r.song_folder,
      size: r.size,
      mtime: r.mtime,
    });
    const paired = (r: DiffPairRow) => ({
      relPath: r.rel_path,
      songFolder: r.song_folder,
      sizeA: r.size,
      sizeB: r.b_size,
      delta: r.b_size - r.size,
      mtimeA: r.mtime,
      mtimeB: r.b_mtime,
    });

    const sum = (rows: DiffFileRow[]) => rows.reduce((n, r) => n + r.size, 0);
    const delta = (rows: DiffPairRow[]) => rows.reduce((n, r) => n + (r.b_size - r.size), 0);

    return {
      a: toSnapshotView(a),
      b: toSnapshotView(b),
      limit,
      added: addedRows.slice(0, limit).map(plain),
      removed: removedRows.slice(0, limit).map(plain),
      grown: grownRows.slice(0, limit).map(paired),
      shrunk: shrunkRows.slice(0, limit).map(paired),
      summary: {
        snapshotA: aId,
        snapshotB: bId,
        fileCountA: a.file_count,
        fileCountB: b.file_count,
        totalBytesA: a.total_bytes,
        totalBytesB: b.total_bytes,
        addedCount: addedRows.length,
        addedBytes: sum(addedRows),
        removedCount: removedRows.length,
        removedBytes: sum(removedRows),
        grownCount: grownRows.length,
        grownBytes: delta(grownRows),
        shrunkCount: shrunkRows.length,
        shrunkBytes: delta(shrunkRows),
        netBytes: b.total_bytes - a.total_bytes,
        // True when a bucket was clipped to `limit`; the counts above are exact.
        listsClipped:
          addedRows.length > limit ||
          removedRows.length > limit ||
          grownRows.length > limit ||
          shrunkRows.length > limit,
      },
    };
  });
}

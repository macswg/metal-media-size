/**
 * Shared selection logic for the filtered list routes.
 *
 * Two shapes, one policy:
 *
 *   1. SQL narrows as far as it can, with every value bound as a parameter.
 *   2. Predicates SQL cannot express -- `path`, `pathRe`, and `status` (which
 *      needs the reclaim verdict) -- are applied in JS over the narrowed set,
 *      which is capped by `guardCandidateCount`.
 *   3. Sorting uses an allowlisted SQL expression, or a JS comparator when the
 *      key only exists in JS (`status`).
 *
 * Rule 2 is why `/api/reclaim` is safe to filter: the verdicts come from
 * `computeReclaim` over the WHOLE snapshot (see `reclaim-cache.ts`), and the
 * filter only decides which verdict rows are counted.
 */

import type { AppContext } from './context.ts';
import {
  toFileRow,
  toVersionRow,
  type FileDbRow,
  type FileRow,
  type VersionDbRow,
  type VersionRow,
} from './context.ts';
import {
  fileWhere,
  guardCandidateCount,
  makePathPredicate,
  versionIdsMatchingPath,
  versionWhere,
  type FilterSpec,
} from './query.ts';

const VERSION_COLUMNS = `av.version_id, av.asset_id, av.snapshot_id, av.song_folder, av.base,
  av.family, av.ver_num, av.sub_letter, av.ver_label, av.is_patch, av.patch_frame,
  av.bytes, av.file_count, av.proxy_bytes, av.region_count, av.latest_mtime`;

// `av.asset_id` rides along on the LEFT JOIN the file queries already carry,
// so a file row can link straight to its asset ladder. NULL for unparsed files.
const FILE_COLUMNS = `f.id, f.rel_path, f.song_folder, f.name, f.ext, f.size, f.mtime,
  f.parse_ok, f.asset_version_id, av.asset_id`;

/**
 * Every asset-version in `snapshotId` that passes `filters`, annotated with its
 * keep/supersede verdict at `keepN`.
 *
 * `orderBySql` must be an ORDER BY clause built by `orderByClause` from an
 * allowlist. It is never derived from user text.
 */
export function selectVersions(
  ctx: AppContext,
  snapshotId: number,
  filters: FilterSpec,
  keepN: number,
  orderBySql: string,
): VersionRow[] {
  const where = versionWhere(snapshotId, filters);

  const count = (
    ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM v_asset_version av WHERE ${where.sql}`)
      .get(...where.params) as { n: number }
  ).n;
  guardCandidateCount(count, 'asset-version query');

  const dbRows = ctx.db
    .prepare(`SELECT ${VERSION_COLUMNS} FROM v_asset_version av WHERE ${where.sql} ${orderBySql}`)
    .all(...where.params) as VersionDbRow[];

  const pathPredicate = makePathPredicate(filters);
  const allowedIds =
    pathPredicate === null ? null : versionIdsMatchingPath(ctx.db, snapshotId, pathPredicate);

  const verdicts = ctx.reclaim.get(snapshotId, keepN).byVersionId;

  const out: VersionRow[] = [];
  for (const r of dbRows) {
    if (allowedIds !== null && !allowedIds.has(r.version_id)) continue;
    const row = toVersionRow(r, verdicts.get(r.version_id));
    if (filters.status !== undefined && row.status !== filters.status) continue;
    out.push(row);
  }
  return out;
}

/**
 * True when the file query needs post-SQL work in JS, and therefore cannot use
 * the LIMIT/OFFSET fast path.
 */
export function fileNeedsJsPass(filters: FilterSpec, sortKey: string): boolean {
  return (
    filters.path !== undefined ||
    filters.pathRe !== undefined ||
    filters.status !== undefined ||
    sortKey === 'status'
  );
}

export interface FilePage {
  rows: FileRow[];
  total: number;
  matchedBytes: number;
}

/**
 * Fast path: SQL does the filtering, the totals and the paging.
 * Only valid when `fileNeedsJsPass` is false.
 */
export function selectFilesPaged(
  ctx: AppContext,
  snapshotId: number,
  filters: FilterSpec,
  orderBySql: string,
  limit: number,
  offset: number,
): FilePage {
  const where = fileWhere(snapshotId, filters);
  const from = `FROM file f LEFT JOIN v_asset_version av ON av.version_id = f.asset_version_id
                WHERE ${where.sql}`;

  const totals = ctx.db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(f.size), 0) AS b ${from}`)
    .get(...where.params) as { n: number; b: number };

  const rows = ctx.db
    .prepare(`SELECT ${FILE_COLUMNS} ${from} ${orderBySql} LIMIT ? OFFSET ?`)
    .all(...where.params, limit, offset) as FileDbRow[];

  return { rows: rows.map(toFileRow), total: totals.n, matchedBytes: totals.b };
}

/**
 * Slow path: SQL narrows, JS applies `path` / `pathRe` / `status`. The caller
 * pages the result.
 */
export function selectFilesFiltered(
  ctx: AppContext,
  snapshotId: number,
  filters: FilterSpec,
  keepN: number,
  orderBySql: string,
): FileRow[] {
  const where = fileWhere(snapshotId, filters);
  const from = `FROM file f LEFT JOIN v_asset_version av ON av.version_id = f.asset_version_id
                WHERE ${where.sql}`;

  const count = (
    ctx.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...where.params) as { n: number }
  ).n;
  guardCandidateCount(count, 'file query');

  const dbRows = ctx.db
    .prepare(`SELECT ${FILE_COLUMNS} ${from} ${orderBySql}`)
    .all(...where.params) as FileDbRow[];

  const pathPredicate = makePathPredicate(filters);
  const verdicts =
    filters.status === undefined ? null : ctx.reclaim.get(snapshotId, keepN).byVersionId;

  const out: FileRow[] = [];
  for (const r of dbRows) {
    if (pathPredicate !== null && !pathPredicate(r.rel_path)) continue;
    if (verdicts !== null) {
      const v = r.asset_version_id === null ? undefined : verdicts.get(r.asset_version_id);
      const status = v === undefined ? 'unknown' : v.keep ? 'kept' : 'superseded';
      if (status !== filters.status) continue;
    }
    out.push(toFileRow(r));
  }
  return out;
}

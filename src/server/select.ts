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
import { badRequest } from './errors.ts';
import type { ProgrammedUse } from '../programmed/protect.ts';
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
  av.bytes, av.file_count, av.proxy_bytes, av.region0_bytes, av.region_count,
  av.latest_mtime`;

// `av.asset_id` rides along on the LEFT JOIN the file queries already carry,
// so a file row can link straight to its asset ladder. NULL for unparsed files.
const FILE_COLUMNS = `f.id, f.rel_path, f.song_folder, f.name, f.ext, f.size, f.mtime,
  f.parse_ok, f.asset_version_id, av.asset_id, fm.width, fm.height,
  (fm.file_id IS NOT NULL) AS probed`;

// Dimensions come from `npm run probe`, which most files may not have had yet,
// so the join is LEFT and a missing row reads as 'not probed' -- never as an
// assertion about the file.
const FILE_FROM = `FROM file f
  LEFT JOIN v_asset_version av ON av.version_id = f.asset_version_id
  LEFT JOIN file_media fm ON fm.file_id = f.id`;

/**
 * The programmed-media filters as one predicate over a version id and its
 * asset id, or null when none is in use. A file with no version (an unparsed
 * name) is never programmed, and its asset is never in the show: no capture
 * can name it.
 *
 * Reads the protection the reclaim cache resolved over the WHOLE snapshot, so
 * the filter and the verdicts agree about what the show plays. It hides rows
 * and does nothing else -- see the note in `query.ts`.
 */
export function programmedPredicate(
  ctx: AppContext,
  snapshotId: number,
  keepN: number,
  filters: FilterSpec,
): ((versionId: number | null, assetId: number | null) => boolean) | null {
  const wantsProgrammed = filters.programmed !== undefined || filters.inShow !== undefined;
  const tracks = filters.excludeTrack ?? [];
  const setlists = filters.excludeSetlist ?? [];
  if (!wantsProgrammed && tracks.length === 0 && setlists.length === 0) return null;

  const prot = ctx.reclaim.get(snapshotId, keepN).programmed;
  if (prot === null) {
    throw badRequest(
      'no_capture',
      'The programmed-media filters need a show capture, and none is loaded. Drop a .d3 ' +
        'project or a Susan summary .json into programmed_media_crosscheck/ and restart.',
    );
  }
  if (!prot.usable) {
    throw badRequest(
      'capture_unusable',
      'The loaded show capture matched nothing in this archive, so it cannot say which ' +
        'files are programmed. Filtering on it would hide nothing, or everything, for no reason.',
    );
  }

  const knownTracks = new Set(prot.tracks.map((t) => t.track));
  const knownSetlists = new Set(prot.setlists.map((s) => s.setlist));
  const badTrack = tracks.find((t) => !knownTracks.has(t));
  if (badTrack !== undefined) {
    throw badRequest('bad_param', `excludeTrack names a track the capture does not have: ${JSON.stringify(badTrack)}`);
  }
  const badSetlist = setlists.find((t) => !knownSetlists.has(t));
  if (badSetlist !== undefined) {
    throw badRequest('bad_param', `excludeSetlist names a setlist the capture does not have: ${JSON.stringify(badSetlist)}`);
  }

  const hideTracks = new Set(tracks);
  const hideSetlists = new Set(setlists);
  const hidden = (versionId: number): boolean => {
    for (const u of prot.programmedOn.get(versionId) ?? []) {
      if (hideTracks.has(u.track)) return true;
      if (u.setlists.some((s) => hideSetlists.has(s))) return true;
    }
    return false;
  };

  return (versionId, assetId) => {
    const isProgrammed = versionId !== null && prot.protectedVersionIds.has(versionId);
    if (filters.programmed === 1 && !isProgrammed) return false;
    if (filters.programmed === 0 && isProgrammed) return false;
    const assetInShow = assetId !== null && prot.programmedAssetIds.has(assetId);
    if (filters.inShow === 1 && !assetInShow) return false;
    if (filters.inShow === 0 && assetInShow) return false;
    if (versionId !== null && (hideTracks.size > 0 || hideSetlists.size > 0) && hidden(versionId)) {
      return false;
    }
    return true;
  };
}

/**
 * The roles `clusterRoles` asks to count, checked against the listing in
 * force. Undefined when absent, or when no listing is in force (the figure is
 * then null anyway, and `onCluster` refuses on its own). A role the listing
 * was not read for is refused: a typo that counted nothing would look like a
 * cluster with nothing on it.
 */
export function clusterRolesOf(ctx: AppContext, filters: FilterSpec): string[] | undefined {
  const want = filters.clusterRoles;
  const l = ctx.cluster.listing;
  if (want === undefined || l === null) return undefined;
  const bad = want.find((r) => !l.roles.includes(r));
  if (bad !== undefined) {
    throw badRequest(
      'bad_cluster_role',
      `clusterRoles names ${JSON.stringify(bad)}, which the cluster listing was not read for (${l.roles.join(', ')}).`,
    );
  }
  return want;
}

/**
 * The `onCluster` filter, or null when it is not in use. Takes the version id
 * and, for a file row, the file id: a FILE is on the cluster when the catalog
 * has it at that size, a VERSION when any of its files is.
 *
 * Refuses when no listing is in force -- "not on the cluster" read off a
 * catalog nobody could reach would hide everything for no reason.
 */
export function clusterPredicate(
  ctx: AppContext,
  snapshotId: number,
  filters: FilterSpec,
): ((versionId: number | null, fileId: number | null) => boolean) | null {
  if (filters.onCluster === undefined) return null;
  if (!ctx.cluster.configured) {
    throw badRequest(
      'no_cluster',
      'The cluster filter needs the Media Index catalog, and none is configured. ' +
        'Add mediaIndex to config/local.json and restart.',
    );
  }
  const p = ctx.cluster.presence(snapshotId, clusterRolesOf(ctx, filters));
  if (p === null) {
    throw badRequest(
      'cluster_unavailable',
      `The Media Index catalog could not be read, so what is on the cluster is unknown: ${ctx.cluster.error ?? 'not read yet'}`,
    );
  }
  const want = filters.onCluster === 1;
  return (versionId, fileId) => {
    const on = fileId !== null ? p.fileIds.has(fileId) : versionId !== null && p.byVersion.has(versionId);
    return on === want;
  };
}

/**
 * Where each file's version is programmed, for the Files table's Programmed
 * column. Null throughout when no usable capture is loaded -- see
 * `FileRow.programmedOn`.
 */
function programmedOnLookup(
  ctx: AppContext,
  snapshotId: number,
  keepN: number,
): (versionId: number | null) => readonly ProgrammedUse[] | null {
  const prot = ctx.reclaim.get(snapshotId, keepN).programmed;
  if (prot === null || !prot.usable) return () => null;
  return (versionId) => (versionId === null ? [] : (prot.programmedOn.get(versionId) ?? []));
}

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
  const programmed = programmedPredicate(ctx, snapshotId, keepN, filters);
  const onCluster = clusterPredicate(ctx, snapshotId, filters);

  const out: VersionRow[] = [];
  for (const r of dbRows) {
    if (allowedIds !== null && !allowedIds.has(r.version_id)) continue;
    if (programmed !== null && !programmed(r.version_id, r.asset_id)) continue;
    if (onCluster !== null && !onCluster(r.version_id, null)) continue;
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
    filters.programmed !== undefined ||
    filters.excludeTrack !== undefined ||
    filters.excludeSetlist !== undefined ||
    filters.inShow !== undefined ||
    filters.onCluster !== undefined ||
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
  keepN: number,
  orderBySql: string,
  limit: number,
  offset: number,
): FilePage {
  const where = fileWhere(snapshotId, filters);
  const from = `${FILE_FROM} WHERE ${where.sql}`;

  const totals = ctx.db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(f.size), 0) AS b ${from}`)
    .get(...where.params) as { n: number; b: number };

  const rows = ctx.db
    .prepare(`SELECT ${FILE_COLUMNS} ${from} ${orderBySql} LIMIT ? OFFSET ?`)
    .all(...where.params, limit, offset) as FileDbRow[];

  // A file inherits its version's verdict. Looked up from the same memoised
  // whole-snapshot computation the version rows use, so the two can never
  // disagree about the same version.
  const verdicts = ctx.reclaim.get(snapshotId, keepN).byVersionId;
  const programmedOn = programmedOnLookup(ctx, snapshotId, keepN);
  const rowsOut = rows.map((r) =>
    toFileRow(
      r,
      r.asset_version_id === null ? undefined : verdicts.get(r.asset_version_id),
      programmedOn(r.asset_version_id),
    ),
  );
  return { rows: rowsOut, total: totals.n, matchedBytes: totals.b };
}

/**
 * Slow path: SQL narrows, JS applies `path` / `pathRe` / `status` and the
 * programmed-media filters. The caller
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
  const from = `${FILE_FROM} WHERE ${where.sql}`;

  const count = (
    ctx.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...where.params) as { n: number }
  ).n;
  guardCandidateCount(count, 'file query');

  const dbRows = ctx.db
    .prepare(`SELECT ${FILE_COLUMNS} ${from} ${orderBySql}`)
    .all(...where.params) as FileDbRow[];

  const pathPredicate = makePathPredicate(filters);
  // Always loaded now, not only when filtering: every file row reports the
  // verdict on its version, so the Files view can show it.
  const verdicts = ctx.reclaim.get(snapshotId, keepN).byVersionId;
  const programmed = programmedPredicate(ctx, snapshotId, keepN, filters);
  const programmedOn = programmedOnLookup(ctx, snapshotId, keepN);
  const onCluster = clusterPredicate(ctx, snapshotId, filters);

  const out: FileRow[] = [];
  for (const r of dbRows) {
    if (pathPredicate !== null && !pathPredicate(r.rel_path)) continue;
    if (programmed !== null && !programmed(r.asset_version_id, r.asset_id)) continue;
    if (onCluster !== null && !onCluster(r.asset_version_id, r.id)) continue;
    const v = r.asset_version_id === null ? undefined : verdicts.get(r.asset_version_id);
    if (filters.status !== undefined) {
      const status = v === undefined ? 'unknown' : v.keep ? 'kept' : 'superseded';
      if (status !== filters.status) continue;
    }
    out.push(toFileRow(r, v, programmedOn(r.asset_version_id)));
  }
  return out;
}

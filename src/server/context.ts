/**
 * Shared per-server state and the row shapes the routes return.
 *
 * The API is READ-ONLY over the SQLite index. The only route with a side
 * effect is `POST /api/scan`, which delegates to the scanner, and
 * `POST /api/export`, which delegates to the exporter agent's module. Nothing
 * in `src/server` touches the archive directly.
 */

import type { Database as Db } from 'better-sqlite3';
import type { AppConfig } from '../config.ts';
import { getSnapshot, latestSnapshot, type SnapshotRow } from '../db/index.ts';
import type { KeepReason } from '../scan/reclaim.ts';
import { ReclaimCache } from './reclaim-cache.ts';
import { ScanRunner } from './scan-runner.ts';
import { badRequest, notFound } from './errors.ts';
import { intParam, type Query } from './query.ts';

export interface AppContext {
  db: Db;
  cfg: AppConfig;
  reclaim: ReclaimCache;
  scans: ScanRunner;
  /**
   * Where the exporter puts its artefacts. Undefined in normal operation, so
   * the exporter uses its own jailed default of `<project>/exports`. Tests set
   * it to a scratch directory so a test run never leaves files in `exports/`.
   */
  exportsDir?: string;
}

export function createContext(db: Db, cfg: AppConfig, exportsDir?: string): AppContext {
  const reclaim = new ReclaimCache(db);
  const scans = new ScanRunner(db, cfg, (snapshotId) => reclaim.invalidate(snapshotId));
  return { db, cfg, reclaim, scans, ...(exportsDir === undefined ? {} : { exportsDir }) };
}

/**
 * Resolve `?snapshotId=`, defaulting to the latest COMPLETE snapshot.
 * A 404 here is a real condition: an empty database before the first scan.
 */
export function resolveSnapshot(ctx: AppContext, q: Query): SnapshotRow {
  const explicit = intParam(q, 'snapshotId');
  if (explicit !== undefined) {
    const row = getSnapshot(ctx.db, explicit);
    if (!row) throw notFound('snapshot_not_found', `No snapshot with id ${explicit}`);
    return row;
  }
  const latest = latestSnapshot(ctx.db);
  if (!latest) {
    throw notFound(
      'no_snapshot',
      'No completed snapshot exists yet. Run a scan first (POST /api/scan).',
    );
  }
  return latest;
}

export function requireIntParam(value: string | undefined, name: string): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n)) {
    throw badRequest('bad_param', `${name} must be an integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Row shapes -- camelCase for the wire, snake_case in SQLite.
// ---------------------------------------------------------------------------

export interface FileRow {
  id: number;
  relPath: string;
  songFolder: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;
  parseOk: boolean;
  assetVersionId: number | null;
  /**
   * The asset this file belongs to, so a file row can open the version ladder
   * without a second lookup. NULL exactly when `parseOk` is false -- an
   * unparsed file has no asset-version and therefore no asset.
   */
  assetId: number | null;
}

export interface FileDbRow {
  id: number;
  rel_path: string;
  song_folder: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;
  parse_ok: number;
  asset_version_id: number | null;
  asset_id: number | null;
}

export function toFileRow(r: FileDbRow): FileRow {
  return {
    id: r.id,
    relPath: r.rel_path,
    songFolder: r.song_folder,
    name: r.name,
    ext: r.ext,
    size: r.size,
    mtime: r.mtime,
    parseOk: r.parse_ok === 1,
    assetVersionId: r.asset_version_id,
    assetId: r.asset_id,
  };
}

export interface VersionDbRow {
  version_id: number;
  asset_id: number;
  snapshot_id: number;
  song_folder: string;
  base: string;
  family: string;
  ver_num: number;
  sub_letter: string | null;
  ver_label: string;
  is_patch: number;
  patch_frame: number | null;
  bytes: number;
  file_count: number;
  proxy_bytes: number;
  region_count: number;
  latest_mtime: number;
}

export interface VersionRow {
  versionId: number;
  assetId: number;
  songFolder: string;
  base: string;
  family: string;
  verNum: number;
  subLetter: string | null;
  verLabel: string;
  isPatch: boolean;
  patchFrame: number | null;
  bytes: number;
  fileCount: number;
  proxyBytes: number;
  regionCount: number;
  latestMtime: number;
  status: 'kept' | 'superseded' | 'unknown';
  keepReason: KeepReason | null;
}

export function toVersionRow(
  r: VersionDbRow,
  verdict: { keep: boolean; reason: KeepReason } | undefined,
): VersionRow {
  return {
    versionId: r.version_id,
    assetId: r.asset_id,
    songFolder: r.song_folder,
    base: r.base,
    family: r.family,
    verNum: r.ver_num,
    subLetter: r.sub_letter,
    verLabel: r.ver_label,
    isPatch: r.is_patch === 1,
    patchFrame: r.patch_frame,
    bytes: r.bytes,
    fileCount: r.file_count,
    proxyBytes: r.proxy_bytes,
    regionCount: r.region_count,
    latestMtime: r.latest_mtime,
    status: verdict === undefined ? 'unknown' : verdict.keep ? 'kept' : 'superseded',
    keepReason: verdict?.reason ?? null,
  };
}

/** Accessor used when a version list has to be sorted in JS. */
export function versionSortValue(row: VersionRow, key: string): unknown {
  return (row as unknown as Record<string, unknown>)[key];
}

/**
 * SQLite access layer (better-sqlite3).
 *
 * The database lives inside the PROJECT (`data/index.db`), never in the
 * archive. Nothing in this module touches the archive at all.
 *
 * Everything here is synchronous by design: better-sqlite3 is synchronous, and
 * the write path is a single transaction of ~30k inserts that completes in
 * well under a second.
 */

import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { SCHEMA_SQL, VIEWS_SQL, SCHEMA_VERSION } from './schema.ts';
import type { FileRecord } from '../scan/walk.ts';
import type { DerivedAsset } from '../scan/derive.ts';
import type { ReclaimAssetInput } from '../scan/reclaim.ts';

export interface SnapshotRow {
  id: number;
  root: string;
  started_at: number;
  finished_at: number | null;
  file_count: number;
  total_bytes: number;
  status: string;
  name: string | null;
  elapsed_ms: number | null;
  dir_count: number | null;
  excluded_count: number;
  excluded_bytes: number;
  unparsed_count: number;
  skipped_json: string | null;
}

/** Open (creating if needed) the index database and ensure the schema exists. */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec(VIEWS_SQL);
  db.prepare(
    `INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
  return db;
}

/** Open a new snapshot row in 'running' state and return its id. */
export function beginSnapshot(db: Db, root: string, name: string, startedAt = Date.now()): number {
  const info = db
    .prepare(
      `INSERT INTO snapshot (root, started_at, status, name) VALUES (?, ?, 'running', ?)`,
    )
    .run(root, startedAt, name);
  return Number(info.lastInsertRowid);
}

export interface FinishSnapshotArgs {
  fileCount: number;
  totalBytes: number;
  elapsedMs: number;
  dirCount: number;
  excludedCount: number;
  excludedBytes: number;
  unparsedCount: number;
  skipped: { path: string; reason: string }[];
  status?: 'complete' | 'failed';
  finishedAt?: number;
}

export function finishSnapshot(db: Db, snapshotId: number, a: FinishSnapshotArgs): void {
  db.prepare(
    `UPDATE snapshot SET
       finished_at = ?, file_count = ?, total_bytes = ?, status = ?,
       elapsed_ms = ?, dir_count = ?, excluded_count = ?, excluded_bytes = ?,
       unparsed_count = ?, skipped_json = ?
     WHERE id = ?`,
  ).run(
    a.finishedAt ?? Date.now(),
    a.fileCount,
    a.totalBytes,
    a.status ?? 'complete',
    a.elapsedMs,
    a.dirCount,
    a.excludedCount,
    a.excludedBytes,
    a.unparsedCount,
    JSON.stringify(a.skipped),
    snapshotId,
  );
}

/**
 * Human-readable version label: `v008`, `v008d`, `v004 frame00000` for a patch.
 */
function verLabel(v: {
  verNum: number;
  subLetter: string | null;
  isPatch: boolean;
  patchFrame: number | null;
}): string {
  const n = `v${String(v.verNum).padStart(3, '0')}${v.subLetter ?? ''}`;
  return v.isPatch ? `${n} frame${String(v.patchFrame ?? 0).padStart(5, '0')}` : n;
}

/**
 * Write files, assets and asset-versions for a snapshot in one transaction.
 *
 * `files` and `assets` must come from the same walk: `DerivedVersion.fileIndexes`
 * indexes into `files`, and that is how `file.asset_version_id` is populated.
 */
export function writeSnapshotData(
  db: Db,
  snapshotId: number,
  files: readonly FileRecord[],
  assets: readonly DerivedAsset[],
  unparsedIndexes: readonly number[],
): void {
  const insertFile = db.prepare(
    `INSERT INTO file (snapshot_id, rel_path, song_folder, name, ext, size, mtime, parse_ok)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAsset = db.prepare(
    `INSERT INTO asset (snapshot_id, song_folder, base, family) VALUES (?, ?, ?, ?)`,
  );
  const insertVersion = db.prepare(
    `INSERT INTO asset_version
       (asset_id, ver_num, sub_letter, is_patch, patch_frame, bytes, file_count,
        proxy_bytes, region_count, latest_mtime, ver_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const linkFile = db.prepare(`UPDATE file SET asset_version_id = ? WHERE id = ?`);

  const unparsed = new Set(unparsedIndexes);

  db.transaction(() => {
    // 1. Files, remembering each row id by its index in `files`.
    const fileIds = new Array<number>(files.length);
    for (let i = 0; i < files.length; i++) {
      const f = files[i] as FileRecord;
      const info = insertFile.run(
        snapshotId,
        f.relPath,
        f.songFolder,
        f.name,
        f.ext,
        f.size,
        Math.round(f.mtime),
        unparsed.has(i) ? 0 : 1,
      );
      fileIds[i] = Number(info.lastInsertRowid);
    }

    // 2. Assets and versions, linking each file back to its version.
    for (const asset of assets) {
      const assetId = Number(
        insertAsset.run(snapshotId, asset.songFolder, asset.base, asset.family).lastInsertRowid,
      );
      for (const v of asset.versions) {
        const versionId = Number(
          insertVersion.run(
            assetId,
            v.verNum,
            v.subLetter,
            v.isPatch ? 1 : 0,
            v.patchFrame,
            v.bytes,
            v.fileCount,
            v.proxyBytes,
            v.regionCount,
            Math.round(v.latestMtime),
            verLabel(v),
          ).lastInsertRowid,
        );
        for (const idx of v.fileIndexes) {
          linkFile.run(versionId, fileIds[idx] as number);
        }
      }
    }
  })();
}

/**
 * Load a snapshot's assets and versions in the shape `computeReclaim` expects.
 * This is what the API layer should call to answer a "keep latest N" request.
 */
export function loadReclaimInput(db: Db, snapshotId: number): ReclaimAssetInput[] {
  const rows = db
    .prepare(
      `SELECT a.id AS asset_id, a.song_folder, a.base,
              av.id AS version_id, av.ver_num, av.sub_letter, av.is_patch,
              av.patch_frame, av.bytes, av.proxy_bytes, av.file_count,
              av.region_count
       FROM asset a
       JOIN asset_version av ON av.asset_id = a.id
       WHERE a.snapshot_id = ?
       ORDER BY a.id, av.ver_num, av.sub_letter, av.is_patch, av.patch_frame`,
    )
    .all(snapshotId) as {
    asset_id: number;
    song_folder: string;
    base: string;
    version_id: number;
    ver_num: number;
    sub_letter: string | null;
    is_patch: number;
    patch_frame: number | null;
    bytes: number;
    proxy_bytes: number;
    file_count: number;
    region_count: number;
  }[];

  const byAsset = new Map<number, ReclaimAssetInput>();
  for (const r of rows) {
    let a = byAsset.get(r.asset_id);
    if (!a) {
      a = { id: r.asset_id, songFolder: r.song_folder, base: r.base, versions: [] };
      byAsset.set(r.asset_id, a);
    }
    a.versions.push({
      id: r.version_id,
      verNum: r.ver_num,
      subLetter: r.sub_letter,
      isPatch: r.is_patch === 1,
      patchFrame: r.patch_frame,
      bytes: r.bytes,
      proxyBytes: r.proxy_bytes,
      fileCount: r.file_count,
      // Required by THE PROXY-ONLY RULE: without it a preview could supersede
      // a master. See src/scan/reclaim.ts.
      regionCount: r.region_count,
    });
  }
  return [...byAsset.values()];
}

export function getSnapshot(db: Db, snapshotId: number): SnapshotRow | undefined {
  return db.prepare(`SELECT * FROM snapshot WHERE id = ?`).get(snapshotId) as
    | SnapshotRow
    | undefined;
}

/** Most recent completed snapshot, or undefined if there is none. */
export function latestSnapshot(db: Db, root?: string): SnapshotRow | undefined {
  const sql = root
    ? `SELECT * FROM snapshot WHERE status = 'complete' AND root = ? ORDER BY id DESC LIMIT 1`
    : `SELECT * FROM snapshot WHERE status = 'complete' ORDER BY id DESC LIMIT 1`;
  const stmt = db.prepare(sql);
  return (root ? stmt.get(root) : stmt.get()) as SnapshotRow | undefined;
}

export function listSnapshots(db: Db): SnapshotRow[] {
  return db.prepare(`SELECT * FROM snapshot ORDER BY id DESC`).all() as SnapshotRow[];
}

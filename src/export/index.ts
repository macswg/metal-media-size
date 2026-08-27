/**
 * =============================================================================
 *  EXPORT LAYER  --  PUBLIC ENTRY POINT
 * =============================================================================
 *
 * `writeExport` is what `POST /api/export` calls. It is the only function in
 * this codebase that produces a file, and everything it produces lands inside
 * the project's `exports/` directory, behind the jail in `writer.ts`.
 *
 * PIPELINE
 *   1. Validate the request. `Permanent` and a missing versioning folder are
 *      hard failures, before any query runs.
 *   2. Load the selected asset-versions and, via `file.asset_version_id`, the
 *      literal files each one covers. The grammar is NOT re-derived here: the
 *      scanner already recorded which file belongs to which version, and
 *      re-deriving it would be a second, divergent source of truth.
 *   3. Run `computeReclaim` over the WHOLE snapshot so every verdict and
 *      `keepReason` in the export is the same verdict the UI showed.
 *   4. Chunk by song folder.
 *   5. Render, then write.
 *
 * ONE PATH LIST, RENDERED THREE TIMES. `ExportChunk.includes` / `.relPaths` are
 * built once, in `buildChunks`. The `.ffs_gui` filter, the `.paths.txt`
 * manifest, the JSON manifest and the Markdown all render those same arrays.
 * A silent divergence between what the human approves and what FreeFileSync
 * acts on is therefore not merely unlikely, it is unrepresentable.
 *
 * VERSION LABELS ARE NEVER COMPOSED HERE. `ver_label` comes out of the database
 * verbatim, so a `v002d` is displayed as `v002d`. `v002` and `v002d` are
 * DIFFERENT versions; composing a label from `ver_num` alone would show two
 * distinct versions under one name, and the human would approve one thing while
 * FreeFileSync acted on another.
 * =============================================================================
 */

import type { Database as Db } from 'better-sqlite3';
import { join } from 'node:path';

import { openDb, getSnapshot, loadReclaimInput } from '../db/index.ts';
import { computeReclaim, type KeepReason } from '../scan/reclaim.ts';
import { compareVersions } from '../scan/derive.ts';

import {
  DEFAULT_EXPORTS_DIR,
  PROJECT_ROOT,
  assertDirectoryEmpty,
  ensureExportDir,
  exportPathExists,
  writeExportText,
} from './writer.ts';
import {
  assertDeletionPolicy,
  buildChunkManifest,
  buildRemovalGui,
  type RemovalGuiOptions,
} from './ffs.ts';
import { renderJsonExport } from './json.ts';
import { renderMarkdown } from './markdown.ts';
import type {
  DeletionPolicy,
  ExportArtifact,
  JobLayout,
  ExportAssetLadder,
  ExportChunk,
  ExportDataset,
  ExportFileRow,
  ExportFormat,
  ExportResult,
  ExportSongRollup,
  ExportVersionRow,
} from './types.ts';

export * from './types.ts';
export {
  ExportJailError,
  assertDirectoryEmpty,
  assertExportPath,
  assertResolvedPathAllowed,
  DEFAULT_EXPORTS_DIR,
  DEFAULT_FORBIDDEN_ROOTS,
} from './writer.ts';
export {
  ALLOWED_DELETION_POLICIES,
  assertDeletionPolicy,
  assertFilterSafePath,
  buildChunkManifest,
  buildRemovalGui,
  escapeXmlAttr,
  escapeXmlText,
  MACOS_EXCLUDES,
  REMOVAL_CHANGES,
  renderFfsGui,
  unescapeXml,
} from './ffs.ts';
export { buildJsonExport, renderJsonExport } from './json.ts';
export { renderMarkdown, formatBytes } from './markdown.ts';

export const ALL_FORMATS: readonly ExportFormat[] = Object.freeze([
  'json',
  'markdown',
  'ffs_gui',
]);

/** Default keep-latest-N used when the caller does not say. */
export const DEFAULT_KEEP_N = 3;

/**
 * Include patterns per `.ffs_gui`. A song is split across several jobs only if
 * it alone exceeds this; a single asset-version is never split.
 */
export const DEFAULT_MAX_PATHS_PER_CHUNK = 750;

/**
 * One job for the whole run unless the caller asks otherwise.
 *
 * The per-song layout came first and is the more defensive of the two -- each
 * pair points inside one song, so a job cannot reach the rest of the archive
 * even in principle. It also produced sixty-odd files to open one at a time,
 * which is its own kind of risk: a human working through 65 near-identical
 * jobs is a human who stops reading them.
 */
export const DEFAULT_JOB_LAYOUT: JobLayout = 'single';

/**
 * Where the emitted job points its right-hand folder.
 *
 *   null / '' / omitted  -- LEAVE IT BLANK. The default. The operator sets the
 *                           folder in FreeFileSync, because the machine that
 *                           runs the job reaches the delivery folder by a
 *                           different path than the machine that scanned it.
 *   a path               -- that folder, with the song folder appended under
 *                           'per-song'. Pass the scan root to reproduce the
 *                           old behaviour; there is no separate "as scanned"
 *                           value, because one meaning per value is what stops
 *                           a caller getting a blank job it did not ask for.
 *
 * Blank works only because the include patterns are anchored and RELATIVE:
 * they bind to whatever folder is chosen. That is also the risk, and the job's
 * banner says so — the chosen folder has to be the delivery folder itself.
 */
export type RightFolderChoice = string | null;

/** Resolve the `<Right>` value for one chunk. */
export function resolveRightFolder(choice: RightFolderChoice, basePrefix: string): string {
  if (!choice) return '';
  const base = choice.replace(/\/+$/, '');
  // Under 'per-song' the pair points inside the song, so an operator-supplied
  // root gets the same song folder appended that the scan root would have.
  return basePrefix === '' ? base : `${base}/${basePrefix.replace(/\/$/, '')}`;
}

export interface WriteExportOptions {
  /** Asset-version ids to propose for removal. Required, non-empty. */
  versionIds: readonly number[];
  /** Which artefacts to produce. Required, non-empty. */
  formats: readonly ExportFormat[];
  /** Required. `'Permanent'` is not representable and is rejected at run time. */
  deletionPolicy: DeletionPolicy;
  /** Required when `deletionPolicy` is `'Versioning'`. Absolute path. */
  versioningFolder?: string | null;
  /** Free text from the operator, reproduced in every artefact. */
  note?: string | null;

  /**
   * Keep-latest-N the verdicts are computed under. Additive to the API
   * contract: without it the export cannot state WHY a version is superseded.
   */
  keepN?: number;

  /** An open database handle. Preferred; the API layer already has one. */
  db?: Db;
  /** Used only when `db` is absent. Defaults to `<project>/data/index.db`. */
  dbPath?: string;

  /** Override the export directory. Tests only; still fully jailed. */
  exportsDir?: string;
  /** Extra never-writable roots, e.g. the configured scan roots. */
  forbiddenRoots?: readonly string[];
  /** Injected clock, for deterministic tests. */
  now?: Date;
  /** Override the run id (and therefore the directory name). Tests only. */
  runId?: string;
  maxPathsPerChunk?: number;
  /**
   * `'single'` (default) emits ONE `.ffs_gui` for everything; `'per-song'`
   * emits one per song folder. See `JobLayout`.
   */
  jobLayout?: JobLayout;
  /**
   * What to put in the job's `<Right>` folder. `null` (the default) leaves it
   * BLANK for the operator to set in FreeFileSync. See `RightFolderChoice`.
   */
  rightFolder?: RightFolderChoice;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface VersionQueryRow {
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

interface FileQueryRow {
  id: number;
  rel_path: string;
  song_folder: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;
  asset_version_id: number;
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}

function toVersionRow(
  r: VersionQueryRow,
  verdict: { keep: boolean; reason: KeepReason } | undefined,
  selected: boolean,
  files: ExportFileRow[],
): ExportVersionRow {
  return {
    versionId: r.version_id,
    assetId: r.asset_id,
    songFolder: r.song_folder,
    base: r.base,
    family: r.family,
    verNum: r.ver_num,
    subLetter: r.sub_letter,
    // Verbatim from the database. Never composed from ver_num.
    verLabel: r.ver_label,
    isPatch: r.is_patch === 1,
    patchFrame: r.patch_frame,
    bytes: r.bytes,
    fileCount: r.file_count,
    proxyBytes: r.proxy_bytes,
    regionCount: r.region_count,
    latestMtime: r.latest_mtime,
    status: verdict ? (verdict.keep ? 'kept' : 'superseded') : 'kept',
    keepReason: verdict?.reason ?? 'kept-no-full-versions',
    selected,
    files,
  };
}

/** Oldest first: version identity, then full before its patches, then frame. */
function ladderOrder(a: ExportVersionRow, b: ExportVersionRow): number {
  const v = compareVersions(a, b);
  if (v !== 0) return v;
  if (a.isPatch !== b.isPatch) return a.isPatch ? 1 : -1;
  return (a.patchFrame ?? 0) - (b.patchFrame ?? 0);
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function safeName(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length ? cleaned.slice(0, 60) : 'root';
}

/**
 * The whole removal set as one job, with the folder pair at the scan root.
 *
 * The include patterns are root-relative and anchored (`/SONG/name.mov`) --
 * the same leading-slash form the verified config uses for a root-relative
 * filter item, and the same form the per-song layout uses against its own
 * base. Sorted, so the file reads in archive order and two runs over the same
 * selection produce the same bytes.
 */
function buildSingleChunk(
  selected: readonly ExportVersionRow[],
  root: string,
  rightFolder: RightFolderChoice,
): ExportChunk {
  const ordered = selected
    .slice()
    .sort((a, b) =>
      a.songFolder < b.songFolder
        ? -1
        : a.songFolder > b.songFolder
          ? 1
          : a.base < b.base
            ? -1
            : a.base > b.base
              ? 1
              : ladderOrder(a, b),
    );
  const relPaths: string[] = [];
  let bytes = 0;
  for (const v of ordered) {
    bytes += v.bytes;
    for (const f of v.files) relPaths.push(f.relPath);
  }
  relPaths.sort();
  const songFolders = [...new Set(ordered.map((v) => v.songFolder))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return {
    index: 1,
    songFolders,
    baseFolder: root,
    pairRightFolder: resolveRightFolder(rightFolder, ''),
    basePrefix: '',
    includes: relPaths.map((p) => `/${p}`),
    relPaths,
    versionIds: ordered.map((v) => v.versionId),
    bytes,
    fileCount: relPaths.length,
    guiFileName: 'removal-all.ffs_gui',
    manifestFileName: 'removal-all.paths.txt',
  };
}

/**
 * Group the selected versions into `.ffs_gui`-sized chunks.
 *
 * UNDER `'per-song'`: ONE SONG FOLDER PER CHUNK. That is what makes the folder
 * pair point at the song folder rather than at the archive root, so a job
 * cannot see — let alone act on — anything outside its own song. A song large
 * enough to exceed `maxPaths` is split into several jobs over the SAME folder,
 * always on an asset-version boundary, so a version is never half-listed.
 *
 * UNDER `'single'`: one chunk for everything, the pair at the scan root, and
 * `maxPaths` does not apply — splitting is the thing the caller asked not to
 * happen. The include list is longer and the paths carry their song folder,
 * but they are the SAME paths, built the same way, and the manifest beside the
 * job still lists every one of them literally.
 */
export function buildChunks(
  selected: readonly ExportVersionRow[],
  root: string,
  maxPaths: number,
  layout: JobLayout = DEFAULT_JOB_LAYOUT,
  rightFolder: RightFolderChoice = null,
): ExportChunk[] {
  if (layout === 'single') return [buildSingleChunk(selected, root, rightFolder)];
  const bySong = new Map<string, ExportVersionRow[]>();
  for (const v of selected) {
    const list = bySong.get(v.songFolder);
    if (list) list.push(v);
    else bySong.set(v.songFolder, [v]);
  }

  const chunks: ExportChunk[] = [];
  const songs = [...bySong.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const song of songs) {
    const versions = (bySong.get(song) as ExportVersionRow[])
      .slice()
      .sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : ladderOrder(a, b)));

    // The folder pair points at the song folder when there is one; at the scan
    // root only for files that live directly at the root.
    const baseFolder = song ? `${root}/${song}` : root;
    const basePrefix = song ? `${song}/` : '';

    const parts: ExportVersionRow[][] = [];
    let current: ExportVersionRow[] = [];
    let currentPaths = 0;
    for (const v of versions) {
      if (current.length && currentPaths + v.files.length > maxPaths) {
        parts.push(current);
        current = [];
        currentPaths = 0;
      }
      current.push(v);
      currentPaths += v.files.length;
    }
    if (current.length) parts.push(current);

    parts.forEach((part, i) => {
      const relPaths: string[] = [];
      let bytes = 0;
      for (const v of part) {
        bytes += v.bytes;
        for (const f of v.files) relPaths.push(f.relPath);
      }
      relPaths.sort();

      const index = chunks.length + 1;
      const suffix = parts.length > 1 ? `-p${i + 1}` : '';
      const stem = `removal-${String(index).padStart(2, '0')}-${safeName(song)}${suffix}`;
      chunks.push({
        index,
        songFolders: [song],
        baseFolder,
        pairRightFolder: resolveRightFolder(rightFolder, basePrefix),
        basePrefix,
        // Anchored, base-relative, forward slashes: the form the verified
        // config uses for a root-relative filter item.
        includes: relPaths.map((p) => `/${p.slice(basePrefix.length)}`),
        relPaths,
        versionIds: part.map((v) => v.versionId),
        bytes,
        fileCount: relPaths.length,
        guiFileName: `${stem}.ffs_gui`,
        manifestFileName: `${stem}.paths.txt`,
      });
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Dataset assembly
// ---------------------------------------------------------------------------

function isoStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build everything the renderers need. Exported so a caller (or a test) can
 * inspect exactly what would be written without writing anything.
 */
export function buildDataset(db: Db, opts: WriteExportOptions): ExportDataset {
  const policy = assertDeletionPolicy(opts.deletionPolicy);
  const versionIds = [...new Set(opts.versionIds ?? [])];
  if (versionIds.length === 0) {
    throw new Error('versionIds is required and must contain at least one asset-version id.');
  }
  for (const id of versionIds) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`Invalid version id ${JSON.stringify(id)}: expected a positive integer.`);
    }
  }
  const versioningFolder = opts.versioningFolder?.trim() || null;
  if (policy === 'Versioning' && !versioningFolder) {
    throw new Error(
      "deletionPolicy 'Versioning' requires versioningFolder: FreeFileSync needs somewhere " +
        'to move the files to, and without it the removal would not be reversible.',
    );
  }
  if (versioningFolder && !versioningFolder.startsWith('/')) {
    throw new Error(
      `versioningFolder must be an absolute path, got ${JSON.stringify(versioningFolder)}.`,
    );
  }
  const keepN = opts.keepN ?? DEFAULT_KEEP_N;
  if (!Number.isInteger(keepN) || keepN < 1) {
    throw new Error(`keepN must be an integer >= 1, got ${keepN}`);
  }

  // --- selected versions -----------------------------------------------
  const selectedRows = db
    .prepare(
      `SELECT * FROM v_asset_version WHERE version_id IN (${placeholders(versionIds.length)})`,
    )
    .all(...versionIds) as VersionQueryRow[];

  if (selectedRows.length !== versionIds.length) {
    const found = new Set(selectedRows.map((r) => r.version_id));
    const missing = versionIds.filter((id) => !found.has(id));
    throw new Error(
      `Unknown asset-version id(s): ${missing.join(', ')}. Refusing to export a partial ` +
        'selection — the request does not describe the data that is actually there.',
    );
  }

  const snapshotIds = [...new Set(selectedRows.map((r) => r.snapshot_id))];
  if (snapshotIds.length !== 1) {
    throw new Error(
      `Selected versions span ${snapshotIds.length} snapshots (${snapshotIds.join(', ')}). ` +
        'An export must describe one snapshot, or its paths and byte totals mean nothing.',
    );
  }
  const snapshotId = snapshotIds[0] as number;
  const snap = getSnapshot(db, snapshotId);
  if (!snap) throw new Error(`Snapshot ${snapshotId} not found.`);

  // --- verdicts, from the same function the UI uses ---------------------
  const reclaim = computeReclaim(loadReclaimInput(db, snapshotId), keepN);
  const verdictById = new Map(reclaim.verdicts.map((v) => [v.versionId, v]));

  // --- literal files ----------------------------------------------------
  const fileRows = db
    .prepare(
      `SELECT id, rel_path, song_folder, name, ext, size, mtime, asset_version_id
         FROM file
        WHERE asset_version_id IN (${placeholders(versionIds.length)})
        ORDER BY rel_path`,
    )
    .all(...versionIds) as FileQueryRow[];

  const filesByVersion = new Map<number, ExportFileRow[]>();
  for (const f of fileRows) {
    const row: ExportFileRow = {
      fileId: f.id,
      relPath: f.rel_path,
      songFolder: f.song_folder,
      name: f.name,
      ext: f.ext,
      size: f.size,
      mtime: f.mtime,
    };
    const list = filesByVersion.get(f.asset_version_id);
    if (list) list.push(row);
    else filesByVersion.set(f.asset_version_id, [row]);
  }

  const selected: ExportVersionRow[] = selectedRows.map((r) =>
    toVersionRow(r, verdictById.get(r.version_id), true, filesByVersion.get(r.version_id) ?? []),
  );

  // A version with no files would produce an empty include list, which
  // FreeFileSync reads as "everything". Refuse before it can be rendered.
  const empty = selected.filter((v) => v.files.length === 0);
  if (empty.length) {
    throw new Error(
      `Asset-version(s) ${empty
        .map((v) => `${v.versionId} (${v.songFolder}/${v.base} ${v.verLabel})`)
        .join(', ')} resolve to no files. Refusing to export: an empty FreeFileSync ` +
        'include filter matches everything.',
    );
  }
  for (const v of selected) {
    if (v.files.length !== v.fileCount) {
      throw new Error(
        `Asset-version ${v.versionId} (${v.songFolder}/${v.base} ${v.verLabel}) says it has ` +
          `${v.fileCount} file(s) but ${v.files.length} were found. The index is inconsistent; ` +
          'refusing to build a removal list from it.',
      );
    }
  }

  // --- full ladders for context ----------------------------------------
  const assetIds = [...new Set(selected.map((v) => v.assetId))];
  const ladderRows = db
    .prepare(`SELECT * FROM v_asset_version WHERE asset_id IN (${placeholders(assetIds.length)})`)
    .all(...assetIds) as VersionQueryRow[];

  const selectedIds = new Set(versionIds);
  const laddersByAsset = new Map<number, ExportAssetLadder>();
  for (const r of ladderRows) {
    const isSel = selectedIds.has(r.version_id);
    const row = toVersionRow(
      r,
      verdictById.get(r.version_id),
      isSel,
      isSel ? (filesByVersion.get(r.version_id) ?? []) : [],
    );
    let l = laddersByAsset.get(r.asset_id);
    if (!l) {
      l = {
        assetId: r.asset_id,
        songFolder: r.song_folder,
        base: r.base,
        family: r.family,
        versions: [],
        selectedVersionIds: [],
        selectedBytes: 0,
        selectedFileCount: 0,
      };
      laddersByAsset.set(r.asset_id, l);
    }
    l.versions.push(row);
    if (isSel) {
      l.selectedVersionIds.push(row.versionId);
      l.selectedBytes += row.bytes;
      l.selectedFileCount += row.fileCount;
    }
  }
  const ladders = [...laddersByAsset.values()].sort(
    (a, b) =>
      (a.songFolder < b.songFolder ? -1 : a.songFolder > b.songFolder ? 1 : 0) ||
      (a.base < b.base ? -1 : a.base > b.base ? 1 : 0),
  );
  for (const l of ladders) l.versions.sort(ladderOrder);

  selected.sort(
    (a, b) =>
      (a.songFolder < b.songFolder ? -1 : a.songFolder > b.songFolder ? 1 : 0) ||
      (a.base < b.base ? -1 : a.base > b.base ? 1 : 0) ||
      ladderOrder(a, b),
  );

  // --- rollups ----------------------------------------------------------
  const songMap = new Map<string, ExportSongRollup>();
  for (const v of selected) {
    let s = songMap.get(v.songFolder);
    if (!s) {
      s = {
        songFolder: v.songFolder,
        versionCount: 0,
        fileCount: 0,
        bytes: 0,
        proxyBytes: 0,
        latestMtime: 0,
      };
      songMap.set(v.songFolder, s);
    }
    s.versionCount += 1;
    s.fileCount += v.files.length;
    s.bytes += v.bytes;
    s.proxyBytes += v.proxyBytes;
    s.latestMtime = Math.max(s.latestMtime, v.latestMtime);
  }
  const bySong = [...songMap.values()].sort((a, b) => b.bytes - a.bytes);

  const totalBytes = selected.reduce((n, v) => n + v.bytes, 0);
  const proxyBytes = selected.reduce((n, v) => n + v.proxyBytes, 0);
  const fileCount = selected.reduce((n, v) => n + v.files.length, 0);

  const chunks = buildChunks(
    selected,
    snap.root,
    opts.maxPathsPerChunk ?? DEFAULT_MAX_PATHS_PER_CHUNK,
    opts.jobLayout ?? DEFAULT_JOB_LAYOUT,
    opts.rightFolder ?? null,
  );

  // Cross-check: the chunking must account for every path exactly once.
  const chunkPaths = chunks.flatMap((c) => c.relPaths);
  if (chunkPaths.length !== fileCount) {
    throw new Error(
      `Chunking lost or duplicated paths: ${fileCount} selected file(s) became ` +
        `${chunkPaths.length} chunked path(s). Refusing to write.`,
    );
  }
  if (new Set(chunkPaths).size !== chunkPaths.length) {
    throw new Error('The removal list contains duplicate paths. Refusing to write.');
  }

  // --- warnings ---------------------------------------------------------
  const warnings: string[] = [];
  const keptSelected = selected.filter((v) => v.status === 'kept');
  if (keptSelected.length) {
    warnings.push(
      `**${keptSelected.length} selected version(s) are marked KEPT at keep-${keepN}**, so the ` +
        'policy does not consider them superseded: ' +
        keptSelected
          .slice(0, 12)
          .map((v) => `\`${v.songFolder}/${v.base} ${v.verLabel}\` (${v.keepReason})`)
          .join(', ') +
        (keptSelected.length > 12 ? ', …' : '') +
        '. Removing them is a deliberate override — confirm it is what you meant.',
    );
  }
  for (const l of ladders) {
    if (l.selectedVersionIds.length === l.versions.length) {
      warnings.push(
        `**Every version of \`${l.songFolder}/${l.base}\` is in this export.** The asset would ` +
          'be left with nothing on the archive.',
      );
    }
  }
  if (policy === 'RecycleBin') {
    warnings.push(
      'Deletion policy is `RecycleBin`. `Versioning` is the safer choice: it moves files into ' +
        'a dated folder you control, rather than relying on the volume having a working trash.',
    );
  }
  if (versioningFolder && versioningFolder.startsWith(snap.root)) {
    warnings.push(
      `The versioning folder \`${versioningFolder}\` is inside the scan root. A later scan ` +
        'will count those files again, and the archive mount is read-only. Put it elsewhere.',
    );
  }
  if (snap.status !== 'complete') {
    warnings.push(
      `Snapshot #${snap.id} has status \`${snap.status}\`, not \`complete\`. Its totals may be ` +
        'partial.',
    );
  }
  if (snap.unparsed_count > 0) {
    warnings.push(
      `${snap.unparsed_count} file(s) in this snapshot did not match the filename grammar and ` +
        'belong to no version. They are never part of an export, but they are also not ' +
        'accounted for in the reclaim total.',
    );
  }

  const now = opts.now ?? new Date();
  return {
    runId: opts.runId ?? isoStamp(now),
    generatedAt: now.toISOString(),
    snapshot: {
      snapshotId: snap.id,
      root: snap.root,
      name: snap.name,
      startedAt: snap.started_at,
      finishedAt: snap.finished_at,
      status: snap.status,
      fileCount: snap.file_count,
      totalBytes: snap.total_bytes,
      excludedCount: snap.excluded_count,
      excludedBytes: snap.excluded_bytes,
      unparsedCount: snap.unparsed_count,
    },
    keepN,
    deletionPolicy: policy,
    versioningFolder,
    note: opts.note?.trim() || null,
    selected,
    ladders,
    chunks,
    bySong,
    totals: {
      versionCount: selected.length,
      fileCount,
      totalBytes,
      proxyBytes,
      assetCount: ladders.length,
      songCount: bySong.length,
      chunkCount: chunks.length,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Produce the export artefacts. The ONLY function in this codebase that puts
 * bytes on disk, and every one of them lands under `exports/`.
 */
export async function writeExport(opts: WriteExportOptions): Promise<ExportResult> {
  const formats = [...new Set(opts.formats ?? [])];
  if (formats.length === 0) {
    throw new Error(`formats is required. Expected one or more of: ${ALL_FORMATS.join(', ')}.`);
  }
  for (const f of formats) {
    if (!ALL_FORMATS.includes(f)) {
      throw new Error(
        `Unknown export format ${JSON.stringify(f)}. Expected one or more of: ` +
          `${ALL_FORMATS.join(', ')}. Note that .ffs_batch is deliberately not offered.`,
      );
    }
  }

  const ownDb = !opts.db;
  const db = opts.db ?? openDb(opts.dbPath ?? join(PROJECT_ROOT, 'data', 'index.db'));
  let dataset: ExportDataset;
  try {
    dataset = buildDataset(db, opts);
  } finally {
    if (ownDb) db.close();
  }

  const jail = {
    exportsDir: opts.exportsDir ?? DEFAULT_EXPORTS_DIR,
    // The scan root always joins the never-writable set, on top of the
    // hard-coded mount and application-support roots in writer.ts.
    forbiddenRoots: [dataset.snapshot.root, ...(opts.forbiddenRoots ?? [])],
  };

  // A fresh directory per run: an export can never overwrite an earlier one.
  let dirName = `export-${dataset.runId}`;
  let n = 2;
  while (await exportPathExists(join(jail.exportsDir, dirName))) {
    dirName = `export-${dataset.runId}-${n++}`;
    if (n > 100) throw new Error('Could not find a free export directory name.');
  }
  const exportDir = await ensureExportDir(join(jail.exportsDir, dirName), jail);

  const artifacts: ExportArtifact[] = [];

  if (formats.includes('ffs_gui')) {
    // THE LEFT-HAND SIDE OF EVERY FOLDER PAIR.
    //
    // It is a real directory, created here inside the fresh run directory, and
    // nothing is ever put in it. Its emptiness is not incidental: with
    // Delete="right", the removal set is exactly "what the right has that the
    // left does not", so an empty left plus the include filter IS the job.
    //
    // A left side that does not exist on disk is the dangerous case, so it is
    // created rather than merely named, and then proved empty immediately
    // before the jobs are written. If FreeFileSync is later pointed at a
    // missing left folder it reports an error and, because we emit
    // <Errors Ignore="false"/>, stops instead of pushing on.
    const emptyLeft = await ensureExportDir(join(exportDir, '_empty_left'), jail);
    await assertDirectoryEmpty(emptyLeft, jail);
    const guiOpts: RemovalGuiOptions = {
      emptyLeftFolder: emptyLeft,
      deletionPolicy: dataset.deletionPolicy,
      versioningFolder: dataset.versioningFolder,
      manifestFileName: '',
      chunkCount: dataset.chunks.length,
      runId: dataset.runId,
      generatedAt: dataset.generatedAt,
      note: dataset.note,
    };
    for (const chunk of dataset.chunks) {
      const o = { ...guiOpts, manifestFileName: chunk.manifestFileName };
      const gui = await writeExportText(
        join(exportDir, chunk.guiFileName),
        buildRemovalGui(chunk, o),
        jail,
      );
      artifacts.push({ format: 'ffs_gui', ...gui });
      // The companion manifest ships with EVERY job, whatever `formats` says:
      // the human reviews a concrete path list, never the filter patterns.
      const man = await writeExportText(
        join(exportDir, chunk.manifestFileName),
        buildChunkManifest(chunk, dataset.snapshot.root, o),
        jail,
      );
      artifacts.push({ format: 'ffs_manifest', ...man });
    }
  }

  if (formats.includes('json')) {
    const f = await writeExportText(
      join(exportDir, 'manifest.json'),
      renderJsonExport(dataset),
      jail,
    );
    artifacts.push({ format: 'json', ...f });
  }

  if (formats.includes('markdown')) {
    const f = await writeExportText(join(exportDir, 'review.md'), renderMarkdown(dataset), jail);
    artifacts.push({ format: 'markdown', ...f });
  }

  return {
    files: artifacts,
    summary: {
      fileCount: dataset.totals.fileCount,
      totalBytes: dataset.totals.totalBytes,
      versionCount: dataset.totals.versionCount,
      assetCount: dataset.totals.assetCount,
      songCount: dataset.totals.songCount,
      chunkCount: dataset.totals.chunkCount,
      artifactBytes: artifacts.reduce((n2, a) => n2 + a.bytes, 0),
      runId: dataset.runId,
      exportDir,
      deletionPolicy: dataset.deletionPolicy,
      warnings: dataset.warnings,
    },
  };
}

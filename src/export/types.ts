/**
 * Shared shapes for the export layer. Types only -- no I/O, no behaviour.
 *
 * `index.ts` builds an `ExportDataset` from the index database; `json.ts`,
 * `markdown.ts` and `ffs.ts` are pure renderers over it. Because all three
 * renderers consume the SAME `ExportChunk.includes` array, the path list in a
 * `.ffs_gui` cannot drift from the path list in the manifest: there is only
 * one list.
 */

import type { KeepReason } from '../scan/reclaim.ts';

/** Only these two. `Permanent` is not representable -- see `ffs.ts`. */
export type DeletionPolicy = 'Versioning' | 'RecycleBin';

export type ExportFormat = 'json' | 'markdown' | 'ffs_gui';

/** One literal file inside a selected version. */
export interface ExportFileRow {
  fileId: number;
  /** Root-relative, forward-slash separated, exactly as stored by the scanner. */
  relPath: string;
  songFolder: string;
  name: string;
  ext: string;
  size: number;
  /** epoch ms */
  mtime: number;
}

/** One asset-version, with the literal files it covers. */
export interface ExportVersionRow {
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
  /** epoch ms */
  latestMtime: number;
  status: 'kept' | 'superseded';
  keepReason: KeepReason;
  /** True when this version is part of THIS export's removal set. */
  selected: boolean;
  /** Literal paths this version covers. Empty for context-only siblings. */
  files: ExportFileRow[];
}

/** Every version of an asset touched by this export, oldest first. */
export interface ExportAssetLadder {
  assetId: number;
  songFolder: string;
  base: string;
  family: string;
  /** Oldest to newest; patches sorted after the full version of the same number. */
  versions: ExportVersionRow[];
  selectedVersionIds: number[];
  selectedBytes: number;
  selectedFileCount: number;
}

/**
 * How the removal set is cut into FreeFileSync jobs.
 *
 *   'single'   -- ONE job for the whole run. The folder pair points at the
 *                 archive root and the include filter carries every path.
 *                 One file to open, one Compare to read, one Sync to press.
 *   'per-song' -- one job per song folder, each pair pointing INSIDE its own
 *                 song, so a job physically cannot see the rest of the
 *                 archive. Safer in the hand, and 65 files to work through.
 *
 * The trade is real and belongs to the operator, so it is an option rather
 * than a decision made here. Everything else -- reversible deletion policy,
 * `Create`/`Update` pinned to `none`, the literal path manifest beside every
 * job, the refusal to emit an empty include list -- is identical either way.
 */
export type JobLayout = 'single' | 'per-song';

/**
 * One `.ffs_gui` file's worth of work.
 *
 * `baseFolder` is the folder the FreeFileSync pair points at: the song folder
 * under 'per-song', where the job cannot see the rest of the archive, and the
 * scan root under 'single', where the include filter is what narrows it.
 */
export interface ExportChunk {
  /** 1-based. */
  index: number;
  /** Song folders represented in this chunk. */
  songFolders: string[];
  /** Absolute path of the right-hand folder-pair root, forward slashes. */
  baseFolder: string;
  /** Root-relative prefix that `baseFolder` adds, '' or 'SONG/'. */
  basePrefix: string;
  /**
   * FreeFileSync include patterns: base-relative, leading slash, forward
   * slashes. THE authoritative path list -- the manifest renders this same
   * array, so the two can never disagree.
   */
  includes: string[];
  /** The same paths, root-relative (i.e. `basePrefix` + include minus slash). */
  relPaths: string[];
  versionIds: number[];
  bytes: number;
  fileCount: number;
  /** File name (not path) of the `.ffs_gui` for this chunk. */
  guiFileName: string;
  /** File name (not path) of the companion literal-path manifest. */
  manifestFileName: string;
}

export interface ExportSnapshotProvenance {
  snapshotId: number;
  /** Absolute scan root the relative paths are relative to. */
  root: string;
  name: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  fileCount: number;
  totalBytes: number;
  excludedCount: number;
  excludedBytes: number;
  unparsedCount: number;
}

export interface ExportSongRollup {
  songFolder: string;
  versionCount: number;
  fileCount: number;
  bytes: number;
  proxyBytes: number;
  /** epoch ms of the newest file being removed in this song. */
  latestMtime: number;
}

/** Everything the renderers need. Built once, shared by all three. */
export interface ExportDataset {
  /** Stable id for this export run, used as the directory name. */
  runId: string;
  /** ISO-8601 UTC. */
  generatedAt: string;
  snapshot: ExportSnapshotProvenance;
  /** The keep-latest-N the verdicts were computed under. */
  keepN: number;
  deletionPolicy: DeletionPolicy;
  versioningFolder: string | null;
  note: string | null;
  /** Selected versions only, in (song, base, version) order. */
  selected: ExportVersionRow[];
  /** Full version ladders for every asset touched, for context. */
  ladders: ExportAssetLadder[];
  chunks: ExportChunk[];
  bySong: ExportSongRollup[];
  totals: {
    versionCount: number;
    fileCount: number;
    totalBytes: number;
    proxyBytes: number;
    assetCount: number;
    songCount: number;
    chunkCount: number;
  };
  /** Loud, human-facing caveats. Rendered at the top of the Markdown. */
  warnings: string[];
}

export interface ExportArtifact {
  format: ExportFormat | 'ffs_manifest';
  path: string;
  bytes: number;
}

export interface ExportResult {
  files: ExportArtifact[];
  summary: {
    /** Literal archive files the export proposes to move. */
    fileCount: number;
    /** Bytes those files occupy. */
    totalBytes: number;
    versionCount: number;
    assetCount: number;
    songCount: number;
    chunkCount: number;
    /** Bytes of the artefacts written into `exports/`. */
    artifactBytes: number;
    runId: string;
    exportDir: string;
    deletionPolicy: DeletionPolicy;
    warnings: string[];
  };
}

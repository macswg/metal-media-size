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
import type { DriveState, MachineRole } from '../machines.ts';

/** Only these two. `Permanent` is not representable -- see `ffs.ts`. */
export type DeletionPolicy = 'Versioning' | 'RecycleBin';

export type ExportFormat = 'json' | 'markdown' | 'ffs_gui' | 'report';

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
  /**
   * Absolute path of the folder this chunk's paths are relative to, as seen by
   * the SCAN. Provenance: it is what the manifests resolve their absolute paths
   * against, and it is not necessarily what the job runs against.
   */
  baseFolder: string;
  /**
   * What goes in the `.ffs_gui`'s `<Right>` element.
   *
   * Usually `baseFolder`. EMPTY STRING when the operator asked for the folder
   * to be left blank, because the job will be run against a different mount of
   * the same delivery folder and the path is theirs to set in FreeFileSync.
   * The include patterns are anchored and relative, so they bind to whatever
   * folder is chosen -- which is exactly why the field can be left open.
   */
  pairRightFolder: string;
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

/** One song's share of a scenario's reclaim. Whole archive, not this export. */
export interface ExportScenarioSong {
  songFolder: string;
  reclaimBytes: number;
  supersededVersions: number;
  supersededFiles: number;
}

/**
 * One keep-latest-N choice, costed over the WHOLE snapshot.
 *
 * These are the rows on page one of the shareable report. They answer "what
 * would we get back if we kept only the current version / one previous / two /
 * three", and they are deliberately NOT scoped to this export's selection or
 * to whatever filters the operator had on screen -- see `scenarios.ts`.
 */
export interface ExportScenario {
  keepN: number;
  /** "Current version only" / "Current + 2 previous versions". */
  label: string;
  /** One plain sentence saying what that means for the archive. */
  subLabel: string;
  reclaimBytes: number;
  reclaimVersions: number;
  reclaimFiles: number;
  reclaimProxyBytes: number;
  /** Bytes still on the archive after this choice. */
  keptBytes: number;
  keptVersions: number;
  /**
   * Patches sitting at or above their asset's latest full version. Constant
   * across every row by construction; carried per row so a reader can SEE that
   * the protection does not depend on the choice being made.
   */
  protectedPatchBytes: number;
  protectedPatchVersions: number;
  /**
   * Bytes given up by choosing this row instead of the one above it -- i.e.
   * what one more version of insurance costs. Zero on the first row, which has
   * nothing above it and is by definition the maximum.
   */
  costVsRowAbove: number;
  /** True on the row whose N this export's verdicts were computed under. */
  isExportPolicy: boolean;
  bySong: ExportScenarioSong[];
}

/** What the scenario table was computed over. The whole snapshot, stated. */
export interface ExportScenarioBasis {
  assetCount: number;
  versionCount: number;
  versionedBytes: number;
  versionedFiles: number;
  songCount: number;
  /** Snapshot bytes belonging to no version: names the grammar could not parse. */
  unversionedBytes: number;
}

/**
 * The storage location as it stands today, before any option is chosen.
 *
 * Deliberately NOT derived from the scenario table: these are the figures a
 * reader wants before they look at the options at all -- how much is there, and
 * how much of it is the whole-canvas copy the offline edit needs.
 *
 * `region0Bytes` and `proxyBytes` are counted SEPARATELY and neither is derived
 * from the other. region0 says which part of the canvas a file covers; a proxy
 * token says what resolution it is. They coincide on this archive and are not
 * required to -- see CLAUDE.md.
 */
export interface ExportStorageTotals {
  /** Everything the scan found, bookkeeping files excluded. */
  totalBytes: number;
  fileCount: number;
  songCount: number;
  /** Bytes in files whose region is 0: the whole canvas, kept for offline editing. */
  region0Bytes: number;
  /** Bytes in files carrying a `_proxyN` token. */
  proxyBytes: number;
}

/** One machine costed at one keep-N option. */
export interface ExportMachineOption {
  keepN: number;
  /** Bytes this option would free ON THIS DRIVE. */
  recoverableBytes: number;
  /** What would still be on the drive afterwards. */
  remainingBytes: number;
  /** `remainingBytes` as a fraction of USABLE space. May exceed 1. */
  remainingFraction: number;
  state: DriveState;
}

/**
 * One playback machine's drive, costed at every option on the report's first
 * page.
 *
 * `totalBytes` is what is on the drive today and does NOT move with the option
 * -- the media is there until somebody removes it. Only the per-option figures
 * move. Rows OVERLAP: a region held by two machines is on both drives, so
 * summing these gives storage, never archive.
 */
export interface ExportMachineFill {
  machineId: string;
  name: string;
  role: MachineRole;
  regions: number[];
  capacityBytes: number;
  reserveBytes: number;
  usableBytes: number;
  totalBytes: number;
  /** `totalBytes / usableBytes` today. May exceed 1. */
  usedFraction: number;
  state: DriveState;
  /** One entry per option on page one, in the same order. */
  options: ExportMachineOption[];
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
  /**
   * Keep-latest-N costed at several values of N over the WHOLE snapshot, for
   * the executive summary. Independent of `selected` and of any filter: see
   * `scenarios.ts` for why narrowing the input would be unsafe.
   */
  scenarios: ExportScenario[];
  /** What `scenarios` was computed over. */
  scenarioBasis: ExportScenarioBasis;
  /** The storage location as it stands, independent of every option. */
  storage: ExportStorageTotals;
  /**
   * Per-machine drive fill, costed at each of `scenarios`. Empty when the
   * caller asked for no machine breakdown.
   */
  machines: ExportMachineFill[];
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

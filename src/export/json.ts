/**
 * =============================================================================
 *  JSON EXPORT  --  THE MACHINE-READABLE, SELF-DESCRIBING RECORD. PURE, NO I/O.
 * =============================================================================
 *
 * The point of this artefact is that someone opening it in eight months, with
 * no access to the database and no memory of the session, can tell exactly what
 * was proposed and on what evidence. So it carries:
 *
 *   - scan provenance: snapshot id, scan root, when the scan ran and finished,
 *     how many files and bytes it saw, and what it excluded;
 *   - the policy the verdicts were computed under (keep-latest-N) and the
 *     deletion policy chosen for this export;
 *   - every selected asset-version with its full identity, byte total, proxy
 *     subtotal, region count, mtime, keep/supersede verdict and `keepReason`;
 *   - the complete list of literal file paths each version covers;
 *   - the full version ladder of every asset touched, so a reader can see what
 *     is being KEPT alongside what is going;
 *   - the FreeFileSync chunking, with each chunk's include list.
 *
 * The chunk include lists here are the SAME arrays `ffs.ts` renders into
 * `<Include>`. There is one list, rendered twice; it cannot diverge.
 * =============================================================================
 */

import type { ExportChunk, ExportDataset, ExportVersionRow } from './types.ts';

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function versionJson(v: ExportVersionRow, includeFiles: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    versionId: v.versionId,
    assetId: v.assetId,
    songFolder: v.songFolder,
    base: v.base,
    family: v.family,
    verNum: v.verNum,
    subLetter: v.subLetter,
    verLabel: v.verLabel,
    isPatch: v.isPatch,
    patchFrame: v.patchFrame,
    bytes: v.bytes,
    fileCount: v.fileCount,
    proxyBytes: v.proxyBytes,
    regionCount: v.regionCount,
    latestMtime: v.latestMtime,
    latestMtimeIso: isoOrNull(v.latestMtime),
    status: v.status,
    keepReason: v.keepReason,
    selected: v.selected,
  };
  if (includeFiles) {
    out.files = v.files.map((f) => ({
      fileId: f.fileId,
      relPath: f.relPath,
      songFolder: f.songFolder,
      name: f.name,
      ext: f.ext,
      size: f.size,
      mtime: f.mtime,
      mtimeIso: isoOrNull(f.mtime),
    }));
  }
  return out;
}

function chunkJson(c: ExportChunk, root: string): Record<string, unknown> {
  return {
    index: c.index,
    guiFileName: c.guiFileName,
    manifestFileName: c.manifestFileName,
    songFolders: c.songFolders,
    /** The right-hand side of the FreeFileSync folder pair. */
    // What the emitted job actually carries -- '' when the operator is setting
    // the folder in FreeFileSync. `scanBaseFolder` is where the paths were
    // seen, which is what `absolutePaths` below resolves against.
    pairRightFolder: c.pairRightFolder,
    scanBaseFolder: c.baseFolder,
    basePrefix: c.basePrefix,
    versionIds: c.versionIds,
    fileCount: c.fileCount,
    bytes: c.bytes,
    /** Verbatim `<Include><Item>` values in the emitted .ffs_gui. */
    includePatterns: c.includes,
    /** The same paths, relative to the scan root. */
    relPaths: c.relPaths,
    /** The same paths again, absolute, for a human eyeballing the file. */
    absolutePaths: c.relPaths.map((p) => `${root}/${p}`),
  };
}

/** The structured object written as `manifest.json`. Exported for tests. */
export function buildJsonExport(d: ExportDataset): Record<string, unknown> {
  return {
    exportFormatVersion: 1,
    generator: 'metal-media-size',
    runId: d.runId,
    generatedAt: d.generatedAt,

    provenance: {
      snapshotId: d.snapshot.snapshotId,
      scanRoot: d.snapshot.root,
      snapshotName: d.snapshot.name,
      scanStartedAt: d.snapshot.startedAt,
      scanStartedAtIso: isoOrNull(d.snapshot.startedAt),
      scanFinishedAt: d.snapshot.finishedAt,
      scanFinishedAtIso: isoOrNull(d.snapshot.finishedAt),
      snapshotStatus: d.snapshot.status,
      snapshotFileCount: d.snapshot.fileCount,
      snapshotTotalBytes: d.snapshot.totalBytes,
      excludedCount: d.snapshot.excludedCount,
      excludedBytes: d.snapshot.excludedBytes,
      unparsedCount: d.snapshot.unparsedCount,
    },

    policy: {
      keepN: d.keepN,
      deletionPolicy: d.deletionPolicy,
      versioningFolder: d.versioningFolder,
      /**
       * Recorded so the artefact states its own safety posture rather than
       * relying on the reader knowing it.
       */
      permanentDeletionOffered: false,
      note: d.note,
    },

    totals: {
      ...d.totals,
      /** Bytes the export proposes to move off the archive. */
      reclaimBytes: d.totals.totalBytes,
    },

    warnings: d.warnings,

    bySong: d.bySong.map((s) => ({
      ...s,
      latestMtimeIso: isoOrNull(s.latestMtime),
    })),

    /** Everything selected for removal, with its literal paths. */
    selectedVersions: d.selected.map((v) => versionJson(v, true)),

    /**
     * Full ladders for context: for each asset touched, every version it has,
     * oldest first, including the ones being kept.
     */
    assetLadders: d.ladders.map((l) => ({
      assetId: l.assetId,
      songFolder: l.songFolder,
      base: l.base,
      family: l.family,
      selectedVersionIds: l.selectedVersionIds,
      selectedBytes: l.selectedBytes,
      selectedFileCount: l.selectedFileCount,
      versions: l.versions.map((v) => versionJson(v, false)),
    })),

    freeFileSync: {
      /** `.ffs_batch` is never emitted: its <Batch> block shape is unverified. */
      fileType: 'ffs_gui',
      xmlFormat: 23,
      /**
       * Move detection is switched off: the archive is a read-only mount, so
       * FreeFileSync cannot write the .ffs_db it would need. With an empty
       * left-hand folder there is nothing to detect a move against in any case.
       */
      detectMovedFiles: false,
      chunkCount: d.chunks.length,
      chunks: d.chunks.map((c) => chunkJson(c, d.snapshot.root)),
    },
  };
}

/** `manifest.json` as text. */
export function renderJsonExport(d: ExportDataset): string {
  return JSON.stringify(buildJsonExport(d), null, 2) + '\n';
}

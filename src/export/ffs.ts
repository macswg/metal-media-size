/**
 * =============================================================================
 *  FREEFILESYNC `.ffs_gui` RENDERER  --  PURE, NO I/O
 * =============================================================================
 *
 * The emitted shape follows `docs/ffs-format.md`, which was verified
 * byte-for-byte against a real config written by the user's own FreeFileSync
 * 14.10. `test/ffs-format.test.ts` reproduces that exact document from this
 * renderer and compares it character by character, so a change to the element
 * grammar here fails the build.
 *
 * WHAT IS EMITTED, AND WHY
 * ------------------------
 * `.ffs_gui` ONLY. Never `.ffs_batch`: the `<Batch>` block shape is unverified,
 * and the GUI form forces a human to open the job and press Compare before
 * anything moves. That human-in-the-loop step is the point.
 *
 * The removal pattern is the one FreeFileSync actually supports: an EMPTY LEFT
 * folder paired against the archive on the right, plus an `<Include>` filter
 * naming the exact relative paths. Items present on the right and absent on the
 * left are the removal set.
 *
 * DIRECTIONS -- narrower than Mirror, on purpose
 * ----------------------------------------------
 * A true Mirror preset is `Left Create="right" Update="right" Delete="right"`.
 * We emit:
 *
 *     <Left  Create="none" Update="none" Delete="right"/>
 *     <Right Create="none" Update="none" Delete="none"/>
 *
 * The `Delete="right"` half is the Mirror behaviour we want: propagate the
 * left-side absence rightwards, i.e. take the right-only files out. The
 * `Create`/`Update` halves are pinned to `none` because the left folder is
 * empty and therefore has nothing legitimate to copy. This costs nothing and
 * makes the failure modes safe:
 *
 *   - if the empty-left folder somehow is NOT empty, nothing is copied INTO the
 *     archive, because creates and updates are switched off;
 *   - if `Delete="right"` were misread by FreeFileSync, the job would simply
 *     propose nothing, which the human sees in Compare.
 *
 * Neither failure can move a byte the user did not ask for. The `none` and
 * `right` attribute values are both present in the verified file.
 *
 * `Permanent` IS NOT REPRESENTABLE
 * --------------------------------
 * `DeletionPolicy` is a two-member union that does not include it, and
 * `assertDeletionPolicy` throws on it at run time for callers coming in from
 * untyped JSON. Both are covered by tests.
 * =============================================================================
 */

import type { DeletionPolicy, ExportChunk } from './types.ts';

/** The only deletion policies this application will ever emit. */
export const ALLOWED_DELETION_POLICIES: readonly DeletionPolicy[] = Object.freeze([
  'Versioning',
  'RecycleBin',
]);

/**
 * Reject anything that is not one of the two allowed policies.
 *
 * `Permanent` is called out by name in the error because a caller who asked for
 * it needs to understand it is a policy decision, not a missing feature.
 *
 * @throws Error
 */
export function assertDeletionPolicy(value: unknown): DeletionPolicy {
  if (value === 'Permanent') {
    throw new Error(
      "DeletionPolicy 'Permanent' is forbidden by this application and can never be " +
        'emitted: it would make removals irreversible on an archive that has no backup. ' +
        "Use 'Versioning' (moves into a dated folder, fully reversible) or 'RecycleBin'.",
    );
  }
  if (typeof value !== 'string' || !ALLOWED_DELETION_POLICIES.includes(value as DeletionPolicy)) {
    throw new Error(
      `Invalid deletionPolicy ${JSON.stringify(value)}. ` +
        `Expected one of: ${ALLOWED_DELETION_POLICIES.join(', ')}.`,
    );
  }
  return value as DeletionPolicy;
}

/** `VersioningFolder Style` values FreeFileSync's source lists. */
export type VersioningStyle = 'Replace' | 'TimeStamp-Folder' | 'TimeStamp-File';

/**
 * The standard macOS exclusions from the verified real config. The user's own
 * project-specific `/x_ArchiveFrom2025/` entry is deliberately NOT here: it
 * belongs to their job, not ours.
 */
export const MACOS_EXCLUDES: readonly string[] = Object.freeze([
  '*/._*',
  '*/.DS_Store',
  '*/.fseventsd/',
  '*/.DocumentRevisions-V100/',
  '*/.Spotlight-V100/',
  '*/.TemporaryItems/',
  '*/.Trashes/',
  '*/desktop.ini',
]);

/** Threads attribute FreeFileSync writes on each folder-pair side. */
export const DEFAULT_THREADS = 8;

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

/**
 * Escape a text node. Real filenames in this archive contain `&`, brackets and
 * spaces; `&` in particular is the one that produces malformed XML if missed.
 * Brackets, spaces, `#`, `'` and `"` are all legal literal text in XML and are
 * left alone so the emitted paths stay readable and byte-comparable.
 */
export function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape an attribute value (double-quoted). */
export function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Undo `escapeXmlText` / `escapeXmlAttr`. Used by the round-trip test. */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Make a string safe to put inside an XML comment: `--` may not appear, and a
 * comment may not end with `-`. Newlines are fine.
 */
export function sanitiseXmlComment(s: string): string {
  return s.replace(/--+/g, (m) => '-' + ' -'.repeat(m.length - 1)).replace(/-$/, '- ');
}

// ---------------------------------------------------------------------------
// Filter-pattern safety
// ---------------------------------------------------------------------------

/**
 * FreeFileSync filter items treat `*` and `?` as wildcards. A literal `*` or
 * `?` in a real filename therefore cannot be expressed as an exact include
 * pattern, and the pattern would silently match MORE files than the human
 * approved. That is an over-deletion vector, so it is a hard error rather than
 * a warning.
 *
 * (Brackets are NOT wildcards in FreeFileSync's filter syntax -- only `*` and
 * `?` are -- so `[LL180]`-style names are matched literally.)
 *
 * @throws Error
 */
export function assertFilterSafePath(relPath: string): void {
  if (relPath.includes('*') || relPath.includes('?')) {
    throw new Error(
      `Cannot build an exact FreeFileSync include pattern for ${JSON.stringify(relPath)}: ` +
        'the name contains a wildcard character (* or ?), so the pattern could match files ' +
        'that were never selected. Deselect this file and export the rest.',
    );
  }
  if (relPath.includes('\\')) {
    throw new Error(
      `Cannot build an exact FreeFileSync include pattern for ${JSON.stringify(relPath)}: ` +
        'whether a literal backslash can be filter-matched at all is unverified ' +
        '(see docs/ffs-format.md). Deselect this file and export the rest.',
    );
  }
}

// ---------------------------------------------------------------------------
// Document model + renderer
// ---------------------------------------------------------------------------

export type ChangeDirection = 'left' | 'right' | 'none';

export interface ChangeDirections {
  Create: ChangeDirection;
  Update: ChangeDirection;
  Delete: ChangeDirection;
}

export interface FolderPair {
  left: string;
  right: string;
  threads?: number;
}

/**
 * A complete `.ffs_gui` document. Every field maps to one verified element; no
 * field invents an element name that is not in `docs/ffs-format.md`.
 */
export interface FfsGuiModel {
  /** Emitted as an XML comment between the declaration and the root element. */
  headerComment?: string;
  /** `<Notes>`. Shown to the user inside the FreeFileSync GUI. */
  notes?: string;
  compareVariant?: string;
  symlinks?: string;
  changes: { left: ChangeDirections; right: ChangeDirections };
  /**
   * `<DetectMovedFiles>`. OMITTED ENTIRELY when undefined, which is what
   * reproduces the verified 14.10 config: that real file does not carry the
   * element at all. Removal jobs set it to `false` explicitly.
   */
  detectMovedFiles?: boolean;
  deletionPolicy: DeletionPolicy;
  versioningStyle: VersioningStyle;
  /** Empty string renders the verified self-closing `<VersioningFolder .../>`. */
  versioningFolder?: string;
  include: readonly string[];
  exclude: readonly string[];
  pairs: readonly FolderPair[];
  gridViewType?: string;
}

const IND = '    ';

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Render two sibling elements with their attributes column-aligned, the way
 * FreeFileSync writes `<Left>`/`<Right>`. Reproducing the alignment is what
 * lets the golden test compare the verified document character for character.
 */
function renderAlignedPair(
  depth: number,
  rows: { name: string; attrs: [string, string][]; body?: string }[],
): string[] {
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const attrCount = Math.max(...rows.map((r) => r.attrs.length));
  const attrWidth: number[] = [];
  for (let i = 0; i < attrCount; i++) {
    attrWidth[i] = Math.max(
      ...rows.map((r) => {
        const a = r.attrs[i];
        return a ? `${a[0]}="${escapeXmlAttr(a[1])}"`.length : 0;
      }),
    );
  }
  return rows.map((r) => {
    const parts = r.attrs.map((a, i) => {
      const text = `${a[0]}="${escapeXmlAttr(a[1])}"`;
      return i === r.attrs.length - 1 ? text : pad(text, attrWidth[i] as number);
    });
    const head = `${IND.repeat(depth)}<${pad(r.name, nameWidth)} ${parts.join(' ')}`;
    return r.body === undefined
      ? `${head}/>`
      : `${head}>${escapeXmlText(r.body)}</${r.name}>`;
  });
}

/**
 * Render a `.ffs_gui` document.
 *
 * The element order, attribute names, empty-element convention and 4-space
 * indentation all reproduce the verified FreeFileSync 14.10 output.
 */
export function renderFfsGui(m: FfsGuiModel): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>');
  if (m.headerComment) {
    out.push('<!--');
    out.push(sanitiseXmlComment(m.headerComment.replace(/\s+$/, '')));
    out.push('-->');
  }
  out.push('<FreeFileSync XmlType="GUI" XmlFormat="23">');

  out.push(m.notes ? `${IND}<Notes>${escapeXmlText(m.notes)}</Notes>` : `${IND}<Notes/>`);

  out.push(`${IND}<Compare>`);
  out.push(`${IND}${IND}<Variant>${escapeXmlText(m.compareVariant ?? 'TimeAndSize')}</Variant>`);
  out.push(`${IND}${IND}<Symlinks>${escapeXmlText(m.symlinks ?? 'Exclude')}</Symlinks>`);
  out.push(`${IND}${IND}<IgnoreTimeShift/>`);
  out.push(`${IND}</Compare>`);

  out.push(`${IND}<Synchronize>`);
  out.push(`${IND}${IND}<Changes>`);
  out.push(
    ...renderAlignedPair(3, [
      {
        name: 'Left',
        attrs: [
          ['Create', m.changes.left.Create],
          ['Update', m.changes.left.Update],
          ['Delete', m.changes.left.Delete],
        ],
      },
      {
        name: 'Right',
        attrs: [
          ['Create', m.changes.right.Create],
          ['Update', m.changes.right.Update],
          ['Delete', m.changes.right.Delete],
        ],
      },
    ]),
  );
  out.push(`${IND}${IND}</Changes>`);
  if (m.detectMovedFiles !== undefined) {
    // Name verified against the FreeFileSync 14.10 binary's XML literal pool.
    // POSITION is inferred: the verified real config does not carry the element,
    // so there is no observed ordering to copy. FreeFileSync reads its config by
    // element name rather than by position, so order is not expected to matter.
    out.push(
      `${IND}${IND}<DetectMovedFiles>${m.detectMovedFiles ? 'true' : 'false'}</DetectMovedFiles>`,
    );
  }
  out.push(
    `${IND}${IND}<DeletionPolicy>${escapeXmlText(assertDeletionPolicy(m.deletionPolicy))}</DeletionPolicy>`,
  );
  const styleAttr = `Style="${escapeXmlAttr(m.versioningStyle)}"`;
  out.push(
    m.versioningFolder
      ? `${IND}${IND}<VersioningFolder ${styleAttr}>${escapeXmlText(m.versioningFolder)}</VersioningFolder>`
      : `${IND}${IND}<VersioningFolder ${styleAttr}/>`,
  );
  out.push(`${IND}</Synchronize>`);

  out.push(`${IND}<Filter>`);
  out.push(`${IND}${IND}<Include>`);
  for (const item of m.include) {
    out.push(`${IND}${IND}${IND}<Item>${escapeXmlText(item)}</Item>`);
  }
  out.push(`${IND}${IND}</Include>`);
  out.push(`${IND}${IND}<Exclude>`);
  for (const item of m.exclude) {
    out.push(`${IND}${IND}${IND}<Item>${escapeXmlText(item)}</Item>`);
  }
  out.push(`${IND}${IND}</Exclude>`);
  out.push(`${IND}${IND}<SizeMin Unit="None">0</SizeMin>`);
  out.push(`${IND}${IND}<SizeMax Unit="None">0</SizeMax>`);
  out.push(`${IND}${IND}<TimeSpan Type="None">0</TimeSpan>`);
  out.push(`${IND}</Filter>`);

  out.push(`${IND}<FolderPairs>`);
  for (const p of m.pairs) {
    out.push(`${IND}${IND}<Pair>`);
    const threads = String(p.threads ?? DEFAULT_THREADS);
    out.push(
      ...renderAlignedPair(3, [
        { name: 'Left', attrs: [['Threads', threads]], body: p.left },
        { name: 'Right', attrs: [['Threads', threads]], body: p.right },
      ]),
    );
    out.push(`${IND}${IND}</Pair>`);
  }
  out.push(`${IND}</FolderPairs>`);

  out.push(`${IND}<Errors Ignore="false" Retry="0" Delay="5"/>`);
  out.push(`${IND}<PostSyncCommand Condition="Completion"/>`);
  out.push(`${IND}<LogFolder/>`);
  out.push(`${IND}<EmailNotification Condition="Always"/>`);
  out.push(`${IND}<GridViewType>${escapeXmlText(m.gridViewType ?? 'Action')}</GridViewType>`);
  out.push('</FreeFileSync>');
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// The removal job
// ---------------------------------------------------------------------------

/**
 * Directions for a removal job: delete-only, as explained in the file header.
 * Frozen so no caller can widen it into something that copies into the archive.
 */
export const REMOVAL_CHANGES: { left: ChangeDirections; right: ChangeDirections } = Object.freeze({
  left: Object.freeze({ Create: 'none', Update: 'none', Delete: 'right' }) as ChangeDirections,
  right: Object.freeze({ Create: 'none', Update: 'none', Delete: 'none' }) as ChangeDirections,
});

export interface RemovalGuiOptions {
  /** Absolute path of an EMPTY directory used as the left-hand side. */
  emptyLeftFolder: string;
  deletionPolicy: DeletionPolicy;
  /** Required when `deletionPolicy` is `Versioning`. */
  versioningFolder?: string | null;
  /** Name of the companion literal-path manifest, for the header comment. */
  manifestFileName: string;
  /** Chunk k of n, for the header comment. */
  chunkCount: number;
  runId: string;
  generatedAt: string;
  /** The user's free-text note, if any. */
  note?: string | null;
}

function tib(bytes: number): string {
  const t = bytes / 1024 ** 4;
  if (t >= 1) return `${t.toFixed(2)} TiB`;
  const g = bytes / 1024 ** 3;
  if (g >= 1) return `${g.toFixed(2)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

/** The banner every emitted job carries, as an XML comment and as `<Notes>`. */
export function removalHeaderText(chunk: ExportChunk, o: RemovalGuiOptions): string {
  const disposition =
    o.deletionPolicy === 'Versioning'
      ? `MOVED (not deleted) into the dated versioning folder:\n    ${o.versioningFolder}\n  ` +
        '  Every removal is reversible: the files are still there, under a timestamped\n  ' +
        '  subfolder, until you choose to clear it out.'
      : 'moved to the RECYCLE BIN / Trash of the volume they live on, not erased in place.';

  const lines = [
    '  ==========================================================================',
    '   FreeFileSync REMOVAL JOB  -  generated by metal-media-size',
    '  ==========================================================================',
    '',
    `   Run:      ${o.runId}   (generated ${o.generatedAt})`,
    `   Chunk:    ${chunk.index} of ${o.chunkCount}`,
    `   Songs:    ${chunk.songFolders.join(', ')}`,
    `   Scope:    ${chunk.fileCount} file(s), ${tib(chunk.bytes)}, ` +
      `${chunk.versionIds.length} superseded asset version(s)`,
    '',
    '   WHAT THIS JOB DOES',
    `   The right-hand folder is ${chunk.baseFolder}`,
    '   The left-hand folder is deliberately EMPTY. The include filter below names',
    '   the exact relative paths that were selected for removal, and nothing else.',
    '   Running it takes those files off the right-hand side. They are',
    `   ${disposition}`,
    '',
    '   Copying is switched off in both directions (Create="none", Update="none"),',
    '   so this job can never put anything INTO the archive.',
    '',
    '   BEFORE YOU RUN IT',
    '   1. Press COMPARE. Do not press Synchronize yet.',
    `   2. Check the row count matches ${chunk.fileCount} and read the file list.`,
    `   3. Cross-check it against the companion manifest ${o.manifestFileName},`,
    '      which lists every literal path in plain text.',
    '   4. If the list is empty, or longer than expected, STOP and re-generate.',
    '   5. Only then press SYNCHRONIZE.',
    '',
    '   This archive has NO BACKUP. Irreversible, erase-in-place deletion is not',
    '   reachable from this tool by design: the only two deletion policies it can',
    '   produce are the reversible ones, and the word for the third does not appear',
    '   anywhere in a generated job.',
    '',
    '   MOVE DETECTION IS SWITCHED OFF: <DetectMovedFiles>false</DetectMovedFiles>.',
    '   The archive mount is read-only, so FreeFileSync cannot write the .ffs_db it',
    '   would need. It cannot change this job either way: the left side is empty, so',
    '   no right-side item has anything to be paired with as a move.',
    '',
    '   Element names in this file come from a real FreeFileSync 14.10 config and',
    '   from the 14.10 binary itself. That is not a substitute for looking: check',
    '   the settings in the GUI before you press Synchronize.',
  ];
  if (o.note) {
    lines.push('', '   NOTE FROM THE OPERATOR', ...o.note.split('\n').map((l) => `   ${l}`));
  }
  lines.push('  ==========================================================================');
  return lines.join('\n');
}

/**
 * Build the `.ffs_gui` for one chunk.
 *
 * The include list is `chunk.includes` verbatim -- the very same array the JSON
 * and text manifests render -- so the human's approved list and FreeFileSync's
 * filter are the same list by construction, not by agreement.
 */
export function buildRemovalGui(chunk: ExportChunk, o: RemovalGuiOptions): string {
  const policy = assertDeletionPolicy(o.deletionPolicy);
  if (policy === 'Versioning' && !o.versioningFolder) {
    throw new Error(
      "deletionPolicy 'Versioning' requires a versioningFolder: without one FreeFileSync " +
        'has nowhere to move the files to, and the removal would not be reversible.',
    );
  }
  // AN EMPTY <Include> MEANS "INCLUDE EVERYTHING" IN FREEFILESYNC. Paired with
  // an empty left folder and Delete="right", that would propose taking out the
  // ENTIRE right-hand folder. There is no legitimate empty chunk, so refuse.
  if (chunk.includes.length === 0) {
    throw new Error(
      `Refusing to emit a .ffs_gui for chunk ${chunk.index} with an empty include list: ` +
        'FreeFileSync treats an empty include filter as "match everything", which paired ' +
        'with an empty left-hand folder would propose removing the whole right-hand folder.',
    );
  }
  if (chunk.includes.length !== chunk.relPaths.length) {
    throw new Error(
      `Chunk ${chunk.index} is inconsistent: ${chunk.includes.length} include pattern(s) ` +
        `but ${chunk.relPaths.length} literal path(s). Refusing to emit a job whose filter ` +
        'and manifest could disagree.',
    );
  }
  for (const p of chunk.relPaths) assertFilterSafePath(p);

  const banner = removalHeaderText(chunk, o);
  return renderFfsGui({
    headerComment: banner,
    notes: banner
      .split('\n')
      .map((l) => l.replace(/^ {1,3}/, ''))
      .join('\n')
      .trim(),
    changes: REMOVAL_CHANGES,
    // The archive is a read-only mount, so FreeFileSync cannot write the .ffs_db
    // that move detection depends on. Switched off explicitly rather than left
    // to whatever the reading FreeFileSync happens to default to.
    detectMovedFiles: false,
    deletionPolicy: policy,
    versioningStyle: 'TimeStamp-Folder',
    versioningFolder: policy === 'Versioning' ? (o.versioningFolder as string) : '',
    include: chunk.includes,
    exclude: MACOS_EXCLUDES,
    pairs: [{ left: o.emptyLeftFolder, right: chunk.baseFolder }],
  });
}

/**
 * The companion literal-path manifest that ships next to every `.ffs_gui`.
 * Plain text, one absolute path per line, so it can be eyeballed or diffed
 * without a JSON viewer. Rendered from `chunk.relPaths`, the same array the
 * include list comes from.
 */
export function buildChunkManifest(
  chunk: ExportChunk,
  root: string,
  o: RemovalGuiOptions,
): string {
  const lines = [
    `# FreeFileSync removal manifest  -  run ${o.runId}  -  chunk ${chunk.index} of ${o.chunkCount}`,
    `# Generated ${o.generatedAt}`,
    `# Job file:   ${chunk.guiFileName}`,
    `# Scan root:  ${root}`,
    `# Pair right: ${chunk.baseFolder}`,
    `# Policy:     ${o.deletionPolicy}${
      o.deletionPolicy === 'Versioning' ? ` -> ${o.versioningFolder}` : ''
    }`,
    `# ${chunk.fileCount} file(s), ${chunk.bytes} bytes (${tib(chunk.bytes)})`,
    '#',
    '# Every line below is a literal path this job will take off the archive.',
    '# This list and the <Include> list in the job file are generated from the',
    '# same array; if they ever differ, do not run the job.',
    '',
  ];
  for (const rel of chunk.relPaths) lines.push(`${root}/${rel}`);
  return lines.join('\n') + '\n';
}

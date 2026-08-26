/**
 * =============================================================================
 *  MARKDOWN EXPORT  --  THE DOCUMENT THE HUMAN ACTUALLY READS. PURE, NO I/O.
 * =============================================================================
 *
 * This is the review artefact. Someone reads it, decides, and only then opens
 * FreeFileSync. So it is ordered by what a reviewer needs, in the order they
 * need it:
 *
 *   1. the headline -- how many versions, how many files, how many bytes;
 *   2. anything alarming, hoisted to the top as warnings;
 *   3. what will physically happen, in plain words, including how many
 *      `.ffs_gui` chunks there are and how to run them;
 *   4. a per-song breakdown, biggest first;
 *   5. the per-asset version ladders, oldest to newest, showing what is KEPT
 *      next to what is going -- the single most useful view for spotting a
 *      mistake;
 *   6. the complete literal path list, per chunk, folded away.
 *
 * Nothing in here rounds a number the reviewer might act on without also
 * printing the exact byte count somewhere.
 * =============================================================================
 */

import type {
  ExportAssetLadder,
  ExportDataset,
  ExportSongRollup,
  ExportVersionRow,
} from './types.ts';

const TIB = 1024 ** 4;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const KIB = 1024;

/** Human byte size, rounded to the unit a reviewer thinks in. */
export function formatBytes(bytes: number): string {
  if (bytes >= TIB) return `${(bytes / TIB).toFixed(2)} TiB`;
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GiB`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  if (bytes >= KIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function n(x: number): string {
  return x.toLocaleString('en-GB');
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function stamp(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

/** Make a value safe inside a Markdown table cell. */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Backtick-quote a path, doubling the fence if the path itself has backticks. */
function code(s: string): string {
  return s.includes('`') ? `<code>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>` : `\`${s}\``;
}

const REASON_TEXT: Record<string, string> = {
  'kept-full-latest': 'inside the latest-N window',
  'kept-patch-newer-than-latest-full': 'patch above the current master — protected',
  'kept-patch-of-latest-full': 'patch on the current master — protected',
  'kept-no-full-versions': 'asset has no full versions — nothing can supersede it',
  'superseded-full': 'pushed out of the latest-N window by newer full versions',
  'superseded-patch': 'overtaken by a kept full version newer than it',
  'kept-proxy-only-newer-than-latest-full':
    'preview only, above the current master — protected, a preview never supersedes a master',
  'superseded-proxy-only': 'preview only, overtaken by a kept region-bearing version',
};

function reason(r: string): string {
  return REASON_TEXT[r] ?? r;
}

function songTable(rows: readonly ExportSongRollup[]): string[] {
  const out = [
    '| Song folder | Versions | Files | Bytes | Exact bytes | Proxy | Newest |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const s of rows) {
    out.push(
      `| ${cell(s.songFolder || '(archive root)')} | ${n(s.versionCount)} | ${n(s.fileCount)} ` +
        `| ${formatBytes(s.bytes)} | ${n(s.bytes)} | ${formatBytes(s.proxyBytes)} ` +
        `| ${day(s.latestMtime)} |`,
    );
  }
  return out;
}

function ladderTable(l: ExportAssetLadder): string[] {
  const out = [
    '| | Version | Kind | Files | Regions | Proxy | Bytes | Newest file | Verdict |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  for (const v of l.versions) {
    const marker = v.selected ? '**MOVE**' : 'keep';
    const kind = v.isPatch ? `patch frame ${v.patchFrame ?? 0}` : 'full';
    out.push(
      `| ${marker} | ${cell(v.verLabel)} | ${kind} | ${n(v.fileCount)} | ${n(v.regionCount)} ` +
        `| ${formatBytes(v.proxyBytes)} | ${formatBytes(v.bytes)} | ${day(v.latestMtime)} ` +
        `| ${v.status} — ${cell(reason(v.keepReason))} |`,
    );
  }
  return out;
}

function selectedInLadderOrder(l: ExportAssetLadder): ExportVersionRow[] {
  return l.versions.filter((v) => v.selected);
}

/** Render the whole review document. */
export function renderMarkdown(d: ExportDataset): string {
  const t = d.totals;
  const out: string[] = [];

  out.push(`# Archive removal review — ${d.runId}`);
  out.push('');
  out.push(
    '> **Nothing has been moved.** This document describes a *proposal*. ' +
      'No file on the archive has been touched, and none will be until you open a ' +
      '`.ffs_gui` job in FreeFileSync, press **Compare**, read the list, and press ' +
      '**Synchronize** yourself.',
  );
  out.push('');

  // ---------------------------------------------------------------- headline
  out.push('## Headline');
  out.push('');
  out.push('| | |');
  out.push('| --- | --- |');
  out.push(`| **Reclaimed** | **${formatBytes(t.totalBytes)}** (${n(t.totalBytes)} bytes) |`);
  out.push(`| Superseded versions | ${n(t.versionCount)} |`);
  out.push(`| Files listed | ${n(t.fileCount)} |`);
  out.push(`| Assets touched | ${n(t.assetCount)} across ${n(t.songCount)} song folder(s) |`);
  out.push(`| Proxy bytes inside that total | ${formatBytes(t.proxyBytes)} |`);
  out.push(`| Policy | keep latest **${d.keepN}** full version(s) per asset |`);
  out.push(
    `| Deletion policy | **${d.deletionPolicy}**${
      d.deletionPolicy === 'Versioning' ? ` → ${code(d.versioningFolder ?? '')}` : ''
    } |`,
  );
  out.push(`| FreeFileSync jobs | ${n(t.chunkCount)} × \`.ffs_gui\` |`);
  out.push(`| Generated | ${d.generatedAt} |`);
  out.push('');

  if (d.note) {
    out.push('### Note from the operator');
    out.push('');
    out.push(d.note.split('\n').map((l) => `> ${l}`).join('\n'));
    out.push('');
  }

  // ---------------------------------------------------------------- warnings
  if (d.warnings.length) {
    out.push('## ⚠ Read these first');
    out.push('');
    for (const w of d.warnings) out.push(`- ${w}`);
    out.push('');
  }

  // ------------------------------------------------------------ what happens
  out.push('## What will happen');
  out.push('');
  if (d.deletionPolicy === 'Versioning') {
    out.push(
      `Each job **moves** the listed files into ${code(d.versioningFolder ?? '')}, into a ` +
        'dated subfolder (`Style="TimeStamp-Folder"`). Nothing is erased. If you change ' +
        'your mind, the files are still there and can be put back.',
    );
  } else {
    out.push(
      'Each job sends the listed files to the **recycle bin / Trash** of the volume they ' +
        'live on. They are not erased in place, but recovery depends on that volume having ' +
        'a working trash and on it not being emptied. `Versioning` is the safer choice.',
    );
  }
  out.push('');
  out.push(
    '`Permanent` deletion is not offered by this tool and cannot be produced by it — ' +
      'the type does not allow it, the exporter asserts against it, and a test proves the ' +
      'assertion fires.',
  );
  out.push('');
  out.push(
    'Move detection is switched off in every job (`<DetectMovedFiles>false</DetectMovedFiles>`): ' +
      'the archive is a read-only mount, so FreeFileSync cannot write the `.ffs_db` it would ' +
      'need, and with an empty left-hand folder there is nothing to detect a move against.',
  );
  out.push('');
  out.push(
    `The work is split into **${n(t.chunkCount)}** \`.ffs_gui\` file(s), grouped by song ` +
      'folder. That is deliberate: each job points at the narrowest folder that contains ' +
      'its own files, so a job physically cannot see the rest of the archive, and each ' +
      'file stays short enough to read.',
  );
  out.push('');
  out.push('### Jobs');
  out.push('');
  out.push('| # | Job file | Manifest | Song folder(s) | Files | Bytes | Pair right-hand folder |');
  out.push('| ---: | --- | --- | --- | ---: | ---: | --- |');
  for (const c of d.chunks) {
    out.push(
      `| ${c.index} | ${code(c.guiFileName)} | ${code(c.manifestFileName)} ` +
        `| ${cell(c.songFolders.join(', '))} | ${n(c.fileCount)} | ${formatBytes(c.bytes)} ` +
        `| ${code(c.baseFolder)} |`,
    );
  }
  out.push('');
  out.push('### Checklist before you run anything');
  out.push('');
  out.push('1. Confirm the headline byte total above is the number you expected.');
  out.push('2. Skim the version ladders — every row marked **MOVE** should look wrong to keep.');
  out.push('3. Open one job in FreeFileSync and press **Compare** only.');
  out.push('4. Check the row count in FreeFileSync matches the **Files** column above.');
  out.push('5. Cross-check against the companion `.paths.txt` manifest for that job.');
  out.push('6. Only then press **Synchronize**, one job at a time.');
  out.push('');

  // ------------------------------------------------------------- provenance
  out.push('## Where these numbers come from');
  out.push('');
  out.push('| | |');
  out.push('| --- | --- |');
  out.push(`| Snapshot | #${d.snapshot.snapshotId}${d.snapshot.name ? ` — ${cell(d.snapshot.name)}` : ''} |`);
  out.push(`| Scan root | ${code(d.snapshot.root)} |`);
  out.push(`| Scan started | ${stamp(d.snapshot.startedAt)} |`);
  out.push(`| Scan finished | ${stamp(d.snapshot.finishedAt)} |`);
  out.push(`| Snapshot status | ${cell(d.snapshot.status)} |`);
  out.push(
    `| Snapshot contents | ${n(d.snapshot.fileCount)} files, ${formatBytes(d.snapshot.totalBytes)} |`,
  );
  out.push(
    `| Excluded bookkeeping files | ${n(d.snapshot.excludedCount)} (${formatBytes(
      d.snapshot.excludedBytes,
    )}) |`,
  );
  out.push(`| Files the grammar could not parse | ${n(d.snapshot.unparsedCount)} |`);
  out.push('');
  out.push(
    'Paths in this document are relative to the scan root unless shown in full. ' +
      'The scan is read-only: the analyser has never had a write handle on the archive.',
  );
  out.push('');

  // ---------------------------------------------------------------- by song
  out.push('## Per-song breakdown');
  out.push('');
  out.push('Largest reclaim first.');
  out.push('');
  out.push(...songTable(d.bySong));
  out.push('');
  out.push(
    `| **Total** | **${n(t.versionCount)}** | **${n(t.fileCount)}** ` +
      `| **${formatBytes(t.totalBytes)}** | **${n(t.totalBytes)}** ` +
      `| **${formatBytes(t.proxyBytes)}** | |`,
  );
  out.push('');

  // -------------------------------------------------------------- detail
  out.push('## Detail — version ladders');
  out.push('');
  out.push(
    'One table per asset, oldest version at the top. Rows marked **MOVE** are in this ' +
      'export; rows marked `keep` stay on the archive and are shown so you can see what ' +
      'survives.',
  );
  out.push('');

  let currentSong: string | null = null;
  for (const l of d.ladders) {
    if (l.songFolder !== currentSong) {
      currentSong = l.songFolder;
      out.push(`### ${currentSong || '(archive root)'}`);
      out.push('');
    }
    const sel = selectedInLadderOrder(l);
    out.push(`#### ${l.base}`);
    out.push('');
    out.push(
      `Family \`${l.family}\` · ${n(sel.length)} of ${n(l.versions.length)} version(s) in this ` +
        `export · ${formatBytes(l.selectedBytes)} (${n(l.selectedBytes)} bytes) · ` +
        `${n(l.selectedFileCount)} file(s).`,
    );
    out.push('');
    out.push(...ladderTable(l));
    out.push('');
  }

  // ---------------------------------------------------------- literal paths
  out.push('## The literal path list');
  out.push('');
  out.push(
    'This is the list FreeFileSync will act on, reproduced from the same array that ' +
      'generates the `<Include>` filter in each job. Review the concrete paths — never ' +
      'the filter patterns.',
  );
  out.push('');
  for (const c of d.chunks) {
    out.push(
      `<details><summary><strong>Job ${c.index}</strong> — ${cell(c.guiFileName)} — ` +
        `${n(c.fileCount)} file(s), ${formatBytes(c.bytes)}</summary>`,
    );
    out.push('');
    out.push('```text');
    out.push(`# right-hand folder: ${c.baseFolder}`);
    for (const rel of c.relPaths) out.push(`${d.snapshot.root}/${rel}`);
    out.push('```');
    out.push('');
    out.push('</details>');
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(
    `Generated by metal-media-size · run \`${d.runId}\` · ` +
      `snapshot #${d.snapshot.snapshotId} · ${d.generatedAt}`,
  );
  out.push('');
  return out.join('\n');
}

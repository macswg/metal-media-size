/**
 * ============================================================================
 *  EXPORT LAYER, END TO END
 * ============================================================================
 *
 * Builds a small index database in a scratch directory, runs the real
 * `writeExport`, and then reads back what landed on disk.
 *
 * The load-bearing assertion is the LAST group: the path list inside each
 * `.ffs_gui` must equal the path list in the JSON manifest AND the path list in
 * the plain-text manifest. A divergence there means the human approves one set
 * of files and FreeFileSync acts on another.
 *
 * No byte totals are hard-coded against the real archive: they are computed
 * from the fixture, so a change to the version grammar cannot silently make
 * this test assert a stale number.
 * ============================================================================
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';

import { openDb } from '../src/db/index.ts';
import {
  writeExport,
  buildDataset,
  buildChunks,
  resolveRightFolder,
} from '../src/export/index.ts';
import { buildRemovalGui, unescapeXml } from '../src/export/ffs.ts';
import type { ExportChunk, ExportVersionRow } from '../src/export/types.ts';

const ROOT = '/Users/Shared/ObjectMount.noindex/show-archive/SHOW_2026/00_D3_Delivery';
const SONG_A = '010_ONE & TWO [LL180]';
const SONG_B = '020_FADE';
const BASE_A = '010_ONE & TWO [LL180]_MAIN';
const BASE_B = '020_FADE_ANIMATIC';

const GIB = 1024 ** 3;

let sandbox: string;
let exportsDir: string;
let db: Db;

/** version label -> its row id, so the test never guesses an id. */
const versionIds = new Map<string, number>();
/** version label -> the rel paths it covers. */
const versionPaths = new Map<string, string[]>();

interface Spec {
  verNum: number;
  subLetter: string | null;
  isPatch?: boolean;
  patchFrame?: number | null;
  /** Key used by the test to find the row id. */
  label: string;
  /** What the scanner would have stored in ver_label. Defaults to `label`. */
  verLabel?: string;
  files: { name: string; size: number; proxy?: boolean }[];
}

function seed(): void {
  const now = Date.UTC(2026, 0, 1);
  const snapshotId = Number(
    db
      .prepare(
        `INSERT INTO snapshot
           (root, started_at, finished_at, file_count, total_bytes, status, name,
            excluded_count, excluded_bytes, unparsed_count)
         VALUES (?, ?, ?, ?, ?, 'complete', 'fixture', 12, 4096, 0)`,
      )
      .run(ROOT, now, now + 1000, 0, 0).lastInsertRowid,
  );

  const insAsset = db.prepare(
    `INSERT INTO asset (snapshot_id, song_folder, base, family) VALUES (?, ?, ?, ?)`,
  );
  const insVersion = db.prepare(
    `INSERT INTO asset_version
       (asset_id, ver_num, sub_letter, is_patch, patch_frame, bytes, file_count,
        proxy_bytes, region_count, latest_mtime, ver_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insFile = db.prepare(
    `INSERT INTO file
       (snapshot_id, rel_path, song_folder, name, ext, size, mtime, parse_ok, asset_version_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  );

  let totalFiles = 0;
  let totalBytes = 0;

  const build = (song: string, base: string, family: string, specs: Spec[]): void => {
    const assetId = Number(insAsset.run(snapshotId, song, base, family).lastInsertRowid);
    for (const s of specs) {
      const bytes = s.files.reduce((n, f) => n + f.size, 0);
      const proxyBytes = s.files.filter((f) => f.proxy).reduce((n, f) => n + f.size, 0);
      const versionId = Number(
        insVersion.run(
          assetId,
          s.verNum,
          s.subLetter,
          s.isPatch ? 1 : 0,
          s.patchFrame ?? null,
          bytes,
          s.files.length,
          proxyBytes,
          s.files.filter((f) => !f.proxy).length,
          now,
          s.verLabel ?? s.label,
        ).lastInsertRowid,
      );
      versionIds.set(s.label, versionId);
      const paths: string[] = [];
      for (const f of s.files) {
        const rel = `${song}/${f.name}`;
        paths.push(rel);
        insFile.run(snapshotId, rel, song, f.name, 'mov', f.size, now, versionId);
        totalFiles += 1;
        totalBytes += f.size;
      }
      versionPaths.set(s.label, paths);
    }
  };

  const regionFiles = (v: string, n: number, size: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `${BASE_A}_${v}_region${i + 1}.mov`, size }));

  build(SONG_A, BASE_A, 'VENUE', [
    { verNum: 1, subLetter: null, label: 'v001', files: regionFiles('v001', 2, 10 * GIB) },
    // v002 and v002d are DIFFERENT versions, not one folded row.
    { verNum: 2, subLetter: null, label: 'v002', files: regionFiles('v002', 2, 11 * GIB) },
    { verNum: 2, subLetter: 'd', label: 'v002d', files: regionFiles('v002d', 2, 12 * GIB) },
    {
      verNum: 3,
      subLetter: null,
      label: 'v003',
      files: [
        ...regionFiles('v003', 2, 13 * GIB),
        { name: `${BASE_A}_v003_proxy1_region0.mov`, size: 2 * GIB, proxy: true },
      ],
    },
  ]);

  build(SONG_B, BASE_B, 'ANIMATIC', [
    {
      verNum: 1,
      subLetter: null,
      label: 'B-v001',
      verLabel: 'v001',
      files: [{ name: `${BASE_B}_v001.mov`, size: 5 * GIB }],
    },
    {
      verNum: 2,
      subLetter: null,
      label: 'B-v002',
      verLabel: 'v002',
      files: [{ name: `${BASE_B}_v002.mov`, size: 6 * GIB }],
    },
  ]);

  db.prepare(`UPDATE snapshot SET file_count = ?, total_bytes = ? WHERE id = ?`).run(
    totalFiles,
    totalBytes,
    snapshotId,
  );
}

/** The superseded set at keep-latest-1. */
function supersededIds(): number[] {
  return ['v001', 'v002', 'v002d', 'B-v001'].map((l) => versionIds.get(l) as number);
}

function includeItemsOf(xml: string): string[] {
  const block = /<Include>([\s\S]*?)<\/Include>/.exec(xml);
  if (!block) throw new Error('no <Include> block');
  return [...(block[1] as string).matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map((m) =>
    unescapeXml(m[1] as string),
  );
}

function manifestPathsOf(text: string): string[] {
  return text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
}

const BASE_OPTS = {
  formats: ['json', 'markdown', 'ffs_gui'] as ('json' | 'markdown' | 'ffs_gui')[],
  deletionPolicy: 'Versioning' as const,
  versioningFolder: '/Users/Shared/reclaim-versions',
  keepN: 1,
};

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'metal-media-size-export-'));
  exportsDir = join(sandbox, 'exports');
  db = openDb(join(sandbox, 'index.db'));
  seed();
});

afterAll(() => {
  db.close();
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('writeExport produces the expected artefacts', () => {
  it('writes JSON, Markdown, one .ffs_gui per song and a manifest beside each', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-A',
      note: 'Reviewed with Sean on 2026-08-25.',
      // The per-song layout is no longer the default; this test is about it.
      jobLayout: 'per-song',
    });

    expect(res.files.filter((f) => f.format === 'json')).toHaveLength(1);
    expect(res.files.filter((f) => f.format === 'markdown')).toHaveLength(1);
    expect(res.files.filter((f) => f.format === 'ffs_gui')).toHaveLength(2);
    expect(res.files.filter((f) => f.format === 'ffs_manifest')).toHaveLength(2);
    for (const f of res.files) {
      expect(f.bytes).toBeGreaterThan(0);
      expect(existsSync(f.path)).toBe(true);
    }
    expect(res.summary.chunkCount).toBe(2);
    expect(res.summary.songCount).toBe(2);
    expect(res.summary.assetCount).toBe(2);
    expect(res.summary.versionCount).toBe(4);
  });

  it('lands everything inside exports/ and nothing anywhere else', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-B',
    });
    for (const f of res.files) {
      expect(f.path.startsWith(res.summary.exportDir + '/')).toBe(true);
    }
    expect(res.summary.exportDir).toContain('/exports/export-RUN-B');
    // The real object mount may well be attached on this machine. Nothing this
    // export produced may be anywhere near it.
    for (const f of res.files) {
      expect(f.path.startsWith('/Users/Shared/ObjectMount.noindex')).toBe(false);
      expect(f.path.startsWith('/Volumes/')).toBe(false);
      expect(f.path.startsWith(ROOT)).toBe(false);
    }
  });

  it('creates a genuinely empty left-hand folder for the folder pair', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-C',
    });
    const emptyLeft = join(res.summary.exportDir, '_empty_left');
    expect(existsSync(emptyLeft)).toBe(true);
    expect(readdirSync(emptyLeft)).toEqual([]);
    const gui = readFileSync(
      res.files.find((f) => f.format === 'ffs_gui')?.path as string,
      'utf8',
    );
    expect(gui).toContain(`<Left  Threads="8">${emptyLeft}</Left>`);
  });

  it('never overwrites an earlier export', async () => {
    const a = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-D',
    });
    const b = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-D',
    });
    expect(b.summary.exportDir).not.toBe(a.summary.exportDir);
    expect(existsSync(join(a.summary.exportDir, 'manifest.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the export refuses to write anything it should not', () => {
  it("rejects deletionPolicy 'Permanent'", async () => {
    await expect(
      writeExport({
        ...BASE_OPTS,
        deletionPolicy: 'Permanent' as unknown as 'RecycleBin',
        versionIds: supersededIds(),
        db,
        exportsDir,
      }),
    ).rejects.toThrow(/Permanent.*forbidden/s);
    expect(readdirSync(exportsDir).some((d) => d.includes('Permanent'))).toBe(false);
  });

  it('rejects Versioning with no versioning folder', async () => {
    await expect(
      writeExport({
        ...BASE_OPTS,
        versioningFolder: null,
        versionIds: supersededIds(),
        db,
        exportsDir,
      }),
    ).rejects.toThrow(/requires versioningFolder/);
  });

  it('rejects an export directory aimed at the archive', async () => {
    await expect(
      writeExport({
        ...BASE_OPTS,
        versionIds: supersededIds(),
        db,
        exportsDir: ROOT,
      }),
    ).rejects.toThrow(/protected location/);
  });

  it('rejects an unknown version id rather than exporting a partial selection', async () => {
    await expect(
      writeExport({ ...BASE_OPTS, versionIds: [999_999], db, exportsDir }),
    ).rejects.toThrow(/Unknown asset-version id/);
  });

  it('rejects an empty selection and an empty format list', async () => {
    await expect(writeExport({ ...BASE_OPTS, versionIds: [], db, exportsDir })).rejects.toThrow(
      /versionIds is required/,
    );
    await expect(
      writeExport({ ...BASE_OPTS, formats: [], versionIds: supersededIds(), db, exportsDir }),
    ).rejects.toThrow(/formats is required/);
  });

  it('rejects .ffs_batch as a format: its <Batch> shape is unverified', async () => {
    await expect(
      writeExport({
        ...BASE_OPTS,
        formats: ['ffs_batch' as unknown as 'ffs_gui'],
        versionIds: supersededIds(),
        db,
        exportsDir,
      }),
    ).rejects.toThrow(/ffs_batch is deliberately not offered/);
  });
});

// ---------------------------------------------------------------------------

describe('version identity is never composed by the exporter', () => {
  it('renders ver_label verbatim, so v002 and v002d stay distinct', () => {
    const d = buildDataset(db, { ...BASE_OPTS, versionIds: supersededIds() });
    const labels = d.selected.map((v) => v.verLabel).sort();
    expect(labels).toEqual(['v001', 'v001', 'v002', 'v002d']);

    // Two DIFFERENT versions that share a version number, both selected.
    const two = d.selected.filter((v) => v.verNum === 2 && v.songFolder === SONG_A);
    expect(two).toHaveLength(2);
    expect(new Set(two.map((v) => v.verLabel))).toEqual(new Set(['v002', 'v002d']));
    expect(new Set(two.map((v) => v.versionId)).size).toBe(2);
  });

  it('shows both of them, separately, in the Markdown ladder', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-LABEL',
    });
    const md = readFileSync(
      res.files.find((f) => f.format === 'markdown')?.path as string,
      'utf8',
    );
    // The ladder shows v001, v002, v002d as MOVE and v003 as keep.
    expect(md).toMatch(/\| \*\*MOVE\*\* \| v002 \|/);
    expect(md).toMatch(/\| \*\*MOVE\*\* \| v002d \|/);
    expect(md).toMatch(/\| keep \| v003 \|/);
  });

  it('carries ver_label into the JSON manifest for every selected version', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-JSONLABEL',
    });
    const json = JSON.parse(
      readFileSync(res.files.find((f) => f.format === 'json')?.path as string, 'utf8'),
    ) as { selectedVersions: { verLabel: string; verNum: number; subLetter: string | null }[] };
    const v2 = json.selectedVersions.filter((v) => v.verNum === 2);
    expect(v2.map((v) => v.verLabel).sort()).toEqual(['v002', 'v002d']);
    expect(v2.find((v) => v.verLabel === 'v002d')?.subLetter).toBe('d');
  });
});

// ---------------------------------------------------------------------------

describe('the verdicts and totals come from computeReclaim, not from the exporter', () => {
  it('marks every selected version superseded at keep-1 and records why', () => {
    const d = buildDataset(db, { ...BASE_OPTS, versionIds: supersededIds() });
    for (const v of d.selected) {
      expect(v.status).toBe('superseded');
      expect(v.keepReason).toBe('superseded-full');
    }
    expect(d.warnings.filter((w) => w.includes('marked KEPT'))).toHaveLength(0);
  });

  it('warns loudly when a KEPT version is selected anyway', () => {
    const keptId = versionIds.get('v003') as number;
    const d = buildDataset(db, { ...BASE_OPTS, versionIds: [keptId] });
    expect(d.selected[0]?.status).toBe('kept');
    expect(d.warnings.join('\n')).toMatch(/marked KEPT at keep-1/);
  });

  it('warns when an asset would be left with nothing at all', () => {
    const all = ['v001', 'v002', 'v002d', 'v003'].map((l) => versionIds.get(l) as number);
    const d = buildDataset(db, { ...BASE_OPTS, versionIds: all });
    expect(d.warnings.join('\n')).toMatch(/Every version of .* is in this export/);
  });

  it('warns when RecycleBin is chosen over Versioning', () => {
    const d = buildDataset(db, {
      ...BASE_OPTS,
      deletionPolicy: 'RecycleBin',
      versioningFolder: null,
      versionIds: supersededIds(),
    });
    expect(d.warnings.join('\n')).toMatch(/Versioning` is the safer choice/);
  });

  it('totals the bytes of the selected versions and nothing else', () => {
    const d = buildDataset(db, { ...BASE_OPTS, versionIds: supersededIds() });
    const expected = (2 * 10 + 2 * 11 + 2 * 12 + 5) * GIB;
    expect(d.totals.totalBytes).toBe(expected);
    expect(d.totals.fileCount).toBe(7);
    expect(d.bySong.map((s) => s.songFolder)).toEqual([SONG_A, SONG_B]);
  });

  it('records the snapshot provenance so the export is self-describing', () => {
    const d = buildDataset(db, { ...BASE_OPTS, versionIds: supersededIds() });
    expect(d.snapshot.root).toBe(ROOT);
    expect(d.snapshot.name).toBe('fixture');
    expect(d.snapshot.status).toBe('complete');
    expect(d.snapshot.excludedCount).toBe(12);
    expect(d.snapshot.snapshotId).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('chunking', () => {
  it('gives each song its own job, pointed at that song folder only', () => {
    const d = buildDataset(db, {
      ...BASE_OPTS,
      versionIds: supersededIds(),
      jobLayout: 'per-song',
    });
    expect(d.chunks).toHaveLength(2);
    expect(d.chunks[0]?.baseFolder).toBe(`${ROOT}/${SONG_A}`);
    expect(d.chunks[1]?.baseFolder).toBe(`${ROOT}/${SONG_B}`);
    expect(d.chunks[0]?.songFolders).toEqual([SONG_A]);
    for (const c of d.chunks) {
      for (const inc of c.includes) expect(inc.startsWith('/')).toBe(true);
      expect(c.includes).toHaveLength(c.relPaths.length);
    }
  });

  it('splits a song that is too large, never across a version boundary', () => {
    const d = buildDataset(db, { ...BASE_OPTS, versionIds: supersededIds() });
    const songA = d.selected.filter((v) => v.songFolder === SONG_A);
    const chunks = buildChunks(songA, ROOT, 2, 'per-song');
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      expect(c.baseFolder).toBe(`${ROOT}/${SONG_A}`);
      // Every file of a version stays with its version.
      for (const id of c.versionIds) {
        const v = songA.find((x) => x.versionId === id) as ExportVersionRow;
        for (const f of v.files) expect(c.relPaths).toContain(f.relPath);
      }
    }
    expect(chunks.flatMap((c) => c.relPaths)).toHaveLength(6);
    expect(new Set(chunks.map((c) => c.guiFileName)).size).toBe(3);
  });

  it('accounts for every selected path exactly once, under either layout', () => {
    for (const jobLayout of ['single', 'per-song'] as const) {
      const d = buildDataset(db, { ...BASE_OPTS, versionIds: supersededIds(), jobLayout });
      const all = d.chunks.flatMap((c) => c.relPaths).sort();
      const expected = ['v001', 'v002', 'v002d', 'B-v001']
        .flatMap((l) => versionPaths.get(l) as string[])
        .sort();
      expect(all).toEqual(expected);
    }
  });

  it('keeps the old default reachable, and it still splits by song', () => {
    const d = buildDataset(db, {
      ...BASE_OPTS,
      versionIds: supersededIds(),
      jobLayout: 'per-song',
    });
    expect(d.chunks).toHaveLength(2);
  });

});

// ---------------------------------------------------------------------------

describe('the single-job layout', () => {
  /**
   * ONE `.ffs_gui` FOR THE WHOLE RUN, which is what an operator asked for after
   * meeting sixty-five of them. The pair moves up to the archive root and the
   * include filter is what narrows the job, so these tests pin the two things
   * that keeps true: every pattern is anchored and carries its song folder, and
   * the path list is still exactly the selected one.
   */
  it('emits exactly one job and one manifest, whatever the song count', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-SINGLE',
    });
    expect(res.files.filter((f) => f.format === 'ffs_gui')).toHaveLength(1);
    expect(res.files.filter((f) => f.format === 'ffs_manifest')).toHaveLength(1);
    expect(res.summary.chunkCount).toBe(1);
    // Two songs went in; one job came out, and it still knows about both.
    expect(res.summary.songCount).toBe(2);
  });

  it('is the default, so a caller that says nothing gets one file', () => {
    const d = buildDataset(db, { ...BASE_OPTS, versionIds: supersededIds() });
    expect(d.chunks).toHaveLength(1);
    expect(d.chunks[0]?.baseFolder).toBe(ROOT);
    expect(d.chunks[0]?.basePrefix).toBe('');
    expect(d.chunks[0]?.songFolders).toEqual([SONG_A, SONG_B].sort());
  });

  it('anchors every include at the root and keeps the song folder in it', () => {
    const d = buildDataset(db, { ...BASE_OPTS, versionIds: supersededIds() });
    const chunk = d.chunks[0] as ExportChunk;
    expect(chunk.includes).toHaveLength(chunk.relPaths.length);
    for (let i = 0; i < chunk.includes.length; i++) {
      const inc = chunk.includes[i] as string;
      expect(inc.startsWith('/')).toBe(true);
      // Anchored pattern minus its slash IS the root-relative path, so the
      // pair root plus the pattern is the file on disk.
      expect(inc.slice(1)).toBe(chunk.relPaths[i]);
      expect(inc.slice(1).includes('/')).toBe(true);
    }
  });

  it('does not split on maxPathsPerChunk -- not splitting is the point', () => {
    const d = buildDataset(db, {
      ...BASE_OPTS,
      versionIds: supersededIds(),
      maxPathsPerChunk: 1,
    });
    expect(d.chunks).toHaveLength(1);
    expect(d.chunks[0]?.fileCount).toBeGreaterThan(1);
  });

  it('says in the job itself that the filter is the only thing narrowing it', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-SINGLE-BANNER',
    });
    const gui = res.files.find((f) => f.format === 'ffs_gui')?.path as string;
    const xml = readFileSync(gui, 'utf8');
    expect(xml).toContain('the only one in this run');
    expect(xml).toContain('the include filter is what narrows it');
    // And the count the human is told to check is the real one.
    expect(xml).toContain(`${res.summary.fileCount} file(s)`);
  });

  it('still refuses to emit a job with an empty include list', () => {
    expect(() =>
      buildRemovalGui(
        {
          index: 1,
          songFolders: [],
          baseFolder: ROOT,
          pairRightFolder: ROOT,
          basePrefix: '',
          includes: [],
          relPaths: [],
          versionIds: [],
          bytes: 0,
          fileCount: 0,
          guiFileName: 'removal-all.ffs_gui',
          manifestFileName: 'removal-all.paths.txt',
        },
        {
          emptyLeftFolder: '/tmp/empty',
          deletionPolicy: 'RecycleBin',
          versioningFolder: null,
          manifestFileName: 'removal-all.paths.txt',
          chunkCount: 1,
          runId: 'RUN-EMPTY',
          generatedAt: '2026-08-26T00:00:00Z',
          note: null,
        },
      ),
    ).toThrow(/empty include list/i);
  });
});

// ---------------------------------------------------------------------------

describe('the right-hand folder', () => {
  /**
   * The job is generated on the machine that scanned the archive and run on a
   * machine that reaches the same delivery folder by a different path, so the
   * emitted `<Right>` is EMPTY by default and the operator sets it in
   * FreeFileSync. This works only because the include patterns are anchored and
   * relative -- they bind to whatever folder is chosen -- which is exactly what
   * these tests pin.
   */
  it('is blank by default, and the filter still carries every path', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-BLANK',
    });
    const xml = readFileSync(res.files.find((f) => f.format === 'ffs_gui')?.path as string, 'utf8');
    expect(/<Right Threads="8"><\/Right>|<Right Threads="8"\/>/.test(xml)).toBe(true);
    expect(includeItemsOf(xml)).toHaveLength(res.summary.fileCount as number);
  });

  it('tells the operator what to point it at, and that a parent will not do', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-BLANK-BANNER',
    });
    const xml = readFileSync(res.files.find((f) => f.format === 'ffs_gui')?.path as string, 'utf8');
    expect(xml).toContain('SET THE RIGHT-HAND FOLDER BEFORE YOU DO ANYTHING ELSE');
    // The folder as scanned, named as the thing to match on the other machine.
    expect(xml).toContain(ROOT);
    expect(xml).toContain('IT MUST BE THAT FOLDER ITSELF');
    expect(xml).toContain('0. Set the right-hand folder');
  });

  it('emits the scan root when the caller passes it', () => {
    // There is no separate "as scanned" value: a caller that wants the scanned
    // path says so by passing it. One meaning per value.
    const d = buildDataset(db, {
      ...BASE_OPTS,
      versionIds: supersededIds(),
      rightFolder: ROOT,
    });
    expect(d.chunks[0]?.pairRightFolder).toBe(ROOT);
  });

  it('takes an operator-supplied folder, and appends the song under per-song', () => {
    const single = buildDataset(db, {
      ...BASE_OPTS,
      versionIds: supersededIds(),
      rightFolder: '/Volumes/OtherMount/00_D3_Delivery',
    });
    expect(single.chunks[0]?.pairRightFolder).toBe('/Volumes/OtherMount/00_D3_Delivery');

    const perSong = buildDataset(db, {
      ...BASE_OPTS,
      versionIds: supersededIds(),
      jobLayout: 'per-song',
      // Trailing slash tolerated: an operator pasting a path should not have to
      // care, and a doubled separator in a folder-pair path is a real bug.
      rightFolder: '/Volumes/OtherMount/00_D3_Delivery/',
    });
    expect(perSong.chunks[0]?.pairRightFolder).toBe(
      `/Volumes/OtherMount/00_D3_Delivery/${SONG_A}`,
    );
  });

  it('resolves the choice the same way everywhere', () => {
    expect(resolveRightFolder(null, '')).toBe('');
    expect(resolveRightFolder('', '')).toBe('');
    expect(resolveRightFolder('/x', '')).toBe('/x');
    expect(resolveRightFolder('/x/', 'SONG/')).toBe('/x/SONG');
    expect(resolveRightFolder('/x///', 'SONG/')).toBe('/x/SONG');
  });

  it('still resolves every include against the scanned base in the manifest', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-BLANK-MANIFEST',
    });
    const man = res.files.find((f) => f.format === 'ffs_manifest')?.path as string;
    const text = readFileSync(man, 'utf8');
    expect(text).toContain('(blank in the job -- set it in FreeFileSync before running)');
    // The literal paths a human reviews are still absolute, against the scan.
    for (const line of manifestPathsOf(text)) expect(line.startsWith(`${ROOT}/`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('THE PATH LIST CANNOT DIVERGE', () => {
  // The invariant is about the path list, not about how it is cut up, so it is
  // asserted under BOTH layouts: one job at the archive root and one job per
  // song folder resolve their patterns against different pair roots and must
  // still land on the same absolute paths.
  it.each([
    ['single', 1],
    ['per-song', 2],
  ] as const)(
    'the .ffs_gui include list equals the JSON manifest equals the text manifest (%s)',
    async (jobLayout, expectedChunks) => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: `RUN-XCHECK-${jobLayout}`,
      jobLayout,
    });
    const json = JSON.parse(
      readFileSync(res.files.find((f) => f.format === 'json')?.path as string, 'utf8'),
    ) as {
      provenance: { scanRoot: string };
      freeFileSync: {
        chunks: {
          guiFileName: string;
          manifestFileName: string;
          pairRightFolder: string;
          scanBaseFolder: string;
          basePrefix: string;
          includePatterns: string[];
          relPaths: string[];
          absolutePaths: string[];
        }[];
      };
    };

    expect(json.freeFileSync.chunks).toHaveLength(expectedChunks);
    const dir = res.summary.exportDir;
    let seen = 0;

    for (const c of json.freeFileSync.chunks) {
      const xml = readFileSync(join(dir, c.guiFileName), 'utf8');
      const fromXml = includeItemsOf(xml);

      // 1. XML <Include> == JSON includePatterns
      expect(fromXml).toEqual(c.includePatterns);

      // 2. XML <Include>, resolved against the folder pair, == JSON relPaths
      expect(fromXml.map((i) => c.basePrefix + i.slice(1))).toEqual(c.relPaths);

      // 3. == the plain-text manifest the human actually reads
      const text = manifestPathsOf(readFileSync(join(dir, c.manifestFileName), 'utf8'));
      expect(text).toEqual(c.relPaths.map((p) => `${json.provenance.scanRoot}/${p}`));
      expect(text).toEqual(c.absolutePaths);

      // 4. == the paths listed in the Markdown review document
      const md = readFileSync(
        res.files.find((f) => f.format === 'markdown')?.path as string,
        'utf8',
      );
      for (const p of c.absolutePaths) expect(md).toContain(p);

      // 5. the pattern resolved against the folder the job will be pointed at
      //    is the real absolute path. That folder is blank in the file by
      //    default -- the operator sets it -- so the scan base is what the
      //    manifest resolves against, and `scanBaseFolder` records it.
      expect(c.pairRightFolder).toBe('');
      for (let i = 0; i < fromXml.length; i++) {
        expect(`${c.scanBaseFolder}${fromXml[i]}`).toBe(c.absolutePaths[i]);
      }
      seen += fromXml.length;
    }
    expect(seen).toBe(res.summary.fileCount);
    },
  );

  it.each(['single', 'per-song'] as const)(
    'every listed path really belongs to a selected version (%s)',
    async (jobLayout) => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: `RUN-XCHECK2-${jobLayout}`,
      jobLayout,
    });
    const allowed = new Set(
      ['v001', 'v002', 'v002d', 'B-v001'].flatMap((l) => versionPaths.get(l) as string[]),
    );
    const forbidden = new Set(
      ['v003', 'B-v002'].flatMap((l) => versionPaths.get(l) as string[]),
    );
    const dir = res.summary.exportDir;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ffs_gui'))) {
      const xml = readFileSync(join(dir, f), 'utf8');
      // The job's own <Right> is empty by default (the operator sets it), so
      // the prefix comes from the run's JSON, which records the scanned base.
      const json = JSON.parse(
        readFileSync(res.files.find((x) => x.format === 'json')?.path as string, 'utf8'),
      ) as { freeFileSync: { chunks: { guiFileName: string; scanBaseFolder: string }[] } };
      const base = json.freeFileSync.chunks.find((c) => c.guiFileName === f)
        ?.scanBaseFolder as string;
      const prefix = base === ROOT ? '' : `${base.slice(ROOT.length + 1)}/`;
      for (const inc of includeItemsOf(xml)) {
        const rel = `${prefix}${inc.slice(1)}`;
        expect(allowed.has(rel)).toBe(true);
        expect(forbidden.has(rel)).toBe(false);
      }
    }
    },
  );

  it('escapes the ampersand in the real song folder name and recovers it', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-AMP',
      // Per-song, so the ampersand lands in the PAIR PATH -- the case this
      // test is named for. The single-job form puts it in the filter items
      // instead, which the test below covers.
      jobLayout: 'per-song',
    });
    const gui = readdirSync(res.summary.exportDir).filter((f) => f.endsWith('.ffs_gui'));
    const xml = readFileSync(join(res.summary.exportDir, gui[0] as string), 'utf8');
    expect(xml).toContain('&amp;');
    // An XML comment is the one context where a literal '&' is legal; the
    // markup itself must carry none.
    expect(xml.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(
      /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/,
    );
    expect(includeItemsOf(xml).every((i) => i.includes('ONE & TWO [LL180]'))).toBe(true);
  });

  it('escapes the ampersand inside a single job, where it lands in the filter', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededIds(),
      db,
      exportsDir,
      runId: 'RUN-AMP-SINGLE',
      jobLayout: 'single',
    });
    const gui = readdirSync(res.summary.exportDir).filter((f) => f.endsWith('.ffs_gui'));
    expect(gui).toHaveLength(1);
    const xml = readFileSync(join(res.summary.exportDir, gui[0] as string), 'utf8');
    expect(xml.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(
      /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/,
    );
    // The song folder now rides inside every include pattern rather than in the
    // pair path, so this is where the escaping has to hold.
    const items = includeItemsOf(xml);
    expect(items.some((i) => i.startsWith(`/${SONG_A}/`))).toBe(true);
    expect(items.every((i) => i.startsWith('/'))).toBe(true);
  });
});

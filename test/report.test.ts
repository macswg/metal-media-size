/**
 * ============================================================================
 *  THE SHAREABLE REPORT
 * ============================================================================
 *
 * Two things are being proved here, and they are different in kind.
 *
 * THE ARITHMETIC. The four keep-N rows on page one are the whole point of the
 * document, and an executive reading them has no way to check them. So the
 * properties that make them meaningful are asserted rather than eyeballed:
 * more versions kept can never free more space; each row's stated cost equals
 * the gap to the row above; the total under management is the same in every
 * row; the patch protection does not move when the choice moves; and the table
 * is computed over the WHOLE archive rather than over whatever the export
 * happened to select. That last one is the same rule that governs
 * `/api/reclaim` -- feed `computeReclaim` a subset and it will promote an old
 * version to "latest kept" and report a live master as reclaimable.
 *
 * THE ARTEFACT. This is the file that gets forwarded, so it has to render on a
 * machine that has never seen this project and may have no network: no script,
 * no external stylesheet, no remote font, no image reference. And it must not
 * misrepresent what the tool does -- nothing has been moved, and permanent
 * deletion is not something it can produce.
 * ============================================================================
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';

import { openDb, loadReclaimInput } from '../src/db/index.ts';
import { buildDataset, writeExport, buildScenarios, scenarioLabel } from '../src/export/index.ts';
import { MAX_REPORT_PATHS, renderReport, reportFileName, esc } from '../src/export/report.ts';
import { formatBytes } from '../src/export/markdown.ts';
import type { ExportDataset } from '../src/export/types.ts';

const ROOT = '/Users/Shared/ObjectMount.noindex/show-archive/SHOW_2026/00_D3_Delivery';
/** Ampersands and angle brackets in a real folder name, so escaping is exercised. */
const SONG = '010_ONE & TWO <LL180>';
const BASE = '010_ONE & TWO <LL180>_MAIN';
const SONG_B = '020_FADE';
const BASE_B = '020_FADE_ANIMATIC';

const GIB = 1024 ** 3;

/** Same grouping the renderer uses, so assertions match what is on the page. */
function n(x: number): string {
  return x.toLocaleString('en-GB');
}

let sandbox: string;
let exportsDir: string;
let db: Db;
let snapshotId: number;
/** label -> version row id */
const ids = new Map<string, number>();

interface Spec {
  label: string;
  verNum: number;
  subLetter?: string | null;
  isPatch?: boolean;
  patchFrame?: number | null;
  files: { name: string; size: number; proxy?: boolean; region0?: boolean }[];
}

function seed(): void {
  const now = Date.UTC(2026, 0, 1);
  snapshotId = Number(
    db
      .prepare(
        `INSERT INTO snapshot
           (root, started_at, finished_at, file_count, total_bytes, status, name,
            excluded_count, excluded_bytes, unparsed_count)
         VALUES (?, ?, ?, 0, 0, 'complete', 'fixture', 3, 1024, 2)`,
      )
      .run(ROOT, now, now + 1000).lastInsertRowid,
  );

  const insAsset = db.prepare(
    `INSERT INTO asset (snapshot_id, song_folder, base, family) VALUES (?, ?, ?, ?)`,
  );
  const insVersion = db.prepare(
    `INSERT INTO asset_version
       (asset_id, ver_num, sub_letter, is_patch, patch_frame, bytes, file_count,
        proxy_bytes, region0_bytes, region_count, latest_mtime, ver_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      const bytes = s.files.reduce((a, f) => a + f.size, 0);
      const proxyBytes = s.files.filter((f) => f.proxy).reduce((a, f) => a + f.size, 0);
      // Counted separately from proxyBytes and never derived from it: region0
      // says WHICH part of the canvas, a proxy token says what resolution.
      const region0Bytes = s.files.filter((f) => f.region0).reduce((a, f) => a + f.size, 0);
      // region0 is never a slice, with or without the proxy token on the name.
      const regionCount = s.files.filter((f) => !f.region0).length;
      const versionId = Number(
        insVersion.run(
          assetId,
          s.verNum,
          s.subLetter ?? null,
          s.isPatch ? 1 : 0,
          s.patchFrame ?? null,
          bytes,
          s.files.length,
          proxyBytes,
          region0Bytes,
          regionCount,
          now,
          s.label.replace(/^B-/, ''),
        ).lastInsertRowid,
      );
      ids.set(s.label, versionId);
      for (const f of s.files) {
        insFile.run(snapshotId, `${song}/${f.name}`, song, f.name, 'mov', f.size, now, versionId);
        totalFiles += 1;
        totalBytes += f.size;
      }
    }
  };

  const regions = (v: string, count: number, size: number) =>
    Array.from({ length: count }, (_, i) => ({
      name: `${BASE}_${v}_region${i + 1}.mov`,
      size,
    }));

  // Five full versions, so keep-1 through keep-4 are all genuinely different,
  // plus a patch above the newest full and a preview-only version.
  build(SONG, BASE, 'VENUE', [
    { label: 'v001', verNum: 1, files: regions('v001', 2, 10 * GIB) },
    { label: 'v002', verNum: 2, files: regions('v002', 2, 11 * GIB) },
    // v002d is a SEPARATE version from v002.
    { label: 'v002d', verNum: 2, subLetter: 'd', files: regions('v002d', 2, 12 * GIB) },
    { label: 'v003', verNum: 3, files: regions('v003', 2, 13 * GIB) },
    {
      label: 'v004',
      verNum: 4,
      files: [
        ...regions('v004', 2, 14 * GIB),
        { name: `${BASE}_v004_proxy3_region0.mov`, size: 2 * GIB, proxy: true, region0: true },
      ],
    },
    {
      label: 'v005patch',
      verNum: 5,
      isPatch: true,
      patchFrame: 120,
      files: [{ name: `${BASE}_v005_frame00120_region1.mov`, size: 3 * GIB }],
    },
    {
      label: 'v006proxy',
      verNum: 6,
      files: [
        { name: `${BASE}_v006_proxy3_region0.mov`, size: 1 * GIB, proxy: true, region0: true },
      ],
    },
  ]);

  build(SONG_B, BASE_B, 'ANIMATIC', [
    { label: 'B-v001', verNum: 1, files: [{ name: `${BASE_B}_v001_region1.mov`, size: 5 * GIB }] },
    { label: 'B-v002', verNum: 2, files: [{ name: `${BASE_B}_v002_region1.mov`, size: 6 * GIB }] },
    { label: 'B-v003', verNum: 3, files: [{ name: `${BASE_B}_v003_region1.mov`, size: 7 * GIB }] },
  ]);

  // Deliberately larger than the sum of the versions: the difference is the
  // "belongs to no version" figure the report prints.
  db.prepare(`UPDATE snapshot SET file_count = ?, total_bytes = ? WHERE id = ?`).run(
    totalFiles + 2,
    totalBytes + 4 * GIB,
    snapshotId,
  );
}

const BASE_OPTS = {
  formats: ['report'] as ['report'],
  deletionPolicy: 'RecycleBin' as const,
};

function id(label: string): number {
  return ids.get(label) as number;
}

/** Everything keep-1 supersedes in this fixture. */
function supersededAtKeep1(): number[] {
  return ['v001', 'v002', 'v002d', 'v003', 'B-v001', 'B-v002'].map(id);
}

function dataset(overrides: Record<string, unknown> = {}): ExportDataset {
  return buildDataset(db, {
    ...BASE_OPTS,
    versionIds: supersededAtKeep1(),
    keepN: 1,
    runId: 'RUN-R',
    now: new Date(Date.UTC(2026, 7, 27, 9, 30)),
    ...overrides,
  } as Parameters<typeof buildDataset>[1]);
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'metal-media-size-report-'));
  exportsDir = join(sandbox, 'exports');
  db = openDb(join(sandbox, 'index.db'));
  seed();
});

afterAll(() => {
  db.close();
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('the four keep-N scenarios', () => {
  it('reports one row per requested N, plus the export policy if it is not among them', () => {
    const assets = loadReclaimInput(db, snapshotId);
    expect(buildScenarios(assets, [1, 2, 3, 4], 1).map((s) => s.keepN)).toEqual([1, 2, 3, 4]);
    // A policy outside the standard four is ADDED rather than dropped: a report
    // that marked no row as the current one would be worse than a longer table.
    expect(buildScenarios(assets, [1, 2, 3, 4], 7).map((s) => s.keepN)).toEqual([1, 2, 3, 4, 7]);
  });

  it('labels each row from its N, so the label and the arithmetic cannot drift', () => {
    expect(scenarioLabel(1)).toBe('Current version only');
    expect(scenarioLabel(2)).toBe('Current + 1 previous version');
    expect(scenarioLabel(3)).toBe('Current + 2 previous versions');
    expect(scenarioLabel(4)).toBe('Current + 3 previous versions');
  });

  it('never frees MORE space by keeping MORE versions', () => {
    const rows = buildScenarios(loadReclaimInput(db, snapshotId), [1, 2, 3, 4], 1);
    for (let i = 1; i < rows.length; i += 1) {
      expect((rows[i] as { reclaimBytes: number }).reclaimBytes).toBeLessThanOrEqual(
        (rows[i - 1] as { reclaimBytes: number }).reclaimBytes,
      );
    }
    // And the fixture is built so the four rows are genuinely distinct --
    // otherwise the assertion above would pass on a table of identical rows.
    expect(new Set(rows.map((r) => r.reclaimBytes)).size).toBe(4);
  });

  it("states each row's cost as the gap to the row above it", () => {
    const rows = buildScenarios(loadReclaimInput(db, snapshotId), [1, 2, 3, 4], 1);
    expect(rows[0]?.costVsRowAbove).toBe(0);
    for (let i = 1; i < rows.length; i += 1) {
      const above = rows[i - 1] as { reclaimBytes: number };
      const row = rows[i] as { reclaimBytes: number; costVsRowAbove: number };
      expect(row.costVsRowAbove).toBe(above.reclaimBytes - row.reclaimBytes);
    }
  });

  it('keeps the total under management constant across every row', () => {
    const rows = buildScenarios(loadReclaimInput(db, snapshotId), [1, 2, 3, 4], 1);
    const totals = new Set(rows.map((r) => r.reclaimBytes + r.keptBytes));
    expect(totals.size).toBe(1);
  });

  it('holds the patch protection constant across every row', () => {
    const rows = buildScenarios(loadReclaimInput(db, snapshotId), [1, 2, 3, 4], 1);
    expect(new Set(rows.map((r) => r.protectedPatchBytes)).size).toBe(1);
    // The fixture has a live patch, so the constant is not trivially zero.
    expect(rows[0]?.protectedPatchBytes).toBe(3 * GIB);
  });

  it('splits each row by song folder, summing back to that row', () => {
    const rows = buildScenarios(loadReclaimInput(db, snapshotId), [1, 2, 3, 4], 1);
    for (const r of rows) {
      expect(r.bySong.reduce((a, s) => a + s.reclaimBytes, 0)).toBe(r.reclaimBytes);
      expect(r.bySong.reduce((a, s) => a + s.supersededVersions, 0)).toBe(r.reclaimVersions);
    }
  });

  it('is computed over the whole archive, not over the export selection', () => {
    // The load-bearing one. Narrowing the input to `computeReclaim` promotes an
    // older version to "latest kept", which would report a live master as
    // reclaimable. The scenario table must not move when the selection does.
    const wide = dataset();
    const narrow = dataset({ versionIds: [id('v001')] });
    expect(narrow.scenarios.map((s) => s.reclaimBytes)).toEqual(
      wide.scenarios.map((s) => s.reclaimBytes),
    );
    expect(narrow.scenarioBasis).toEqual(wide.scenarioBasis);
    // ...while the export's own totals do move, which is the whole distinction.
    expect(narrow.totals.totalBytes).toBeLessThan(wide.totals.totalBytes);
  });

  it('marks exactly the row the export was computed under', () => {
    const d = dataset({ keepN: 3, versionIds: [id('v001')] });
    const marked = d.scenarios.filter((s) => s.isExportPolicy);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.keepN).toBe(3);
  });

  it('reports the storage location as it stands, independent of the selection', () => {
    const wide = dataset();
    const narrow = dataset({ versionIds: [id('v002')] });
    // The tiles describe the storage, not the proposal, so they cannot move
    // when the proposal does.
    expect(narrow.storage).toEqual(wide.storage);
    expect(wide.storage.totalBytes).toBe(wide.snapshot.totalBytes);
    expect(wide.storage.fileCount).toBe(wide.snapshot.fileCount);
    expect(wide.storage.songCount).toBe(2);
    // Two whole-canvas copies in the fixture: 2 GiB on v004, 1 GiB on v006.
    expect(wide.storage.region0Bytes).toBe(3 * GIB);
    // Counted separately from the proxy subtotal and never derived from it.
    // They coincide here, as they do on the real archive, and are not required
    // to -- so the two numbers are summed independently.
    expect(wide.storage.proxyBytes).toBe(3 * GIB);
  });

  it('counts the snapshot bytes that belong to no version', () => {
    const d = dataset();
    expect(d.scenarioBasis.unversionedBytes).toBe(4 * GIB);
    expect(d.scenarioBasis.versionedBytes).toBe(
      d.snapshot.totalBytes - d.scenarioBasis.unversionedBytes,
    );
  });
});

// ---------------------------------------------------------------------------

describe('the rendered report', () => {
  let html: string;
  let d: ExportDataset;
  /** Everything from the stat tiles down to the safety banner. */
  let tiles: string;

  beforeAll(() => {
    d = dataset({ note: 'Reviewed with production on 2026-08-27.' });
    html = renderReport(d);
    tiles = html.slice(html.indexOf('<div class="stats">'), html.indexOf('<div class="banner">'));
  });

  it('is a complete HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).toContain('<title>');
  });

  it('carries nothing it would have to fetch to render', () => {
    // It is going to be mailed to someone. It has to render on their machine,
    // offline, with no part of it silently missing.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\ssrc\s*=/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).toContain('<style>');
  });

  it('paginates when printed, which is how it becomes a PDF', () => {
    expect(html).toContain('@page');
    expect(html).toContain('@media print');
    expect(html).toContain('break-after: page');
    expect(html).toContain('print-color-adjust: exact');
  });

  it('leads with the four options and their sizes', () => {
    for (const s of d.scenarios) {
      expect(html).toContain(esc(s.label));
    }
    // The options page comes before everything else in the document.
    const options = html.indexOf('The options');
    const detail = html.indexOf('Every affected asset');
    expect(options).toBeGreaterThan(-1);
    expect(detail).toBeGreaterThan(options);
  });

  it('opens with what is on the storage and how much of it is region 0', () => {
    expect(tiles).toContain('Total assets today');
    expect(tiles).toContain(esc(formatBytes(d.storage.totalBytes).split(' ')[0] as string));
    expect(tiles).toContain('Region 0');
    expect(tiles).toContain(esc(formatBytes(d.storage.region0Bytes).split(' ')[0] as string));
    expect(tiles).toContain(`${n(d.storage.fileCount)} files`);
    // Above the options, which is the point of putting them there.
    expect(html.indexOf('<div class="stats">')).toBeLessThan(html.indexOf('The options'));
  });

  it('names the folder it scanned, right under those figures', () => {
    // The figures are meaningless without the folder they came from, and page
    // three is too late for someone who reads only the summary.
    expect(tiles).toContain('Folder scanned');
    const strip = html.slice(html.indexOf('<div class="scanned">'), html.indexOf('<div class="banner">'));
    expect(strip).toContain(esc(ROOT));
    expect(html.indexOf('<div class="stats">')).toBeLessThan(html.indexOf('<div class="scanned">'));
    expect(html.indexOf('<div class="scanned">')).toBeLessThan(html.indexOf('The options'));
  });

  it('is titled as a media cleanup', () => {
    expect(html).toContain('Media cleanup — executive summary');
    expect(html).not.toContain('Archive reclaim');
  });

  it('presents the options without marking which one the job uses', () => {
    // The person page one is written for does not know an export was selected,
    // and a highlighted row reads to them as a recommendation nobody made. So
    // the choice table must be neutral: no badge, no tinted row, and no figure
    // that belongs to the attached job rather than to an option.
    // v002 alone: 22 GiB, which is not the reclaim of any of the four options
    // in this fixture (103 / 71 / 42 / 20 GiB), so the figure is unambiguous.
    const sub = dataset({ versionIds: [id('v002')] });
    const subHtml = renderReport(sub);
    const table = subHtml.slice(
      subHtml.indexOf('<table class="choices"'),
      subHtml.indexOf('</table>', subHtml.indexOf('<table class="choices"')),
    );
    expect(table).not.toContain('THIS EXPORT');
    expect(table).not.toContain('current');
    expect(subHtml).not.toContain('THIS EXPORT');

    // The export's own headline -- its byte total, set large -- belongs to page
    // two. Page one carries no figure that is the attached job's rather than an
    // option's, and the structural check for that is that the headline block
    // does not appear before page two starts.
    const pageTwo = subHtml.indexOf('The proposal attached to this report');
    expect(pageTwo).toBeGreaterThan(-1);
    const pageOne = subHtml.slice(0, pageTwo);
    expect(pageOne).not.toContain('class="headline"');
    expect(subHtml.slice(pageTwo)).toContain('class="headline"');
    // ...and page two is where the tie-back to an option is made.
    expect(subHtml.slice(pageTwo)).toContain('option on page one');
    // The selection here is a strict subset, so page two says so rather than
    // letting the reader assume the job is the whole option.
    expect(sub.totals.totalBytes).toBeLessThan(
      sub.scenarios.find((sc) => sc.isExportPolicy)?.reclaimBytes ?? 0,
    );
    expect(subHtml.slice(pageTwo)).toContain('subset');
    expect(subHtml.slice(pageTwo)).toContain(formatBytes(sub.totals.totalBytes));
  });

  it('is dark on screen and ink on paper', () => {
    // A dark page either floods a printer with toner or, when the browser drops
    // the backgrounds, prints pale text on white. The PDF route is the reason
    // this file is HTML at all, so the print block inverts the whole palette.
    const root = html.slice(html.indexOf(':root {'), html.indexOf('}', html.indexOf(':root {')));
    expect(root).toContain('--paper: #15181e');
    const print = html.slice(html.indexOf('@media print'));
    expect(print).toContain('--paper: #ffffff');
    expect(print).toContain('--ink: #16181d');
  });

  it('says plainly that nothing has been moved, and does not offer permanent deletion', () => {
    expect(html).toContain('Nothing has been moved.');
    expect(html).toContain('Permanent deletion is not offered by this tool');
    // Never as a value the reader could take for the policy in force.
    expect(html).not.toMatch(/>\s*Permanent\s*</);
    expect(html).toContain('RecycleBin');
  });

  it('escapes song and asset names rather than emitting them raw', () => {
    expect(html).toContain(esc(SONG));
    expect(html).not.toContain('010_ONE & TWO <LL180>');
    expect(html).not.toMatch(/<LL180>/);
  });

  it('shows what stays next to what goes', () => {
    expect(html).toContain('MOVE');
    expect(html).toContain('keep');
    // v004 is the current master at keep-1 and is not in the export, so it must
    // appear in its ladder as a kept row.
    expect(html).toContain('v004');
  });

  it('reproduces the operator note and the provenance', () => {
    expect(html).toContain('Reviewed with production on 2026-08-27.');
    expect(html).toContain(esc(ROOT));
    expect(html).toContain(`#${d.snapshot.snapshotId}`);
  });

  it('lists every literal path when the list is short enough to print', () => {
    const paths = d.chunks.flatMap((c) => c.relPaths);
    expect(paths.length).toBeLessThanOrEqual(MAX_REPORT_PATHS);
    for (const p of paths) expect(html).toContain(esc(`${ROOT}/${p}`));
  });
});

// ---------------------------------------------------------------------------

describe('the per-machine drive section', () => {
  /**
   * The fixture's regions land on the real rig: region1 -> 101 and 207,
   * region2 -> 206 and 305, region0 -> 306 and 307. The byte totals below are
   * summed from the fixture spec rather than read back off the code.
   *
   *   region 1  10+11+12+13+14+3 (asset A, incl. the patch) + 5+6+7 (asset B) = 81 GiB
   *   region 2  10+11+12+13+14                                               = 60 GiB
   *   region 0  2 (v004 proxy) + 1 (v006 proxy)                              =  3 GiB
   */
  let d: ExportDataset;
  let byId: Map<string, ExportDataset['machines'][number]>;

  beforeAll(() => {
    d = dataset();
    byId = new Map(d.machines.map((m) => [m.machineId, m]));
  });

  it('puts a region on every machine holding it', () => {
    expect(byId.get('101')?.totalBytes).toBe(81 * GIB);
    expect(byId.get('207')?.totalBytes).toBe(81 * GIB);
    expect(byId.get('206')?.totalBytes).toBe(60 * GIB);
    expect(byId.get('305')?.totalBytes).toBe(60 * GIB);
    expect(byId.get('306')?.totalBytes).toBe(3 * GIB);
    expect(byId.get('307')?.totalBytes).toBe(3 * GIB);
    // A machine holding a region the fixture never uses is reported at zero
    // rather than dropped -- a rig with an idle drive is a fact, not a gap.
    expect(byId.get('104')?.totalBytes).toBe(0);
  });

  it('costs every machine at every option on page one, in the same order', () => {
    // The report puts a row's figures under the four rows of the table above
    // it; if the orders diverged, each column would be labelled with the wrong
    // option and the whole section would read plausibly and be wrong.
    for (const m of d.machines) {
      expect(m.options.map((o) => o.keepN)).toEqual(d.scenarios.map((sc) => sc.keepN));
    }
  });

  it('never frees more on a drive by keeping more versions', () => {
    for (const m of d.machines) {
      for (let i = 1; i < m.options.length; i += 1) {
        expect((m.options[i] as { recoverableBytes: number }).recoverableBytes).toBeLessThanOrEqual(
          (m.options[i - 1] as { recoverableBytes: number }).recoverableBytes,
        );
      }
    }
  });

  it('leaves behind exactly what it did not free', () => {
    for (const m of d.machines) {
      for (const o of m.options) {
        expect(o.recoverableBytes + o.remainingBytes).toBe(m.totalBytes);
        expect(o.remainingFraction).toBeCloseTo(o.remainingBytes / m.usableBytes, 12);
      }
    }
  });

  it('does not move what is ON the drive when the option moves', () => {
    // Only the reclaim varies with keep-N. The media is on the disk until
    // somebody removes it.
    const other = dataset({ keepN: 1 });
    for (const m of other.machines) {
      expect(m.totalBytes).toBe(byId.get(m.machineId)?.totalBytes);
    }
  });

  it('renders the section below the options table and above what holds', () => {
    const html = renderReport(d);
    const options = html.indexOf('The options');
    const drives = html.indexOf('Where it lands: the playback machines');
    const holds = html.indexOf('What holds whichever option is chosen');
    expect(options).toBeGreaterThan(-1);
    expect(drives).toBeGreaterThan(options);
    expect(holds).toBeGreaterThan(drives);
    expect(html).toContain('reserved headroom');
    // Rows overlap by design, so the section must say so where it draws them.
    expect(html).toContain('must not be added up as archive');
  });

  it('declares the two threshold colours', () => {
    const html = renderReport(d);
    expect(html).toContain('.pct.is-watch { color: var(--hold); }');
    expect(html).toContain('.pct.is-over { color: var(--warn); font-weight: 700; }');
  });

  it('paints amber past 75% and red past 90%, wherever the figure appears', () => {
    // The fixture's drives are all but empty, so the bands that matter are
    // never reached by it. Set the fractions explicitly.
    const want = [
      { used: 0.5, opt: 0.74, usedCls: 'ok', optCls: 'ok', usedPct: '50', optPct: '74' },
      { used: 0.8, opt: 0.75, usedCls: 'watch', optCls: 'watch', usedPct: '80', optPct: '75' },
      { used: 0.95, opt: 0.9, usedCls: 'critical', optCls: 'critical', usedPct: '95', optPct: '90' },
      { used: 1.2, opt: 1.0, usedCls: 'over', optCls: 'over', usedPct: '120', optPct: '100' },
    ];
    const staged: ExportDataset = {
      ...d,
      machines: want.map((w, i) => ({
        ...(d.machines[i] as ExportDataset['machines'][number]),
        machineId: `t${i}`,
        name: `T${i}`,
        usedFraction: w.used,
        options: (d.machines[i] as ExportDataset['machines'][number]).options.map((o) => ({
          ...o,
          remainingFraction: w.opt,
        })),
      })),
    };
    const html = renderReport(staged);
    for (const w of want) {
      expect(html).toContain(`<td class="num pct is-${w.usedCls}">${w.usedPct}%</td>`);
      expect(html).toContain(`<td class="num pct is-${w.optCls}">${w.optPct}%</td>`);
    }
  });

  it('never prints a figure whose colour contradicts the number', () => {
    // 74.5% displays as "75%". Grading the exact fraction would leave that cell
    // uncoloured, so the page would show a number at the threshold that is not
    // treated as being at it. The band is taken from what is PRINTED.
    const staged: ExportDataset = {
      ...d,
      machines: [
        {
          ...(d.machines[0] as ExportDataset['machines'][number]),
          usedFraction: 0.745,
          options: [],
        },
      ],
    };
    expect(renderReport(staged)).toContain('<td class="num pct is-watch">75%</td>');
  });

  it('can be left out when a caller does not want the extra pass', () => {
    const without = dataset({ includeMachines: false });
    expect(without.machines).toEqual([]);
    expect(renderReport(without)).not.toContain('Where it lands');
  });
});

// ---------------------------------------------------------------------------

describe('writeExport emits the report', () => {
  it('produces report.html and nothing else when only the report is asked for', async () => {
    const res = await writeExport({
      ...BASE_OPTS,
      versionIds: supersededAtKeep1(),
      keepN: 1,
      db,
      exportsDir,
      runId: 'RUN-W',
    });
    const report = res.files.filter((f) => f.format === 'report');
    expect(report).toHaveLength(1);
    expect(report[0]?.path).toMatch(
      /\/media_cleanup_report_\d{2}(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\d{4}_\d{4}\.html$/,
    );
    expect(existsSync(report[0]?.path as string)).toBe(true);
    expect(readFileSync(report[0]?.path as string, 'utf8').startsWith('<!doctype html>')).toBe(true);
    // The .ffs_gui was not requested, so no job and no empty left-hand folder.
    expect(res.files.some((f) => f.format === 'ffs_gui')).toBe(false);
  });

  it('ships alongside the job and the manifests when all formats are asked for', async () => {
    const res = await writeExport({
      versionIds: supersededAtKeep1(),
      formats: ['ffs_gui', 'report', 'json', 'markdown'],
      deletionPolicy: 'RecycleBin',
      keepN: 1,
      db,
      exportsDir,
      runId: 'RUN-X',
    });
    const formats = res.files.map((f) => f.format);
    expect(formats).toContain('report');
    expect(formats).toContain('ffs_gui');
    expect(formats).toContain('ffs_manifest');
    expect(formats).toContain('json');
    expect(formats).toContain('markdown');
  });
});

// ---------------------------------------------------------------------------

describe('the report is named for when it was produced', () => {
  it('stamps the local day and time into the file name', () => {
    // Built from LOCAL components on purpose, so the expectation holds in any
    // time zone -- the name is local time, and a UTC fixture here would assert
    // one thing on this machine and another in CI.
    expect(reportFileName(new Date(2026, 7, 27, 11, 12))).toBe(
      'media_cleanup_report_27Aug2026_1112.html',
    );
  });

  it('pads the day and the time so a folder of them sorts', () => {
    expect(reportFileName(new Date(2026, 0, 5, 9, 4))).toBe(
      'media_cleanup_report_05Jan2026_0904.html',
    );
    expect(reportFileName(new Date(2026, 11, 31, 23, 59))).toBe(
      'media_cleanup_report_31Dec2026_2359.html',
    );
  });

  it('uses fixed month literals rather than anything locale-dependent', () => {
    const months = Array.from({ length: 12 }, (_, m) => reportFileName(new Date(2026, m, 1, 0, 0)));
    expect(months.map((f) => f.slice('media_cleanup_report_01'.length, -'2026_0000.html'.length))).toEqual(
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    );
  });
});

describe('the path list never truncates silently', () => {
  it('says how many paths it is not printing, and where the full list is', () => {
    // Hand-built: producing 2,000+ real files in the fixture would cost more
    // than it proves. What matters is the wording when the cap bites.
    const d = dataset();
    const chunk = d.chunks[0] as { relPaths: string[]; fileCount: number; bytes: number };
    const inflated: ExportDataset = {
      ...d,
      chunks: [
        {
          ...(d.chunks[0] as ExportDataset['chunks'][number]),
          relPaths: Array.from(
            { length: MAX_REPORT_PATHS + 37 },
            (_, i) => `${SONG_B}/pad_v001_region${i}.mov`,
          ),
          fileCount: MAX_REPORT_PATHS + 37,
        },
      ],
    };
    const html = renderReport(inflated);
    expect(html).toContain('37 of 2,037 paths are not printed here');
    expect(html).toContain('.paths.txt');
    expect(chunk.relPaths.length).toBeGreaterThan(0);
  });
});

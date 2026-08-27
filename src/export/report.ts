/**
 * =============================================================================
 *  THE SHAREABLE REPORT  --  ONE SELF-CONTAINED HTML FILE. PURE, NO I/O.
 * =============================================================================
 *
 * WHY HTML AND NOT PDF
 *
 * This project has no build step, no bundler and three runtime dependencies.
 * Producing a PDF directly would mean either a PDF library or a headless
 * browser -- a large dependency, in the one module whose output a person is
 * expected to trust, to gain a format that a browser will produce from this
 * file in two keystrokes. So the report is a single `.html` file with its CSS
 * inline, no scripts, and no external references of any kind: it opens from a
 * mail attachment on a machine with no network, and `Cmd-P -> Save as PDF`
 * gives the PDF. The print stylesheet below is what makes that second step
 * come out paginated rather than merely printed.
 *
 * SELF-CONTAINED IS A PROPERTY, NOT A PREFERENCE. A report that fetched a font
 * or a stylesheet would render differently -- or blank -- on the machine of
 * whoever it was forwarded to. `test/report.test.ts` asserts the emitted file
 * contains no `http:` reference, no `<script`, and no `src=`.
 *
 * WHAT IS ON WHICH PAGE
 *
 *   1. The options, and NOTHING else. Four keep-N choices, what each returns,
 *      and what each rung of insurance costs. It does not say which one the
 *      attached job uses and does not badge a row: the person this page is
 *      written for has no idea an export was ever selected, and a highlighted
 *      row reads to them as a recommendation nobody made.
 *   2. Which of those options the attached job is, what it contains, what
 *      running it would do, and anything alarming.
 *   3. Where the numbers come from, and the per-song split at each choice.
 *   4+ The version ladders: every asset this export touches, showing what goes
 *      NEXT TO what stays. This is where a mistake is actually spotted.
 *   last. The literal path list.
 *
 * THE SCENARIO TABLE IS ARCHIVE-WIDE; THE REST OF THE DOCUMENT IS THIS EXPORT.
 * Those are two different scopes and the report says so on the page, every
 * time, rather than relying on the reader to infer it. See `scenarios.ts`.
 * =============================================================================
 */

import { formatBytes } from './markdown.ts';
import type {
  ExportAssetLadder,
  ExportDataset,
  ExportScenario,
  ExportSongRollup,
  ExportVersionRow,
} from './types.ts';

/**
 * Literal paths reproduced in the report before it starts summarising.
 *
 * The report is the document that gets forwarded; the complete list always
 * lives in the `.paths.txt` manifest beside each job and in `manifest.json`.
 * When the cap bites, the page says exactly how many paths it is not showing
 * and where the full list is -- a truncated list that looked complete would be
 * the single worst failure this document could have.
 */
export const MAX_REPORT_PATHS = 2000;

/** Assets given a full ladder table before the report switches to a summary. */
export const MAX_REPORT_LADDERS = 400;

/** Three-letter month names. Fixed here so the file name never depends on locale. */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * `media_cleanup_report_27Aug2026_1112.html`.
 *
 * LOCAL time, not UTC, and deliberately: the name is read by the person who
 * produced the report, on the machine that produced it, and a stamp seven hours
 * off the clock on their wall is worse than useless for telling two runs apart.
 * The UTC instant is still printed inside the document, so nothing is lost.
 *
 * Day and time are zero-padded so a folder of these sorts correctly within a
 * month, and the month is one of the twelve literals above rather than anything
 * locale-dependent -- a report named `27ago2026` would be a different file name
 * on a different machine for the same run.
 */
export function reportFileName(when: Date): string {
  const p2 = (x: number): string => String(x).padStart(2, '0');
  const stampedDay = `${p2(when.getDate())}${MONTHS[when.getMonth()]}${when.getFullYear()}`;
  const stampedTime = `${p2(when.getHours())}${p2(when.getMinutes())}`;
  return `media_cleanup_report_${stampedDay}_${stampedTime}.html`;
}

const REASON_TEXT: Record<string, string> = {
  'kept-full-latest': 'inside the kept window',
  'kept-patch-newer-than-latest-full': 'patch above the current master — protected',
  'kept-patch-of-latest-full': 'patch on the current master — protected',
  'kept-no-full-versions': 'no full versions exist — nothing can supersede it',
  'superseded-full': 'pushed out of the kept window by newer full versions',
  'superseded-patch': 'overtaken by a kept full version newer than it',
  'kept-proxy-only-newer-than-latest-full': 'preview only, above the current master — protected',
  'superseded-proxy-only': 'preview only, overtaken by a kept full version',
};

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Escape for HTML text and double-quoted attributes alike. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function n(x: number): string {
  return x.toLocaleString('en-GB');
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function stamp(ms: number | null): string {
  return ms === null ? '—' : `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)}Z`;
}

/**
 * The headline figure, split so the page can set the number large and the unit
 * small without the renderer parsing its own output back.
 */
function bigBytes(bytes: number): { value: string; unit: string } {
  const s = formatBytes(bytes);
  const i = s.lastIndexOf(' ');
  return { value: s.slice(0, i), unit: s.slice(i + 1) };
}

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

function pct1(part: number, whole: number): string {
  return `${pct(part, whole).toFixed(1)}%`;
}

/** Markdown-ish emphasis and code spans, as used in the warning strings. */
function inlineMarkup(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------

/**
 * Inline CSS. No web fonts: the stack is what is already on a Mac or a Windows
 * machine, so the document looks the same wherever it lands.
 *
 * DARK ON SCREEN, INK ON PAPER. The palette below is dark, and every colour is
 * a token so the print block can swap the whole thing back to black-on-white in
 * one place. That is not a hedge -- printing a dark page either floods it with
 * toner or, if the browser drops the backgrounds, leaves pale text on white and
 * unreadable. The PDF route is the whole reason this file is HTML, so it has to
 * come out of the printer legible. Both palettes are defined here in full; the
 * markup below never names a colour directly.
 *
 * `print-color-adjust: exact` is load-bearing. Without it browsers drop the
 * background fills when printing, and the bars -- which are how the four
 * choices are compared at a glance -- come out as empty outlines.
 */
const STYLE = `
:root {
  --ink: #e7eaf1;
  --ink-soft: #a3abbb;
  --ink-faint: #767f90;
  --rule: #333a46;
  --rule-soft: #262c36;
  --paper: #15181e;
  --page: #0d0f14;
  --tint: #1d222a;
  --accent: #5c9dff;
  --accent-soft: #1b2a44;
  --go: #45d495;
  --warn: #ff8c72;
  --warn-soft: #2e1b17;
  --shadow: rgba(0,0,0,.5);
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font: 14px/1.5 "Helvetica Neue", Helvetica, Arial, "Segoe UI", system-ui, sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.sheet {
  max-width: 210mm;
  margin: 0 auto;
  background: var(--paper);
  padding: 16mm 14mm;
  box-shadow: 0 1px 4px var(--shadow);
}
.page + .page { margin-top: 14mm; padding-top: 10mm; border-top: 1px dashed var(--rule); }
h1 { font-size: 25px; line-height: 1.2; margin: 0 0 4px; letter-spacing: -.2px; }
h2 { font-size: 17px; margin: 26px 0 8px; letter-spacing: -.1px; }
h2:first-child { margin-top: 0; }
h3 { font-size: 14px; margin: 18px 0 6px; }
h4 { font-size: 13px; margin: 14px 0 4px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
p { margin: 8px 0; }
.lede { font-size: 15px; color: var(--ink-soft); margin: 0 0 2px; }
.muted { color: var(--ink-faint); }
.small { font-size: 12px; }
.tiny { font-size: 11px; }
code, .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .92em; }
code { background: var(--tint); padding: 0 2px; border-radius: 3px; word-break: break-all; }

.masthead { border-bottom: 2px solid var(--ink); padding-bottom: 10px; margin-bottom: 16px; }
.masthead .meta { font-size: 11.5px; color: var(--ink-faint); margin-top: 6px; }
.masthead .meta span + span::before { content: " · "; }

.banner {
  border: 1px solid var(--rule);
  border-left: 4px solid var(--go);
  background: var(--tint);
  padding: 10px 12px;
  margin: 14px 0 20px;
  font-size: 13px;
}
.banner strong { color: var(--go); }
.alert { border-left-color: var(--warn); background: var(--warn-soft); }
.alert strong { color: var(--warn); }

/*
 * Stat tiles. Sentence-case label, value in TEXT tokens rather than the accent
 * -- the accent belongs to the bars, where it carries meaning. Values use the
 * font's proportional figures on purpose: tabular-nums gives every digit the
 * width of a zero, which reads loose at this size, and these are standalone
 * numbers rather than a column that has to align.
 */
.stats { display: flex; gap: 10px; margin: 16px 0 4px; }
.stat { flex: 1; border: 1px solid var(--rule); border-left: 3px solid var(--rule); background: var(--tint); padding: 10px 12px; }
.stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--ink-faint); font-weight: 600; }
.stat .v { font-size: 26px; font-weight: 600; letter-spacing: -.5px; margin-top: 4px; line-height: 1.1; }
.stat .v small { font-size: 15px; font-weight: 600; color: var(--ink-soft); margin-left: 3px; }
.stat .n { font-size: 11.5px; color: var(--ink-faint); margin-top: 4px; }
/* The folder those figures were taken from, said plainly and once. */
.scanned { border: 1px solid var(--rule); background: var(--tint); padding: 8px 12px; margin-top: 10px; font-size: 12px; }
.scanned .k { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--ink-faint); font-weight: 600; }
.scanned .p { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; margin-top: 3px; word-break: break-all; }

.headline { display: flex; align-items: baseline; gap: 10px; margin: 4px 0 2px; }
.headline .num { font-size: 46px; font-weight: 700; letter-spacing: -1.5px; line-height: 1; }
.headline .unit { font-size: 20px; font-weight: 600; color: var(--ink-soft); }

table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
thead th { border-bottom: 1px solid var(--rule); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--ink-faint); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.num { white-space: nowrap; }
tbody tr:last-child td { border-bottom: 1px solid var(--rule); }
tfoot td { font-weight: 700; border-top: 1px solid var(--ink); border-bottom: none; }
.kv td:first-child { color: var(--ink-soft); width: 44%; }

.choices { margin-top: 6px; table-layout: fixed; }
.choices th, .choices td { padding: 10px 8px; }
.choices col.c-what { width: 27%; }
.choices col.c-got { width: 13%; }
.choices col.c-bar { width: 21%; }
.choices col.c-cost { width: 13%; }
.choices col.c-after { width: 15%; }
.choices col.c-count { width: 11%; }
.choices td.num { white-space: nowrap; }
.choices thead th { line-height: 1.25; }
.choices .lab { font-weight: 600; font-size: 13px; }
.choices .sub { color: var(--ink-faint); font-size: 11px; font-weight: 400; margin-top: 2px; }
.choices .figure { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.bar { background: var(--rule-soft); border-radius: 2px; height: 12px; width: 100%; overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--accent); }
.bar.kept > i { background: var(--ink-soft); }

.pill { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 10px; letter-spacing: .4px; font-weight: 700; }
.pill.move { background: var(--warn); color: var(--paper); }
.pill.keep { background: var(--rule-soft); color: var(--ink-soft); }

ol.steps { margin: 8px 0 0; padding-left: 20px; font-size: 13px; }
ol.steps li { margin-bottom: 5px; }
ul.warn { margin: 8px 0; padding-left: 18px; font-size: 12.5px; }
ul.warn li { margin-bottom: 6px; }

.paths { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 10px; line-height: 1.45; white-space: pre-wrap; word-break: break-all; background: var(--tint); border: 1px solid var(--rule-soft); padding: 8px; margin: 6px 0 0; }
.foot { margin-top: 24px; padding-top: 8px; border-top: 1px solid var(--rule); font-size: 10.5px; color: var(--ink-faint); }

.ladder { margin-bottom: 14px; break-inside: avoid; }
.ladder .cap { font-size: 11px; color: var(--ink-faint); margin: 2px 0 4px; }
.ladder table { table-layout: fixed; }
/* Everything but the reason is a short token; only the reason may wrap. */
.ladder td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ladder td.why { white-space: normal; }
.ladder col.l-flag { width: 9%; }
.ladder col.l-ver { width: 10%; }
.ladder col.l-kind { width: 14%; }
.ladder col.l-files { width: 7%; }
.ladder col.l-slices { width: 8%; }
.ladder col.l-size { width: 11%; }
.ladder col.l-date { width: 12%; }
.ladder col.l-why { width: 29%; }

@media print {
  /* Ink on paper. Same document, same tokens, inverted. */
  :root {
    --ink: #16181d;
    --ink-soft: #4a5160;
    --ink-faint: #767f90;
    --rule: #d8dce4;
    --rule-soft: #eceef3;
    --paper: #ffffff;
    --page: #ffffff;
    --tint: #f5f7fa;
    --accent: #1d5fd6;
    --accent-soft: #e5edfb;
    --go: #1f7a4d;
    --warn: #a3341f;
    --warn-soft: #fdeeeb;
    --shadow: transparent;
  }
  body { background: var(--paper); font-size: 10.5pt; }
  .sheet { max-width: none; margin: 0; padding: 0; box-shadow: none; }
  .page { break-after: page; }
  .page:last-child { break-after: auto; }
  .page + .page { margin-top: 0; padding-top: 0; border-top: none; }
  .pill.move { color: #ffffff; }
  table, .ladder, .banner, .stats, .scanned { break-inside: avoid; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  h2, h3, h4 { break-after: avoid; }
  .screen-only { display: none; }
}
@page { size: A4; margin: 14mm 12mm 16mm; }
`;

// ---------------------------------------------------------------------------
// Page 1 — the decision
// ---------------------------------------------------------------------------

function choiceTable(scenarios: readonly ExportScenario[]): string {
  const max = Math.max(...scenarios.map((s) => s.reclaimBytes), 1);
  const rows = scenarios
    .map((s) => {
      const cost =
        s.costVsRowAbove > 0
          ? `<td class="num">−${esc(formatBytes(s.costVsRowAbove))}</td>`
          : '<td class="num muted">—</td>';
      return `
      <tr>
        <td>
          <div class="lab">${esc(s.label)}</div>
          <div class="sub">keep ${n(s.keepN)} full version${s.keepN === 1 ? '' : 's'} per asset — ${esc(s.subLabel)}</div>
        </td>
        <td class="num"><span class="figure">${esc(formatBytes(s.reclaimBytes))}</span></td>
        <td><div class="bar"><i style="width:${pct(s.reclaimBytes, max).toFixed(1)}%"></i></div>
          <div class="sub num">${pct1(s.reclaimBytes, s.reclaimBytes + s.keptBytes)} of the archive</div></td>
        ${cost}
        <td class="num">${esc(formatBytes(s.keptBytes))}</td>
        <td class="num">${n(s.reclaimVersions)}<div class="sub num">${n(s.reclaimFiles)} files</div></td>
      </tr>`;
    })
    .join('');

  return `
  <table class="choices">
    <colgroup>
      <col class="c-what"><col class="c-got"><col class="c-bar">
      <col class="c-cost"><col class="c-after"><col class="c-count">
    </colgroup>
    <thead>
      <tr>
        <th>If we keep…</th>
        <th class="num">Recovered</th>
        <th></th>
        <th class="num">Cost of<br>one more</th>
        <th class="num">Left on<br>the drive(s)</th>
        <th class="num">Versions<br>removed</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function decisionPage(d: ExportDataset): string {
  const scenarios = d.scenarios;
  const top = scenarios[0] as ExportScenario;
  const bottom = scenarios[scenarios.length - 1] as ExportScenario;
  const basis = d.scenarioBasis;
  const archive = basis.versionedBytes;
  const store = bigBytes(d.storage.totalBytes);
  const r0 = bigBytes(d.storage.region0Bytes);

  const spread =
    scenarios.length > 1
      ? `The whole decision is worth ${esc(
          formatBytes(top.reclaimBytes - bottom.reclaimBytes),
        )}: that is the difference between the most and the least aggressive option on this page.`
      : '';

  // The preview subtotal moves with the option, so it is stated as a range
  // rather than as one number belonging to a row the reader has not chosen.
  const previewRange =
    top.reclaimProxyBytes === bottom.reclaimProxyBytes
      ? esc(formatBytes(top.reclaimProxyBytes))
      : `${esc(formatBytes(bottom.reclaimProxyBytes))} to ${esc(formatBytes(top.reclaimProxyBytes))}`;

  return `
  <section class="page">
    <div class="masthead">
      <h1>Media cleanup — executive summary</h1>
      <div class="lede">${esc(d.snapshot.name ? d.snapshot.name : 'D3 delivery archive')} · superseded render versions</div>
      <div class="meta">
        <span>Snapshot #${n(d.snapshot.snapshotId)}</span>
        <span>${esc(stamp(d.snapshot.finishedAt ?? d.snapshot.startedAt))}</span>
        <span>${n(d.snapshot.fileCount)} files, ${esc(formatBytes(d.snapshot.totalBytes))} scanned</span>
        <span>Report ${esc(d.generatedAt.slice(0, 16).replace('T', ' '))}Z</span>
      </div>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="k">Total assets today</div>
        <div class="v">${esc(store.value)}<small>${esc(store.unit)}</small></div>
        <div class="n">${n(d.storage.fileCount)} files across ${n(d.storage.songCount)} song folders</div>
      </div>
      <div class="stat">
        <div class="k">Region 0 — offline-edit copies</div>
        <div class="v">${esc(r0.value)}<small>${esc(r0.unit)}</small></div>
        <div class="n">${
          d.storage.totalBytes > 0
            ? `${pct1(d.storage.region0Bytes, d.storage.totalBytes)} of the above`
            : 'no material scanned'
        } — the whole canvas, kept so the offline edit has something to cut with</div>
      </div>
    </div>

    <div class="scanned">
      <div class="k">Folder scanned — every figure in this report comes from here and nowhere else</div>
      <div class="p">${esc(d.snapshot.root)}</div>
    </div>

    <div class="banner">
      <strong>Nothing has been moved.</strong> This is a proposal produced by a read-only
      analyser. No file on the storage has been touched and none will be until a person opens a
      FreeFileSync job, presses <em>Compare</em>, reads the list and presses <em>Synchronize</em>.
      The tool cannot delete anything, and the only removal it can propose is a reversible one.
    </div>

    <h2>The options</h2>
    <p class="small muted" style="margin-top:0">
      Every delivered asset has a stack of versions. Keeping the current one is the minimum;
      each older version kept behind it is insurance, paid for in storage. These are the same
      policy applied to the whole archive at four settings — ${n(basis.assetCount)} assets,
      ${n(basis.versionCount)} versions, ${esc(formatBytes(archive))} across
      ${n(basis.songCount)} song folders.
    </p>
    ${choiceTable(scenarios)}
    <p class="small muted">
      <strong>Reading the columns.</strong> <em>Recovered</em> is what that option frees.
      <em>Cost of one more</em> is what the next version of insurance is worth in storage — the
      gap between that row and the one above it. <em>Left on the drive(s)</em> is what is still
      there once that option has been carried out: the delivery folder holds
      ${esc(formatBytes(archive))} today, so the two figures on each row add back up to it.
    </p>
    <p class="small muted">
      ${spread}
      Percentages are of that same ${esc(formatBytes(archive))} — the material that belongs to a
      recognised version. A further ${esc(formatBytes(basis.unversionedBytes))} in the snapshot
      belongs to no version, is never proposed for removal, and stays on the archive whichever
      option is chosen.
    </p>

    <h2>What holds whichever option is chosen</h2>
    <table class="kv">
      <tbody>
        <tr><td>The current version is always kept</td><td>No option above removes an asset's
          newest delivery. The choice is only about how far back the history goes.</td></tr>
        <tr><td>Fixes are never treated as replacements</td><td>${esc(
          formatBytes(top.protectedPatchBytes),
        )} across ${n(top.protectedPatchVersions)} partial re-render(s) stay on the archive at
          every setting — which is why that figure does not move down the table.</td></tr>
        <tr><td>Previews never displace a master</td><td>A low-resolution preview is not a
          delivery and can never push a full-resolution version out. Between
          ${previewRange} of what these options recover is itself preview material — the
          whole-canvas copies the offline edit uses, superseded along with the version they
          belong to.</td></tr>
        <tr><td>Nothing is erased</td><td>Whatever is chosen, files are moved somewhere they can
          be brought back from — the Recycle Bin, or a dated folder. Permanent deletion is not
          something this tool can produce.</td></tr>
      </tbody>
    </table>

    <p class="small muted" style="margin-top:16px">
      Detail follows: the proposal attached to this report and what running it does (page 2),
      where the numbers come from and the per-song split (page 3), then every affected asset
      showing what goes next to what stays, and finally the literal file list.
    </p>
  </section>`;
}

// ---------------------------------------------------------------------------
// Page 2 — this export
// ---------------------------------------------------------------------------

function exportPage(d: ExportDataset): string {
  const t = d.totals;
  const warnings = d.warnings.length
    ? `<div class="banner alert">
         <strong>Read these first</strong>
         <ul class="warn">${d.warnings.map((w) => `<li>${inlineMarkup(w)}</li>`).join('')}</ul>
       </div>`
    : '';

  const jobs = d.chunks
    .map(
      (c) => `<tr>
        <td class="num">${n(c.index)}</td>
        <td><code>${esc(c.guiFileName)}</code></td>
        <td>${esc(c.songFolders.join(', ') || '(archive root)')}</td>
        <td class="num">${n(c.fileCount)}</td>
        <td class="num">${esc(formatBytes(c.bytes))}</td>
        <td>${c.pairRightFolder ? `<code>${esc(c.pairRightFolder)}</code>` : '<span class="muted">blank — set it in FreeFileSync</span>'}</td>
      </tr>`,
    )
    .join('');

  // Which of page one's options this proposal is. Page one deliberately does
  // not badge a row -- an executive reading the summary has no idea an export
  // is even selected -- so the tie-back is made here, where the export is the
  // subject rather than an intrusion into a neutral table.
  const option = d.scenarios.find((sc) => sc.isExportPolicy);
  const big = bigBytes(t.totalBytes);

  return `
  <section class="page">
    <h2>The proposal attached to this report</h2>
    ${warnings}
    <div class="headline">
      <div class="num">${esc(big.value)}</div>
      <div class="unit">${esc(big.unit)}</div>
    </div>
    <p class="small" style="margin-top:2px">
      recovered by the FreeFileSync job shipped beside this document${
        option
          ? ` — the <strong>${esc(option.label.toLowerCase())}</strong> option on page one`
          : ''
      }.${
        option && option.reclaimBytes !== t.totalBytes
          ? ` It covers a <strong>subset</strong> of that option: the operator narrowed the
             selection, so ${esc(
               formatBytes(Math.max(0, option.reclaimBytes - t.totalBytes)),
             )} of what that row offers is left where it is.`
          : ''
      }
    </p>
    <table class="kv" style="margin-top:14px">
      <tbody>
        <tr><td>Space it would recover</td><td><strong>${esc(formatBytes(t.totalBytes))}</strong> (${n(
          t.totalBytes,
        )} bytes exactly)</td></tr>
        <tr><td>Superseded versions</td><td>${n(t.versionCount)}</td></tr>
        <tr><td>Files listed</td><td>${n(t.fileCount)}</td></tr>
        <tr><td>Assets affected</td><td>${n(t.assetCount)} across ${n(t.songCount)} song folder(s)</td></tr>
        <tr><td>Preview material inside the total</td><td>${esc(formatBytes(t.proxyBytes))}</td></tr>
        <tr><td>Policy</td><td>keep the latest <strong>${n(d.keepN)}</strong> full version(s) per asset${
          option ? ` — “${esc(option.label)}”` : ''
        }</td></tr>
        <tr><td>Removal method</td><td><strong>${esc(d.deletionPolicy)}</strong>${
          d.deletionPolicy === 'Versioning'
            ? ` — files are moved into <code>${esc(d.versioningFolder ?? '')}</code>, in a dated folder`
            : ' — files go to the Recycle Bin / Trash, where they can be put back'
        }</td></tr>
        <tr><td>FreeFileSync jobs</td><td>${n(t.chunkCount)} × <code>.ffs_gui</code></td></tr>
      </tbody>
    </table>

    ${
      d.note
        ? `<h3>Note from the operator</h3><p class="small">${esc(d.note).replace(/\n/g, '<br>')}</p>`
        : ''
    }

    <h2>What happens when this is run</h2>
    <p class="small">
      ${
        d.deletionPolicy === 'Versioning'
          ? `Each job <strong>moves</strong> the listed files into <code>${esc(
              d.versioningFolder ?? '',
            )}</code>, inside a dated subfolder. Nothing is erased. If the decision is reversed, the
             files are still there and can be moved back.`
          : `Each job sends the listed files to the <strong>Recycle Bin / Trash</strong> of the volume
             they live on. They are not erased in place, and they can be put back — though that
             depends on the volume having a working trash and on it not being emptied. Moving into a
             dated folder instead (“Versioning”) is the safer of the two.`
      }
      Permanent deletion is not offered by this tool and cannot be produced by it: the option does
      not exist in the code, an assertion refuses it, and a test proves the assertion fires.
    </p>
    <p class="small">
      The analyser has never held a write handle on the archive. It reads names, sizes and dates,
      works out which versions are superseded, and produces a list. Everything after that is done
      by a person in FreeFileSync.
    </p>

    <h3>The jobs</h3>
    <table>
      <thead><tr><th class="num">#</th><th>Job file</th><th>Song folder(s)</th><th class="num">Files</th><th class="num">Size</th><th>Target folder</th></tr></thead>
      <tbody>${jobs}</tbody>
    </table>

    <h3>Before anything is run</h3>
    <ol class="steps">
      <li>Confirm the total above is the number that was expected.</li>
      <li>Skim the version ladders further on — every row marked <span class="pill move">MOVE</span> should look wrong to keep.</li>
      <li>Open one job in FreeFileSync and press <em>Compare</em> only.</li>
      <li>Check the row count FreeFileSync reports matches the <em>Files</em> column above.</li>
      <li>Cross-check against the <code>.paths.txt</code> manifest shipped beside the job.</li>
      <li>Only then press <em>Synchronize</em>, one job at a time.</li>
    </ol>
  </section>`;
}

// ---------------------------------------------------------------------------
// Page 3 — provenance and the per-song split
// ---------------------------------------------------------------------------

function songScenarioTable(d: ExportDataset, limit: number): string {
  const scenarios = d.scenarios;
  const bySongPerScenario = scenarios.map((s) => new Map(s.bySong.map((r) => [r.songFolder, r])));
  const songs = [...new Set(scenarios.flatMap((s) => s.bySong.map((r) => r.songFolder)))];
  const first = bySongPerScenario[0] as Map<string, { reclaimBytes: number }>;
  songs.sort((a, b) => (first.get(b)?.reclaimBytes ?? 0) - (first.get(a)?.reclaimBytes ?? 0));

  const shown = songs.slice(0, limit);
  const head = scenarios
    .map((s) => `<th class="num">Keep ${n(s.keepN)}</th>`)
    .join('');
  const body = shown
    .map((song) => {
      const cells = bySongPerScenario
        .map((m) => `<td class="num">${esc(formatBytes(m.get(song)?.reclaimBytes ?? 0))}</td>`)
        .join('');
      return `<tr><td>${esc(song || '(archive root)')}</td>${cells}</tr>`;
    })
    .join('');
  const totals = scenarios
    .map((s) => `<td class="num">${esc(formatBytes(s.reclaimBytes))}</td>`)
    .join('');

  const omitted =
    songs.length > shown.length
      ? `<p class="tiny muted">${n(songs.length - shown.length)} further song folder(s) are not
         listed individually; the totals row covers every one of them.</p>`
      : '';

  return `
  <table>
    <thead><tr><th>Song folder</th>${head}</tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><td>All ${n(songs.length)} of ${n(
      d.scenarioBasis.songCount,
    )} song folders — the other ${n(
      Math.max(0, d.scenarioBasis.songCount - songs.length),
    )} have nothing superseded at any setting</td>${totals}</tr></tfoot>
  </table>
  ${omitted}`;
}

function exportSongTable(rows: readonly ExportSongRollup[], d: ExportDataset): string {
  const body = rows
    .map(
      (s) => `<tr>
        <td>${esc(s.songFolder || '(archive root)')}</td>
        <td class="num">${n(s.versionCount)}</td>
        <td class="num">${n(s.fileCount)}</td>
        <td class="num">${esc(formatBytes(s.bytes))}</td>
        <td class="num">${esc(formatBytes(s.proxyBytes))}</td>
        <td>${esc(day(s.latestMtime))}</td>
      </tr>`,
    )
    .join('');
  return `
  <table>
    <thead><tr><th>Song folder</th><th class="num">Versions</th><th class="num">Files</th><th class="num">Size</th><th class="num">Preview</th><th>Newest file</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr>
      <td>Total</td>
      <td class="num">${n(d.totals.versionCount)}</td>
      <td class="num">${n(d.totals.fileCount)}</td>
      <td class="num">${esc(formatBytes(d.totals.totalBytes))}</td>
      <td class="num">${esc(formatBytes(d.totals.proxyBytes))}</td>
      <td></td>
    </tr></tfoot>
  </table>`;
}

function provenancePage(d: ExportDataset): string {
  return `
  <section class="page">
    <h2>Where these numbers come from</h2>
    <table class="kv">
      <tbody>
        <tr><td>Snapshot</td><td>#${n(d.snapshot.snapshotId)}${
          d.snapshot.name ? ` — ${esc(d.snapshot.name)}` : ''
        } (${esc(d.snapshot.status)})</td></tr>
        <tr><td>Archive folder scanned</td><td><code>${esc(d.snapshot.root)}</code></td></tr>
        <tr><td>Scan window</td><td>${esc(stamp(d.snapshot.startedAt))} → ${esc(
          stamp(d.snapshot.finishedAt),
        )}</td></tr>
        <tr><td>Snapshot contents</td><td>${n(d.snapshot.fileCount)} files, ${esc(
          formatBytes(d.snapshot.totalBytes),
        )}</td></tr>
        <tr><td>Bookkeeping files excluded</td><td>${n(d.snapshot.excludedCount)} (${esc(
          formatBytes(d.snapshot.excludedBytes),
        )})</td></tr>
        <tr><td>Names the version grammar could not read</td><td>${n(
          d.snapshot.unparsedCount,
        )} file(s) — never proposed for removal, and not counted in any reclaim figure</td></tr>
      </tbody>
    </table>
    <p class="small muted">
      A version is the set of files a render produced: the slices the picture is cut into for the
      venue, plus a whole-canvas preview used for offline editing. Those slices are wildly
      unequal in size, so nothing here estimates a version's weight from how many files it has —
      every figure is summed bytes. Sizes come from the file system, not from reading the media.
    </p>

    <h2>Where the space is, at each choice</h2>
    <p class="small muted" style="margin-top:0">
      Whole archive, biggest first at the most aggressive setting. Each column is that song
      folder's share of the corresponding row on page one.
    </p>
    ${songScenarioTable(d, 70)}

    <h2>What this export removes, by song folder</h2>
    ${exportSongTable(d.bySong, d)}
  </section>`;
}

// ---------------------------------------------------------------------------
// Ladders
// ---------------------------------------------------------------------------

function ladderRows(l: ExportAssetLadder): string {
  return l.versions
    .map((v: ExportVersionRow) => {
      const pill = v.selected
        ? '<span class="pill move">MOVE</span>'
        : '<span class="pill keep">keep</span>';
      const kind = v.isPatch
        ? `patch · frame ${n(v.patchFrame ?? 0)}`
        : v.regionCount === 0
          ? 'preview only'
          : 'full';
      return `<tr>
        <td>${pill}</td>
        <td class="mono">${esc(v.verLabel)}</td>
        <td>${esc(kind)}</td>
        <td class="num">${n(v.fileCount)}</td>
        <td class="num">${n(v.regionCount)}</td>
        <td class="num">${esc(formatBytes(v.bytes))}</td>
        <td>${esc(day(v.latestMtime))}</td>
        <td class="small why">${esc(REASON_TEXT[v.keepReason] ?? v.keepReason)}</td>
      </tr>`;
    })
    .join('');
}

function ladderPages(d: ExportDataset): string {
  const shown = d.ladders.slice(0, MAX_REPORT_LADDERS);
  let currentSong: string | null = null;
  const blocks: string[] = [];

  for (const l of shown) {
    if (l.songFolder !== currentSong) {
      currentSong = l.songFolder;
      blocks.push(`<h3>${esc(currentSong || '(archive root)')}</h3>`);
    }
    const sel = l.versions.filter((v) => v.selected).length;
    blocks.push(`
    <div class="ladder">
      <h4>${esc(l.base)}</h4>
      <div class="cap">${n(sel)} of ${n(l.versions.length)} version(s) in this export ·
        ${esc(formatBytes(l.selectedBytes))} · ${n(l.selectedFileCount)} file(s)</div>
      <table>
        <colgroup>
          <col class="l-flag"><col class="l-ver"><col class="l-kind"><col class="l-files">
          <col class="l-slices"><col class="l-size"><col class="l-date"><col class="l-why">
        </colgroup>
        <thead><tr><th></th><th>Version</th><th>Kind</th><th class="num">Files</th><th class="num">Slices</th><th class="num">Size</th><th>Newest</th><th class="why">Why</th></tr></thead>
        <tbody>${ladderRows(l)}</tbody>
      </table>
    </div>`);
  }

  const omitted =
    d.ladders.length > shown.length
      ? `<p class="small muted">${n(
          d.ladders.length - shown.length,
        )} further asset(s) are in this export but are not shown as ladders here, to keep the
         document readable. Every one of them is listed in full in <code>review.md</code> and
         <code>manifest.json</code> beside this report, and every file is in the path list that
         follows.</p>`
      : '';

  return `
  <section class="page">
    <h2>Every affected asset, version by version</h2>
    <p class="small muted" style="margin-top:0">
      Oldest version at the top of each table. <span class="pill move">MOVE</span> rows are in
      this export; <span class="pill keep">keep</span> rows stay on the archive and are shown so
      that what survives is visible next to what does not. A patch is a partial re-render, not a
      replacement, and is never removed while the version it layers on is kept. A preview-only
      version is never treated as a delivery and can never push a master out.
    </p>
    ${blocks.join('')}
    ${omitted}
  </section>`;
}

// ---------------------------------------------------------------------------
// The literal path list
// ---------------------------------------------------------------------------

function pathPage(d: ExportDataset): string {
  const all: { chunk: number; path: string }[] = [];
  for (const c of d.chunks) for (const p of c.relPaths) all.push({ chunk: c.index, path: p });
  const shown = all.slice(0, MAX_REPORT_PATHS);

  const blocks = d.chunks
    .map((c) => {
      const mine = shown.filter((r) => r.chunk === c.index).map((r) => r.path);
      if (mine.length === 0) return '';
      return `
      <h3>Job ${n(c.index)} — <code>${esc(c.guiFileName)}</code></h3>
      <div class="cap small muted">${n(c.fileCount)} file(s), ${esc(formatBytes(c.bytes))}${
        mine.length < c.fileCount ? ` — first ${n(mine.length)} shown` : ''
      }</div>
      <pre class="paths">${mine.map((p) => esc(`${d.snapshot.root}/${p}`)).join('\n')}</pre>`;
    })
    .join('');

  const omitted =
    all.length > shown.length
      ? `<div class="banner alert"><strong>${n(all.length - shown.length)} of ${n(
          all.length,
        )} paths are not printed here.</strong> This report caps the list at ${n(
          MAX_REPORT_PATHS,
        )} so it stays a document rather than a phone book. The COMPLETE list — the one
        FreeFileSync will act on — is in the <code>.paths.txt</code> manifest shipped beside each
        job, and in <code>manifest.json</code>. Review that list, not this excerpt.</div>`
      : '';

  return `
  <section class="page">
    <h2>The file list</h2>
    <p class="small muted" style="margin-top:0">
      These are the concrete files, reproduced from the same array that generates the filter
      inside each FreeFileSync job — so what is approved here and what the job acts on cannot
      drift apart. Review concrete paths, never filter patterns.
    </p>
    ${omitted}
    ${blocks}
  </section>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Render the whole shareable report as one self-contained HTML document. */
export function renderReport(d: ExportDataset): string {
  const title = `Media cleanup — snapshot ${d.snapshot.snapshotId} — ${d.runId}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="sheet">
${decisionPage(d)}
${exportPage(d)}
${provenancePage(d)}
${ladderPages(d)}
${pathPage(d)}
<div class="foot">
  Produced by metal-media-size · run ${esc(d.runId)} · snapshot #${n(d.snapshot.snapshotId)} ·
  ${esc(d.generatedAt)} · read-only analysis, no archive file was altered ·
  to share as a PDF, print this page and choose “Save as PDF”.
</div>
</main>
</body>
</html>
`;
}

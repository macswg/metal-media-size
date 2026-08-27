/**
 * Application bootstrap and wiring.
 *
 * Read-only by construction: the only request this app can make that is not a
 * GET is POST /api/export, which produces a manifest inside the project's
 * exports/ directory. The archive is never touched.
 */

import { h, clear, $, toast } from './dom.js';
import { state, subscribe, update, readUrl, clearSelection, clearOverrides, selectionTotals, emit, activeFilterCount } from './state.js';
import { isNarrow, onBreakpointChange } from './viewport.js';
import { initApi, api, apiSource, apiNote, apiInfo } from './api.js';
import { ReclaimStrip } from './reclaim.js';
import { FilterPanel } from './filters.js';
import { TableView } from './tableview.js';
import { LadderPanel } from './ladder.js';
import { AnomaliesPanel, DuplicatesPanel } from './panels.js';
import { SnapshotBar, DiffPanel } from './snapshots.js';
import { openExportDialog, resolveSelectedVersionIds } from './export.js';
import { bytes as fmtBytes, count } from './format.js';

const TABS = [
  ['table', 'Browse'],
  ['anomalies', 'Anomalies'],
  ['duplicates', 'Duplicates'],
  ['diff', 'Snapshot diff'],
];

const app = {};

async function boot() {
  readUrl();

  const source = await initApi();
  renderSourcePill(source);

  app.snapshotBar = new SnapshotBar($('#snapshotBar'), { onChange: () => reloadEverything() });
  await app.snapshotBar.load();

  app.reclaim = new ReclaimStrip($('#reclaimStrip'));
  app.filters = new FilterPanel($('#filterPanel'));
  app.filters.render();

  buildTabs();
  buildPanes();
  buildStatusBar();
  trackStatusBarHeight();
  buildMobileChrome();

  app.ladder = new LadderPanel($('#ladderPanel'), {
    onClose: () => {
      $('.workspace').classList.remove('with-drawer');
      app.table.setActiveAsset(null);
      setSheetOpen(false);
    },
    onSelectionChange: () => emit('selection'),
  });

  await loadSummary();

  subscribe(handleStateChange);

  api
    .health()
    .then((h_) => {
      if (h_?.version) app.versionEl.textContent = `v${h_.version}`;
    })
    .catch(() => {
      /* no version rather than a wrong one */
    });

  // Debug hook, opt-in via ?debug — lets the table internals be profiled from
  // the console without shipping a global by default.
  if (new URLSearchParams(location.search).has('debug')) window.__aa = app;

  showTab(state.tab);
  // Loaded eagerly so the tab badge is honest from the first paint.
  app.anomaliesLoaded = true;
  app.anomalies.load();
  await app.table.refresh();
  await app.reclaim.fetch();
  paintStatusBar();

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.modal-backdrop')) return;
    // The filter sheet is the innermost dismissable thing when it is open.
    if (isSidebarOpen()) {
      closeSidebar();
      return;
    }
    if (!$('#ladderPanel').hidden) app.ladder.close();
  });

  // Crossing the breakpoint changes which columns exist, so the table has to
  // be rebuilt -- a repaint would reuse the old header. Nothing else in the
  // layout needs JS; the rest is the media query in app.css.
  onBreakpointChange((narrow) => {
    if (!narrow) closeSidebar();
    app.table.refresh();
    // The keep-N control is a slider on a wide screen and a stepper on a
    // phone, so crossing the breakpoint has to rebuild it -- otherwise a
    // rotated phone keeps whichever one it booted with.
    app.reclaim.repaint();
  });
}

/* ------------------------------------------------------------------ */
/* Mobile chrome: the off-canvas filter sheet                          */
/* ------------------------------------------------------------------ */

function isSidebarOpen() {
  return $('#filterPanel').classList.contains('open');
}

/**
 * Freeze the page behind an open sheet.
 *
 * On a phone the document itself scrolls (see THE PAGE SCROLLS in app.css), so
 * a sheet that covers the screen would otherwise let 26k rows slide past
 * underneath it. Both sheets are `position: fixed` and unaffected; only what
 * is behind them is locked. A no-op on desktop, where the shell never scrolled.
 */
function setSheetOpen(open) {
  document.documentElement.classList.toggle(
    'sheet-open',
    open || isSidebarOpen() || !$('#ladderPanel').hidden,
  );
}

function openSidebar() {
  if (!isNarrow()) return;
  $('#filterPanel').classList.add('open');
  const scrim = $('#sidebarScrim');
  scrim.hidden = false;
  // Two frames: the element must be laid out un-faded before the class that
  // fades it in, or the transition is skipped and it pops.
  requestAnimationFrame(() => scrim.classList.add('open'));
  $('#filtersToggle').setAttribute('aria-expanded', 'true');
  setSheetOpen(true);
}

function closeSidebar() {
  $('#filterPanel').classList.remove('open');
  const scrim = $('#sidebarScrim');
  scrim.classList.remove('open');
  scrim.hidden = true;
  $('#filtersToggle').setAttribute('aria-expanded', 'false');
  setSheetOpen(false);
}

/**
 * Publish the status bar's height as `--statusbar-h`.
 *
 * On a phone the bar is fixed to the bottom of the viewport (see THE PAGE
 * SCROLLS in app.css) and the shell reserves its height as padding. It wraps to
 * two lines when the figures are long, so the reservation is measured rather
 * than assumed -- guessing 40px would hide the last row of the list precisely
 * when there is most to say about it.
 */
function trackStatusBarHeight() {
  const bar = $('#statusBar');
  const publish = () => {
    document.documentElement.style.setProperty('--statusbar-h', `${bar.offsetHeight}px`);
  };
  publish();
  if (typeof ResizeObserver === 'function') new ResizeObserver(publish).observe(bar);
  else window.addEventListener('resize', publish);
}

function buildMobileChrome() {
  const toggle = $('#filtersToggle');
  toggle.addEventListener('click', () => {
    if (isSidebarOpen()) closeSidebar();
    else openSidebar();
  });
  $('#sidebarScrim').addEventListener('click', closeSidebar);

  // The sheet covers the results it filters, so on a phone the point of
  // changing a filter is to look at what it did. Close on any filter change.
  subscribe((reasons) => {
    if (isNarrow() && isSidebarOpen() && (reasons.has('filters') || reasons.has('mode'))) {
      closeSidebar();
    }
    paintFilterBadge();
  });
  paintFilterBadge();
}

function paintFilterBadge() {
  const el = $('#filtersToggleCount');
  if (!el) return;
  const n = activeFilterCount();
  el.textContent = n ? String(n) : '';
  el.hidden = n === 0;
}

/* ------------------------------------------------------------------ */

function renderSourcePill(source) {
  const host = $('#sourcePill');
  clear(host);
  if (source === 'live') {
    host.appendChild(
      h('div.source-pill', { title: 'Reading the live API on this machine' }, h('span.dot'), 'live API'),
    );
  } else {
    const info = apiInfo();
    const made = info?.generatedAt ? new Date(info.generatedAt).toISOString().slice(0, 16).replace('T', ' ') : 'an earlier build';
    host.appendChild(
      h(
        'div.source-pill.mock',
        {
          title:
            `The HTTP API is not answering${apiNote() ? ` (${apiNote()})` : ''}, so this page is replaying a fixture generated ` +
            `read-only from data/index.db at ${made}. Every figure was computed from that fixture's own rows, but the fixture is a ` +
            'frozen copy: rescan the archive and regenerate it, or start the API, to see current numbers. Add ?api=live to force the live API.',
        },
        h('span.dot'),
        `mock fixture · ${made}`,
      ),
    );
  }
}

/**
 * /api/summary is described in the contract only as "headline totals", so its
 * payload is read defensively: several plausible spellings are accepted and
 * anything missing falls back to /api/songs, which the contract does pin.
 */
async function loadSummary() {
  try {
    const s = await api.summary({ snapshotId: state.snapshotId ?? undefined, keepN: state.keepN });
    app.summary = s;

    const maxKeepN = s?.maxKeepN ?? (Array.isArray(s?.reclaimByKeepN) ? s.reclaimByKeepN.length : null);
    if (maxKeepN) app.reclaim.setMaxN(maxKeepN);

    const families =
      s?.families ||
      (Array.isArray(s?.byFamily) ? s.byFamily.map((f) => f.family).filter(Boolean) : []) ||
      [];

    // Drives whether the Files table shows a Resolution column at all.
    state.mediaProbed = Number(s?.media?.withDimensions ?? 0);

    app.filters.setOptions({
      songFolders: s?.songFolders || [],
      families,
      extensions: s?.extensions || [],
      byExtension: Array.isArray(s?.byExtension) ? s.byExtension : [],
    });
    // The fallback stays: /api/summary only started reporting songFolders
    // later, so a page served against an older API still fills its dropdown.
    if (!s?.songFolders?.length) await loadOptionsFromSongs();
  } catch {
    await loadOptionsFromSongs();
  }
}

async function loadOptionsFromSongs() {
  try {
    const res = await api.songs({ limit: 2000, snapshotId: state.snapshotId ?? undefined });
    app.filters.setOptions({ songFolders: (res.rows || []).map((r) => r.songFolder).sort() });
  } catch {
    /* leave the folder list empty rather than inventing one */
  }
}

/* ------------------------------------------------------------------ */

function buildTabs() {
  const host = $('#tabs');
  clear(host);
  app.tabButtons = new Map();
  for (const [id, label] of TABS) {
    const btn = h(`button.tab${state.tab === id ? '.on' : ''}`, {
      type: 'button',
      text: label,
      onClick: () => {
        if (state.tab === id) return;
        update({ tab: id }, 'tab');
        showTab(id);
      },
    });
    app.tabButtons.set(id, btn);
    host.appendChild(btn);
  }
  host.appendChild(h('span.tabs-spacer'));
  host.appendChild(
    h('span.muted.tabs-note', {
      style: { fontSize: '11.5px', alignSelf: 'center', paddingRight: '6px' },
      text: 'read-only analysis · this tool never removes anything',
    }),
  );
}

function buildPanes() {
  const host = $('#panelHost');
  clear(host);
  app.panes = {
    table: h('div.tab-pane'),
    anomalies: h('div.tab-pane.scrollpane'),
    duplicates: h('div.tab-pane.scrollpane'),
    diff: h('div.tab-pane.scrollpane'),
  };
  for (const pane of Object.values(app.panes)) host.appendChild(pane);

  app.table = new TableView(app.panes.table, {
    onOpenAsset: (assetId, versionId) => {
      if (assetId == null) return;
      $('.workspace').classList.add('with-drawer');
      app.ladder.open(assetId, versionId);
      setSheetOpen(true);
    },
    onSelectionChange: () => paintStatusBar(),
  });
  app.anomalies = new AnomaliesPanel(app.panes.anomalies, {
    // The badge counts HIGH severity only. A badge that also counted anomalies
    // a later render already fixes would train the user to ignore it.
    onCounts: (c) => setTabBadge('anomalies', c.high ?? 0, c.low ?? 0),
  });
  app.duplicates = new DuplicatesPanel(app.panes.duplicates);
  app.diff = new DiffPanel(app.panes.diff, { snapshotBar: app.snapshotBar });
}

function setTabBadge(tab, n, secondary) {
  const btn = app.tabButtons?.get(tab);
  if (!btn) return;
  btn.querySelector('.badge')?.remove();
  if (!n) return;
  btn.appendChild(
    h('span.badge', {
      text: String(n),
      title: `${n} need attention${secondary ? ` · ${secondary} more already superseded by a newer full render` : ''}`,
    }),
  );
}

function showTab(id) {
  for (const [tab, btn] of app.tabButtons) btn.classList.toggle('on', tab === id);
  for (const [tab, pane] of Object.entries(app.panes)) pane.classList.toggle('on', tab === id);
  if (id === 'duplicates' && !app.duplicatesLoaded) {
    app.duplicatesLoaded = true;
    app.duplicates.load();
  }
  if (id === 'diff') app.diff.load();
  if (id === 'table') app.table.table.paint();
}

/* ------------------------------------------------------------------ */

function buildStatusBar() {
  const host = $('#statusBar');
  clear(host);
  app.selSummary = h('div.sel-summary', { text: 'Nothing is slated for removal at this keep-N' });
  app.exportBtn = h('button.btn.primary', {
    text: 'Export manifest…',
    disabled: true,
    onClick: () => startExport(),
  });
  app.clearSelBtn = h('button.btn.sm.ghost', {
    text: 'Reset my overrides',
    title: 'Put the manifest back to exactly what the keep-N policy slates',
    hidden: true,
    onClick: () => clearOverrides(),
  });
  // Which build you are looking at. Filled in once /api/health answers; left
  // blank rather than guessed if it does not.
  app.versionEl = h('span.app-version', { title: 'Application version' });
  host.append(
    h('span.readonly-note', 'Archive mounted read-only · nothing here removes files · exports land in exports/'),
    app.versionEl,
    h('span.spacer'),
    app.selSummary,
    app.clearSelBtn,
    app.exportBtn,
  );
}

function paintStatusBar() {
  const totals = selectionTotals(state.slated);
  const has = totals.count > 0;
  app.exportBtn.disabled = !has;
  // "Clear" now means "drop my overrides", which is only meaningful if there
  // are any. It no longer empties the manifest -- the policy fills that.
  app.clearSelBtn.hidden = totals.vetoed === 0;
  clear(app.selSummary);
  if (!has) {
    app.selSummary.textContent =
      totals.slated > 0
        ? 'You have kept every slated version — the manifest is empty'
        : 'Nothing is slated for removal at this keep-N';
    return;
  }
  app.selSummary.append(
    h('b', { text: count(totals.count) }),
    ` version${totals.count === 1 ? '' : 's'} in the manifest`,
    totals.bytes != null ? ' · ' : '',
    totals.bytes != null ? h('span.bytes', { text: `${totals.exact ? '' : '≈'}${fmtBytes(totals.bytes)}` }) : '',
    totals.vetoed > 0 ? h('span.sep', '·') : '',
    totals.vetoed > 0
      ? h('span', {
          style: { color: 'var(--kept)' },
          text: `${count(totals.vetoed)} kept by you`,
        })
      : '',
  );
}

async function startExport() {
  const totals = selectionTotals(state.slated);
  app.exportBtn.disabled = true;
  app.exportBtn.textContent = 'Resolving selection…';
  try {
    const resolved = await resolveSelectedVersionIds();
    openExportDialog({
      versionIds: resolved.ids,
      summary: { ...totals, count: resolved.ids.length, bytes: resolved.bytes, files: resolved.files, exact: resolved.exact },
    });
  } catch (err) {
    toast(`Could not resolve the selection — ${err.message}`, 'error');
  } finally {
    app.exportBtn.textContent = 'Export manifest…';
    paintStatusBar();
  }
}

/* ------------------------------------------------------------------ */

let reloading = false;
function handleStateChange(reasons) {
  paintStatusBar();
  if (reasons.has('selection') && reasons.size === 1) {
    app.filters.paintSelectionHint();
    // While "Marked for removal" is on, the selection IS the row set, so
    // un-ticking has to remove the row rather than just un-highlight it.
    if (state.manifestView) app.table.refresh();
    else app.table.repaintSelection();
    app.ladder.repaintSelection();
    return;
  }
  if (reasons.has('snapshot')) {
    reloadEverything();
    return;
  }
  if (reasons.has('filters') || reasons.has('mode') || reasons.has('sort') || reasons.has('keepN')) {
    app.table.refresh();
    if (reasons.has('filters') || reasons.has('mode')) app.reclaim.refresh();
    if (reasons.has('keepN')) app.ladder.refresh();
  }
  void reloading;
}

async function reloadEverything() {
  app.duplicatesLoaded = false;
  app.anomalies.load();
  clearSelection();
  await loadSummary();
  app.reclaim.refresh();
  await app.table.refresh();
  app.ladder.refresh();
  if (state.tab !== 'table') showTab(state.tab);
  paintStatusBar();
}

boot().catch((err) => {
  document.body.innerHTML = '';
  document.body.appendChild(
    h(
      'div',
      { style: { padding: '40px', fontFamily: 'var(--sans)', color: '#dfe6ee' } },
      h('h1', { style: { fontSize: '18px' }, text: 'Archive Analyser could not start' }),
      h('p.mono', { style: { color: '#e0703a' }, text: String(err && err.stack ? err.stack : err) }),
      h('p.muted', `API source attempted: ${apiSource()}. ${apiNote()}`),
    ),
  );
});

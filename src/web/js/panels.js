/**
 * Anomalies and duplicates panels.
 *
 * The API contract fixes the routes and the top-level keys but not the row
 * shapes inside them, so both panels render defensively: known field names get
 * proper formatting (bytes, dates, paths), anything else is shown as-is rather
 * than dropped. Nothing here is silently hidden — invisible anomalies are the
 * thing this panel exists to prevent.
 */

import { h, clear, pathCell } from './dom.js';
import { state, update } from './state.js';
import { api } from './api.js';
import { bytes as fmtBytes, count, date as fmtDate, dateTime } from './format.js';

/* ------------------------------------------------------------------ */
/* Generic renderer for rows whose exact shape the contract leaves open */
/* ------------------------------------------------------------------ */

const HIDE_KEYS = new Set(['key', 'members']);

function labelFor(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\bId\b/, 'ID');
}

function isByteKey(k) {
  return /bytes$|^size$|^sizeBefore$|^sizeAfter$|^delta$/i.test(k);
}
function isDateKey(k) {
  return /mtime$|^scannedAt$|At$/i.test(k);
}

function renderValue(key, value) {
  if (value == null) return h('span.muted', { text: '—' });
  if (Array.isArray(value)) return h('span.mono', { text: value.length > 12 ? `${value.slice(0, 12).join(', ')} … (${value.length})` : value.join(', ') || '—' });
  if (typeof value === 'object') return h('span.mono', { text: JSON.stringify(value) });
  if (isByteKey(key) && typeof value === 'number') return h('span', { text: fmtBytes(value) });
  if (isDateKey(key) && typeof value === 'number' && value > 1e11) return h('span', { text: fmtDate(value) });
  if (key === 'relPath' || key === 'path') return h('span.mono', pathCell(String(value)));
  if (typeof value === 'number') return h('span', { text: count(value) });
  return h('span', { text: String(value) });
}

function autoTable(rows, { limit = 300, onRowClick } = {}) {
  if (!rows || rows.length === 0) return h('div.muted', { style: { padding: '4px 0' } }, 'None found.');
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !HIDE_KEYS.has(k));
  const shown = rows.slice(0, limit);
  const table = h(
    'table.grid',
    h('thead', h('tr', ...keys.map((k) => h('th', { class: typeof rows[0][k] === 'number' && !/id$/i.test(k) ? 'num' : '' }, labelFor(k))))),
    h(
      'tbody',
      ...shown.map((r) =>
        h(
          'tr',
          { style: onRowClick ? { cursor: 'pointer' } : null, onClick: onRowClick ? () => onRowClick(r) : null },
          ...keys.map((k) => {
            const numeric = typeof r[k] === 'number' && !/id$/i.test(k);
            return h(`td${numeric ? '.num' : ''}${k === 'relPath' || k === 'base' || k === 'path' ? '.mono' : ''}`, renderValue(k, r[k]));
          }),
        ),
      ),
    ),
  );
  const wrap = h('div', { style: { overflowX: 'auto' } }, table);
  if (rows.length > shown.length) {
    wrap.appendChild(h('div.card-note', `Showing the first ${count(shown.length)} of ${count(rows.length)}.`));
  }
  return wrap;
}

function card(title, n, ...body) {
  return h(
    'div.card',
    h('header', h('h3', { text: title }), h('span.n', { text: n == null ? '' : `${count(n)}` }), h('span.spacer')),
    h('div.card-body', ...body),
  );
}

/* ------------------------------------------------------------------ */
/* Anomalies                                                           */
/* ------------------------------------------------------------------ */

export class AnomaliesPanel {
  constructor(host, { onCounts } = {}) {
    this.host = host;
    this.onCounts = onCounts;
    this.severity = '';
    this.counts = { high: 0, low: 0 };
  }

  async load() {
    clear(this.host);
    this.host.appendChild(h('div.muted', 'Loading anomalies…'));
    try {
      const a = await api.anomalies({
        snapshotId: state.snapshotId ?? undefined,
        ...(this.severity ? { severity: this.severity } : {}),
      });
      this.render(a);
    } catch (err) {
      clear(this.host);
      this.host.appendChild(h('div.caveat', h('div', h('b', 'Could not load anomalies. '), err.message)));
    }
  }

  render(a) {
    clear(this.host);
    const missing = a.missingRegions || [];
    const orphan = a.orphanRegions || [];
    const unparsed = a.unparsed || [];
    const zero = a.zeroByte || [];
    const noHeader = a.noHeader || [];
    const excluded = a.excluded || {};
    // How much of the snapshot the probe has actually read. Without it, an
    // empty noHeader list would read as "no broken files" when it may only
    // mean "nobody has looked yet".
    const coverage = a.probeCoverage || null;

    const graded = [...missing, ...orphan, ...unparsed, ...zero, ...noHeader];
    const counts = a.severity ||
      a.severityCounts || {
        high: graded.filter((r) => r.severity === 'high').length,
        low: graded.filter((r) => r.severity === 'low').length,
      };
    // Only report high as "the number", so a badge never cries wolf.
    this.counts = counts;
    this.onCounts?.(counts);

    this.host.append(
      h(
        'div.stat-row',
        stat('Needs attention', count(counts.high ?? 0), 'nothing newer exists that would already fix these'),
        statMuted('Already superseded', count(counts.low ?? 0), 'a later full render presumably fixes these'),
        stat('Unparsed filenames', count(unparsed.length), 'in no asset-version at all'),
        stat('Zero-byte files', count(zero.length), ''),
        stat(
          'Unplayable renders',
          count(noHeader.length),
          coverage && coverage.probed < coverage.total
            ? `of ${count(coverage.probed)} files read so far`
            : 'no header — nothing can open these',
        ),
        stat('Excluded bookkeeping', count(excluded.count ?? 0), excluded.bytes != null ? fmtBytes(excluded.bytes) : ''),
      ),
      h(
        'div.caveat',
        h(
          'div',
          h('b', 'These are observations, not recommendations. '),
          'Nothing here is proposed for removal. Severity asks only whether a newer full render of the same asset exists — ',
          h('b', 'it does not move with the keep-latest-N slider'),
          '.',
        ),
      ),
      this.severityFilter(),
      anomalyCard('Versions with an incomplete region set', missing, describeMissing),
      anomalyCard('Versions with regions but no proxy', orphan, () => 'no proxy render'),
      anomalyCard('Files whose names did not parse', unparsed, (r) => r.reason || 'did not match the version grammar', 'relPath'),
      anomalyCard('Zero-byte files', zero, () => 'zero bytes on disk', 'relPath'),
      anomalyCard(
        'Files with no header — an interrupted render',
        noHeader,
        (r) => r.reason || 'no header atom',
        'relPath',
        // What was actually looked at. An empty list on an unprobed archive is
        // not a clean bill of health, and must not be presented as one.
        coverage
          ? coverage.probed === 0
            ? 'Nothing has been probed yet, so nothing here has been checked. Run `npm run probe` to read the file headers.'
            : coverage.probed < coverage.total
              ? `Checked ${count(coverage.probed)} of ${count(coverage.total)} files so far — the probe is still working through the archive.`
              : `Every file in this snapshot has been checked.`
          : null,
      ),
      card(
        'Excluded from the index',
        excluded.count ?? 0,
        h(
          'dl.kv',
          h('dt', 'Files excluded'),
          h('dd', { text: count(excluded.count ?? 0) }),
          h('dt', 'Bytes excluded'),
          h('dd', { text: fmtBytes(excluded.bytes ?? 0) }),
        ),
        h('div.card-note', { style: { padding: '8px 0 0' } },
          excluded.note || 'FreeFileSync bookkeeping and macOS metadata files. Counted here so they are visible rather than silently dropped.'),
        Array.isArray(excluded.globs) && excluded.globs.length
          ? h('div', { style: { marginTop: '8px' } },
              h('div.muted', { style: { fontSize: '11px', marginBottom: '3px' }, text: 'Exclusion patterns in force' }),
              h('div.mono', { style: { fontSize: '11.5px', color: 'var(--text-2)' }, text: excluded.globs.join('   ') }))
          : null,
        Array.isArray(excluded.skippedDirs) && excluded.skippedDirs.length
          ? h('div', { style: { marginTop: '8px' } }, autoTable(excluded.skippedDirs))
          : null,
      ),
    );
  }

  severityFilter() {
    const opts = [
      ['', 'All'],
      ['high', 'Needs attention'],
      ['low', 'Already superseded'],
    ];
    return h(
      'div.toolbar',
      { style: { border: '1px solid var(--line)', borderRadius: 'var(--radius)', marginBottom: '14px' } },
      h('span.muted', 'Show'),
      h(
        'div.seg',
        opts.map(([v, label]) =>
          h(`button${this.severity === v ? '.on' : ''}`, {
            type: 'button',
            text: label,
            onClick: () => {
              if (this.severity === v) return;
              this.severity = v;
              this.load();
            },
          }),
        ),
      ),
      h('span.spacer'),
      h('span.muted', { style: { fontSize: '11.5px' }, text: 'Severity is independent of the keep-latest-N policy.' }),
    );
  }
}

/**
 * One anomaly category. High-severity rows are listed plainly and first; the
 * superseded ones stay present but recede behind a disclosure, each showing
 * what supersedes it so the de-emphasis is visible rather than asserted.
 */
/**
 * `scopeNote` says what the card was computed OVER. Only categories that can
 * be computed from part of the archive need it -- everything derived from the
 * index covers all of it by construction, but the header check covers only
 * what has been probed, and an empty list there means nothing without it.
 */
function anomalyCard(title, rows, describe, identityKey, scopeNote) {
  rows = rows || [];
  const high = rows.filter((r) => r.severity !== 'low');
  const low = rows.filter((r) => r.severity === 'low');

  const body = h('div.card-body');

  if (high.length === 0 && low.length === 0) {
    body.appendChild(h('div.muted', 'None found.'));
  }
  if (scopeNote) body.appendChild(h('div.card-note', { style: { padding: '6px 0 0' }, text: scopeNote }));
  if (high.length) body.appendChild(h('div.anom-list', ...high.map((r) => anomalyRow(r, describe, false, identityKey))));
  if (low.length) {
    const list = h('div.anom-list.low', ...low.map((r) => anomalyRow(r, describe, true, identityKey)));
    list.hidden = true;
    const toggle = h('button.btn.sm.ghost.anom-toggle', {
      text: `Show ${count(low.length)} already superseded`,
      onClick: () => {
        list.hidden = !list.hidden;
        toggle.textContent = list.hidden
          ? `Show ${count(low.length)} already superseded`
          : `Hide ${count(low.length)} already superseded`;
      },
    });
    body.append(toggle, list);
  }

  return h(
    'div.card',
    h(
      'header',
      h('h3', { text: title }),
      high.length
        ? h('span.pill.superseded', { text: `${count(high.length)} need${high.length === 1 ? 's' : ''} attention` })
        : h('span.n', { text: 'none need attention' }),
      low.length ? h('span.n', { text: `${count(low.length)} already superseded` }) : null,
      h('span.spacer'),
    ),
    body,
  );
}

function describeMissing(r) {
  const list = Array.isArray(r.missing) ? r.missing : null;
  if (list && list.length) return `missing region${list.length > 1 ? 's' : ''} ${list.join(', ')}`;
  const expected = Array.isArray(r.expected) ? r.expected.length : r.expected ?? 14;
  const present = Array.isArray(r.present) ? r.present.length : r.present ?? 0;
  return `missing ${Math.max(0, expected - present)} of ${expected} regions`;
}

function anomalyRow(r, describe, isLow, identityKey) {
  const identity = identityKey ? r[identityKey] : r.base;
  return h(
    `div.anom${isLow ? '.low' : ''}`,
    h('span.anom-sev', { text: isLow ? '' : '!', title: isLow ? '' : 'No newer full render of this asset exists' }),
    h('span.anom-song', { text: r.songFolder || '' }),
    h('span.anom-base', { text: identity || r.name || '', title: identity || '' }),
    h('span.anom-ver', { text: r.verLabel || '' }),
    h('span.anom-what', { text: describe(r) }),
    isLow && r.supersededBy
      ? h('span.anom-by', { text: `superseded by ${r.supersededBy}` })
      : h('span.anom-by', { text: isLow ? 'superseded' : 'no newer full render' }),
    // File-level rows carry `size`, version-level rows carry `bytes`. A 140 GB
    // unplayable file is the whole point of its row; it must not render blank.
    h('span.anom-bytes', { text: r.bytes != null ? fmtBytes(r.bytes) : r.size != null ? fmtBytes(r.size) : '' }),
  );
}

function statMuted(label, value, sub) {
  return h('div.stat.muted-stat', h('div.k', { text: label }), h('div.v', { text: value }), sub ? h('div.s', { text: sub }) : null);
}

/* ------------------------------------------------------------------ */
/* Duplicates                                                          */
/* ------------------------------------------------------------------ */

// One mode remains. `version-shape` and `size-mtime` were removed at the
// user's request; with a single choice left the "Match on" selector would be
// a control you cannot change, so it is not rendered at all.
const DUP_MODE = 'name-size';
const DUP_MODE_DESC = 'Files sharing a filename and a size in different folders.';

export class DuplicatesPanel {
  constructor(host, { onOpenAsset } = {}) {
    this.host = host;
    this.onOpenAsset = onOpenAsset;
  }

  async load() {
    clear(this.host);
    this.host.appendChild(h('div.muted', 'Loading duplicate candidates…'));
    try {
      const res = await api.duplicates({ mode: DUP_MODE, snapshotId: state.snapshotId ?? undefined, limit: 500 });
      this.render(res);
    } catch (err) {
      clear(this.host);
      this.host.appendChild(h('div.caveat', h('div', h('b', 'Could not load duplicates. '), err.message)));
    }
  }

  render(res) {
    clear(this.host);
    const rows = res.rows || [];
    const desc = DUP_MODE_DESC;

    this.host.append(
      h(
        'div.caveat',
        h(
          'div',
          h('b', 'Likely duplicate — content not verified. '),
          'These are matched on metadata alone (names, sizes, timestamps). No file bytes are ever read, so two entries here may still differ. Treat them as candidates to look at, never as proven copies.',
        ),
      ),
      h(
        'div.toolbar',
        { style: { border: '1px solid var(--line)', borderRadius: 'var(--radius)', marginBottom: '14px' } },
        h('span.muted', 'Match on name + size'),
        h('span.spacer'),
        h('div.totals', h('b', { text: count(res.total ?? rows.length) }), ` candidate group${(res.total ?? rows.length) === 1 ? '' : 's'}`, h('span.sep', '·'),
          h('b', { text: fmtBytes(res.wastedBytes ?? res.matchedBytes ?? 0) }), ' held by the extra copies'),
      ),
      h('div.muted', { style: { marginBottom: '12px' }, text: desc }),
    );

    if (rows.length === 0) {
      this.host.appendChild(h('div.card', h('div.card-body', h('div.muted', 'No duplicate candidates under this rule.'))));
      return;
    }

    for (const g of rows.slice(0, 200)) {
      const members = g.members || [];
      this.host.appendChild(
        h(
          'div.card',
          h(
            'header',
            h('h3', { text: g.base ? `${g.songFolder || (Array.isArray(g.songFolders) ? g.songFolders.join(', ') : '')}/${g.base}` : `${members.length} matching files` }),
            h('span.n', { text: `${g.count ?? members.length} copies` }),
            h('span.spacer'),
            h('span.n', { text: `${fmtBytes(g.wastedBytes ?? 0)} in the extra copies` }),
          ),
          h(
            'div.card-body',
            autoTable(members, {
              onRowClick: g.songFolder && this.onOpenAsset ? undefined : undefined,
            }),
            h('div.card-note', { style: { padding: '8px 0 0' } }, g.label || 'Likely duplicate — content not verified.'),
          ),
        ),
      );
    }
    if (rows.length > 200) this.host.appendChild(h('div.muted', `Showing the first 200 of ${count(rows.length)} groups.`));
  }
}

function stat(label, value, sub) {
  return h('div.stat', h('div.k', { text: label }), h('div.v', { text: value }), sub ? h('div.s', { text: sub }) : null);
}

export { autoTable, stat, card, dateTime };

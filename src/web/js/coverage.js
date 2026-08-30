/**
 * REGION GAPS — versions holding some of the canvas but not all of it.
 *
 * The rest of the app measures in bytes, and a version missing ten of its
 * fourteen slices can still be enormous. This panel measures in SLICES, so a
 * delivery with holes in it reads as a delivery with holes in it.
 *
 * Every row draws the whole canvas: fourteen cells, filled where the version
 * has that slice and empty where it does not. That is the point of the view —
 * "missing 4" is a number, and the strip is the shape.
 *
 * It proposes nothing for removal. An incomplete version may be a delivery
 * still in flight, and a gap is a reason to go and look.
 */

import { h, clear } from './dom.js';
import { state } from './state.js';
import { api } from './api.js';
import { bytes as fmtBytes, count, date as fmtDate } from './format.js';
import { stat } from './panels.js';

/** How many rows to draw before the list gets a "showing the first N" note. */
const RENDER_LIMIT = 300;

export class CoveragePanel {
  constructor(host, { onCounts, onOpenAsset } = {}) {
    this.host = host;
    this.onCounts = onCounts;
    this.onOpenAsset = onOpenAsset;
    this.severity = '';
    this.includePatches = false;
    this.loaded = false;
  }

  async load() {
    this.loaded = true;
    clear(this.host);
    this.host.appendChild(h('div.muted', 'Looking for versions with region gaps…'));
    try {
      const res = await api.coverage({
        snapshotId: state.snapshotId ?? undefined,
        keepN: state.keepN,
        ...state.filters,
        ...(this.severity ? { severity: this.severity } : {}),
        ...(this.includePatches ? { includePatches: 1 } : {}),
        limit: 1000,
      });
      this.render(res);
    } catch (err) {
      clear(this.host);
      this.host.appendChild(
        h('div.caveat', h('div', h('b', 'Could not load region coverage. '), err.message)),
      );
      this.onCounts?.({ high: 0, low: 0 });
    }
  }

  render(res) {
    clear(this.host);
    const rows = res.rows || [];
    const required = res.requiredRegions || [];
    const counts = res.counts || {};
    const sev = res.severity || { high: 0, low: 0 };
    // The badge counts gaps on a LIVE master only. A badge that also counted
    // gaps a later render already fixes would train the user to ignore it.
    this.onCounts?.(sev);

    // The four buckets are a partition of every version the filters matched,
    // whichever way the patch toggle is set — so this addition is allowed to
    // be an addition. See CoverageCounts in the route.
    const totalVersions =
      (counts.completeVersions ?? 0) +
      (counts.incompleteVersions ?? 0) +
      (counts.proxyOnlyVersions ?? 0) +
      (counts.regionlessVersions ?? 0);

    this.host.append(
      h(
        'div.stat-row',
        stat(
          'Versions with gaps',
          count(counts.listedVersions ?? 0),
          `across ${count(counts.listedAssets ?? 0)} asset${counts.listedAssets === 1 ? '' : 's'}`,
        ),
        stat('On a live master', count(sev.high ?? 0), 'nothing newer exists to fix these'),
        mutedStat('Already superseded', count(sev.low ?? 0), 'a later full render presumably fixes these'),
        stat('Slices missing', count(res.listedMissingSlices ?? 0), `of ${count(required.length)} per version`),
        stat('Held by those versions', fmtBytes(res.listedBytes ?? 0), 'not a reclaim figure'),
      ),
      h(
        'div.caveat',
        h(
          'div',
          h('b', 'These are observations, not recommendations. '),
          'Nothing here is proposed for removal — an incomplete version may be a delivery still in flight. ',
          'Severity asks only whether a newer full render of the same asset exists, so it ',
          h('b', 'does not move with the keep-latest-N slider'),
          '.',
        ),
      ),
      this.requiredCard(res, required),
      this.controls(),
      this.gapsCard(rows, required, counts),
      this.accountingCard(counts, totalVersions),
    );
  }

  /** What a complete delivery is, and where that answer came from. */
  requiredCard(res, required) {
    const source =
      res.allocationSource === 'config'
        ? 'read from config/machines.json'
        : 'the rig compiled into this build';
    return h(
      'div.card',
      h(
        'header',
        h('h3', { text: 'What a complete delivery looks like' }),
        h('span.n', { text: `${count(required.length)} slices` }),
        h('span.spacer'),
      ),
      h(
        'div.card-body',
        h('div.slice-grid.legend', ...required.map((r) => sliceCell(r, true, false))),
        h(
          'div.card-note',
          { style: { padding: '10px 0 0', border: 0 } },
          `Region ${required[0] ?? '?'}–${required[required.length - 1] ?? '?'}, taken from the playback machines — ${source}. `,
          h('b', 'Region 0 is not one of them'),
          ': it is the whole-canvas copy the offline edit is cut against, not a slice of the canvas. A version that has nothing but region 0 is a preview, and is counted separately below rather than reported as a version with gaps.',
        ),
      ),
    );
  }

  controls() {
    const opts = [
      ['', 'All'],
      ['high', 'On a live master'],
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
      h(
        'label.inline-check',
        h('input', {
          type: 'checkbox',
          checked: this.includePatches,
          onChange: (e) => {
            this.includePatches = e.target.checked;
            this.load();
          },
        }),
        h('span', {
          title:
            'A _frameNNNNN render is a partial re-render covering a frame range, so it is expected to touch only some slices. Off by default — a patch with gaps is a patch, not a defect.',
          text: 'Include patch versions',
        }),
      ),
      h('span.muted', {
        style: { fontSize: '11.5px', marginLeft: '12px' },
        text: 'The sidebar filters narrow this view.',
      }),
    );
  }

  gapsCard(rows, required, counts) {
    const body = h('div.card-body');
    const total = counts.listedVersions ?? 0;

    if (rows.length === 0) {
      body.appendChild(
        h(
          'div.muted',
          total > 0
            ? 'None under this filter — clear it to see the rest.'
            : 'Every version in view carries either the whole canvas or none of it. Nothing has holes in it.',
        ),
      );
    } else {
      const shown = rows.slice(0, RENDER_LIMIT);
      body.appendChild(
        h('div.cov-list', ...shown.map((r) => this.gapRow(r, required))),
      );
      if (rows.length > shown.length) {
        body.appendChild(
          h('div.card-note', `Showing the first ${count(shown.length)} of ${count(rows.length)}.`),
        );
      }
    }

    const high = rows.filter((r) => r.severity === 'high').length;
    return h(
      'div.card',
      h(
        'header',
        h('h3', { text: 'Versions with some slices but not all' }),
        high
          ? h('span.pill.superseded', { text: `${count(high)} on a live master` })
          : h('span.n', { text: 'none on a live master' }),
        h('span.spacer'),
        h('span.n', { text: `${count(total)} in view` }),
      ),
      body,
    );
  }

  gapRow(r, required) {
    const present = new Set(r.present || []);
    // The canvas, plus anything this version has that the rig does not carry.
    // An extra slice is not a gap, but hiding it would leave a count that does
    // not add up and no reason on the screen for why.
    const cells = [...required, ...(r.extra || [])];
    const row = h(
      `div.cov${r.severity === 'low' ? '.low' : ''}`,
      {
        style: this.onOpenAsset ? { cursor: 'pointer' } : null,
        title: this.onOpenAsset ? 'Open this asset’s version ladder' : null,
        onClick: this.onOpenAsset ? () => this.onOpenAsset(r.assetId, r.versionId) : null,
      },
      h('span.cov-sev', {
        text: r.severity === 'low' ? '' : '!',
        title: r.severity === 'low' ? '' : 'No newer full render of this asset exists',
      }),
      h(
        'div.cov-id',
        h('span.cov-song', { text: r.songFolder || '' }),
        h('span.cov-base', { text: r.base || '', title: r.base || '' }),
      ),
      h(
        'div.cov-ver',
        h('span.cov-verlabel', { text: r.verLabel || '' }),
        r.isPatch ? h('span.pill.patch', { text: 'patch' }) : null,
        h(`span.pill.${r.status || 'unknown'}`, { text: r.status || 'unknown' }),
      ),
      h(
        'div.slice-grid',
        ...cells.map((n) => sliceCell(n, present.has(n), !required.includes(n))),
      ),
      h(
        'div.cov-what',
        h('b', { text: `missing ${count(r.missingCount ?? 0)}` }),
        h('span.cov-missing', { text: ` · region ${(r.missing || []).join(', ')}` }),
      ),
      h('span.cov-by', {
        text:
          r.severity === 'low' && r.supersededBy
            ? `superseded by ${r.supersededBy}`
            : r.severity === 'low'
              ? 'superseded'
              : 'no newer full render',
      }),
      h('span.cov-when', { text: r.latestMtime ? fmtDate(r.latestMtime) : '' }),
      h('span.cov-bytes', { text: fmtBytes(r.bytes ?? 0) }),
    );
    return row;
  }

  /**
   * Every version in view, in exactly one bucket. Same gesture as the machine
   * view's reconcile block: a partial list invites the question "what about
   * the rest of them", and this answers it on the page.
   */
  accountingCard(counts, totalVersions) {
    const rowsOf = [
      ['Complete', counts.completeVersions ?? 0, 'every required slice present'],
      [
        'With gaps',
        counts.incompleteVersions ?? 0,
        counts.incompletePatchVersions
          ? `some slices, not all — of which ${count(counts.incompletePatchVersions)} are patches`
          : 'some slices, not all — listed above',
      ],
      [
        'Region 0 only',
        counts.proxyOnlyVersions ?? 0,
        'a whole-canvas preview with no slices behind it — offline-edit material, not a delivery',
      ],
      [
        'No region token',
        counts.regionlessVersions ?? 0,
        'a legal whole-canvas deliverable that is not cut into slices at all',
      ],
    ];
    return h(
      'div.card',
      h(
        'header',
        h('h3', { text: 'Every version in view, accounted for' }),
        h('span.n', { text: `${count(totalVersions)} versions` }),
        h('span.spacer'),
      ),
      h(
        'div.card-body',
        h(
          'table.grid',
          h('thead', h('tr', h('th', 'Bucket'), h('th.num', 'Versions'), h('th', 'What it means'))),
          h(
            'tbody',
            ...rowsOf.map(([label, n, why]) =>
              h('tr', h('td', { text: label }), h('td.num', { text: count(n) }), h('td.muted', { text: why })),
            ),
          ),
        ),
        counts.incompletePatchVersions
          ? h(
              'div.card-note',
              { style: { padding: '10px 0 0' } },
              `${count(counts.incompletePatchVersions)} patch version${counts.incompletePatchVersions === 1 ? '' : 's'} also carry only some slices. A patch covers a frame range and is expected to, so ${this.includePatches ? 'they are shown above because you asked for them' : 'they are not listed above'}.`,
            )
          : null,
      ),
    );
  }
}

/** One slice of the canvas. Filled when present, hollow when missing. */
function sliceCell(n, present, extra) {
  const cls = extra ? 'extra' : present ? 'on' : 'off';
  return h(`i.slice.${cls}`, {
    text: String(n),
    title: extra
      ? `region ${n} — present, but no playback machine carries it`
      : present
        ? `region ${n} — present`
        : `region ${n} — MISSING`,
  });
}

function mutedStat(label, value, sub) {
  return h(
    'div.stat.muted-stat',
    h('div.k', { text: label }),
    h('div.v', { text: value }),
    sub ? h('div.s', { text: sub }) : null,
  );
}

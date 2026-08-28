/**
 * The main table: mode toggle, running totals, and the virtualized grid.
 *
 * Rows are Files / Asset-versions / Song folders. Asset-versions is the
 * default and the one the reclaim maths is expressed in, so it carries the
 * selection checkboxes and the keep/supersede colouring.
 */

import { h, clear, pathCell } from './dom.js';
import { state, update, inManifest, setInManifest, effectiveStatus, selectionTotals, clearOverrides, filterParams, selectionParams, defaultSortFor } from './state.js';
import { api } from './api.js';
import { VirtualTable } from './vtable.js';
import { isNarrow } from './viewport.js';
import {
  bytes as fmtBytes,
  count,
  date as fmtDate,
  keepReasonText,
  keepReasonDetail,
  statusLabel,
  OVERRIDE_REASON_TEXT,
  overrideReasonDetail,
} from './format.js';

/** What ticking a row actually does. Shown on the column head and every box. */
const TICK_TIP =
  'Ticked means this version is IN the export manifest. Everything the policy ' +
  'slates for removal starts ticked; un-tick to keep it anyway. Nothing is ' +
  'deleted either way — the manifest is a FreeFileSync job you run yourself.';
const TICK_TIP_KEPT =
  'The policy is keeping this version at the current keep-N, so it is not in ' +
  'the manifest. A version that is being kept cannot be added by hand.';

/** Display names for MachineSpec.role, mirroring ROLE_LABELS in src/machines.ts. */
const ROLE_LABELS = {
  actor: 'Actor',
  understudy: 'Understudy',
  director: 'Director',
  // Shortened: the full phrase is clipped by the column at any sane width.
  'director-understudy': 'Director u/s',
};

const MODES = [
  ['versions', 'Asset-versions'],
  ['files', 'Files'],
  ['songs', 'Song folders'],
  ['machines', 'Per-machine'],
];

export class TableView {
  constructor(host, { onOpenAsset, onSelectionChange }) {
    this.host = host;
    this.onOpenAsset = onOpenAsset;
    this.onSelectionChange = onSelectionChange;
    this.total = 0;
    this.matchedBytes = null;
    this.activeAssetId = null;
    this.build();
  }

  build() {
    clear(this.host);
    this.modeSeg = h('div.seg');
    this.totalsEl = h('div.totals');
    this.selectAllEl = h('label.muted', { style: { display: 'none' } });
    this.hintEl = h('span.muted');

    this.toolbar = h(
      'div.toolbar',
      this.modeSeg,
      this.totalsEl,
      h('span.spacer'),
      this.selectAllEl,
      this.hintEl,
    );

    this.tableHost = h('div.vt');
    this.host.append(this.toolbar, this.tableHost);

    this.table = new VirtualTable(this.tableHost, {
      rowHeight: 30,
      columns: this.columns(),
      // Column widths are remembered per table, and the narrow layout is a
      // different table from the wide one, so it gets its own widths.
      layoutKey: () => (isNarrow() ? `${state.mode}.narrow` : state.mode),
      getSort: () => ({ sort: state.sort, dir: state.dir }),
      onSort: (key) => this.sortBy(key),
      fetchPage: (offset, limit) => this.fetchPage(offset, limit),
      rowClass: (row) => this.rowClass(row),
      rowSignature: (row) => this.rowSignature(row),
      onRowClick: (row) => this.openRow(row),
      rowIsClickable: (row) => this.rowIsClickable(row),
      onTotals: ({ total, matchedBytes }) => {
        this.total = total;
        this.matchedBytes = matchedBytes;
        this.paintTotals();
        this.onSelectionChange?.();
      },
      onError: (err) => this.showError(err),
      emptyNode: () => h('div', { style: { textAlign: 'center' } }, h('div', 'Nothing matches the current filters.'), h('div.muted', { style: { marginTop: '6px', fontSize: '12px' } }, 'Loosen a filter on the left, or clear them all.')),
    });

    this.renderModes();
  }

  renderModes() {
    clear(this.modeSeg);
    for (const [value, label] of MODES) {
      this.modeSeg.appendChild(
        h(`button${state.mode === value ? '.on' : ''}`, {
          type: 'button',
          text: label,
          onClick: () => {
            if (state.mode === value) return;
            update({ mode: value }, 'mode');
          },
        }),
      );
    }
  }

  sortBy(key) {
    const d = defaultSortFor(state.mode);
    const dir = state.sort === key ? (state.dir === 'asc' ? 'desc' : 'asc') : key === 'songFolder' || key === 'base' || key === 'relPath' || key === 'name' || key === 'ext' ? 'asc' : 'desc';
    update({ sort: key, dir }, 'sort');
    void d;
  }

  /** Called by main.js when state changed in a way that invalidates rows. */
  refresh() {
    this.renderModes();
    this.table.setColumns(this.columns());
    this.table.renderHead();
    return this.table.reload();
  }

  /** Cheap repaint for selection changes only. */
  repaintSelection() {
    this.table.repaint();
    this.paintSelectAll();
  }

  async fetchPage(offset, limit) {
    const params = { ...filterParams(), sort: state.sort, dir: state.dir, limit, offset, keepN: state.keepN };

    // "Only what I've ticked" applies to asset-versions alone: a selection is
    // a set of VERSION ids, so it has no meaning in the file or song domains.
    const sel = state.mode === 'versions' ? selectionParams() : null;
    if (sel?.empty) {
      // Nothing ticked. Answer locally: an empty id list and an omitted one
      // look identical in a query string, and omitted means "no filter" --
      // which would show everything, the exact opposite of what was asked.
      return { rows: [], total: 0, matchedBytes: 0, limit, offset };
    }
    if (sel) Object.assign(params, sel);

    if (state.mode === 'versions') return api.versions(params);
    if (state.mode === 'files') return api.files(params);
    if (state.mode === 'songs') return api.songs(params);

    // The machine rollup carries two things no other mode has: where the
    // allocation came from, and how the bytes reconcile. Both are stashed for
    // paintTotals, which runs after this resolves.
    const res = await api.machines(params);
    this.machineMeta = {
      allocationSource: res.allocationSource ?? null,
      reconcile: res.reconcile ?? null,
      machineCount: res.machineCount ?? 0,
      drive: res.drive ?? null,
      firstRow: res.rows?.[0] ?? null,
    };
    return res;
  }

  showError(err) {
    clear(this.hintEl);
    this.hintEl.className = 'err';
    // Same reasoning as the reclaim strip: an empty index is a starting state,
    // so it gets an instruction rather than a raw error code.
    this.hintEl.textContent =
      err.code === 'no_snapshot'
        ? 'No index yet — press Scan now to build one.'
        : `${err.code ? `${err.code}: ` : ''}${err.message}`;
  }

  paintTotals() {
    // Singular when there is exactly one. Filtering down to a single row is
    // common enough -- one patch, one anomaly -- that "1 versions" shows up
    // regularly.
    const one = this.total === 1;
    const NOUNS = {
      versions: ['version', 'versions'],
      files: ['file', 'files'],
      songs: ['song folder', 'song folders'],
      machines: ['machine', 'machines'],
    };
    const noun = (NOUNS[state.mode] ?? NOUNS.versions)[one ? 0 : 1];
    clear(this.totalsEl);
    this.hintEl.className = 'muted';

    // In every other mode the rows partition the media, so summing their bytes
    // gives what is in view. Machine rows OVERLAP -- on a mirrored rig every
    // byte appears twice -- so that sum is not "matched", it is what the rig
    // stores. Showing it under the same word would be a straightforward
    // misstatement of how big the archive is.
    const r = state.mode === 'machines' ? this.machineMeta?.reconcile : null;
    if (r) {
      this.totalsEl.append(
        h('b', { text: count(this.total) }),
        ` ${noun}`,
        h('span.sep', '·'),
        h('b', { text: fmtBytes(r.allocatedBytes) }),
        ' allocated',
        h('span.sep', '·'),
        h('b', { text: fmtBytes(r.allocatedBytes + r.duplicatedBytes) }),
        ' stored across the rig',
      );
    } else {
      this.totalsEl.append(
        h('b', { text: count(this.total) }),
        ` ${noun}`,
        h('span.sep', '·'),
        h('b', { text: this.matchedBytes == null ? '—' : fmtBytes(this.matchedBytes) }),
        ' matched',
      );
    }
    if (state.mode === 'machines') this.paintMachineNote();
    this.paintSelectAll();
  }

  /**
   * The two things a per-machine table would otherwise mislead about.
   *
   * FIRST, whether the allocation is real. While it is a placeholder the
   * machine names are invented, and a table of plausible-looking names with
   * real byte totals beside them is the single worst thing this view could be.
   *
   * SECOND, that the column does not sum to the archive. A region can be held
   * by more than one machine, so bytes appear in more than one row by design.
   * The note states the overlap as a number rather than leaving someone to
   * discover their totals do not tie out.
   */
  paintMachineNote() {
    const meta = this.machineMeta;
    if (!meta) return;
    clear(this.hintEl);
    this.hintEl.className = 'muted';

    // The meter has more than one segment, so identity may not rest on colour
    // alone: every band is named here.
    const swatch = (cls, label) =>
      h('span.meter-legend', h(`i.${cls}`), h('span', { text: label }));
    this.hintEl.append(
      h(
        'span',
        { style: { display: 'inline-flex', gap: '12px', flexWrap: 'wrap', marginRight: '10px' } },
        swatch('meter-kept', 'stays'),
        swatch('meter-recover', 'recoverable'),
        swatch('meter-reserve', 'reserved headroom'),
      ),
    );

    // What the fullness figures assume, said on the page rather than left in
    // the source: a drive sold as 32 TB holds 29.10 TiB, not 32 TiB, and the
    // difference decides whether the fullest machine reads 94% or 86%.
    const d = meta.drive;
    const r0 = meta.firstRow;
    if (d && r0) {
      this.hintEl.append(
        `Drives ${fmtBytes(d.defaultCapacityBytes)} (${(d.defaultCapacityBytes / 1e12).toFixed(0)} TB as labelled), ` +
          `less ${(d.reserveFraction * 100).toFixed(0)}% headroom = ${fmtBytes(r0.usableBytes)} usable; ` +
          'percentages are of that. ',
      );
    }

    if (meta.allocationSource === 'built-in') {
      // Not a warning: the rig is real. It is a statement of where it lives,
      // because it cannot be changed from this screen.
      this.hintEl.append('Allocation is compiled in (src/machines.ts). ');
    }

    const r = meta.reconcile;
    if (!r) return;
    const bits = [];
    if (r.duplicatedBytes > 0) {
      const times = r.allocatedBytes ? (r.allocatedBytes + r.duplicatedBytes) / r.allocatedBytes : 1;
      bits.push(
        `${fmtBytes(r.duplicatedBytes)} is held by more than one machine — the rig stores ` +
          `${times.toFixed(2)}× what the archive holds, so these rows overlap and do not sum ` +
          'to it',
      );
    } else {
      bits.push('no region is held by two machines, so these rows happen not to overlap');
    }
    if (r.unallocatedBytes > 0) {
      bits.push(
        `${fmtBytes(r.unallocatedBytes)} in region${r.unallocatedRegions.length === 1 ? '' : 's'} ` +
          `${r.unallocatedRegions.join(', ')} reaches NO machine`,
      );
    }
    if (r.regionlessBytes > 0) {
      bits.push(`${fmtBytes(r.regionlessBytes)} carries no region and is not allocatable`);
    }
    if (r.unparsedBytes > 0) {
      bits.push(`${fmtBytes(r.unparsedBytes)} has a name the grammar cannot read`);
    }
    // The placeholder warning may precede this, so the first clause starts a
    // new sentence rather than trailing off the end of that one.
    const joined = bits.join(' · ');
    this.hintEl.append(`${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`);
  }

  /**
   * The line above the table: what the manifest currently covers, repainted on
   * every tick. This is the feedback the tick box needs -- you can see the
   * number move as you veto a row, so what the box does is never in doubt.
   */
  paintSelectAll() {
    if (state.mode !== 'versions') {
      this.selectAllEl.style.display = 'none';
      return;
    }
    clear(this.selectAllEl);
    const t = selectionTotals(state.slated);

    const parts = [
      h('b', { text: count(t.count) }),
      ` version${t.count === 1 ? '' : 's'} in the manifest`,
    ];
    if (t.bytes != null) parts.push(h('span.sep', '·'), h('b', { text: fmtBytes(t.bytes) }));
    if (t.vetoed > 0) {
      parts.push(
        h('span.sep', '·'),
        h('span', {
          style: { color: 'var(--kept)' },
          text: `${count(t.vetoed)} you chose to keep`,
        }),
        h('button.btn.sm.ghost', {
          type: 'button',
          text: 'Reset',
          title: 'Drop your overrides and go back to exactly what the policy slates',
          style: { marginLeft: '8px' },
          onClick: () => clearOverrides(),
        }),
      );
    } else {
      parts.push(
        // Classed so the narrow layout can drop it: on a phone it wraps to two
        // lines of a toolbar that is already taking a quarter of the screen,
        // and the status bar carries the same figures at the bottom.
        h('span.muted.slated-hint', {
          style: { marginLeft: '8px', fontSize: '11.5px' },
          text: 'everything slated for removal under these filters · un-tick a row to keep it',
        }),
      );
    }
    this.selectAllEl.append(...parts);
    // On a phone this line repeats what the status bar already shows along the
    // bottom of the screen -- EXCEPT when you have overrides, because then it
    // carries the Reset button, which lives nowhere else. Decided here rather
    // than in CSS because the display below is an inline style, and an inline
    // style beats any stylesheet rule that tries to hide it.
    const duplicatesStatusBar = isNarrow() && t.vetoed === 0;
    this.selectAllEl.style.display = duplicatesStatusBar ? 'none' : 'flex';
    this.selectAllEl.style.alignItems = 'center';
    this.selectAllEl.style.gap = '6px';
  }

  /**
   * A file row can only open the version ladder when the API hands back the
   * owning assetId. The contract does not require it on /api/files and there
   * is no route from a versionId to its asset, so without it the row is inert
   * rather than silently doing nothing. Flagged to the API agent.
   */
  rowIsClickable(row) {
    if (state.mode === 'files') return row.assetId != null;
    // A machine row has nowhere to drill to: there is no region filter, so
    // clicking through would land on an unfiltered version list and look like
    // it had done something.
    if (state.mode === 'machines') return false;
    return true;
  }

  rowClass(row) {
    const cls = [];
    if (state.mode === 'versions') {
      if (row.status === 'superseded') cls.push('is-superseded');
      // No row tint for manifest membership. Under the opt-out model most rows
      // ARE in the manifest, so tinting them washed out half the table and
      // made the exceptions harder to spot -- the opposite of the point. The
      // tick box and the status flag already say it, per row, without shouting.
      if (this.activeAssetId != null && row.assetId === this.activeAssetId) cls.push('active-row');
    }
    return cls.join(' ');
  }

  rowSignature(row) {
    // Files rows carry the verdict of their version, so an override made in
    // the versions view has to be able to repaint them too -- otherwise the
    // Status and Why cells keep showing the policy's answer after you have
    // overruled it.
    if (state.mode === 'files') return `${row.id}|${effectiveStatus(row)}`;
    if (state.mode !== 'versions') return null;
    return `${row.versionId}|${effectiveStatus(row)}|${inManifest(row) ? 1 : 0}|${row.assetId === this.activeAssetId ? 1 : 0}`;
  }

  openRow(row) {
    if (state.mode === 'versions') {
      this.activeAssetId = row.assetId;
      this.table.repaint();
      this.onOpenAsset?.(row.assetId, row.versionId);
    } else if (state.mode === 'files' && row.assetId == null) {
      // No way to resolve this file's asset from the contract as written.
    } else if (state.mode === 'files') {
      this.activeAssetId = row.assetId;
      this.onOpenAsset?.(row.assetId, row.assetVersionId);
    } else if (state.mode === 'songs') {
      update({ mode: 'versions', filters: { songFolder: row.songFolder } }, 'mode');
    }
  }

  setActiveAsset(assetId) {
    this.activeAssetId = assetId;
    this.table.repaint();
  }

  /* ---------------------------------------------------------------- */
  /* Column definitions                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Columns that survive the phone layout, per mode. Everything else is
   * dropped outright rather than squeezed: twelve columns on a 390px screen
   * is unreadable at any font size, and a horizontal scroll past nine columns
   * you did not want is worse than not having them.
   *
   * What is kept is what identifies a row and what the tool is FOR: which
   * asset, which version, whether it is superseded, and how big it is. The
   * detail lives one tap away in the ladder sheet, which is a better place
   * for it on a phone than a column you have to scroll sideways to reach.
   */
  static NARROW_KEYS = {
    files: ['relPath', 'size'],
    songs: ['songFolder', 'versionCount', 'totalBytes'],
    machines: ['name', 'totalBytes', 'usedFraction'],
  };

  columns() {
    if (isNarrow()) {
      if (state.mode === 'versions') return this.narrowVersionColumns();
      const all =
        state.mode === 'files'
          ? this.fileColumns()
          : state.mode === 'machines'
            ? this.machineColumns()
            : this.songColumns();
      const keep = new Set(TableView.NARROW_KEYS[state.mode] ?? []);
      const narrow = all.filter((c) => keep.has(c.key));
      // Never return an empty header: if a mode grows a new key set and this
      // map falls behind, every column beats no column.
      return narrow.length ? narrow : all;
    }
    if (state.mode === 'files') return this.fileColumns();
    if (state.mode === 'songs') return this.songColumns();
    if (state.mode === 'machines') return this.machineColumns();
    return this.versionColumns();
  }

  /**
   * The phone layout for asset-versions.
   *
   * Simply dropping columns did not work: the four that mattered still needed
   * ~620px, so status and size ended up behind a horizontal swipe -- which is
   * where you least want the two facts the whole tool exists to show. So the
   * row becomes two lines inside one cell instead of four columns:
   *
   *     [x]  580_CAUSEWAY_0000A_LL180                     475.4 GiB
   *          580_CAUSEWAY - v002 - kept
   *
   * Everything fits 390px with no sideways scroll, and the full column set is
   * one tap away in the ladder sheet.
   */
  narrowVersionColumns() {
    return [
      {
        key: 'sel',
        label: '',
        width: '36px',
        sortable: false,
        render: (row) => {
          const slated = row.status === 'superseded';
          const cb = h('input', {
            type: 'checkbox',
            'data-stop': '',
            checked: inManifest(row),
            disabled: !slated,
            title: slated ? TICK_TIP : TICK_TIP_KEPT,
            onChange: (e) => setInManifest(row, e.target.checked),
          });
          return h('div.checkcell', { 'data-stop': '' }, cb);
        },
      },
      {
        key: 'base',
        label: 'Asset',
        width: 'minmax(0, 1fr)',
        render: (row) =>
          h(
            'div.stack',
            h('span.stack-1', { text: row.base }),
            h(
              'div.stack-2',
              h('span.cell-song', { text: row.songFolder }),
              h('span.stack-dot', { text: '·' }),
              h('span.cell-ver', { text: row.verLabel }),
              row.isPatch ? h('span.pill.patch.tiny', { text: 'patch' }) : null,
              h(`span.pill.${effectiveStatus(row)}.tiny`, { text: statusLabel(effectiveStatus(row)) }),
            ),
          ),
        tooltip: (row) => `${row.songFolder}/${row.base} ${row.verLabel}`,
      },
      {
        key: 'bytes',
        label: 'Size',
        width: '92px',
        align: 'right',
        render: (row) => sizeCell(row.bytes),
      },
    ];
  }

  versionColumns() {
    return [
      {
        key: 'sel',
        label: '',
        width: '58px',
        sortable: false,
        // An unlabelled checkbox column is a guess. Say what ticking does.
        head: () => h('span', { title: TICK_TIP, text: 'Mark' }),
        render: (row) => {
          const cb = h('input', {
            type: 'checkbox',
            'data-stop': '',
            checked: inManifest(row),
            disabled: row.status !== 'superseded',
            title: row.status === 'superseded' ? TICK_TIP : TICK_TIP_KEPT,
            onChange: (e) => setInManifest(row, e.target.checked),
          });
          return h('div.checkcell', { 'data-stop': '' }, cb);
        },
      },
      {
        key: 'songFolder',
        label: 'Song',
        width: 'minmax(110px, 0.7fr)',
        render: (row) => h('span.cell-song', { text: row.songFolder }),
        tooltip: (row) => row.songFolder,
      },
      {
        key: 'base',
        label: 'Asset',
        width: 'minmax(220px, 2.2fr)',
        render: (row) => h('span.cell-base', { text: row.base }),
        tooltip: (row) => `${row.songFolder}/${row.base}`,
      },
      {
        key: 'verLabel',
        label: 'Version',
        width: '108px',
        render: (row) => h('span.cell-ver', { text: row.verLabel }),
        tooltip: (row) => (row.isPatch ? `Partial re-render, frame ${row.patchFrame ?? '?'}` : 'Full render'),
      },
      {
        key: 'isPatch',
        label: 'Type',
        width: '62px',
        render: (row) => (row.isPatch ? h('span.pill.patch', { text: 'patch' }) : h('span.pill.muted', { text: 'full' })),
        tooltip: (row) => (row.isPatch ? 'A partial re-render covering a frame range — never a replacement for the full version of the same number.' : 'A complete render of every region.'),
      },
      {
        key: 'status',
        label: 'Status',
        width: '152px',
        render: (row) =>
          h(`span.pill.${effectiveStatus(row)}`, {
            text: statusLabel(effectiveStatus(row)),
            title:
              effectiveStatus(row) === 'kept-by-you'
                ? 'The policy slates this for removal; you un-ticked it, so it stays out of the manifest.'
                : '',
          }),
      },
      {
        key: 'keepReason',
        label: 'Why',
        width: 'minmax(180px, 1.6fr)',
        sortable: false,
        // Once you have un-ticked a row, YOU are the reason it is being kept.
        // Showing the policy's sentence there would read as though the tool
        // decided; it moves to the tooltip instead.
        render: (row) =>
          effectiveStatus(row) === 'kept-by-you'
            ? h('span.reason.override', { text: OVERRIDE_REASON_TEXT })
            : h('span.reason', { text: keepReasonText(row.keepReason) }),
        tooltip: (row) =>
          effectiveStatus(row) === 'kept-by-you'
            ? overrideReasonDetail(row.keepReason)
            : `${row.keepReason}\n\n${keepReasonDetail(row.keepReason)}`,
      },
      {
        key: 'family',
        label: 'Family',
        width: '92px',
        render: (row) => h('span.pill.family', { text: row.family }),
        title: 'Display label only — never a removal recommendation',
      },
      {
        key: 'fileCount',
        label: 'Files',
        width: '58px',
        align: 'right',
        render: (row) => count(row.fileCount),
      },
      {
        key: 'regionCount',
        label: 'Regions',
        // 58px fitted "Tiles" but clips "Regions" -- the header is uppercase
        // with letter-spacing, so it is wider than the digits beneath it.
        width: '78px',
        align: 'right',
        render: (row) => (row.regionCount ? count(row.regionCount) : h('span.muted', { text: '—' })),
        tooltip: (row) =>
          `${row.regionCount} distinct slices — region 0, the whole canvas, is not one of them`,
      },
      {
        key: 'bytes',
        label: 'Version size',
        width: '108px',
        align: 'right',
        render: (row) => sizeCell(row.bytes),
        tooltip: (row) => `${row.fileCount} files summed — this is the number a "version" actually costs`,
      },
      {
        key: 'latestMtime',
        label: 'Modified',
        width: '96px',
        align: 'right',
        render: (row) => fmtDate(row.latestMtime),
      },
    ];
  }

  fileColumns() {
    return [
      {
        key: 'relPath',
        label: 'Path',
        width: 'minmax(320px, 3fr)',
        render: (row) => h('span.mono', { style: { fontSize: '11.8px' } }, pathCell(row.relPath)),
        tooltip: (row) => row.relPath,
      },
      { key: 'ext', label: 'Ext', width: '58px', render: (row) => h('span.mono', { text: row.ext || '—' }) },
      {
        key: 'status',
        label: 'Status',
        width: '152px',
        sortable: false,
        // A file has no fate of its own: it goes or stays with its version.
        render: (row) =>
          row.status === 'unknown'
            ? h('span.pill.muted', {
                text: 'no version',
                title:
                  'This filename did not match the version grammar, so the file belongs to no asset-version and no keep-N verdict applies to it. ' +
                  'The Anomalies tab lists these with the reason.',
              })
            : h(`span.pill.${effectiveStatus(row)}`, {
                text: statusLabel(effectiveStatus(row)),
                title:
                  effectiveStatus(row) === 'kept-by-you'
                    ? 'The policy slates this version for removal; you un-ticked it, so it stays out of the manifest.'
                    : 'The verdict on the version this file belongs to.',
              }),
      },
      {
        key: 'keepReason',
        label: 'Why',
        width: 'minmax(160px, 1.4fr)',
        sortable: false,
        render: (row) => {
          if (effectiveStatus(row) === 'kept-by-you') return h('span.reason.override', { text: OVERRIDE_REASON_TEXT });
          return row.keepReason
            ? h('span.reason', { text: keepReasonText(row.keepReason) })
            : h('span.muted', { text: '—' });
        },
        tooltip: (row) => {
          if (effectiveStatus(row) === 'kept-by-you') return overrideReasonDetail(row.keepReason);
          return row.keepReason ? `${row.keepReason}\n\n${keepReasonDetail(row.keepReason)}` : '';
        },
      },
      {
        key: 'assetVersionId',
        label: 'Version',
        width: '92px',
        sortable: false,
        render: (row) => (row.assetVersionId == null ? h('span.muted', { text: '—' }) : h('span.mono.muted', { text: `#${row.assetVersionId}` })),
      },
      // Present only once something has been probed. Before that it would be
      // a column of dashes explaining nothing; after `npm run probe` it fills
      // in on the next load with no other change.
      state.mediaProbed > 0 && {
        key: 'resolution',
        label: 'Resolution',
        width: '116px',
        align: 'right',
        // Three states, and they are NOT the same thing: dimensions we read,
        // a file we read that had none, and a file nobody has looked inside
        // yet. Sorting is by pixel count -- 8996x2584 against 3976x3248 cannot
        // be ordered on either axis alone.
        render: (row) => {
          if (row.width && row.height) return h('span.mono', { text: `${row.width}×${row.height}` });
          // Probed and empty is not the same as unprobed. A .mov whose header
          // atom was never written is an interrupted render — the bytes are
          // there and nothing can open them — so it gets said out loud.
          if (row.probed) return h('span.pill.broken', { text: 'no header' });
          return h('span.muted', { text: '—' });
        },
        tooltip: (row) => {
          if (row.width && row.height) return `${(row.width * row.height).toLocaleString()} pixels, read from this file's own header`;
          if (row.probed) return 'Read cleanly, but the file carries no header atom — an interrupted render. Nothing can play this file.';
          return 'Not probed yet. Run `npm run probe` to read dimensions from the file headers.';
        },
      },
      { key: 'size', label: 'Size', width: '108px', align: 'right', render: (row) => sizeCell(row.size) },
      { key: 'mtime', label: 'Modified', width: '150px', align: 'right', render: (row) => fmtDate(row.mtime) },
    ].filter(Boolean);
  }

  songColumns() {
    const maxBytes = 1;
    return [
      { key: 'songFolder', label: 'Song folder', width: 'minmax(180px, 1.4fr)', render: (row) => h('span.cell-base', { text: row.songFolder }) },
      { key: 'assetCount', label: 'Assets', width: '80px', align: 'right', render: (row) => count(row.assetCount) },
      { key: 'versionCount', label: 'Versions', width: '86px', align: 'right', render: (row) => count(row.versionCount) },
      { key: 'fileCount', label: 'Files', width: '80px', align: 'right', render: (row) => count(row.fileCount) },
      { key: 'totalBytes', label: 'Total', width: '112px', align: 'right', render: (row) => sizeCell(row.totalBytes) },
      {
        key: 'supersededBytes',
        label: 'Superseded',
        width: '112px',
        align: 'right',
        render: (row) => (row.supersededBytes ? h('span', { style: { color: 'var(--superseded)' } }, sizeCell(row.supersededBytes)) : h('span.muted', { text: '—' })),
      },
      {
        key: 'share',
        label: 'Share superseded',
        width: 'minmax(120px, 1fr)',
        sortable: false,
        render: (row) => {
          const pct = row.totalBytes ? (row.supersededBytes / row.totalBytes) * 100 : 0;
          return h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', width: '100%' }, title: `${pct.toFixed(1)}% of this folder is superseded at keep-${state.keepN}` },
            h('div.bar', { style: { flex: '1' } }, h('i', { style: { width: `${Math.min(100, pct)}%` } })),
            h('span.mono.muted', { style: { fontSize: '11px', minWidth: '38px', textAlign: 'right' }, text: `${pct.toFixed(0)}%` }),
          );
        },
      },
      { key: 'latestMtime', label: 'Latest', width: '96px', align: 'right', render: (row) => fmtDate(row.latestMtime) },
    ];
    void maxBytes;
  }

  /**
   * One row per playback machine.
   *
   * `Total` is what that machine has to hold, and it is NOT a share of the
   * archive -- see paintMachineNote. `Shared` is the part of it some other
   * machine also holds, which is the only honest way to show redundancy in a
   * column of overlapping totals: it reads as zero when the allocation happens
   * to be a partition, and stops being zero the moment it is not.
   */
  machineColumns() {
    return [
      {
        key: 'name',
        label: 'Machine',
        width: 'minmax(150px, 1.2fr)',
        render: (row) =>
          h(
            'div',
            { title: row.note || undefined },
            h('div.cell-base', { text: row.name }),
            row.note ? h('div.muted', { style: { fontSize: '11px' }, text: row.note }) : null,
          ),
      },
      {
        key: 'role',
        label: 'Role',
        width: 'minmax(96px, 0.7fr)',
        render: (row) => h('span', { text: ROLE_LABELS[row.role] ?? row.role }),
      },
      {
        key: 'regions',
        label: 'Regions',
        width: 'minmax(90px, 0.7fr)',
        sortable: false,
        render: (row) =>
          row.regions.length
            ? h('span.mono', { style: { fontSize: '11.5px' }, text: row.regions.join(', ') })
            : h('span.muted', { text: 'none assigned' }),
      },
      { key: 'fileCount', label: 'Files', width: '84px', align: 'right', render: (row) => count(row.fileCount) },
      { key: 'totalBytes', label: 'Total', width: '112px', align: 'right', render: (row) => sizeCell(row.totalBytes) },
      {
        // Was 'Superseded'. On a machine row the question is not what fraction
        // of the media is superseded, it is what a cleanup would free on THIS
        // drive -- which is the same number under a name that says so.
        key: 'supersededBytes',
        label: 'Recoverable',
        width: '112px',
        align: 'right',
        render: (row) =>
          row.supersededBytes
            ? h(
                'span',
                {
                  style: { color: 'var(--superseded)' },
                  title: `Removing the versions superseded at keep-${state.keepN} would free this much on ${row.name}`,
                },
                sizeCell(row.supersededBytes),
              )
            : h('span.muted', { text: '—' }),
      },
      {
        key: 'usedFraction',
        label: 'Drive',
        width: 'minmax(150px, 1.3fr)',
        render: (row) => driveMeter(row),
      },
      {
        key: 'freeBytes',
        label: 'Free',
        width: '104px',
        align: 'right',
        render: (row) =>
          row.freeBytes >= 0
            ? h('span', { title: `${fmtBytes(row.usableBytes)} usable of a ${fmtBytes(row.capacityBytes)} drive` }, sizeCell(row.freeBytes))
            : h(
                'span',
                { style: { color: 'var(--warn)' }, title: 'Past the reserved headroom' },
                `−${fmtBytes(-row.freeBytes)}`,
              ),
      },
      {
        // On a fully mirrored rig `sharedBytes` equals `totalBytes` on every
        // row, so a column of it would just restate Total. What is actually
        // wanted is WHICH machine covers this one -- the question asked when
        // one of them fails. The byte figure rides along as the tooltip so the
        // arithmetic is still reachable.
        key: 'peers',
        label: 'Mirrored on',
        width: 'minmax(100px, 0.8fr)',
        sortable: false,
        render: (row) =>
          row.peers && row.peers.length
            ? h('span.mono', {
                style: { fontSize: '11.5px' },
                title: `${fmtBytes(row.sharedBytes)} of this machine's media is also held elsewhere`,
                text: row.peers.join(', '),
              })
            : h('span.muted', { text: 'nothing covers it' }),
      },
      { key: 'latestMtime', label: 'Latest', width: '96px', align: 'right', render: (row) => fmtDate(row.latestMtime) },
    ];
  }
}

/**
 * One machine's drive, drawn as the whole drive rather than as a percentage.
 *
 * The track IS the capacity, so the reserved headroom is a visible slice of it
 * instead of a number quietly taken off the top: you can see the part you are
 * not allowed to fill. The used portion is split into what stays after a
 * cleanup and what a cleanup would free, which is the second question a person
 * looking at a full drive immediately asks.
 *
 * The percentage beside it is of USABLE space, not of the drive, so 100% means
 * "into the reserve" rather than "physically full" -- the line worth flagging,
 * and reachable while the drive still has bytes on it. Severity is never colour
 * alone: the critical and over states carry a word as well.
 */
function driveMeter(row) {
  const cap = row.capacityBytes || 1;
  const pctOf = (n) => `${Math.max(0, (n / cap) * 100)}%`;
  const over = row.freeBytes < 0;

  // Segments are fractions of the DRIVE. When a machine is into its reserve the
  // overflow is drawn in the reserve's place, so the bar still totals the drive
  // and the encroachment is where you would look for it.
  const kept = Math.max(0, row.keptBytes);
  const recover = Math.max(0, row.supersededBytes);
  const free = Math.max(0, row.freeBytes);
  const reserve = Math.max(0, row.reserveBytes);
  const spill = over ? Math.min(-row.freeBytes, reserve) : 0;

  const seg = (cls, bytes) =>
    bytes > 0 ? h(`span.${cls}`, { style: { width: pctOf(bytes) } }) : null;

  const pctText = `${(row.usedFraction * 100).toFixed(row.usedFraction >= 1 ? 0 : 1)}%`;
  // No badge for 'critical'. The bar shows it, and the threshold behind the
  // word is an approximation built on an assumed capacity and an assumed
  // reserve -- a label reads as a finding, which is more certainty than the
  // number deserves. 'over' is kept because it is the one state the bar CANNOT
  // show: a full track looks the same whether a machine just fits or does not.
  const flag = row.driveState === 'over' ? 'OVER' : null;

  return h(
    'div.meter',
    {
      title:
        `${row.name}: ${fmtBytes(row.totalBytes)} on a ${fmtBytes(row.capacityBytes)} drive · ` +
        `${fmtBytes(row.usableBytes)} usable after a ${fmtBytes(row.reserveBytes)} reserve · ` +
        `${pctText} of usable · ` +
        (over
          ? `${fmtBytes(-row.freeBytes)} INTO the reserve`
          : `${fmtBytes(row.freeBytes)} free`) +
        ` · of what is there, ${fmtBytes(recover)} is recoverable at keep-${state.keepN}`,
    },
    h(
      'div.meter-track',
      seg('meter-kept', kept),
      seg('meter-recover', recover),
      seg('meter-free', free),
      seg('meter-over', spill),
      seg('meter-reserve', reserve - spill),
    ),
    h('span.meter-pct', { class: `meter-pct is-${row.driveState}`, text: pctText }),
    flag ? h('span.meter-flag', { text: flag }) : null,
  );
}

/** What the status bar needs to total a selection without a round trip. */
function metaOf(row) {
  return {
    bytes: row.bytes,
    fileCount: row.fileCount,
    base: row.base,
    songFolder: row.songFolder,
    verLabel: row.verLabel,
    status: row.status,
  };
}

/** Right-aligned size with a dimmed unit so the digits line up visually. */
function sizeCell(n) {
  const s = fmtBytes(n);
  const i = s.lastIndexOf(' ');
  const frag = document.createDocumentFragment();
  frag.append(s.slice(0, i), h('span.bytes-unit', { text: s.slice(i + 1) }));
  return frag;
}

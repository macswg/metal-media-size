/**
 * Snapshot picker and snapshot diff.
 *
 * The archive is live — it grew by 13 files during one 30-minute build — so
 * which scan you are looking at is never left implicit. The top bar always
 * names the snapshot on screen, and any older snapshot can be compared
 * against it.
 */

import { h, clear, modal, toast } from './dom.js';
import { state, update } from './state.js';
import { api, apiSource } from './api.js';
import { bytes as fmtBytes, count, dateTime, duration } from './format.js';
import { autoTable, stat } from './panels.js';

export class SnapshotBar {
  constructor(host, { onChange }) {
    this.host = host;
    this.onChange = onChange;
    this.snapshots = [];
  }

  async load() {
    try {
      this.snapshots = await api.snapshots();
    } catch {
      this.snapshots = [];
    }
    // NORMALISE TO ASCENDING, oldest first. Everything below reads positionally
    // -- complete[length - 1] for the newest, slice(-1) for "latest", reverse()
    // to display -- but /api/snapshots serves ORDER BY id DESC. The two
    // disagreed, so the app opened on the OLDEST snapshot, defaulted the diff
    // to the wrong pair, and inverted the "not the newest scan" pill. Sorting
    // once here is what makes the positional reads mean what they say.
    this.snapshots.sort((a, b) => a.id - b.id);
    const complete = this.snapshots.filter((s) => s.status === 'complete');
    if (state.snapshotId == null && complete.length) {
      state.snapshotId = complete[complete.length - 1].id;
    }
    if (state.compareId == null && complete.length > 1) {
      state.compareId = complete[complete.length - 2].id;
    }
    this.render();
    return this.snapshots;
  }

  current() {
    return this.snapshots.find((s) => s.id === state.snapshotId) || null;
  }

  label(s) {
    const when = dateTime(s.finishedAt ?? s.startedAt);
    return `#${s.id}  ${when}  ·  ${count(s.fileCount)} files  ·  ${fmtBytes(s.totalBytes)}${s.status !== 'complete' ? `  ·  ${s.status}` : ''}`;
  }

  render() {
    clear(this.host);

    // Scanning and deleting both need a real server. Against a frozen fixture
    // there is nothing to walk and nothing to remove.
    const live = apiSource() === 'live';

    if (!this.snapshots.length) {
      // A fresh clone lands here: the index is empty and there is nothing to
      // pick. It still needs the one control that gets you out of this state,
      // or the only way to a first scan is the command line.
      this.host.appendChild(
        h('div.snap',
          h('span.muted', this.scanning ? 'Building the first index…' : 'No index yet — run a scan to build one.'),
          live ? h('span.snap-actions',
            h('button.btn.sm.primary', {
              type: 'button',
              text: this.scanning ? 'Scanning…' : 'Scan now',
              disabled: !!this.scanning,
              title: 'Walk the archive and build the index. Reads only — nothing in the archive is modified.',
              onClick: () => this.startScan(),
            }),
          ) : null,
        ),
      );
      if (this.scanning) {
        this.host.appendChild(
          h('div.snap-progress', h('span.spinner'), h('span', { text: this.scanNote || 'Walking the archive…' })),
        );
      }
      return;
    }
    const sel = h(
      'select',
      {
        title: 'Which scan you are looking at',
        onChange: (e) => {
          update({ snapshotId: Number(e.target.value) }, 'snapshot');
          this.render();
          this.onChange?.();
        },
      },
      this.snapshots
        .slice()
        .reverse()
        .map((s) => h('option', { value: s.id, selected: s.id === state.snapshotId }, this.label(s))),
    );
    sel.value = String(state.snapshotId ?? '');

    const cur = this.current();
    const latest = this.snapshots.filter((s) => s.status === 'complete').slice(-1)[0];
    const isLatest = cur && latest && cur.id === latest.id;

    this.host.append(
      h(
        'div.snap',
        h('label', 'Snapshot'),
        sel,
        cur
          ? h('span.snap-meta', {
              text: `${cur.dirCount != null ? `${cur.dirCount} folders · ` : ''}${cur.elapsedMs != null ? `scanned in ${duration(cur.elapsedMs)}` : ''}`,
            })
          : null,
        !isLatest ? h('span.pill.superseded', { title: 'A newer complete scan exists', text: 'not the newest scan' }) : null,
        live ? h('span.snap-actions',
          h('button.btn.sm', {
            type: 'button',
            text: this.scanning ? 'Scanning…' : 'Rescan',
            disabled: !!this.scanning,
            title: 'Walk the archive again and add a new snapshot. Reads only — nothing in the archive is modified.',
            onClick: () => this.startScan(),
          }),
          h('button.btn.sm.ghost', {
            type: 'button',
            text: 'Manage…',
            title: 'Remove snapshots from the index',
            onClick: () => this.openManager(),
          }),
        ) : null,
      ),
    );

    if (this.scanning) {
      this.host.appendChild(
        h('div.snap-progress', h('span.spinner'), h('span', { text: this.scanNote || 'Walking the archive…' })),
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rescan                                                            */
  /* ---------------------------------------------------------------- */

  async startScan() {
    if (this.scanning) return;
    this.scanning = true;
    this.scanNote = 'Starting…';
    this.render();
    try {
      const res = await api.startScan();
      const newId = res?.snapshotId ?? null;
      await this.pollScan(newId);
    } catch (err) {
      this.scanning = false;
      this.render();
      toast(`Scan could not start: ${err.message}`, 'error');
    }
  }

  async pollScan(newId) {
    // The POST returns as soon as the walk is queued; the walk itself runs in
    // the background and is polled. ~10s cold on the delivery folder.
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      let st;
      try {
        st = await api.scanStatus();
      } catch (err) {
        this.scanning = false;
        this.render();
        toast(`Lost track of the scan: ${err.message}`, 'error');
        return;
      }
      const stage = st?.stage ? `${st.stage}… ` : 'Walking the archive… ';
      const seen = st?.filesSeen != null ? `${count(st.filesSeen)} files` : '';
      const note = `${stage}${seen}`.trim();
      if (note !== this.scanNote) {
        this.scanNote = note;
        this.render();
      }
      if (!st?.running) {
        // The runner keeps the failure on the status object; without this a
        // failed scan looks identical to one that simply found nothing.
        if (st?.error) {
          this.scanning = false;
          this.render();
          toast(`Scan failed: ${st.error}`, 'error');
          return;
        }
        break;
      }
    }

    this.scanning = false;
    const before = new Set(this.snapshots.map((s) => s.id));
    await this.load();
    const landed =
      this.snapshots.find((s) => s.id === newId) ||
      this.snapshots.filter((s) => !before.has(s.id)).slice(-1)[0];

    if (!landed) {
      toast('Scan finished but produced no snapshot. Check the server log.', 'error');
      return;
    }
    if (landed.status !== 'complete') {
      toast(`Scan ended with status "${landed.status}". Staying on the previous snapshot.`, 'error');
      return;
    }
    update({ snapshotId: landed.id }, 'snapshot');
    this.render();
    this.onChange?.();
    toast(`Snapshot #${landed.id} · ${count(landed.fileCount)} files · ${fmtBytes(landed.totalBytes)}`, 'ok');
  }

  /* ---------------------------------------------------------------- */
  /* Manage: remove snapshots from the index                           */
  /* ---------------------------------------------------------------- */

  openManager() {
    const body = h('div');
    const dlg = modal('Manage snapshots', body, null, { width: '640px' });

    const paint = () => {
      clear(body);
      body.append(
        h('div.caveat',
          h('div',
            h('b', 'This removes an index entry, never a file. '),
            'Deleting a snapshot forgets one walk of the archive. Nothing in the archive is touched, and a rescan rebuilds an equivalent snapshot.',
          ),
        ),
      );

      if (!this.snapshots.length) {
        body.appendChild(h('div.muted', { style: { padding: '12px 0' }, text: 'The index is empty. Run a scan to populate it.' }));
        return;
      }

      const rows = this.snapshots.slice().reverse().map((s) => {
        const isCurrent = s.id === state.snapshotId;
        return h('div.snap-row',
          h('div',
            h('div', h('b', { text: `#${s.id}` }), ' ', h('span.mono', { text: dateTime(s.finishedAt ?? s.startedAt) }),
              isCurrent ? h('span.pill.family', { style: { marginLeft: '8px' }, text: 'viewing' }) : null,
              s.status !== 'complete' ? h('span.pill.superseded', { style: { marginLeft: '8px' }, text: s.status }) : null),
            h('div.muted', { style: { fontSize: '11.5px' }, text: `${count(s.fileCount)} files · ${fmtBytes(s.totalBytes)}` }),
          ),
          h('button.btn.sm', {
            type: 'button',
            text: 'Delete',
            title: `Forget snapshot #${s.id}`,
            onClick: () => this.confirmDelete(s, paint),
          }),
        );
      });
      body.append(h('div.snap-list', ...rows));
    };

    paint();
    return dlg;
  }

  confirmDelete(s, onDone) {
    const isCurrent = s.id === state.snapshotId;
    const isLast = this.snapshots.length === 1;
    const body = h('div',
      h('p', { text: `Forget snapshot #${s.id}? It indexed ${count(s.fileCount)} files totalling ${fmtBytes(s.totalBytes)}.` }),
      h('p.muted', { text: 'The archive is not touched. Only this tool\'s record of that walk is removed, and it cannot be undone except by scanning again.' }),
      isLast ? h('div.caveat', h('div', h('b', 'This is the only snapshot. '), 'The app will have nothing to show until you run a scan.')) : null,
      isCurrent && !isLast ? h('div.muted', { text: 'You are viewing this snapshot; the view will move to the newest one that remains.' }) : null,
    );

    const go = h('button.btn.primary', {
      type: 'button',
      text: 'Delete snapshot',
      onClick: async () => {
        go.disabled = true;
        go.textContent = 'Deleting…';
        try {
          const res = await api.deleteSnapshot(s.id);
          dlg.close();
          const d = res?.deleted;
          toast(
            d ? `Snapshot #${d.snapshotId} forgotten · ${count(d.files)} indexed files released`
              : `Snapshot #${s.id} forgotten`,
            'ok',
          );
          if (isCurrent) state.snapshotId = null;
          if (state.compareId === s.id) state.compareId = null;
          await this.load();
          this.onChange?.();
          onDone?.();
        } catch (err) {
          go.disabled = false;
          go.textContent = 'Delete snapshot';
          toast(`Could not delete: ${err.message}`, 'error');
        }
      },
    });

    const dlg = modal('Delete snapshot', body,
      [h('button.btn.ghost', { type: 'button', text: 'Cancel', onClick: () => dlg.close() }), go],
      { width: '480px' });
    return dlg;
  }
}

export class DiffPanel {
  constructor(host, { snapshotBar }) {
    this.host = host;
    this.bar = snapshotBar;
  }

  async load() {
    clear(this.host);
    const snaps = (this.bar.snapshots || []).filter((s) => s.status === 'complete');
    if (snaps.length < 2) {
      this.host.appendChild(
        h('div.card', h('div.card-body', h('div.muted', 'Only one complete snapshot exists so far. Run another scan to compare.'))),
      );
      return;
    }
    const a = state.compareId ?? snaps[snaps.length - 2].id;
    const b = state.snapshotId ?? snaps[snaps.length - 1].id;

    const picker = h(
      'div.toolbar',
      { style: { border: '1px solid var(--line)', borderRadius: 'var(--radius)', marginBottom: '14px' } },
      h('span.muted', 'Compare'),
      snapSelect(snaps, a, (v) => {
        update({ compareId: v }, 'diff');
        this.load();
      }),
      h('span.muted', '→'),
      snapSelect(snaps, b, (v) => {
        update({ snapshotId: v }, 'diff');
        this.bar.render();
        this.load();
      }),
      h('span.spacer'),
      h('span.muted', { style: { fontSize: '11.5px' }, text: 'The archive is live; a diff shows what changed underneath you.' }),
    );
    this.host.appendChild(picker);

    const busy = h('div.muted', 'Comparing…');
    this.host.appendChild(busy);
    try {
      const d = await api.diff(a, b);
      busy.remove();
      this.render(d, a, b);
    } catch (err) {
      busy.remove();
      this.host.appendChild(h('div.caveat', h('div', h('b', 'Could not compare these snapshots. '), err.message)));
    }
  }

  render(d, a, b) {
    const s = d.summary || {};
    const added = d.added || [];
    const removed = d.removed || [];
    const grown = d.grown || [];
    const shrunk = d.shrunk || [];

    this.host.append(
      h(
        'div.stat-row',
        stat('Added', count(s.addedCount ?? added.length), s.addedBytes != null ? fmtBytes(s.addedBytes) : ''),
        stat('No longer present', count(s.removedCount ?? removed.length), s.removedBytes != null ? fmtBytes(s.removedBytes) : ''),
        stat('Grew', count(s.grownCount ?? grown.length), ''),
        stat('Shrank', count(s.shrunkCount ?? shrunk.length), ''),
        stat('Net change', s.netBytes != null ? `${s.netBytes >= 0 ? '+' : ''}${fmtBytes(s.netBytes)}` : '—', `snapshot #${a} → #${b}`),
      ),
      h(
        'div.caveat',
        h('div', h('b', '"No longer present" means the file was not seen in the later scan. '),
          'That is an observation about two scans, not something this tool did. Nothing here was removed by the analyser.'),
      ),
      section('Added', added),
      section('No longer present', removed),
      section('Grew', grown),
      section('Shrank', shrunk),
    );
  }
}

function section(title, rows) {
  return h(
    'div.card',
    h('header', h('h3', { text: title }), h('span.n', { text: count(rows.length) })),
    h('div.card-body', autoTable(rows, { limit: 200 })),
  );
}

function snapSelect(snaps, value, onChange) {
  const sel = h(
    'select',
    { onChange: (e) => onChange(Number(e.target.value)) },
    snaps
      .slice()
      .reverse()
      .map((s) => h('option', { value: s.id, selected: s.id === value }, `#${s.id}  ${dateTime(s.finishedAt ?? s.startedAt)}  ·  ${count(s.fileCount)} files`)),
  );
  sel.value = String(value);
  return sel;
}

/**
 * Version ladder for a single asset: every version oldest → newest with its
 * rolled-up size, region count, proxy subtotal, date and verdict.
 *
 * The point of this panel is the WHY column. `keepReason` arrives from the API
 * verbatim from the KeepReason union in src/scan/reclaim.ts, and is turned
 * into plain English here (and only here) so the user can see exactly what
 * made a version superseded before acting on it.
 */

import { h, clear } from './dom.js';
import { state, inManifest, setInManifest, effectiveStatus } from './state.js';
import { api } from './api.js';
import {
  bytes as fmtBytes,
  count,
  dateTime,
  keepReasonText,
  keepReasonDetail,
} from './format.js';

export class LadderPanel {
  constructor(host, { onClose, onSelectionChange }) {
    this.host = host;
    this.onClose = onClose;
    this.onSelectionChange = onSelectionChange;
    this.assetId = null;
    this.data = null;
    this.seq = 0;
  }

  close() {
    this.assetId = null;
    this.data = null;
    this.seq += 1;
    this.host.hidden = true;
    clear(this.host);
    this.onClose?.();
  }

  /** Re-fetch for the current asset (keepN or snapshot changed). */
  refresh() {
    if (this.assetId != null) this.open(this.assetId, this.highlightVersionId);
  }

  async open(assetId, highlightVersionId) {
    this.assetId = assetId;
    this.highlightVersionId = highlightVersionId ?? null;
    this.host.hidden = false;
    const seq = ++this.seq;
    this.renderLoading();
    try {
      const data = await api.assetVersions(assetId, { keepN: state.keepN, snapshotId: state.snapshotId ?? undefined });
      if (seq !== this.seq) return;
      this.data = data;
      this.render();
    } catch (err) {
      if (seq !== this.seq) return;
      clear(this.host);
      this.host.append(
        this.head('Version ladder', ''),
        h('div.ladder', h('div.caveat', h('div', h('b', 'Could not load this asset. '), err.message))),
      );
    }
  }

  head(title, sub) {
    return h(
      'div.drawer-head',
      h('div', { style: { minWidth: 0, flex: 1 } }, h('h2', { text: title }), h('div.sub', { text: sub })),
      h('button.icon-btn', { text: '✕', title: 'Close the ladder', onClick: () => this.close() }),
    );
  }

  renderLoading() {
    clear(this.host);
    this.host.append(this.head('Loading…', ''), h('div.ladder', h('div.muted', 'Fetching the version ladder…')));
  }

  /** Refresh checkbox state without refetching. */
  repaintSelection() {
    if (!this.itemNodes) return;
    for (const [versionId, node] of this.itemNodes) {
      const row = this.rowsById?.get(versionId);
      if (!row) continue;
      // No ring for manifest membership -- same reason as the table: under the
      // opt-out model most items are in it, so the highlight said nothing.
      // The item already carries its effective status as a class.
      node.className = `lad-item ${effectiveStatus(row)}`;
      const cb = node.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = inManifest(row);
    }
  }

  render() {
    const { asset, versions } = this.data;
    clear(this.host);
    this.itemNodes = new Map();

    const totalBytes = versions.reduce((t, v) => t + v.bytes, 0);
    const supers = versions.filter((v) => v.status === 'superseded');
    const supersededBytes = supers.reduce((t, v) => t + v.bytes, 0);

    this.host.append(
      this.head(asset.base, `${asset.songFolder}  ·  family ${asset.family}  ·  asset #${asset.assetId ?? asset.id ?? ''}`),
    );

    const body = h('div.ladder');
    this.host.appendChild(body);

    body.appendChild(
      h(
        'div',
        { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '2px' } },
        miniStat('Versions', count(versions.length)),
        miniStat('Total', fmtBytes(totalBytes)),
        miniStat(`Slated for removal at keep-${state.keepN}`, fmtBytes(supersededBytes), supers.length ? 'var(--superseded)' : null),
      ),
    );

    if (supers.length) {
      body.appendChild(
        h(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          h('button.btn.sm.ghost', {
            text: `Keep all ${supers.length} anyway`,
            title: 'Veto every slated version of this asset, so none of them enter the manifest',
            onClick: () => {
              for (const v of supers) setInManifest(v, false);
              this.onSelectionChange?.();
            },
          }),
          h('button.btn.sm.ghost', {
            text: 'Undo my overrides here',
            onClick: () => {
              for (const v of supers) setInManifest(v, true);
              this.onSelectionChange?.();
            },
          }),
        ),
      );
    }

    // Oldest first — the order the renders actually happened in.
    for (const v of versions) {
      const item = h(`div.lad-item.${effectiveStatus(v)}`);
      if (v.versionId === this.highlightVersionId) item.style.outline = '1px solid var(--accent-dim)';
      this.itemNodes.set(v.versionId, item);
      (this.rowsById ??= new Map()).set(v.versionId, v);

      const cb = h('input', {
        type: 'checkbox',
        checked: inManifest(v),
        disabled: v.status !== 'superseded',
        title:
          v.status === 'superseded'
            ? 'In the export manifest. Un-tick to keep this version anyway.'
            : 'The policy is keeping this version, so it is not in the manifest.',
        onChange: (e) => {
          setInManifest(v, e.target.checked);
          this.onSelectionChange?.();
        },
      });

      item.append(
        h(
          'div.lad-top',
          cb,
          h('span.lad-ver', { text: v.verLabel }),
          v.isPatch ? h('span.pill.patch', { text: `patch · frame ${v.patchFrame ?? '?'}` }) : null,
          h('span.spacer'),
          h(`span.pill.${v.status}`, { text: v.status }),
          h('span.lad-bytes', { text: fmtBytes(v.bytes) }),
        ),
        h(
          'div.lad-grid',
          cell('Files', count(v.fileCount)),
          cell('Regions', v.regionCount ? count(v.regionCount) : '—'),
          cell('Proxy', v.proxyBytes ? fmtBytes(v.proxyBytes) : '—'),
          cell('Modified', dateTime(v.latestMtime)),
        ),
        h(
          'div.lad-reason',
          h('span.why', 'Why:'),
          h(
            'span',
            { title: v.keepReason },
            h('b', { text: keepReasonText(v.keepReason) }),
            h('div.muted', { style: { marginTop: '2px' }, text: keepReasonDetail(v.keepReason) }),
          ),
        ),
      );
      body.appendChild(item);
    }

    body.appendChild(
      h(
        'div.card-note',
        { style: { padding: '10px 0 0' } },
        'Ticking a version adds it to an export manifest. Nothing is ever removed by this tool.',
      ),
    );
  }
}

function cell(label, value) {
  return h('div', label, h('b', { text: value }));
}

function miniStat(label, value, colour) {
  return h(
    'div',
    h('div', { style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--faint)' }, text: label }),
    h('div.mono', { style: { fontSize: '14px', color: colour || 'var(--text)' }, text: value }),
  );
}

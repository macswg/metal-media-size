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
import { state, isSelected, toggleSelected } from './state.js';
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
      const on = isSelected(versionId);
      node.classList.toggle('selected', on);
      const cb = node.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = on;
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
          h('button.btn.sm', {
            text: `Tick all ${supers.length} slated for removal`,
            onClick: () => {
              for (const v of supers) toggleSelected(v.versionId, true, ladderMeta(asset, v));
              this.onSelectionChange?.();
            },
          }),
          h('button.btn.sm.ghost', {
            text: 'Untick this asset',
            onClick: () => {
              for (const v of versions) toggleSelected(v.versionId, false, ladderMeta(asset, v));
              this.onSelectionChange?.();
            },
          }),
        ),
      );
    }

    // Oldest first — the order the renders actually happened in.
    for (const v of versions) {
      const item = h(`div.lad-item.${v.status}`);
      if (v.versionId === this.highlightVersionId) item.style.outline = '1px solid var(--accent-dim)';
      this.itemNodes.set(v.versionId, item);

      const cb = h('input', {
        type: 'checkbox',
        checked: isSelected(v.versionId),
        title: 'Include this version in an export manifest',
        onChange: (e) => {
          toggleSelected(v.versionId, e.target.checked, ladderMeta(asset, v));
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

function ladderMeta(asset, v) {
  return {
    bytes: v.bytes,
    fileCount: v.fileCount,
    base: asset.base,
    songFolder: asset.songFolder,
    verLabel: v.verLabel,
    status: v.status,
  };
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

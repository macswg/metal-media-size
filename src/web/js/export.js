/**
 * ============================================================================
 *  EXPORT A MANIFEST
 * ============================================================================
 *
 * This tool never removes anything. The only action it offers is producing a
 * manifest into the project's exports/ directory, which the user then reviews
 * and runs himself in FreeFileSync. Every string in this dialog is worded on
 * that basis, and the confirmation step spells out exactly what the manifest
 * will contain before it is produced.
 *
 * A deletion policy is required. Two are offered:
 *   Versioning  — moves into a timestamped folder. Reversible. The default.
 *   RecycleBin  — matches the user's existing FreeFileSync jobs.
 * 'Permanent' is not offered, is not reachable from this UI, and is rejected
 * by the API and the exporter.
 * ============================================================================
 */

import { h, clear, modal, toast } from './dom.js';
import { state, filterParams, clearSelection, emit } from './state.js';
import { api, apiSource } from './api.js';
import { bytes as fmtBytes, count } from './format.js';

const FORMATS = [
  ['ffs_gui', 'FreeFileSync job (.ffs_gui)', 'Opens in FreeFileSync so you review the file list and press Compare yourself.'],
  ['json', 'JSON manifest', 'The literal resolved paths, for scripting or record-keeping.'],
  ['markdown', 'Markdown manifest', 'A readable list to check over or paste into a ticket.'],
];

/**
 * Resolve the selection to a concrete list of version ids.
 * "Select all matched" is stored as a predicate, so it is expanded here by
 * paging /api/versions — the contract caps a page at 2000.
 */
export async function resolveSelectedVersionIds(onProgress) {
  const sel = state.selection;
  if (!sel.allMatched) {
    let bytes = 0;
    let files = 0;
    let known = 0;
    for (const id of sel.ids) {
      const m = sel.meta.get(id);
      if (!m) continue;
      bytes += m.bytes || 0;
      files += m.fileCount || 0;
      known += 1;
    }
    return { ids: [...sel.ids], bytes, files, exact: known === sel.ids.size };
  }

  const ids = [];
  let bytes = 0;
  let files = 0;
  const limit = 2000;
  let offset = 0;
  for (;;) {
    const res = await api.versions({ ...filterParams(), keepN: state.keepN, sort: 'bytes', dir: 'desc', limit, offset });
    for (const row of res.rows) {
      if (sel.except.has(row.versionId)) continue;
      ids.push(row.versionId);
      bytes += row.bytes || 0;
      files += row.fileCount || 0;
    }
    offset += res.rows.length;
    onProgress?.(offset, res.total);
    if (res.rows.length === 0 || offset >= res.total) break;
  }
  // Paging the whole matched set gives an exact file and byte count, so the
  // confirmation can state precisely what the manifest covers.
  return { ids, bytes, files, exact: true };
}

export function openExportDialog({ versionIds, summary }) {
  let policy = 'Versioning';
  let versioningFolder = localStorage.getItem('aa.versioningFolder') || '';
  let note = '';
  const formats = new Set(['ffs_gui', 'json', 'markdown']);

  const folderField = h('div.field', { hidden: false });
  const folderInput = h('input', {
    type: 'text',
    class: 'mono',
    value: versioningFolder,
    placeholder: '/Volumes/…/archive-removals',
    spellcheck: 'false',
    onInput: (e) => {
      versioningFolder = e.target.value.trim();
      validate();
    },
  });
  folderField.append(
    h('label', 'Versioning folder'),
    folderInput,
    h('div.hint', 'Every file the job touches is moved into a timestamped folder here, so the whole operation can be undone by moving it back.'),
  );

  const policyOpts = h('fieldset.policy', h('legend', 'Deletion policy — required'));
  const optNodes = new Map();
  for (const [value, title, desc, recommended] of [
    ['Versioning', 'Versioning → timestamped folder', 'Files are moved into a dated folder rather than removed. Fully reversible.', true],
    ['RecycleBin', 'Recycle Bin', "Files go to the system Recycle Bin. Matches your existing FreeFileSync jobs.", false],
  ]) {
    const radio = h('input', { type: 'radio', name: 'delpolicy', value, checked: value === policy });
    const opt = h(
      `label.policy-opt${value === policy ? '.on' : ''}`,
      {
        onClick: () => {
          policy = value;
          radio.checked = true;
          for (const [v, n] of optNodes) n.classList.toggle('on', v === value);
          folderField.hidden = value !== 'Versioning';
          validate();
        },
      },
      radio,
      h('div', h('div.t', title, recommended ? h('span.tag-rec', 'recommended') : null), h('div.d', desc)),
    );
    optNodes.set(value, opt);
    policyOpts.appendChild(opt);
  }
  policyOpts.appendChild(
    h('div.hint', { style: { fontSize: '11.5px', color: 'var(--faint)', marginTop: '6px' } },
      'A permanent-deletion policy is deliberately not offered by this tool and is rejected by the exporter.'),
  );

  const formatBox = h(
    'div.field',
    h('label', 'Manifest formats'),
    ...FORMATS.map(([value, title, desc]) =>
      h(
        'label.policy-opt.on',
        { style: { border: '1px solid var(--line)', marginBottom: '4px' } },
        h('input', {
          type: 'checkbox',
          checked: true,
          onChange: (e) => {
            if (e.target.checked) formats.add(value);
            else formats.delete(value);
            validate();
          },
        }),
        h('div', h('div.t', title), h('div.d', desc)),
      ),
    ),
  );

  const noteBox = h(
    'div.field',
    h('label', 'Note (optional)'),
    h('textarea', { rows: '2', placeholder: 'Why this set — recorded in the manifest header.', onInput: (e) => (note = e.target.value) }),
  );

  const problem = h('div.hint.bad', { hidden: true });
  const reviewBtn = h('button.btn.primary', { text: 'Review manifest…' });

  const body = h(
    'div',
    summaryCard(versionIds, summary),
    policyOpts,
    folderField,
    formatBox,
    noteBox,
    problem,
  );

  const dlg = modal('Export a removal manifest', body, [
    h('span.muted', { style: { fontSize: '11.5px' }, text: 'Nothing is removed by this tool. It produces a manifest into exports/.' }),
    h('span.spacer'),
    h('button.btn', { text: 'Cancel', onClick: () => dlg.close() }),
    reviewBtn,
  ], { width: '720px' });

  function validate() {
    let msg = '';
    if (!versionIds.length) msg = 'No versions are selected.';
    else if (!policy) msg = 'Choose a deletion policy.';
    else if (policy === 'Versioning' && !versioningFolder) msg = 'Versioning needs a folder path — that folder is what makes the operation reversible.';
    else if (formats.size === 0) msg = 'Choose at least one manifest format.';
    problem.hidden = !msg;
    problem.textContent = msg;
    reviewBtn.disabled = !!msg;
  }
  validate();

  reviewBtn.onclick = () => {
    dlg.close();
    openConfirm({ versionIds, summary, policy, versioningFolder, formats: [...formats], note });
  };
}

function summaryCard(versionIds, summary) {
  return h(
    'div.confirm-box',
    { style: { marginBottom: '14px' } },
    h('div', h('b', { text: `${count(versionIds.length)} asset-versions selected` })),
    h(
      'div.muted',
      { style: { marginTop: '4px' } },
      summary.files ? `${count(summary.files)} files · ` : '',
      summary.bytes ? `${fmtBytes(summary.bytes)} of archive space` : 'size unavailable',
      summary.exact === false ? ' (approximate — some rows were selected in bulk)' : '',
    ),
  );
}

function openConfirm({ versionIds, summary, policy, versioningFolder, formats, note }) {
  const lines = [
    ['Asset-versions in the manifest', count(versionIds.length)],
    ['Files those versions cover', summary.files ? count(summary.files) : 'resolved by the exporter'],
    ['Archive space they occupy', summary.bytes ? `${summary.exact === false ? 'about ' : ''}${fmtBytes(summary.bytes)}` : 'resolved by the exporter'],
    ['Keep-latest-N in force when selected', `keep latest ${state.keepN}`],
    ['Snapshot', state.snapshotId != null ? `#${state.snapshotId}` : 'latest complete'],
    ['Deletion policy', policy === 'Versioning' ? 'Versioning → timestamped folder (reversible)' : 'Recycle Bin'],
    ...(policy === 'Versioning' ? [['Versioning folder', versioningFolder]] : []),
    ['Formats produced', formats.join(', ')],
    ['Written to', 'exports/ inside this project — nowhere else'],
  ];

  const body = h(
    'div',
    h(
      'div.caveat',
      h(
        'div',
        h('b', 'This produces a manifest. It does not remove anything.'),
        ' You will open the FreeFileSync job yourself, review the concrete file list it shows, and press Compare and Synchronize when you are satisfied.',
      ),
    ),
    h(
      'div.confirm-box',
      h('div', { style: { marginBottom: '6px' } }, h('b', 'The manifest will contain exactly:')),
      h(
        'dl.kv',
        ...lines.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })]),
      ),
      note ? h('div', { style: { marginTop: '8px' } }, h('span.muted', 'Note: '), h('span', { text: note })) : null,
    ),
    h(
      'div.card-note',
      { style: { padding: '10px 0 0' } },
      'The archive itself is mounted read-only and is never modified by this tool, under any policy.',
    ),
  );

  const goBtn = h('button.btn.primary', { text: 'Produce manifest' });
  const dlg = modal('Confirm — what the manifest will contain', body, [
    h('span.spacer'),
    h('button.btn', { text: 'Back', onClick: () => { dlg.close(); openExportDialog({ versionIds, summary }); } }),
    goBtn,
  ], { width: '680px' });

  goBtn.onclick = async () => {
    goBtn.disabled = true;
    goBtn.textContent = 'Producing…';
    try {
      const res = await api.exportManifest({
        versionIds,
        formats,
        deletionPolicy: policy,
        ...(policy === 'Versioning' ? { versioningFolder } : {}),
        ...(note ? { note } : {}),
      });
      if (policy === 'Versioning') localStorage.setItem('aa.versioningFolder', versioningFolder);
      dlg.close();
      showResult(res);
      clearSelection();
      emit('selection');
    } catch (err) {
      goBtn.disabled = false;
      goBtn.textContent = 'Produce manifest';
      toast(`Export refused — ${err.code ? `${err.code}: ` : ''}${err.message}`, 'error');
    }
  };
}

function showResult(res) {
  const mock = res?.mock || apiSource() === 'mock';
  const body = h(
    'div',
    mock
      ? h('div.caveat', h('div', h('b', 'Mock mode. '), 'No API is running, so no manifest was produced. The paths below are what a live run would produce.'))
      : null,
    h(
      'div.confirm-box',
      h('div', { style: { marginBottom: '6px' } }, h('b', mock ? 'Would be produced:' : 'Produced:')),
      h(
        'table.grid',
        h('thead', h('tr', h('th', 'Format'), h('th', 'Path'), h('th', { style: { textAlign: 'right' } }, 'Size'))),
        h(
          'tbody',
          ...(res?.files || []).map((f) =>
            h('tr', h('td.mono', { text: f.format }), h('td.mono', { text: f.path }), h('td.num', { text: f.bytes ? fmtBytes(f.bytes) : '—' })),
          ),
        ),
      ),
      res?.summary
        ? h('div.muted', { style: { marginTop: '8px' } },
            `${count(res.summary.versionCount ?? 0)} versions · ${count(res.summary.fileCount ?? 0)} files · ${fmtBytes(res.summary.totalBytes ?? 0)}`)
        : null,
    ),
    h('div.card-note', { style: { padding: '10px 0 0' } }, 'Next step is yours: open the .ffs_gui in FreeFileSync, review the file list, then Compare.'),
  );
  const dlg = modal(mock ? 'Manifest preview' : 'Manifest ready', body, [h('span.spacer'), h('button.btn.primary', { text: 'Done', onClick: () => dlg.close() })], { width: '640px' });
  if (!mock) toast('Manifest produced in exports/', 'ok');
}

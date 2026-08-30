/**
 * RIG — what is actually on the machines, against what the archive says.
 *
 * Every other tab describes the archive. This one describes the playback rig
 * and puts the two side by side, which is the only way to answer the question
 * an operator has the night before a show: is the right media on the right
 * machine?
 *
 * THE ADDRESSES ARE NOT STORED. They live in the running server's memory and in
 * whatever YAML file you choose to save from here — generated in the browser as
 * a download, so it lands wherever you put it and never in this project. The
 * password lives in memory for the session and is never written to the file,
 * never shown back, and never returned by the API.
 *
 * EVERY MOUNT IS READ-ONLY, enforced by the kernel: `mount_smbfs -o rdonly`
 * means even root cannot write through it. That is a stronger promise than
 * "this application does not write", and the panel says which one is in force
 * per machine rather than asserting it — a share you separately connected in
 * Finder is read-write, and the row says so.
 *
 * This tab reads. It mounts shares, walks a directory and compares — it never
 * removes anything, and it produces no manifest.
 */

import { h, clear, toast } from './dom.js';
import { state } from './state.js';
import { api } from './api.js';
import { bytes as fmtBytes, count } from './format.js';
import { stat } from './panels.js';

/** Poll interval while a survey is running. */
const POLL_MS = 900;

const PLACEHOLDER = `101 10.10.1.53
102 10.10.1.54
# an address on its own is listed but not compared
10.10.1.99`;

export class RigPanel {
  constructor(host, { onCounts } = {}) {
    this.host = host;
    this.onCounts = onCounts;
    this.status = null;
    this.parseErrors = [];
    this.unknownMachineIds = [];
    this.timer = null;
    this.busy = false;
    /** Kept out of `status` on purpose — it is never echoed by the server. */
    this.draft = { text: '', share: 'd3 Projects', directory: '', username: '', password: '' };
  }

  async load() {
    try {
      this.status = await api.rigStatus();
      if (this.status.share) this.draft.share = this.status.share;
      if (this.status.directory != null) this.draft.directory = this.status.directory;
      if (this.status.username) this.draft.username = this.status.username;
      // Show the list the SERVER actually holds, not an empty box beside a
      // populated table — otherwise a reloaded tab looks like it lost the list.
      if (!this.draft.text && this.status.targets?.length) {
        this.draft.text = this.status.targets
          .map((t) => (t.machineId ? `${t.machineId} ${t.host}` : t.host))
          .join('\n');
      }
    } catch (err) {
      this.status = null;
      this.error = err.message;
    }
    this.render();
    this.pollIfRunning();
  }

  pollIfRunning() {
    clearTimeout(this.timer);
    if (!this.status?.survey?.running) return;
    this.timer = setTimeout(async () => {
      try {
        this.status = await api.rigStatus();
      } catch {
        /* keep the last good status rather than blanking the panel */
      }
      this.render();
      this.pollIfRunning();
    }, POLL_MS);
  }

  /** Run an action with the panel disabled, so nothing is double-fired. */
  async act(fn, { rerender = true } = {}) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      await fn();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      this.busy = false;
      if (rerender) this.render();
      this.pollIfRunning();
    }
  }

  /* ---------------------------------------------------------------- actions */

  async submitTargets(text) {
    const res = await api.rigTargets({
      text,
      share: this.draft.share,
      directory: this.draft.directory,
    });
    this.parseErrors = res.errors || [];
    this.unknownMachineIds = res.unknownMachineIds || [];
    this.status = await api.rigStatus();
    const n = (res.targets || []).length;
    if (n) toast(`${n} machine${n === 1 ? '' : 's'} in the list`, 'info');
  }

  async connect() {
    if (this.draft.username || this.draft.password) {
      await api.rigCredentials({ username: this.draft.username, password: this.draft.password });
      // Dropped from the page as soon as the server has it. Nothing here keeps
      // a copy, so a screenshot of this tab cannot contain it.
      this.draft.password = '';
    }
    const res = await api.rigConnect({ share: this.draft.share });
    this.status = await api.rigStatus();
    toast(
      `${res.connected} of ${res.connected + res.failed} machines mounted`,
      res.failed ? 'error' : 'info',
    );
  }

  async survey() {
    await api.rigSurvey({
      directory: this.draft.directory,
      keepN: state.keepN,
      snapshotId: state.snapshotId ?? undefined,
    });
    this.status = await api.rigStatus();
  }

  async disconnect() {
    const res = await api.rigDisconnect();
    this.status = await api.rigStatus();
    toast(
      res.errors?.length
        ? `Disconnected ${res.disconnected}; ${res.errors.length} would not unmount`
        : `Disconnected ${res.disconnected} machine${res.disconnected === 1 ? '' : 's'}`,
      res.errors?.length ? 'error' : 'info',
    );
  }

  async forget() {
    await api.rigForget();
    this.status = await api.rigStatus();
    this.parseErrors = [];
    this.unknownMachineIds = [];
    this.draft.password = '';
    toast('Addresses, mounts, results and the password are gone', 'info');
  }

  /**
   * Save the list as YAML.
   *
   * The server renders the text and the browser hands it to the OS save dialog
   * — nothing is written by this application. The file carries addresses only.
   */
  async saveYaml() {
    const text = await api.rigTargetsYaml();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
    const a = h('a', { href: url, download: 'rig-targets.yaml' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Read a YAML file back in. Parsed by the same parser that reads a paste. */
  importYaml(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const box = this.host.querySelector('#rigTargets');
      if (box) box.value = text;
      this.act(() => this.submitTargets(text));
    };
    reader.onerror = () => toast('Could not read that file', 'error');
    reader.readAsText(file);
  }

  /* ---------------------------------------------------------------- render */

  render() {
    const scrollTop = this.host.scrollTop;
    clear(this.host);
    const s = this.status;
    const targets = s?.targets || [];
    const survey = s?.survey || {};
    const results = survey.results || [];

    const alarms = results.reduce((n, r) => n + (r.totals?.missingKeptFiles ? 1 : 0), 0);
    this.onCounts?.({ high: alarms, low: 0 });

    this.host.append(
      this.caveat(),
      this.targetsCard(targets),
      this.connectCard(targets),
      this.surveyCard(survey, targets),
    );
    if (results.length) {
      this.host.append(
        this.summaryRow(results),
        // FIRST, above the per-machine cards. A card per machine answers "what
        // is wrong with 301?"; this answers "what is wrong with the show?", and
        // that is the one you read first.
        this.missingCard(survey.missing),
        ...this.resultCards(results),
      );
    }
    this.host.scrollTop = scrollTop;
  }

  caveat() {
    return h(
      'div.caveat',
      h(
        'div',
        h('b', 'Nothing here is stored, and nothing here removes anything. '),
        'Every machine is mounted ',
        h('b', 'read-only'),
        ' — `mount_smbfs -o rdonly`, which the kernel enforces against every process on this Mac including root, so nothing here or elsewhere can alter a playback machine through it. Files are compared by name and size only; no file’s contents are ever read at all. Addresses live in this server’s memory until you press Forget or stop it; the password is held for the session, never written to the YAML file and never sent back to this page.',
      ),
    );
  }

  targetsCard(targets) {
    const box = h('textarea#rigTargets.rig-paste', {
      rows: 7,
      spellcheck: false,
      placeholder: PLACEHOLDER,
      value: this.draft.text,
      onInput: (e) => {
        this.draft.text = e.target.value;
      },
    });
    const fileInput = h('input', {
      type: 'file',
      accept: '.yaml,.yml,text/yaml',
      style: { display: 'none' },
      onChange: (e) => {
        const f = e.target.files?.[0];
        if (f) this.importYaml(f);
        e.target.value = '';
      },
    });

    return h(
      'div.card',
      h(
        'header',
        h('h3', { text: 'Machines' }),
        h('span.n', { text: `${count(targets.length)} in the list` }),
        h('span.spacer'),
        h('button.btn.sm.ghost', {
          text: 'Import YAML…',
          disabled: this.busy,
          onClick: () => fileInput.click(),
        }),
        h('button.btn.sm.ghost', {
          text: 'Save YAML',
          disabled: this.busy || targets.length === 0,
          title: 'Addresses only — no user name, no password',
          onClick: () => this.act(() => this.saveYaml(), { rerender: false }),
        }),
      ),
      h(
        'div.card-body',
        fileInput,
        h('div.rig-hint', 'One machine per line: ', h('code', '101 10.10.1.53'), '. An address on its own is surveyed but cannot be compared — the archive’s expectations are keyed by machine.'),
        box,
        h(
          'div.rig-row',
          h('button.btn.primary', {
            text: 'Use this list',
            disabled: this.busy,
            onClick: () => this.act(() => this.submitTargets(this.draft.text)),
          }),
          h('span.spacer'),
          targets.length
            ? h('button.btn.sm.ghost', {
                text: 'Forget everything',
                title: 'Drops the addresses, the mounts, the results and the password',
                disabled: this.busy,
                onClick: () => this.act(() => this.forget()),
              })
            : null,
        ),
        this.parseErrors.length ? this.errorList() : null,
        this.unknownMachineIds.length
          ? h(
              'div.rig-warn',
              `Not machines this rig knows: ${this.unknownMachineIds.join(', ')}. They will be listed but not compared.`,
            )
          : null,
        targets.length ? this.targetTable(targets) : null,
      ),
    );
  }

  errorList() {
    return h(
      'div.rig-warn',
      h('b', `${count(this.parseErrors.length)} line${this.parseErrors.length === 1 ? '' : 's'} could not be read:`),
      h(
        'ul.rig-errors',
        ...this.parseErrors.map((e) =>
          h('li', h('span.mono', { text: e.line ? `line ${e.line}: ` : '' }), h('span.mono', { text: e.text || '' }), ` — ${e.message}`),
        ),
      ),
    );
  }

  targetTable(targets) {
    return h(
      'div',
      { style: { overflowX: 'auto', marginTop: '10px' } },
      h(
        'table.grid',
        h('thead', h('tr', h('th', 'Machine'), h('th', 'Address'), h('th', 'Mounted at'), h('th', 'State'))),
        h(
          'tbody',
          ...targets.map((t) =>
            h(
              'tr',
              h('td.mono', { text: t.machineId || '—' }),
              h('td.mono', { text: t.host }),
              h('td.mono', { text: t.mountPoint || '—' }),
              h(
                'td',
                t.error
                  ? h('span.pill.broken', { text: 'failed', title: t.error })
                  : t.mountPoint
                    ? h(
                        'span',
                        h('span.pill.kept', {
                          text: t.readOnly ? 'read-only' : 'MOUNTED READ-WRITE',
                          title: t.readOnly
                            ? 'mount_smbfs -o rdonly — the kernel refuses every write through this mountpoint'
                            : 'This mountpoint is writable. It was not made by this application.',
                        }),
                        t.otherWritableMount
                          ? h('span.pill.superseded', {
                              text: 'also open in Finder',
                              title: `This machine is ALSO mounted read-write at ${t.otherWritableMount}, which this application did not make and cannot protect.`,
                            })
                          : null,
                      )
                    : h('span.pill.unknown', { text: 'not connected' }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  connectCard(targets) {
    const s = this.status;
    return h(
      'div.card',
      h(
        'header',
        h('h3', { text: 'Connect' }),
        h('span.n', { text: `${count(targets.filter((t) => t.mountPoint).length)} mounted` }),
        h('span.spacer'),
      ),
      h(
        'div.card-body',
        h(
          'div.rig-fields',
          field('SMB share', h('input.rig-input', {
            type: 'text',
            value: this.draft.share,
            placeholder: 'd3 Projects',
            onInput: (e) => {
              this.draft.share = e.target.value;
            },
          })),
          field('User name', h('input.rig-input', {
            type: 'text',
            autocomplete: 'off',
            value: this.draft.username,
            placeholder: 'd3',
            onInput: (e) => {
              this.draft.username = e.target.value;
            },
          })),
          field(
            'Password',
            h('input.rig-input', {
              type: 'password',
              autocomplete: 'new-password',
              value: this.draft.password,
              placeholder: s?.hasCredentials ? 'held for this session' : '',
              onInput: (e) => {
                this.draft.password = e.target.value;
              },
            }),
          ),
        ),
        h(
          'div.rig-row',
          h('button.btn.primary', {
            text: this.busy ? 'Working…' : 'Connect all (read-only)',
            disabled: this.busy || targets.length === 0,
            onClick: () => this.act(() => this.connect()),
          }),
          targets.some((t) => t.mountPoint)
            ? h('button.btn.sm.ghost', {
                text: 'Disconnect',
                title: 'Unmounts only the mountpoints this application made',
                disabled: this.busy,
                onClick: () => this.act(() => this.disconnect()),
              })
            : null,
          h('span.muted', {
            style: { fontSize: '11.5px' },
            text: s?.hasCredentials
              ? 'A password is held for this session. Leave it blank to reuse it.'
              : 'Leave blank to mount with whatever macOS already has saved.',
          }),
        ),
      ),
    );
  }

  surveyCard(survey, targets) {
    const running = !!survey.running;
    const mounted = targets.filter((t) => t.mountPoint).length;
    const pct = survey.total ? Math.round((survey.done / survey.total) * 100) : 0;
    return h(
      'div.card',
      h(
        'header',
        h('h3', { text: 'Survey' }),
        h('span.n', { text: survey.total ? `${count(survey.done)} of ${count(survey.total)}` : '' }),
        h('span.spacer'),
      ),
      h(
        'div.card-body',
        h(
          'div.rig-fields',
          field(
            'Directory on each machine',
            h('input.rig-input.wide', {
              type: 'text',
              value: this.draft.directory,
              placeholder: 'leave blank for the share root',
              onInput: (e) => {
                this.draft.directory = e.target.value;
              },
            }),
          ),
        ),
        h('div.rig-hint', 'Relative to the share root, and the same on every machine. Compared at the current keep-latest-', h('b', { text: String(state.keepN) }), ' policy.'),
        h(
          'div.rig-row',
          running
            ? h('button.btn', {
                text: 'Stop',
                onClick: () => this.act(async () => {
                  await api.rigCancelSurvey();
                  this.status = await api.rigStatus();
                }),
              })
            : h('button.btn.primary', {
                text: 'Survey the rig',
                disabled: this.busy || mounted === 0,
                onClick: () => this.act(() => this.survey()),
              }),
          running ? h('span.spinner') : null,
          running
            ? h('div.bar', { style: { flex: '1' } }, h('i', { style: { width: `${pct}%` } }))
            : null,
          survey.cancelled ? h('span.muted', { text: 'Stopped — the machines already surveyed are kept.' }) : null,
          survey.error ? h('span', { style: { color: 'var(--warn)' }, text: survey.error }) : null,
        ),
      ),
    );
  }

  summaryRow(results) {
    const t = results.reduce(
      (acc, r) => {
        const x = r.totals;
        if (!x) return acc;
        acc.missingKeptFiles += x.missingKeptFiles;
        acc.missingKeptBytes += x.missingKeptBytes;
        acc.supersededBytes += x.presentSupersededBytes;
        acc.mismatch += x.sizeMismatchFiles;
        acc.actualBytes += x.actualBytes;
        acc.inSync += x.inSync ? 1 : 0;
        acc.compared += 1;
        return acc;
      },
      { missingKeptFiles: 0, missingKeptBytes: 0, supersededBytes: 0, mismatch: 0, actualBytes: 0, inSync: 0, compared: 0 },
    );
    return h(
      'div.stat-row',
      stat('Machines in sync', `${count(t.inSync)} / ${count(t.compared)}`, 'every current file present, at the right size'),
      stat('Current media missing', count(t.missingKeptFiles), t.missingKeptFiles ? fmtBytes(t.missingKeptBytes) : 'nothing absent'),
      stat('Size mismatches', count(t.mismatch), 'same name, different size'),
      stat('Superseded on the rig', fmtBytes(t.supersededBytes), 'space a cleanup would return'),
      stat('On the machines', fmtBytes(t.actualBytes), 'in the surveyed directory'),
    );
  }

  /**
   * The master list: everything missing anywhere on the rig, worst first.
   *
   * The three states are the point. Every region sits on two machines, so a
   * file absent from one still plays and the rig has merely lost its spare;
   * absent from both, nothing can put it on screen. `unconfirmed` is the honest
   * third case — we could not read one of its holders, so we do not know.
   */
  missingCard(m) {
    if (!m) return null;
    const rows = m.rows || [];
    const counts = m.counts || {};
    const bytes = m.bytes || {};

    const body = h('div.card-body');

    if (m.clean) {
      body.appendChild(
        h('div.rig-hint', 'Nothing current is missing from any machine that was surveyed.'),
      );
    } else {
      body.appendChild(
        h(
          'div.miss-legend',
          legend('gone', `${count(counts.gone || 0)} gone from the rig`, fmtBytes(bytes.gone || 0), 'No surveyed machine has a good copy, and every machine that carries it was looked at. Nothing can play these.'),
          legend('unconfirmed', `${count(counts.unconfirmed || 0)} unconfirmed`, fmtBytes(bytes.unconfirmed || 0), 'No surveyed machine has a good copy, but a machine that carries it was not surveyed. It may be safe there.'),
          legend('reduced', `${count(counts.reduced || 0)} redundancy lost`, fmtBytes(bytes.reduced || 0), 'At least one machine still has a good copy, so the show plays — but the spare is gone.'),
        ),
      );

      if (m.unsurveyedHolders?.length) {
        body.appendChild(
          h(
            'div.rig-warn',
            `This list cannot be complete: ${m.unsurveyedHolders.join(', ')} ` +
              `${m.unsurveyedHolders.length === 1 ? 'carries' : 'carry'} some of these regions and ` +
              `${m.unsurveyedHolders.length === 1 ? 'was' : 'were'} not surveyed.`,
          ),
        );
      }

      if (m.byRegion?.length) {
        body.appendChild(
          h(
            'div.miss-regions',
            ...m.byRegion.map((r) =>
              h(
                `span.miss-region${r.gone ? '.gone' : ''}`,
                {
                  title:
                    `Region ${r.region} is carried by ${r.holders.join(' and ') || 'no machine'}. ` +
                    `${r.files} file(s) missing, ${r.gone} of them from every surveyed holder.`,
                },
                h('b', { text: `r${r.region}` }),
                ` ${count(r.files)} · ${fmtBytes(r.bytes)}`,
                r.gone ? h('span.miss-gone-n', { text: `${count(r.gone)} gone` }) : null,
              ),
            ),
          ),
        );
      }

      const shown = rows.slice(0, 500);
      body.appendChild(
        h(
          // Scrolls inside itself. At 1,293 rows an uncapped table is 27,000px
          // tall and buries every per-machine card under it.
          'div.miss-scroll',
          h(
            'table.grid.miss-table',
            h(
              'thead',
              h(
                'tr',
                h('th', 'State'),
                h('th', 'Song'),
                h('th', 'File'),
                h('th', 'Ver'),
                h('th.num', 'Region'),
                h('th.num', 'Size'),
                h('th', 'Missing from'),
                h('th', 'Still on'),
              ),
            ),
            h(
              'tbody',
              ...shown.map((r) =>
                h(
                  `tr.miss-${r.state}`,
                  h('td', h(`span.pill.miss-${r.state}`, { text: STATE_LABEL[r.state] || r.state })),
                  h('td.mono', { text: r.songFolder }),
                  h('td.mono.miss-file', { text: r.name, title: r.name }),
                  h('td.mono', { text: r.verLabel }),
                  h('td.num', { text: String(r.region) }),
                  h('td.num', { text: fmtBytes(r.size) }),
                  h('td.mono', { text: r.missingFrom.join(', ') || '—' }),
                  h(
                    'td.mono',
                    r.presentOn.length
                      ? h('span', { style: { color: 'var(--kept)' }, text: r.presentOn.join(', ') })
                      : null,
                    r.wrongSizeOn.length
                      ? h('span', { style: { color: 'var(--warn)' }, text: ` ${r.wrongSizeOn.join(', ')} (wrong size)` })
                      : null,
                    r.unknownOn.length
                      ? h('span.muted', {
                          text: ` ${r.unknownOn.join(', ')}?`,
                          title: `${r.unknownOn.join(', ')} carries this region but was not surveyed`,
                        })
                      : null,
                    !r.presentOn.length && !r.wrongSizeOn.length && !r.unknownOn.length
                      ? h('span', { style: { color: 'var(--warn)' }, text: 'nowhere' })
                      : null,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      if (rows.length > shown.length) {
        body.appendChild(h('div.card-note', `Showing the first ${count(shown.length)} of ${count(rows.length)}.`));
      }
    }

    return h(
      'div.card',
      h(
        'header',
        h('h3', { text: 'Missing across the rig' }),
        counts.gone
          ? h('span.pill.broken', { text: `${count(counts.gone)} unplayable` })
          : h('span.n', { text: m.clean ? 'nothing missing' : 'nothing unplayable' }),
        h('span.spacer'),
        h('span.n', { text: rows.length ? `${count(rows.length)} files` : '' }),
      ),
      body,
    );
  }

  resultCards(results) {
    return results.map((r) => {
      const t = r.totals;
      const c = r.comparison;
      const title = r.machineId ? `${r.machineId} · ${r.host}` : r.host;

      const body = h('div.card-body');
      if (r.error) {
        body.appendChild(h('div.rig-warn', r.error));
      } else if (!c) {
        body.append(
          h('div.rig-hint', 'This address was not tagged with a machine, so there is nothing to compare it against — the archive’s expectations are keyed by machine. Listing only.'),
          h('div.kv-inline', kv('Files', count(r.fileCount)), kv('Bytes', fmtBytes(r.totalBytes))),
        );
      } else {
        body.append(
          h(
            'div.kv-inline',
            kv('On the machine', `${count(t.actualFiles)} · ${fmtBytes(t.actualBytes)}`),
            kv('Archive expects', `${count(t.expectedFiles)} · ${fmtBytes(t.expectedBytes)}`),
            kv('Walked in', `${(r.elapsedMs / 1000).toFixed(1)}s`),
          ),
          section('Current media missing from this machine', c.missingKept, 'warn', (x) => `${x.name} · ${fmtBytes(x.size)} · ${x.verLabel}`),
          section('Same name, different size', c.sizeMismatch, 'warn', (x) => `${x.name} · archive ${fmtBytes(x.archiveSize)} vs machine ${fmtBytes(x.machineSize)}`),
          section('Superseded media still on the machine', c.presentSuperseded, 'super', (x) => `${x.name} · ${fmtBytes(x.machineSize)} · ${x.verLabel}`),
          section('Belongs to another machine', c.extraForeign, 'super', (x) => `${x.name} · ${fmtBytes(x.size)}`),
          section('Not in the archive at all', c.extraUnknown, 'super', (x) => `${x.name} · ${fmtBytes(x.size)}`),
          section('Already cleaned off (superseded, absent)', c.missingSuperseded, 'quiet', (x) => `${x.name} · ${fmtBytes(x.size)}`),
          t.nameCollisions
            ? h('div.rig-warn', `${count(t.nameCollisions)} archive file names appear more than once, so matching on this machine is not reliable.`)
            : null,
          r.skipped.length
            ? h('div.rig-hint', `${count(r.skipped.length)} directories were skipped (timeout or permission).`)
            : null,
        );
      }

      return h(
        'div.card',
        h(
          'header',
          h('h3', { text: title }),
          t
            ? t.inSync
              ? h('span.pill.kept', { text: 'in sync' })
              : h('span.pill.broken', { text: 'needs attention' })
            : h('span.pill.unknown', { text: r.error ? 'failed' : 'listed only' }),
          h('span.spacer'),
          h('span.n', { text: r.mountPoint || '' }),
        ),
        body,
      );
    });
  }
}

/** A collapsible list. Empty sections are drawn as a single quiet line. */
function section(title, rows, tone, describe) {
  rows = rows || [];
  if (rows.length === 0) {
    return h('div.rig-sec.empty', h('span.rig-sec-t', { text: title }), h('span.rig-sec-n', { text: 'none' }));
  }
  const list = h('div.rig-list', ...rows.slice(0, 300).map((x) => h('div.rig-item', { text: describe(x) })));
  list.hidden = true;
  const toggle = h(`button.btn.sm.ghost.rig-sec-toggle`, {
    text: 'show',
    onClick: () => {
      list.hidden = !list.hidden;
      toggle.textContent = list.hidden ? 'show' : 'hide';
    },
  });
  return h(
    'div.rig-sec',
    h(
      'div.rig-sec-head',
      h(`span.rig-sec-t.${tone}`, { text: title }),
      h('span.rig-sec-n', { text: count(rows.length) }),
      h('span.spacer'),
      toggle,
    ),
    rows.length > 300 ? h('div.rig-hint', `Showing the first 300 of ${count(rows.length)}.`) : null,
    list,
  );
}

const STATE_LABEL = {
  gone: 'gone',
  unconfirmed: 'unconfirmed',
  reduced: 'spare lost',
};

function legend(kind, label, sub, title) {
  return h(
    `div.miss-legend-item.${kind}`,
    { title },
    h('span.miss-dot'),
    h('span', h('b', { text: label }), h('span.muted', { text: ` · ${sub}` })),
  );
}

function field(label, control) {
  return h('label.rig-field', h('span', { text: label }), control);
}

function kv(k, v) {
  return h('span.kvi', h('b', { text: k }), h('span', { text: v }));
}

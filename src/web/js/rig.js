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

import { h, append, clear, modal, toast } from './dom.js';
import { gridTable } from './gridtable.js';
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
    this.draft = {
      text: '',
      share: 'd3 Projects',
      directory: '',
      /**
       * Append d3's own media path to the directory. See `VIDEO_FILE_SUFFIX`.
       * ON by default: on a d3 machine that is where the media is, so it is
       * what the operator wants nearly every time.
       */
      appendVideoFile: true,
      username: '',
      password: '',
    };
  }

  async load() {
    try {
      this.status = await api.rigStatus();
      if (this.status.share) this.draft.share = this.status.share;
      if (this.status.directory) {
        // The server holds ONE directory: the whole path that was surveyed. The
        // two controls are a way of typing it, so it is split back into them —
        // otherwise a reloaded tab shows the suffix in the box AND an unticked
        // checkbox, and ticking it would append the suffix a second time.
        const { base, append } = splitVideoFile(this.status.directory);
        this.draft.directory = base;
        this.draft.appendVideoFile = append;
      }
      if (this.status.username) this.draft.username = this.status.username;
      // Show the list the SERVER actually holds, not an empty box beside a
      // populated table — otherwise a reloaded tab looks like it lost the list.
      if (!this.draft.text && this.status.targets?.length) {
        this.draft.text = targetLines(this.status.targets);
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

  /**
   * The directory that will actually be walked: what is typed, plus d3's own
   * media path when the box is ticked.
   *
   * ONE function, used by the survey, by what is stored in the session and by
   * every line of copy that names the path — a checkbox whose effect the screen
   * does not show is a checkbox somebody surveys the wrong directory with.
   */
  surveyDirectory() {
    return withVideoFile(this.draft.directory, this.draft.appendVideoFile);
  }

  async submitTargets(text) {
    const res = await api.rigTargets({
      text,
      share: this.draft.share,
      directory: this.surveyDirectory(),
    });
    this.parseErrors = res.errors || [];
    this.unknownMachineIds = res.unknownMachineIds || [];
    this.status = await api.rigStatus();
    const n = (res.targets || []).length;
    if (n) toast(`${n} machine${n === 1 ? '' : 's'} in the list`, 'info');
  }

  /**
   * Put the list the SERVER is holding back in the box, ready to be edited.
   *
   * The box and the list are not the same thing: the box is a draft, and after
   * an import it holds the raw YAML, after an edit it holds whatever was typed,
   * and after enough of either it holds something nobody would want to press
   * "Use this list" on. This is how you get back to what is actually loaded,
   * written in the plain `id host` form the parser reads, without a round trip
   * through the YAML file.
   */
  editList() {
    const targets = this.status?.targets || [];
    if (!targets.length) return;
    this.draft.text = targetLines(targets);
    this.render();
    const box = this.host.querySelector('#rigTargets');
    if (box) {
      box.focus();
      // Cursor at the end, not at the top: the usual edit is another machine.
      box.setSelectionRange(box.value.length, box.value.length);
    }
    toast('The loaded list is in the box — edit it, then press Use this list', 'info');
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
      directory: this.surveyDirectory(),
      keepN: state.keepN,
      snapshotId: state.snapshotId ?? undefined,
    });
    this.status = await api.rigStatus();
  }

  /**
   * Pick the survey directory off a machine instead of typing it.
   *
   * ONE machine is listed, and the modal says which — the survey applies one
   * directory to every machine, so this is choosing a path, not inspecting the
   * rig. A path that exists on 301 and not on 302 is a finding the SURVEY
   * makes, and browsing must not quietly stand in for it.
   *
   * Nothing here reads a file. The route lists directory entries one level
   * deep, through the same read-only mount everything else on this tab uses.
   */
  openBrowser() {
    const mounted = (this.status?.targets || []).filter((t) => t.mountPoint);
    if (!mounted.length) {
      toast('Connect a machine first — the list comes from the machine itself', 'error');
      return;
    }

    let host = mounted[0].host;
    let dir = this.draft.directory || '';
    let listing = null;
    let error = null;
    let loading = true;

    const body = h('div.rig-browse');
    const chosen = h('span.rig-browse-chosen');
    const dlg = modal(
      'Choose the directory to survey',
      body,
      [
        chosen,
        h('span.spacer'),
        h('button.btn.sm.ghost', { text: 'Cancel', onClick: () => dlg.close() }),
        h('button.btn.primary', {
          text: 'Use this directory',
          onClick: () => {
            this.draft.directory = dir;
            dlg.close();
            this.render();
          },
        }),
      ],
      { width: '660px' },
    );

    /**
     * Load one directory. `dir` only moves once the machine has answered, and a
     * reply that arrives after a newer request is dropped — clicking twice on a
     * slow share must not land you in the first folder you left.
     */
    let generation = 0;
    const go = async (next) => {
      const mine = ++generation;
      loading = true;
      error = null;
      draw();
      let got = null;
      let failed = null;
      try {
        got = await api.rigBrowse({ host, directory: next });
      } catch (err) {
        failed = err.message;
      }
      if (mine !== generation) return;
      if (got) {
        listing = got;
        dir = got.directory;
        host = got.host;
      }
      error = failed;
      loading = false;
      draw();
    };

    const crumb = (text, path, current) =>
      current
        ? h('span.rig-crumb.here', { text })
        : h('button.rig-crumb', { text, onClick: () => go(path) });

    const draw = () => {
      clear(body);
      const segments = dir === '' ? [] : dir.split('/');
      const label = mounted.find((t) => t.host === host);

      append(body, [
        mounted.length > 1
          ? h(
              'div.rig-browse-machine',
              h('span', { text: 'Listing' }),
              h(
                'select.rig-input',
                {
                  value: host,
                  onChange: (e) => {
                    host = e.target.value;
                    go(dir);
                  },
                },
                ...mounted.map((t) =>
                  h('option', {
                    value: t.host,
                    selected: t.host === host,
                    text: t.machineId ? `${t.machineId} — ${t.host}` : t.host,
                  }),
                ),
              ),
              h('span.muted', { text: 'the path you choose is used on every machine' }),
            )
          : h('div.rig-browse-machine', h('span.muted', {
              text: `Listing ${label?.machineId ? `${label.machineId} — ` : ''}${host}`,
            })),
        h(
          'div.rig-crumbs',
          crumb('share root', '', segments.length === 0),
          ...segments.map((seg, i) =>
            h(
              'span.rig-crumb-sep',
              h('span', { text: '/' }),
              crumb(seg, segments.slice(0, i + 1).join('/'), i === segments.length - 1),
            ),
          ),
        ),
        error ? h('div.rig-warn', h('b', 'Could not read that directory. '), error) : null,
        loading
          ? h('div.rig-browse-empty', h('span.spinner'), h('span', { text: 'Reading…' }))
          : null,
      ]);

      if (!loading && !error && listing) {
        // Read off the listing NOW: `listing` is reassigned on every load, and a
        // click handler that read it later would navigate from the wrong place.
        const { parent } = listing;
        const rows = [];
        if (parent !== null) {
          rows.push(
            h('button.rig-browse-row.up', { onClick: () => go(parent) },
              h('span.rig-browse-name', { text: '↑ up one level' })),
          );
        }
        for (const d of listing.directories) {
          rows.push(
            h('button.rig-browse-row', { onClick: () => go(d.path) },
              h('span.rig-browse-name', { text: d.name }),
              h('span.rig-browse-go', { text: '›' })),
          );
        }
        append(body, [
          rows.length
            ? h('div.rig-browse-list', ...rows)
            : h('div.rig-browse-empty', h('span', { text: 'No folders here.' })),
          h(
            'div.rig-hint',
            { style: { marginTop: '8px', marginBottom: '0' } },
            listing.fileCount
              ? `${count(listing.fileCount)} file${listing.fileCount === 1 ? '' : 's'} sit directly in this directory. `
              : 'No files sit directly in this directory. ',
            'Names only — nothing here is opened, and sizes are the survey’s job.',
          ),
          listing.truncated
            ? h('div.rig-warn', h('b', 'This list is cut short. '), 'There are more folders here than the picker shows; type the path if the one you want is missing.')
            : null,
        ]);
      }

      // The same path the field will show, suffix included: the picker chooses
      // the project folder, and the checkbox is part of what gets surveyed.
      const effective = withVideoFile(dir, this.draft.appendVideoFile);
      chosen.textContent = effective === '' ? 'Will survey: the share root' : `Will survey: ${effective}`;
    };

    go(dir);
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
    download('rig-targets.yaml', await api.rigTargetsYaml(), 'text/yaml');
  }

  /**
   * Save the master missing list as a CSV.
   *
   * The WHOLE list, not the 500 rows on screen — an export that stopped where
   * the table stops would be a list of findings with findings missing from it.
   * Rendered by the server, saved by the browser: nothing is written here, and
   * the rig session stays unpersisted. Machine ids only; no address, no
   * credential.
   */
  async saveMissingCsv() {
    const text = await api.rigMissingCsv();
    download(`rig-missing_${stamp()}.csv`, text, 'text/csv');
    toast('Saved the whole list, not just the rows on screen', 'info');
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

    // The tab badge counts MACHINES THAT PLAY something they have not got, not
    // machines with anything missing: an understudy short of a file is a lost
    // spare, and a badge that cannot tell those apart cries wolf at a rig that
    // is fine. A wrong-sized copy on any machine counts too — whatever that
    // file is, it is not the one the archive recorded.
    const alarmMachines = new Set();
    const spareMachines = new Set();
    for (const r of survey.missing?.rows || []) {
      const primaries = r.primaryOn?.length ? r.primaryOn : r.missingFrom;
      if (r.state === 'missing' || r.state === 'recoverable') {
        for (const id of r.missingFrom) if (primaries.includes(id)) alarmMachines.add(id);
      } else if (r.state === 'spareLost') {
        for (const id of r.missingFrom) spareMachines.add(id);
      }
    }
    for (const r of results) if (r.totals?.sizeMismatchFiles) alarmMachines.add(r.machineId || r.host);
    this.onCounts?.({ high: alarmMachines.size, low: spareMachines.size });

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
      onInput: (e) => {
        this.draft.text = e.target.value;
      },
    });
    // Assigned, NOT passed as an attribute. A textarea takes its value from its
    // content, so `value=` on one sets an attribute the browser ignores — the
    // box came up empty on every render, which is why the list kept vanishing
    // out of it the moment anything re-drew the card. An `<input>` hides this
    // bug, because there the attribute IS the initial value.
    box.value = this.draft.text;
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
          text: 'Edit list',
          title: 'Put the loaded list back in the box, in the form the parser reads',
          disabled: this.busy || targets.length === 0,
          onClick: () => this.editList(),
        }),
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
    // The one place the directory and the checkbox are shown as the single path
    // they add up to. Written imperatively because both controls change it and
    // neither may cost the box its focus.
    const pathEl = h('code');
    const showPath = () => {
      pathEl.textContent = this.surveyDirectory() || 'the share root';
    };
    showPath();
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
          // Not `field()`: that wraps the control in a <label>, and a button
          // inside a label is a second thing for a click on it to do.
          h(
            'div.rig-field',
            h('label', { for: 'rigDirectory', text: 'Directory on each machine' }),
            h(
              'div.rig-dir',
              h('input#rigDirectory.rig-input.wide', {
                type: 'text',
                value: this.draft.directory,
                placeholder: 'leave blank for the share root',
                onInput: (e) => {
                  this.draft.directory = e.target.value;
                  // The line below says what will be surveyed, so it is written
                  // on every keystroke rather than on the next render. A full
                  // render here would take the focus out of the box mid-word.
                  showPath();
                },
              }),
              // Typing it is still the fast path. Browsing is for the first
              // time, and for the case a typo would otherwise survey an empty
              // directory and report the rig as clean.
              h('button.btn.sm.ghost', {
                text: 'Browse…',
                disabled: this.busy || mounted === 0,
                title: mounted
                  ? 'List the directories on a mounted machine and pick one'
                  : 'Connect a machine first — the list comes from the machine itself',
                onClick: () => this.openBrowser(),
              }),
              // To the right of Browse, because it acts on what Browse produced.
              h(
                'label.rig-check',
                {
                  title: `Survey <directory>/${VIDEO_FILE_SUFFIX} — where d3 keeps its media inside a project folder. Browse to the project; this adds the rest.`,
                },
                h('input', {
                  type: 'checkbox',
                  checked: this.draft.appendVideoFile,
                  onChange: (e) => {
                    this.draft.appendVideoFile = e.target.checked;
                    showPath();
                  },
                }),
                h('span', { text: 'append d3 VideoFile path' }),
              ),
            ),
          ),
        ),
        // Says the whole path, not the parts: a checkbox whose effect the screen
        // does not show is a checkbox somebody surveys the wrong folder with.
        h(
          'div.rig-hint',
          'Surveying ',
          pathEl,
          ' on every machine. Compared at the current keep-latest-',
          h('b', { text: String(state.keepN) }),
          ' policy.',
        ),
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
          // Ordered by what they cost. The first two are both alarms: the
          // machine that PLAYS the file has not got it, and an understudy is a
          // backup, not a second place it plays from.
          legend('missing', `${count(counts.missing || 0)} missing from the rig`, fmtBytes(bytes.missing || 0), 'Not on the machine that plays it, and no surveyed machine has a good copy. The archive is the only place left to get it from.'),
          legend('recoverable', `${count(counts.recoverable || 0)} on the backup only`, fmtBytes(bytes.recoverable || 0), 'Not on the machine that plays it, so the show cannot play it — but its understudy has a good copy, so it can be restored from the rig rather than from the archive.'),
          legend('unconfirmed', `${count(counts.unconfirmed || 0)} unconfirmed`, fmtBytes(bytes.unconfirmed || 0), 'The machine that PLAYS this was not surveyed, so there is no finding to make. A backup we did not read would leave the alarm settled and only the repair route unknown; this is the other case.'),
          legend('spareLost', `${count(counts.spareLost || 0)} spare lost`, fmtBytes(bytes.spareLost || 0), 'The machine that plays it has it, at the right size. The show plays; the backup copy is gone.'),
        ),
      );

      // Two different omissions, and only the first can hide an alarm: a
      // machine that PLAYS a region and was not read is a finding this list
      // cannot make at all, where an unread BACKUP leaves every verdict intact
      // and only the repair route unknown.
      const unreadPrimaries = m.unsurveyedPrimaries || [];
      const unreadBackups = (m.unsurveyedHolders || []).filter((id) => !unreadPrimaries.includes(id));
      if (unreadPrimaries.length) {
        body.appendChild(
          h(
            'div.rig-warn',
            h('b', 'This list cannot be complete. '),
            `${unreadPrimaries.join(', ')} ${unreadPrimaries.length === 1 ? 'plays' : 'play'} some of these regions and ` +
              `${unreadPrimaries.length === 1 ? 'was' : 'were'} not surveyed, so findings about ` +
              `${unreadPrimaries.length === 1 ? 'that machine' : 'those machines'} cannot be made at all.`,
          ),
        );
      }
      if (unreadBackups.length) {
        body.appendChild(
          h(
            'div.rig-hint',
            { style: { marginTop: '8px' } },
            `${unreadBackups.join(', ')} ${unreadBackups.length === 1 ? 'backs' : 'back'} up some of these regions and ` +
              `${unreadBackups.length === 1 ? 'was' : 'were'} not surveyed. That does not change any verdict above — ` +
              'it means some of what is listed as missing may in fact be restorable from the rig.',
          ),
        );
      }

      if (m.byRegion?.length) {
        body.appendChild(
          h(
            'div.miss-regions',
            ...m.byRegion.map((r) =>
              h(
                `span.miss-region${r.unplayable ? '.alarm' : ''}`,
                {
                  title:
                    `Region ${r.region} is played by ${r.primaries?.join(' and ') || '—'} and backed up by ` +
                    `${(r.holders || []).filter((id) => !(r.primaries || []).includes(id)).join(' and ') || 'nothing'}. ` +
                    `${r.files} file(s) missing somewhere, ${r.unplayable} of them not on the machine that plays them.`,
                },
                h('b', { text: `r${r.region}` }),
                ` ${count(r.files)} · ${fmtBytes(r.bytes)}`,
                r.unplayable ? h('span.miss-alarm-n', { text: `${count(r.unplayable)} unplayable` }) : null,
              ),
            ),
          ),
        );
      }

      body.appendChild(
        // Scrolls inside itself. At 1,293 rows an uncapped table is 27,000px
        // tall and buries every per-machine card under it.
        h('div.rig-grid', gridTable({
          key: 'rig.missing',
          columns: missingCols(),
          rows,
          max: 500,
          // By song, but never across the state groups: the alarms stay at the
          // top, which is the entire reason the states exist.
          order: bySongWithinState(rows),
          maxHeight: 440,
          rowClass: (r) => `miss-${r.state}`,
        })),
      );
      const shown = Math.min(rows.length, 500);
      if (rows.length > shown) {
        body.appendChild(
          h('div.card-note', `Showing the worst ${count(shown)} of ${count(rows.length)}, listed by song within each state.`),
        );
      }
    }

    return h(
      'div.card',
      h(
        'header',
        h('h3', { text: 'Missing across the rig' }),
        m.unplayable?.files
          ? h('span.pill.broken', {
              text: `${count(m.unplayable.files)} unplayable`,
              title: 'Not on the machine that plays them. An understudy holding a copy is a backup, not a second place the file plays from.',
            })
          : h('span.n', { text: m.clean ? 'nothing missing' : 'nothing unplayable' }),
        h('span.spacer'),
        h('span.n', { text: rows.length ? `${count(rows.length)} files` : '' }),
        rows.length
          ? h('button.btn.sm.ghost', {
              text: 'Export CSV',
              title: `Save all ${count(rows.length)} rows — not just the ones shown. Machine ids only; no address and no password.`,
              disabled: this.busy,
              onClick: () => this.act(() => this.saveMissingCsv(), { rerender: false }),
            })
          : null,
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
          section('Current media missing from this machine', c.missingKept, 'warn', archiveCols('size'), 'rig.archive'),
          section('Same name, different size', c.sizeMismatch, 'warn', mismatchCols(), 'rig.mismatch'),
          section('Superseded media still on the machine', c.presentSuperseded, 'super', archiveCols('machineSize'), 'rig.archive'),
          // Read off the NAME, not out of the index — the index has no row for
          // these, or none that belongs here. Same columns all the same,
          // because the question an operator asks of them is the same one:
          // which song, which version, which slice.
          section('Belongs to another machine', c.extraForeign, 'super', foreignCols(), 'rig.foreign'),
          // `extraUnknown` is deliberately NOT shown. It is media carrying a
          // region this machine plays that the archive has no row for, and it
          // is the one bucket the archive cannot form an opinion about — so it
          // could only ever be read and wondered at. Removed at the user's
          // request. Still counted: `totals.extraUnknownFiles`.
          section('Names this grammar cannot read', c.extraUnparsed, 'quiet', foreignCols(), 'rig.foreign'),
          // NOT a section. A file with no region belongs to no machine, because
          // the allocation is BY region — so it is neither missing from this
          // machine nor extra on it, and listing it as either is a finding that
          // is not there. Confirmed with the user. Counted, so the totals still
          // add up to what is on the drive, and said in one line so it cannot
          // become an invisible omission.
          t.regionlessFiles
            ? h(
                'div.rig-sec.empty',
                h('span.rig-sec-t', {
                  text: 'Whole-canvas media, carrying no region',
                  title: 'The rig allocates by region, so a file with no region token belongs to no machine. Not compared, and not a finding.',
                }),
                h('span.rig-sec-n', { text: `${count(t.regionlessFiles)} · ${fmtBytes(t.regionlessBytes)} · not compared` }),
              )
            : null,
          // `missingSuperseded` is deliberately NOT shown. Old media that is
          // already off the machine is the one bucket an operator has nothing
          // to do about, and on this rig it is hundreds of rows of it. The
          // comparison still counts it — the arithmetic has to close, and
          // `totals.missingSupersededFiles` is still there for anything that
          // wants it. Only the section is gone. Removed at the user's request.
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
/**
 * One finding list, collapsed until asked for.
 *
 * The rows are columned rather than run together into a line: song, file,
 * version and region are four different questions, and reading them out of one
 * string means reading the same delimiter four times. `columns` says which four
 * (or six), and `widthKey` is what a dragged column is filed under — shared
 * across lists of the same SHAPE, so widening `File` once widens it everywhere
 * the same rows appear.
 */
function section(title, rows, tone, columns, widthKey) {
  rows = rows || [];
  if (rows.length === 0) {
    return h('div.rig-sec.empty', h('span.rig-sec-t', { text: title }), h('span.rig-sec-n', { text: 'none' }));
  }
  const list = h(
    'div.rig-grid',
    gridTable({
      key: widthKey,
      columns,
      rows,
      max: 300,
      // The 300 kept are the 300 biggest; the order they are READ in is by song.
      order: bySong,
      maxHeight: 320,
      rowClass: () => tone,
    }),
  );
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
    rows.length > 300
      ? h('div.rig-hint', `Showing the largest 300 of ${count(rows.length)}, by song.`)
      : null,
    list,
  );
}

/* ------------------------------------------------------------------ columns

   Song, file, version and region are four separate questions, so they are four
   separate columns everywhere they appear. Widths are shared per SHAPE rather
   than per list, so widening `File` on one list widens it on every list built
   from the same kind of row.

   `region` is the canvas slice. `0` is the whole canvas — the offline-edit copy
   — and is never a slice, which is why it is printed as `0` rather than folded
   in with the rest. A name with no region token at all is a legal whole-canvas
   deliverable and shows an em dash, not a zero: they are different things.
   ------------------------------------------------------------------------- */

/** The song folder a machine path sits in. The rig mirrors the archive's shape. */
function songOf(relPath) {
  const i = String(relPath || '').indexOf('/');
  return i > 0 ? relPath.slice(0, i) : '';
}

/**
 * Song first, then file name.
 *
 * The lists are CHOSEN biggest-first — that is how a capped list keeps the rows
 * that cost the most to be wrong about — and then READ by song, which is how an
 * operator works through them: everything for one song together, and an asset's
 * files next to each other because the name sorts them. Asked for by the user.
 */
function bySong(a, b) {
  return (
    songOfRow(a).localeCompare(songOfRow(b), undefined, { numeric: true, sensitivity: 'base' }) ||
    String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' })
  );
}

/**
 * Where d3 keeps its media inside a project folder.
 *
 * The operator browses to (or types) the project directory; the media sits one
 * fixed pair of folders below it. The checkbox is that fact, rather than four
 * more segments to type correctly every time.
 */
const VIDEO_FILE_SUFFIX = 'objects/VideoFile';

/**
 * The path to survey. Idempotent on purpose: a directory that already ends in
 * the suffix is left alone, so typing it out by hand AND ticking the box
 * cannot produce `.../objects/VideoFile/objects/VideoFile`.
 */
function withVideoFile(directory, append) {
  const dir = String(directory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!append || endsWithVideoFile(dir)) return dir;
  return dir === '' ? VIDEO_FILE_SUFFIX : `${dir}/${VIDEO_FILE_SUFFIX}`;
}

/** Take a stored path back apart into the two controls that produced it. */
function splitVideoFile(directory) {
  const dir = String(directory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!endsWithVideoFile(dir)) return { base: dir, append: false };
  return { base: dir.slice(0, -VIDEO_FILE_SUFFIX.length).replace(/\/+$/, ''), append: true };
}

/** Case-insensitive: an SMB share does not care, and neither should this. */
function endsWithVideoFile(dir) {
  return dir.toLowerCase().endsWith(VIDEO_FILE_SUFFIX.toLowerCase());
}

/**
 * Hand text to the browser's save dialog.
 *
 * The one way anything on this tab reaches a disk, and it is the OPERATOR's
 * dialog: the server renders the bytes into a response, this makes a blob of
 * them, and where it lands is the operator's choice. Nothing in this
 * application writes it, which is what keeps "the rig session is never stored"
 * literally true.
 */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `20260830-0431`, local time — so two exports of a live rig are tellable apart. */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * The target list as the box takes it: one machine per line, `id host`.
 *
 * One formatter, because the box is populated from two places — a tab that
 * loads with a list already on the server, and the Edit list button — and two
 * spellings of the same list is how a round trip through the box starts
 * changing it.
 */
function targetLines(targets) {
  return targets.map((t) => (t.machineId ? `${t.machineId} ${t.host}` : t.host)).join('\n');
}

/** The song a row belongs to, whichever kind of row it is. */
function songOfRow(row) {
  return row.songFolder || songOf(row.relPath) || '';
}

/**
 * Song order WITHIN the grouping the server sent, for the master list.
 *
 * The groups are the four states, and they must stay in the order they arrived:
 * a `missing` file sorted under a late song, below a screenful of `spare lost`, is
 * the failure the states exist to prevent. The group order is read off the rows
 * rather than restated here, so this cannot drift from `rollUpMissing`.
 */
function bySongWithinState(rows) {
  const group = new Map();
  for (const r of rows) if (!group.has(r.state)) group.set(r.state, group.size);
  return (a, b) => (group.get(a.state) ?? 0) - (group.get(b.state) ?? 0) || bySong(a, b);
}

function regionCell(region) {
  return region === null || region === undefined ? '—' : String(region);
}

const SONG_COL = { key: 'song', label: 'Song', width: 'minmax(110px, 1fr)', cls: 'cell-song' };
const FILE_COL = { key: 'file', label: 'File', width: 'minmax(220px, 3fr)', cls: 'cell-file' };
const VER_COL = { key: 'ver', label: 'Version', width: '110px', cls: 'cell-ver' };
const REGION_COL = { key: 'region', label: 'Region', width: '76px', align: 'right' };

/**
 * A list of files the ARCHIVE knows about: every column is read out of the
 * index, including the version label.
 *
 * @param {'size'|'machineSize'} sizeField which side's bytes this list reports.
 */
function archiveCols(sizeField) {
  return [
    { ...SONG_COL, cell: (x) => x.songFolder },
    { ...FILE_COL, cell: (x) => x.name },
    { ...VER_COL, cell: (x) => x.verLabel },
    { ...REGION_COL, cell: (x) => regionCell(x.region) },
    {
      key: 'size',
      label: sizeField === 'machineSize' ? 'On machine' : 'Size',
      width: '96px',
      align: 'right',
      cell: (x) => fmtBytes(x[sizeField]),
    },
  ];
}

/** Both sizes, because with a mismatch neither reading is the answer. */
function mismatchCols() {
  return [
    { ...SONG_COL, cell: (x) => x.songFolder },
    { ...FILE_COL, cell: (x) => x.name },
    { ...VER_COL, cell: (x) => x.verLabel },
    { ...REGION_COL, cell: (x) => regionCell(x.region) },
    { key: 'archive', label: 'Archive', width: '96px', align: 'right', cell: (x) => fmtBytes(x.archiveSize) },
    { key: 'machine', label: 'On machine', width: '104px', align: 'right', cell: (x) => fmtBytes(x.machineSize) },
  ];
}

/**
 * A file the index has no row for here. Song comes from where it sits on the
 * machine; version and region are what the NAME says, parsed by the scan's own
 * grammar on the server. Nothing in these rows is an archive fact.
 */
function foreignCols() {
  return [
    { ...SONG_COL, label: 'Folder', title: 'The folder it sits in on the machine', cell: (x) => songOf(x.relPath) },
    { ...FILE_COL, cell: (x) => x.name },
    { ...VER_COL, title: 'What the file name says. The archive has no row for this file.', cell: (x) => x.verLabel || '—' },
    { ...REGION_COL, title: 'What the file name says. An em dash means the name carries no region.', cell: (x) => regionCell(x.region) },
    { key: 'size', label: 'On machine', width: '104px', align: 'right', cell: (x) => fmtBytes(x.size) },
  ];
}

/**
 * The master list's columns.
 *
 * `Missing from` and `Still on` are the two halves of the finding: which
 * holders have not got it, and whether anything else has. `Still on` is
 * deliberately three-coloured — a good copy, a wrong-sized one, and a machine
 * nobody looked at are three different answers, and only the first means the
 * show plays.
 */
function missingCols() {
  return [
    {
      key: 'state',
      label: 'State',
      width: '108px',
      cell: (r) => h(`span.pill.miss-${r.state}`, { text: STATE_LABEL[r.state] || r.state }),
    },
    { ...SONG_COL, cell: (r) => r.songFolder },
    { ...FILE_COL, cell: (r) => r.name },
    { ...VER_COL, cell: (r) => r.verLabel },
    { ...REGION_COL, cell: (r) => regionCell(r.region) },
    { key: 'size', label: 'Size', width: '96px', align: 'right', cell: (r) => fmtBytes(r.size) },
    {
      key: 'missingFrom',
      label: 'Missing from',
      width: 'minmax(110px, 1fr)',
      cls: 'cell-ver',
      cell: (r) => r.missingFrom.join(', ') || '—',
    },
    {
      key: 'stillOn',
      label: 'Still on',
      width: 'minmax(120px, 1fr)',
      /**
       * Machines that actually have it. A machine we could not read is NOT
       * named here: this column answers "where can I still get this?", and
       * `207?` was answering a different question — it named a machine while
       * saying nothing about it, which reads as a finding at a glance and is
       * not one. An em dash says the honest thing, and the machine's name is on
       * the tooltip and in the warning at the top of the card, where "we did not
       * look at 207" is stated once instead of a thousand times. Asked for by
       * the user.
       */
      cell: (r) => {
        const nothingKnown = !r.presentOn.length && !r.wrongSizeOn.length;
        if (nothingKnown && r.unknownOn.length) {
          return h('span.mono.muted', {
            text: '—',
            title: `${r.unknownOn.join(', ')} also ${r.unknownOn.length === 1 ? 'carries' : 'carry'} this region but ${r.unknownOn.length === 1 ? 'was' : 'were'} not surveyed, so nothing is known about ${r.unknownOn.length === 1 ? 'it' : 'them'}.`,
          });
        }
        if (nothingKnown) {
          return h('span.mono', { style: { color: 'var(--warn)' }, text: 'nowhere' });
        }
        return h(
          'span.mono',
          r.presentOn.length
            ? h('span', { style: { color: 'var(--kept)' }, text: r.presentOn.join(', ') })
            : null,
          r.wrongSizeOn.length
            ? h('span', { style: { color: 'var(--warn)' }, text: ` ${r.wrongSizeOn.join(', ')} (wrong size)` })
            : null,
        );
      },
    },
  ];
}

const STATE_LABEL = {
  missing: 'missing',
  recoverable: 'backup only',
  unconfirmed: 'unconfirmed',
  spareLost: 'spare lost',
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

/**
 * The reclaim strip: the keep-latest-N slider and the headline figure it
 * drives. This is the centrepiece of the tool, so it is built to feel
 * immediate — the slider label updates on every input event, the request is
 * debounced, and results are memoised per (filter set × N) so dragging back
 * over ground already covered is instant.
 *
 * Nothing here is a literal. Every figure shown comes from /api/reclaim for
 * the filter set currently on screen.
 */

import { h, clear, debounce, append } from './dom.js';
import { state, update, emit, filterParams } from './state.js';
import { api } from './api.js';
import { bytesParts, tib, count, bytes as fmtBytes } from './format.js';
import { isNarrow } from './viewport.js';
import { driveMeter } from './tableview.js';

const MAX_N_FALLBACK = 8;

export class ReclaimStrip {
  constructor(host) {
    this.host = host;
    this.maxN = MAX_N_FALLBACK;
    this.cache = new Map();
    this.seq = 0;
    this.last = null;
    this.fetchSoon = debounce(() => this.fetch(), 140);
    this.render();
  }

  setMaxN(n) {
    if (!n || n === this.maxN) return;
    this.maxN = Math.max(3, Math.min(20, n));
    this.render();
    this.refresh();
  }

  /**
   * The filter set the reclaim figure is computed over.
   *
   * `status` is deliberately dropped. Asking "how much can I reclaim?" while
   * filtered to status=superseded is circular — the answer would be "all of
   * it", and "retained" would read 0.00 TiB. The slider must always answer
   * for the whole set in view, with the kept/superseded lens taken off.
   */
  params(n) {
    const p = { ...filterParams(), keepN: n };
    delete p.status;
    return p;
  }

  key(n) {
    return JSON.stringify(this.params(n));
  }

  render() {
    clear(this.host);

    this.numEl = h('span.headline-num');
    this.leadEl = h('div.headline-lead');
    this.subEl = h('div.headline-sub');
    this.headlineEl = h('div.headline', this.numEl, h('div.headline-text', this.leadEl, this.subEl));

    this.slider = h('input', {
      type: 'range',
      min: '1',
      max: String(this.maxN),
      step: '1',
      value: String(state.keepN),
      'aria-label': 'Keep latest N versions of each asset',
      onInput: (e) => this.onSlide(Number(e.target.value)),
    });
    this.sliderValue = h('span.value');
    this.ticks = h(
      'div.ticks',
      Array.from({ length: this.maxN }, (_, i) =>
        h(`span${i + 1 === state.keepN ? '.on' : ''}`, { text: String(i + 1), onClick: () => this.onSlide(i + 1, true) }),
      ),
    );

    this.factProtected = fact('Protected patches', 'protected');
    this.factKept = fact('Retained', 'kept');
    // Not a keep-N figure. It says how much of what is in view is the
    // whole-canvas region0 copy the offline edit is cut against -- material
    // the edit needs, whatever the slider is set to.
    this.factRegion0 = fact('Region 0s', 'region0', 'REGION 0s');
    // Region 0s plus untagged (valid name, no region token) files -- every
    // whole-canvas file in view. Roughly what a director drive holds.
    this.factWholeCanvas = fact('Region 0 + untagged', 'region0', 'REGION 0 + UNTAGGED');
    this.factMatched = fact('In view', '');
    // What the show-file cross-check rescued from this keep-N, within the rows
    // in view. Hidden entirely when no capture is loaded: a `0.00 TiB` on an
    // unchecked archive reads as "nothing was at risk", which is the one thing
    // it does not mean. The line below says which case we are in.
    this.factProgrammed = fact('Crosscheck saves', 'programmed');
    this.factProgrammed.node.hidden = true;
    // Superseded bytes in view that the cluster still holds, by the Media
    // Index's last scan: what a cleanup frees on the machines rather than on
    // long-term storage. Hidden with no listing -- a `0.00 TiB` there would
    // read as "the machines are clean".
    this.factCluster = fact('On the cluster', 'cluster', 'ON CLUSTER');
    this.factCluster.node.hidden = true;

    // On a phone the slider is a 7-stop track you drag with a thumb that
    // covers three of the stops, and it costs two rows -- the track and the
    // tick numbers -- out of a screen that has about eight. A stepper says the
    // same thing in one row and is exact on the first tap.
    this.stepDown = h('button.btn.sm.step', {
      type: 'button',
      text: '−',
      'aria-label': 'Keep one fewer version',
      onClick: () => this.onSlide(Math.max(1, state.keepN - 1), true),
    });
    this.stepUp = h('button.btn.sm.step', {
      type: 'button',
      text: '+',
      'aria-label': 'Keep one more version',
      onClick: () => this.onSlide(Math.min(this.maxN, state.keepN + 1), true),
    });

    this.host.append(
      this.headlineEl,
      isNarrow()
        ? h(
            'div.slider-block.stepper',
            this.sliderValue,
            // Adjacent, not one at each edge: a pair you nudge with one thumb
            // without moving your hand across the screen.
            h('div.step-group', this.stepDown, this.stepUp),
          )
        : h(
            'div.slider-block',
            h('div.slider-head', h('span.label', 'Keep latest N versions of each asset'), this.sliderValue),
            this.slider,
            this.ticks,
          ),
      h(
        'div.reclaim-facts',
        this.factMatched.node,
        this.factProtected.node,
        this.factKept.node,
        this.factProgrammed.node,
        this.factCluster.node,
        this.factRegion0.node,
        this.factWholeCanvas.node,
      ),
      // Never a null child: `append` here is the DOM's own, which stringifies
      // null into the literal word on the page. See dom.js.
      (this.crosscheckEl = h('div.crosscheck')),
      (this.clusterEl = h('div.crosscheck.cluster', { hidden: true })),
    );

    this.paintSliderLabel();
    this.paintFill();
  }

  paintFill() {
    const pct = this.maxN > 1 ? ((state.keepN - 1) / (this.maxN - 1)) * 100 : 0;
    this.slider.style.setProperty('--fill', `${pct}%`);
    for (const [i, node] of [...this.ticks.children].entries()) node.classList.toggle('on', i + 1 === state.keepN);
    // The stepper's own bounds. The slider gets these from min/max; buttons
    // have to be told, or you can tap past the end of the range.
    if (this.stepDown) this.stepDown.disabled = state.keepN <= 1;
    if (this.stepUp) this.stepUp.disabled = state.keepN >= this.maxN;
  }

  paintSliderLabel() {
    clear(this.sliderValue);
    this.sliderValue.append(
      'keep ',
      h('b', { text: `latest ${state.keepN}` }),
      state.keepN === 1 ? ' full version' : ' full versions',
      h('span.muted', { text: '  ·  per asset' }),
    );
  }

  onSlide(n, immediate) {
    if (n === state.keepN) return;
    update({ keepN: n }, 'keepN');
    this.slider.value = String(n);
    this.paintSliderLabel();
    this.paintFill();
    // Show a cached answer instantly if we already have one, otherwise dim the
    // current figure so it is never mistaken for the answer to the new N.
    const cached = this.cache.get(this.key(n));
    if (cached) this.paint(cached);
    else this.headlineEl.classList.add('stale');
    if (immediate) this.fetch();
    else this.fetchSoon();
  }

  /** Called when filters, snapshot or mode change. */
  refresh() {
    this.cache.clear();
    this.headlineEl.classList.add('stale');
    this.fetchSoon();
  }

  async fetch() {
    const n = state.keepN;
    const key = this.key(n);
    const cached = this.cache.get(key);
    if (cached) {
      this.paint(cached);
      return cached;
    }
    const seq = ++this.seq;
    try {
      const r = await api.reclaim(this.params(n));
      if (seq !== this.seq) return null;
      this.cache.set(key, r);
      this.paint(r);
      return r;
    } catch (err) {
      if (seq !== this.seq) return null;
      this.headlineEl.classList.remove('stale');
      clear(this.numEl);
      this.numEl.textContent = '—';
      // An empty index is the FIRST thing a new user sees, not an error. The
      // API's own wording names the route to POST to, which is right for an
      // API consumer and wrong for someone who has just double-clicked a file.
      // A cluster filter carried in a link, against a server whose catalog is
      // not configured or not readable. Drop it rather than leave every figure
      // blank; the cluster line then says why.
      if ((err.code === 'no_cluster' || err.code === 'cluster_unavailable') && state.filters.onCluster) {
        update({ filters: { onCluster: '' } }, 'filters');
        return null;
      }
      // A role the listing no longer has (the config changed): count them all.
      if (err.code === 'bad_cluster_role' && state.filters.clusterRoles) {
        update({ filters: { clusterRoles: '' } }, 'filters');
        return null;
      }
      if (err.code === 'no_snapshot') {
        this.leadEl.textContent = 'No index yet';
        this.subEl.textContent = 'Press Scan now, above, to walk the archive and build one.';
      } else {
        this.leadEl.textContent = 'Reclaim figure unavailable';
        this.subEl.textContent = err.message;
      }
      return null;
    }
  }

  /**
   * Rebuild the control and put the last known figures back on it. Used when
   * the layout crosses the breakpoint, where the keep-N control changes shape
   * between a slider and a stepper.
   */
  repaint() {
    this.render();
    if (this.last) this.paint(this.last);
  }

  paint(r) {
    this.last = r;
    // The manifest is "everything slated under these filters, minus vetoes",
    // so the count has to come from the policy, not from whichever page the
    // table happens to be showing.
    state.slated = {
      supersededCount: r.supersededCount ?? 0,
      supersededFiles: r.supersededFiles ?? null,
      reclaimBytes: r.reclaimBytes ?? null,
    };
    emit('selection');
    this.headlineEl.classList.remove('stale');
    const [num, unit] = bytesParts(r.reclaimBytes);
    clear(this.numEl);
    this.numEl.append(num, h('span.unit', { text: unit }));

    const n = r.keepN ?? state.keepN;
    clear(this.leadEl);
    this.leadEl.append(
      'reclaimable by keeping the latest ',
      h('b', { text: String(n) }),
      n === 1 ? ' full version' : ' full versions',
      ' of each asset',
    );

    clear(this.subEl);
    this.subEl.append(
      `${count(r.supersededCount)} versions slated for removal`,
      r.supersededFiles != null ? `  ·  ${count(r.supersededFiles)} files` : '',
      r.totalBytes ? `  ·  ${((r.reclaimBytes / r.totalBytes) * 100).toFixed(1)}% of what is in view` : '',
    );

    this.factMatched.set(
      tib(r.totalBytes),
      state.filters.status
        ? `across the current filters — the ${state.filters.status}-only filter is ignored here, or this figure would be circular`
        : 'across the current filters',
    );
    this.factMatched.flag(!!state.filters.status);
    this.factProtected.set(
      fmtBytes(r.protectedPatchBytes),
      r.protectedPatchVersions != null ? `${count(r.protectedPatchVersions)} live patches, never dropped` : 'live patches, never dropped',
    );
    this.factKept.set(tib(r.keptBytes ?? (r.totalBytes - r.reclaimBytes)), 'stays on the archive');
    this.factRegion0.set(
      r.region0Bytes != null ? fmtBytes(r.region0Bytes) : '—',
      'whole-canvas region0 files in view — what offline editing is cut against',
    );
    this.factWholeCanvas.set(
      r.region0Bytes != null && r.regionlessBytes != null ? fmtBytes(r.region0Bytes + r.regionlessBytes) : '—',
      r.regionlessBytes != null
        ? `region0 files plus ${fmtBytes(r.regionlessBytes)} of files with no region token — every whole-canvas file in view`
        : 'region0 files plus files with no region token',
    );
    this.paintCrosscheck(r);
    this.paintCluster(r);
  }

  /**
   * THE CLUSTER LINE: what the Media Index catalog last saw on the machines,
   * treated as one location, and the checkbox that scopes the board to it.
   *
   * Three states, as for the cross-check: not configured (no line at all --
   * nothing here then claims anything about the machines), configured and
   * unreadable (a warning, never an empty listing), and loaded. A listing is
   * a point in time, so the scan it is as of is always stated.
   */
  paintCluster(r) {
    const el = this.clusterEl;
    if (!el) return;
    clear(el);
    const c = r.cluster ?? null;
    if (!c) {
      el.hidden = true;
      this.factCluster.node.hidden = true;
      return;
    }
    el.hidden = false;

    if (!c.usable) {
      el.className = 'crosscheck cluster warn';
      this.factCluster.node.hidden = true;
      el.append(
        h('b', { text: 'Cluster listing unavailable.' }),
        ` The Media Index catalog could not be read, so what is on the machines is unknown: ${c.error}`,
        this.clusterReloadButton(),
      );
      if (this.clusterNote) el.append(h('span.cc-meta', { text: `  ·  ${this.clusterNote}` }));
      return;
    }

    el.className = 'crosscheck cluster ok';
    const bytesThere = r.clusterReclaimBytes ?? 0;
    this.factCluster.node.hidden = false;
    this.factCluster.set(
      fmtBytes(bytesThere),
      `${count(r.clusterReclaimCount ?? 0)} superseded version(s) in view still have files on the cluster — ` +
        'what a cleanup frees on the machines rather than on long-term storage',
    );

    const on = state.filters.onCluster === '1';
    const toggle = h(
      `label.inshow${on ? '.on' : ''}`,
      {
        title:
          'Hide everything the Media Index did not find on the cluster at its last scan. A version stays in ' +
          'view while any of its files is there; in Files, each file is judged on its own. Hides rows only.',
      },
      h('input', {
        type: 'checkbox',
        checked: on,
        onChange: (e) => update({ filters: { onCluster: e.target.checked ? '1' : '' } }, 'filters'),
      }),
      h('span', { text: `Only what is on the cluster (${(c.countedRoles ?? c.roles).join(', ')})` }),
    );

    // Actors and understudies are scanned as separate catalog locations, at
    // separate times, and a scan of one leaves the other's rows untouched. So
    // each age is stated against what it covers: one figure would either hide
    // a fresh actor scan behind an old understudy one, or the reverse.
    const ages = scanAges(c);
    el.append(toggle);
    if (c.roles.length > 1) el.append(this.clusterRoleChooser(c));
    el.append(
      h('b', { text: `Cluster: ${roleCounts(c.machines)}.` }),
      ` ${count(c.matchedFiles)} archive files, ${fmtBytes(c.matchedBytes)}, are on it`,
      h('span.cc-meta', {
        text:
          '  ·  Media Index scan: ' +
          (ages.length ? ages.map((a) => `${a.label} ${a.at ? ago(a.at) : 'never completed'}`).join(', ') : 'none'),
        title: ages
          .map((a) => `${a.label} (${a.location}): last complete scan ${a.at ?? 'never'}`)
          .join('\n'),
      }),
    );

    // Each is a reason the listing may say less than the machines hold.
    const notes = [];
    const counted = c.countedRoles ?? c.roles;
    const dated = ages.filter((a) => a.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (dated.length > 1) {
      const lag = Date.parse(dated.at(-1).at) - Date.parse(dated[0].at);
      const old = dated[0];
      if (lag >= STALE_SCAN_SPREAD_MS && old.roles.some((r) => counted.includes(r))) {
        notes.push(
          `${old.label} scanned ${spanOf(lag)} before the ${dated.at(-1).label}: their cells, and anything ` +
            `held only by them, are as of then — untick ${old.label} to count the ${dated.at(-1).label} alone`,
        );
      }
    }
    // A machine the last scan could not reach keeps its earlier file list
    // beside a fresh scan time. Said here, for the machines counted.
    const unread = c.machines.filter((m) => counted.includes(m.role) && m.read?.state === 'not-read');
    if (unread.length) {
      notes.push(
        `${unread.map((m) => `${m.key} (listed as of ${m.read.lastReadAt ? ago(m.read.lastReadAt) : 'an older scan'})`).join(', ')} ` +
          'not read by the last scan',
      );
    }
    const partly = c.machines.filter((m) => counted.includes(m.role) && m.read?.state === 'partly');
    if (partly.length) {
      notes.push(`${partly.map((m) => m.key).join(', ')} partly unread by the last scan; those folders are as of an older one`);
    }
    for (const s of c.scans) {
      if (s.newestStatus && s.newestStatus !== 'complete') {
        notes.push(`${s.location}: newest scan ${s.newestStatus}, figures are from the last complete one`);
      }
    }
    const empty = c.machines.filter((m) => counted.includes(m.role) && !m.disabled && m.files === 0).map((m) => m.key);
    if (empty.length) notes.push(`no files listed for ${empty.join(', ')} — not scanned, or empty`);
    const off = c.machines.filter((m) => m.disabled).map((m) => m.key);
    if (off.length) notes.push(`${off.join(', ')} disabled in the Media Index, not read`);
    if (c.sizeMismatchFiles) notes.push(`${count(c.sizeMismatchFiles)} archive file(s) on it only at another size, not counted`);
    if (c.strangerFiles) notes.push(`${count(c.strangerFiles)} file(s), ${fmtBytes(c.strangerBytes)}, on it that the archive has no name for`);
    if (c.error) notes.push(`last reload failed, older listing still in force: ${c.error}`);
    if (this.clusterNote) notes.push(this.clusterNote);
    for (const n of notes) el.append(h('span.cc-stale', { text: `  ·  ${n}` }));
    el.append(this.clusterReloadButton());
    if (r.clusterMachines) el.append(this.machineGrid(r.clusterMachines, r.keepN ?? state.keepN, c.scans));
  }

  /**
   * Which roles count as "on the cluster". Each role is scanned on its own,
   * so a fresh actor scan can be used alone while the understudies' is old.
   * Scopes ON CLUSTER and the filter; the grid still draws every machine.
   * At least one role stays ticked.
   */
  clusterRoleChooser(c) {
    const counted = c.countedRoles ?? c.roles;
    const set = (roles) => {
      const all = c.roles.every((r) => roles.includes(r));
      update({ filters: { clusterRoles: all ? '' : c.roles.filter((r) => roles.includes(r)).join(',') } }, 'filters');
    };
    return h(
      'span.cc-roles',
      {
        title:
          'Which machines count as the cluster, for ON CLUSTER and the filter. Each role is scanned on its own: ' +
          'untick one whose scan is old to use the others alone. Every machine stays in the grid below.',
      },
      'count: ',
      ...c.roles.map((role) => {
        const on = counted.includes(role);
        return h(
          'label.cc-role',
          h('input', {
            type: 'checkbox',
            checked: on,
            disabled: on && counted.length === 1,
            onChange: (e) => set(e.target.checked ? [...counted, role] : counted.filter((r) => r !== role)),
          }),
          h('span', { text: plural(role) }),
        );
      }),
    );
  }

  /**
   * Per machine: what removing the superseded versions in view frees on it,
   * against its drive as the Media Index measured it. Grouped by role, in key
   * order, so a machine is found where it was last time; fullness is carried
   * by colour.
   *
   * Machines are NOT additive and the copy says so: a file held by an actor
   * and its understudy frees space on both, and is counted once in ON CLUSTER.
   */
  machineGrid(rows, keepN, scans) {
    // Open on a desktop, where it is a few rows; shut on a phone, where 22
    // cards are a column longer than the screen sitting above the table.
    const open = this.machinesOpen ?? !isNarrow();
    const head = h(
      'button.cm-head',
      {
        type: 'button',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => {
          this.machinesOpen = !open;
          if (this.last) this.paintCluster(this.last);
        },
      },
      h('span.cm-caret', { text: open ? '▾' : '▸' }),
      h('b', { text: 'Per machine' }),
      h('span.cm-note', {
        text:
          `  what removing the superseded versions in view frees on each, at keep-${keepN}. ` +
          'Drive used is measured by the Media Index scan, as % of usable space after the 5% reserve. ' +
          'Not additive: a file on an actor and its understudy frees on both.',
      }),
    );
    if (!open) return h('div.cluster-machines', head);

    const byRole = new Map();
    for (const m of rows) {
      if (!byRole.has(m.role)) byRole.set(m.role, []);
      byRole.get(m.role).push(m);
    }
    const order = ['actor', 'understudy', 'director'];
    const roles = [...byRole.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const lastScan = new Map(scans.map((x) => [x.location, x.lastCompleteAt]));
    const scannedLine = (list) =>
      [...new Set(list.map((m) => m.location))]
        .map((loc) => {
          const at = lastScan.get(loc);
          return at ? `scanned ${ago(at)}` : 'never scanned';
        })
        .join(', ');
    const groups = roles.map((role) =>
      h(
        'div.cm-group',
        h(
          'div.cm-role',
          plural(role),
          h('span.cm-scanned', {
            text:
              `  ·  ${scannedLine(byRole.get(role))}` +
              (byRole.get(role).every((m) => m.counted === false) ? '  ·  not counted as the cluster' : ''),
          }),
        ),
        h(
          'div.cm-grid',
          ...byRole
            .get(role)
            .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
            .map((m) => machineCell(m, keepN)),
        ),
      ),
    );
    return h('div.cluster-machines', head, ...groups);
  }

  /**
   * Read the catalog again. Starts no rig scan: that is armed in the Media
   * Index and run there, by a person.
   */
  clusterReloadButton() {
    const btn = h('button.btn.sm', {
      type: 'button',
      text: this.clusterReloading ? 'Reloading…' : 'Reload cluster',
      title: 'Read the Media Index catalog again, to pick up a rig scan finished since. Does not start a scan.',
      style: { marginLeft: '10px' },
      disabled: !!this.clusterReloading,
      onClick: async () => {
        if (this.clusterReloading) return;
        this.clusterReloading = true;
        this.clusterNote = null;
        btn.disabled = true;
        btn.textContent = 'Reloading…';
        try {
          await api.reloadCluster();
        } catch (err) {
          this.clusterNote = err.message;
        } finally {
          this.clusterReloading = false;
          // Every list and figure depends on the listing; refresh them all.
          emit('filters');
        }
      },
    });
    return btn;
  }

  /**
   * "Only assets the show uses" -- the `inShow` filter, on the board rather
   * than in the panel because it changes what the headline is ABOUT. An asset
   * the show has dropped is already off the machines, so its superseded
   * renders free space on long-term storage and none on the rig.
   *
   * Drawn only while a usable capture is in force: the server refuses the
   * filter otherwise, and a box that cannot be ticked is a box that lies.
   * Like every programmed filter it hides rows and nothing else -- it never
   * changes a verdict or unprotects anything.
   */
  inShowToggle(p) {
    const on = state.filters.inShow === '1';
    const n = p.programmedAssets;
    return h(
      `label.inshow${on ? '.on' : ''}`,
      {
        title:
          'Hide every asset with no version on a setlist in the show file. Superseded renders of an asset ' +
          'the show still uses stay in view; an asset the show has dropped disappears entirely, old ' +
          'versions and all. Hides rows only — it never changes what is protected.',
      },
      h('input', {
        type: 'checkbox',
        checked: on,
        onChange: (e) => update({ filters: { inShow: e.target.checked ? '1' : '' } }, 'filters'),
      }),
      h('span', { text: 'Only assets the show uses' }),
      n != null ? h('span.cc-meta', { text: ` (${count(n)})` }) : null,
    );
  }

  /**
   * THE CROSS-CHECK STATUS LINE.
   *
   * It exists because the two states it distinguishes produce IDENTICAL
   * numbers everywhere else on this screen: an archive with no show-file
   * capture loaded and one whose capture happened to protect nothing read the
   * same in every figure above. Only this line tells them apart, so it is drawn
   * in both cases and never hidden. Same principle as `probeCoverage` on the
   * anomalies tab — an empty result on an unchecked archive is not a clean bill
   * of health.
   */
  paintCrosscheck(r) {
    const el = this.crosscheckEl;
    if (!el) return;
    clear(el);
    const p = r.programmed ?? null;

    // NOT APPLIED. The loud case, and the default state of a fresh install.
    if (!p) {
      el.className = 'crosscheck warn';
      this.factProgrammed.node.hidden = true;
      el.append(
        h('b', { text: 'Not cross-checked against the show file.' }),
        ' Nothing here has been checked against what the show actually plays — ',
        'an empty cross-check is not a clean bill of health. Put the d3 project ',
        '(.d3) or a Susan summary export into ',
        h('code', { text: 'programmed_media_crosscheck/' }),
        ' and press Reload captures in the filter panel.',
      );
      return;
    }

    // Loaded, but it resolved to nothing at all. Almost always a capture of a
    // different show, or of a project whose media never reached this archive.
    if (!p.usable) {
      el.className = 'crosscheck warn';
      this.factProgrammed.node.hidden = true;
      el.append(
        h('b', { text: 'The show-file capture matched nothing in this archive.' }),
        ` None of its ${count(p.totalNames)} media names resolved to an asset here, so it is `,
        'protecting nothing. Check it is a capture of this show, and of a project whose ',
        'media came from this delivery folder.',
      );
      append(el, [captureSources(p.captures)]);
      return;
    }

    // IN FORCE.
    el.className = 'crosscheck ok';
    el.append(this.inShowToggle(p));
    const inView = r.programmedBytes ?? 0;
    this.factProgrammed.node.hidden = inView <= 0;
    this.factProgrammed.set(
      fmtBytes(inView),
      `${count(r.programmedCount ?? 0)} version(s) in view that the show is cued to play, held ` +
        'back from removal whatever the keep-N policy says',
    );

    const newest = p.captures.map((c) => c.capturedAt).filter(Boolean).sort().at(-1) ?? null;
    el.append(
      h('b', { text: 'Cross-checked against the show file.' }),
      ` ${count(p.protectedVersions)} version(s) the show plays are held back from removal`,
      inView > 0
        ? ` — ${fmtBytes(inView)} of them in view at keep-${r.keepN ?? state.keepN}.`
        : `; none of them is inside the current view at keep-${r.keepN ?? state.keepN}.`,
      h('span.cc-meta', {
        text:
          `  ·  ${count(p.matchedNames)} of ${count(p.totalNames)} media names matched` +
          (p.unmatchedNames > 0 ? ` (${count(p.unmatchedNames)} did not)` : ''),
      }),
      h('span.cc-meta', { text: `  ·  ${captureAge(newest)}` }),
    );

    // A capture is a point in time and nothing here can detect re-programming,
    // so age is stated rather than left to be worked out from a timestamp.
    if (staleDays(newest) != null && staleDays(newest) > 30) {
      el.classList.add('aging');
      el.append(
        h('span.cc-stale', {
          text: '  ·  a capture is a point in time — take a fresh one if the show has moved on',
        }),
      );
    }
    append(el, [captureSources(p.captures)]);
  }
}

/**
 * Which project the cross-check was read from, and where the file sits. The
 * figures above say THAT the archive was checked; this says against WHAT, which
 * is the first thing to confirm before trusting them -- a capture of another
 * show, or an old save of this one, produces a perfectly well-formed banner.
 * One line per capture, since every file in the folder is unioned.
 */
function captureSources(captures) {
  const rows = (captures ?? []).map((c) => {
    const kind = c.kind === 'project' ? 'd3 project' : 'Susan summary';
    const name = c.project || c.sourceFile.replace(/\.[^.]*$/, '');
    return h(
      'div.cc-source',
      h('span.cc-meta', { text: `${kind} ` }),
      h('b.cc-project', { text: name }),
      h('span.cc-meta', { text: '  ·  ' }),
      h('code', { text: c.location ?? c.sourceFile, title: c.location ?? c.sourceFile }),
    );
  });
  return rows.length ? h('div.cc-sources', ...rows) : null;
}

/**
 * `display` overrides the text of the key line while `label` stays the plain
 * name used in the tooltip. It exists for one case: the keys are uppercased in
 * CSS, and a label ending in a plural `s` comes out as REGION 0S, where the S
 * reads as part of the figure. That one key is pre-cased here and opts out of
 * the transform in `.fact.region0 .k`.
 */
function fact(label, cls, display = label) {
  const v = h('div.v', { text: '—' });
  const k = h('div.k', { text: display });
  const node = h(`div.fact${cls ? `.${cls}` : ''}`, { title: label }, k, v);
  return {
    node,
    set(value, tooltip) {
      v.textContent = value;
      node.title = tooltip ? `${label} — ${tooltip}` : label;
    },
    /** Mark the figure as computed with one filter deliberately ignored. */
    flag(on) {
      k.textContent = on ? `${display} *` : display;
      node.classList.toggle('flagged', !!on);
    },
  };
}

const plural = (role) => (role.endsWith('y') ? `${role.slice(0, -1)}ies` : `${role}s`);

/** "14 actors, 8 understudies" */
function roleCounts(machines) {
  const n = new Map();
  for (const m of machines) n.set(m.role, (n.get(m.role) ?? 0) + 1);
  return [...n].map(([role, k]) => `${k} ${k === 1 ? role : plural(role)}`).join(', ');
}

/**
 * One machine: its regions, the drive meter, used now -> after, and what goes.
 * The meter is the Machines tab's own, fed the MEASURED drive; with no
 * reading there is no meter, and the cell says so rather than drawing an
 * empty drive.
 */
function machineCell(m, keepN) {
  const pct = (f) => `${(f * 100).toFixed(f >= 1 ? 0 : 1)}%`;
  const regions = m.regions.length ? `r${m.regions.join(', r')}` : 'no regions';
  const d = m.drive;
  const meter = d
    ? driveMeter({
        name: m.key,
        capacityBytes: d.capacityBytes,
        reserveBytes: d.reserveBytes,
        usableBytes: d.usableBytes,
        totalBytes: d.usedBytes,
        keptBytes: d.usedBytes - Math.min(m.freesBytes, d.usedBytes),
        supersededBytes: Math.min(m.freesBytes, d.usedBytes),
        freeBytes: d.usableBytes - d.usedBytes,
        usedFraction: d.usedFraction,
        driveState: d.driveState,
      })
    : h('span.muted', { text: 'no drive reading' });
  return h(
    `div.cm-cell.is-${d ? d.driveState : 'unknown'}${m.counted === false ? '.uncounted' : ''}`,
    {
      title:
        `${m.key} (${m.role}, ${regions}): ${fmtBytes(m.heldBytes)} listed on it. ` +
        (m.counted === false ? 'Its role is not counted as the cluster just now; its own figures still are. ' : '') +
        `Removing the ${count(m.freesVersions)} superseded version(s) in view at keep-${keepN} frees ` +
        `${fmtBytes(m.freesBytes)} in ${count(m.freesFiles)} file(s)` +
        (d ? `, taking it from ${pct(d.usedFraction)} to ${pct(d.afterFraction)} of usable space.` : '.') +
        (d?.measuredAt ? ` Drive measured ${d.measuredAt.slice(0, 16).replace('T', ' ')} UTC.` : ''),
    },
    h(
      'div.cm-top',
      h('b.cm-key', { text: m.key }),
      h('span.cm-reg', { text: regions }),
      d
        ? h(
            'span.cm-pct',
            h('span', { class: `meter-pct is-${d.driveState}`, text: pct(d.usedFraction) }),
            m.freesBytes > 0 ? ' → ' : '',
            m.freesBytes > 0 ? h('span', { class: `meter-pct is-${d.afterState}`, text: pct(d.afterFraction) }) : null,
          )
        : null,
    ),
    meter,
    h('div.cm-frees', m.freesBytes > 0 ? `frees ${fmtBytes(m.freesBytes)}` : 'nothing superseded here'),
    readLine(m.read),
  );
}

/**
 * Said only when the last scan of its location did not read all of it: the
 * listing is then older than the scan time on the group header.
 */
function readLine(read) {
  if (!read || read.state === 'read') return null;
  if (read.state === 'partly') {
    return h('div.cm-unread', {
      text: `${count(read.unreadable.length)} folder(s) unread by the last scan`,
      title: `Listed as an earlier scan saw them:\n${read.unreadable.slice(0, 20).join('\n')}`,
    });
  }
  return h('div.cm-unread', {
    text: `not read by the last scan — listed as of ${read.lastReadAt ? ago(read.lastReadAt) : 'an older scan'}`,
    title: read.lastReadAt ? `Last read by the scan finished ${read.lastReadAt}` : 'No recent complete scan read it',
  });
}

/** Scans further apart than this are called out on the board. */
const STALE_SCAN_SPREAD_MS = 60 * 60_000;

/**
 * One entry per catalog location the cluster is scanned in, labelled by the
 * roles seated there ("actors", "understudies"). Two locations seating the
 * same roles are told apart by their slug.
 */
function scanAges(c) {
  const rolesAt = new Map();
  for (const m of c.machines) {
    if (!m.location) continue;
    if (!rolesAt.has(m.location)) rolesAt.set(m.location, new Set());
    rolesAt.get(m.location).add(m.role);
  }
  const out = c.scans.map((s) => {
    const roles = [...(rolesAt.get(s.location) ?? [])].sort();
    return { location: s.location, at: s.lastCompleteAt, roles, label: roles.length ? roles.map(plural).join('/') : s.location };
  });
  const seen = new Map();
  for (const a of out) seen.set(a.label, (seen.get(a.label) ?? 0) + 1);
  for (const a of out) if (seen.get(a.label) > 1 && a.label !== a.location) a.label = `${a.label} (${a.location})`;
  return out;
}

/** "18 h", for a gap between two times. */
function spanOf(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** "3 h ago", for a scan time. */
function ago(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'at an unknown time';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Whole days since a capture was taken, or null if it carried no readable date.
 * A capture with no date is not treated as fresh -- see `captureAge`.
 */
function staleDays(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * How old the capture is, in the words an operator would use.
 *
 * A missing date says so rather than being silently omitted: "we do not know
 * when this was taken" is a materially different thing from "taken today", and
 * the whole risk this line exists to surface is a stale capture.
 */
function captureAge(iso) {
  const d = staleDays(iso);
  if (d == null) return 'capture date unknown';
  if (d <= 0) return 'captured today';
  if (d === 1) return 'captured yesterday';
  return `captured ${d} days ago`;
}

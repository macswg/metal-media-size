/**
 * Left filter panel. Every control maps to exactly one query param from
 * docs/api-contract.md, and every change is written into the URL so a filtered
 * view can be bookmarked or pasted to someone else.
 */

import { h, clear, debounce } from './dom.js';
import { state, update, resetFilters, activeFilterCount, selectionTotals, FILTER_KEYS } from './state.js';
import { parseSize, bytes as fmtBytes, parseDateInput, date as fmtDate } from './format.js';

export class FilterPanel {
  constructor(host) {
    this.host = host;
    this.options = { songFolders: [], families: [], extensions: [], byExtension: [], programmed: undefined };
    this.pushSoon = debounce((patch) => update({ filters: patch }), 260);
  }

  setOptions(options) {
    this.options = { ...this.options, ...options };
    this.render();
  }

  /**
   * The line under the Selection control. Says what is ticked, and says so in
   * the language of a decision the user made -- never "the tool marked these".
   */
  paintSelectionHint() {
    if (!this.selCountEl) return;
    const t = selectionTotals(state.slated);
    this.selCountEl.textContent =
      t.vetoed === 0
        ? `${t.count.toLocaleString()} slated for removal — all of them in the manifest.`
        : `${t.count.toLocaleString()} in the manifest · ${t.vetoed} you chose to keep.`;
  }

  /** The extension filter as a set, parsed from whatever the field holds. */
  chosenExts(raw = state.filters.ext) {
    return new Set(
      String(raw || '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  /**
   * Paint chip state from the filter value. The text field stays authoritative
   * -- typing `tif` by hand lights the tif chip -- so the two controls can
   * never disagree about what is filtered.
   */
  syncExtChips(raw) {
    if (!this.extChips) return;
    const chosen = this.chosenExts(raw);
    for (const [ext, el] of this.extChips) {
      el.classList.toggle('on', chosen.has(ext));
      el.setAttribute('aria-pressed', chosen.has(ext) ? 'true' : 'false');
    }
    if (this.extInput && raw === undefined) this.extInput.value = state.filters.ext ?? '';
    if (this.extClearChip) this.extClearChip.hidden = chosen.size === 0;
  }

  /** "26,651 files · 133.57 TiB" for an extension chip, when counts are known. */
  extTitle(ext) {
    const row = (this.options.byExtension || []).find((e) => e.ext === ext);
    if (!row) return `Filter to .${ext}`;
    return `${row.count.toLocaleString()} file${row.count === 1 ? '' : 's'} · ${fmtBytes(row.bytes)}`;
  }

  /**
   * The show-capture controls: programmed / not programmed, and setlists and
   * tracks to hide. They HIDE ROWS and nothing else -- what the show plays is
   * still protected whatever is hidden, and the copy must not suggest
   * otherwise.
   *
   * Three states, never collapsed into one (see CLAUDE.md, "Silence is not a
   * state"): still loading, no capture, and a capture that matched nothing.
   * Offering the controls in either of the last two would invite a filter the
   * server refuses.
   */
  programmedGroup() {
    const p = this.options.programmed;
    const f = state.filters;
    if (p === undefined) return group('Programmed in show', hint('Loading the show capture…'));
    if (p === null) {
      return group(
        'Programmed in show',
        hint('No show capture loaded. Drop a .d3 project or a Susan summary .json into programmed_media_crosscheck/, then reload.'),
        this.reloadControl(),
      );
    }
    if (!p.usable) {
      return group(
        'Programmed in show',
        hint('The loaded show capture matched nothing in this archive, so it cannot filter.'),
        this.reloadControl(),
      );
    }

    const source = p.captures
      .map((c) => `${c.sourceFile} · ${c.capturedAtSource === 'file-mtime' ? 'saved' : 'captured'} ${(c.capturedAt ?? '?').slice(0, 16).replace('T', ' ')}`)
      .join('\n');

    // Setlists: few enough for chips.
    const setlistChips = new Map();
    const paintSetlists = () => {
      const on = lineSet(state.filters.excludeSetlist);
      for (const [name, el] of setlistChips) {
        el.classList.toggle('on', on.has(name));
        el.setAttribute('aria-pressed', on.has(name) ? 'true' : 'false');
      }
    };
    for (const sl of p.setlists) {
      setlistChips.set(
        sl.setlist,
        h('button.chip', {
          type: 'button',
          text: sl.setlist,
          title: `${sl.tracks} track(s)${sl.transports.length ? ` · on ${sl.transports.join(', ')}` : ''}. Click to hide everything programmed on it.`,
          onClick: () => {
            this.set('excludeSetlist', toggleLine(state.filters.excludeSetlist, sl.setlist));
            paintSetlists();
          },
        }),
      );
    }
    paintSetlists();

    // Tracks: too many for chips, so a searchable checklist. Only tracks that
    // reach a version in this archive are offered -- hiding one that reaches
    // nothing would hide nothing.
    const tracks = p.tracks.filter((t) => t.versions > 0);
    const hidden = lineSet(f.excludeTrack);
    const rows = tracks.map((t) => {
      const cb = h('input', {
        type: 'checkbox',
        checked: hidden.has(t.track),
        onChange: () => {
          this.set('excludeTrack', toggleLine(state.filters.excludeTrack, t.track));
          paintTrackCount();
        },
      });
      const row = h(
        'label.track-row',
        { title: t.setlists.length ? `On ${t.setlists.join(', ')}` : 'Setlist unknown' },
        cb,
        h('span.track-name', { text: t.track }),
        h('span.track-n', { text: String(t.versions) }),
      );
      row.dataset.name = t.track.toLowerCase();
      return row;
    });
    const trackCount = h('span.fhint');
    const paintTrackCount = () => {
      const n = lineSet(state.filters.excludeTrack).size;
      trackCount.textContent = n ? `${n} track(s) hidden` : `${tracks.length} tracks reach this archive · number = versions`;
    };
    paintTrackCount();
    const search = h('input', {
      type: 'text',
      placeholder: 'find a track…',
      spellcheck: 'false',
      onInput: (e) => {
        const q = e.target.value.trim().toLowerCase();
        for (const r of rows) r.hidden = q !== '' && !r.dataset.name.includes(q);
      },
    });

    return group(
      'Programmed in show',
      seg(
        [
          ['', 'All'],
          ['1', 'Programmed'],
          ['0', 'Not programmed'],
        ],
        f.programmed,
        (v) => this.set('programmed', v),
      ),
      h('div.fhint', { style: { whiteSpace: 'pre-line' }, text: source }),
      hint(`${p.protectedVersions.toLocaleString()} version(s) programmed. Hiding rows never unprotects them.`),
      this.reloadControl(),
      h('div', { style: { height: '8px' } }),
      h('span.flabel', 'Hide setlists'),
      p.setlists.length
        ? h('div.chips', ...setlistChips.values())
        : hint('This capture lists no setlists.'),
      h('span.flabel', 'Hide tracks'),
      search,
      h('div.track-list', ...rows),
      trackCount,
    );
  }

  /**
   * Reload captures: re-read programmed_media_crosscheck/ so an added or
   * removed .d3 / .json takes effect without restarting the server.
   *
   * The outcome line is held on the panel, not the button, because a
   * successful reload re-renders this whole panel from the new summary -- a
   * message drawn on the old button would vanish with it. A refusal is shown
   * in full: it is the server saying the old captures are STILL in force,
   * which is the one thing the operator must not miss.
   */
  reloadControl() {
    const note = h('div.fhint', { style: { whiteSpace: 'pre-line' } });
    // Always paint the CURRENT line and button: a successful reload has
    // re-rendered the panel by the time the click handler resumes, and the
    // ones this closure made are detached.
    this.reloadNoteEl = note;
    const paintNote = () => {
      const el = this.reloadNoteEl;
      const n = this.reloadNote;
      el.textContent = n ? n.text : '';
      el.classList.toggle('bad', Boolean(n?.bad));
      el.hidden = !n;
    };
    paintNote();
    const btn = h('button.btn.sm', {
      type: 'button',
      text: 'Reload captures',
      title: 'Re-read programmed_media_crosscheck/ — pick up a .d3 or .json added or removed since the server started',
      style: { width: '100%', marginTop: '8px' },
      disabled: this.reloading || !this.onReloadCaptures,
      onClick: async () => {
        if (!this.onReloadCaptures || this.reloading) return;
        this.reloading = true;
        btn.disabled = true;
        btn.textContent = 'Reloading…';
        // A panel re-rendered mid-reload must not offer the button again.
        this.reloadNote = null;
        paintNote();
        try {
          const res = await this.onReloadCaptures();
          const caps = res?.captures ?? [];
          const warnings = caps.reduce((n, c) => n + (c.warnings?.length ?? 0), 0);
          this.reloadNote = {
            text:
              (caps.length === 0
                ? 'Reloaded: the folder holds no capture, so the cross-check is now NOT in use.'
                : `Reloaded ${caps.length} capture(s): ${caps.map((c) => c.sourceFile).join(', ')}.`) +
              (warnings ? `\n${warnings} reference(s) could not be resolved — see the server window.` : ''),
            bad: caps.length === 0 || warnings > 0,
          };
        } catch (err) {
          this.reloadNote = { text: err?.message || String(err), bad: true };
        } finally {
          this.reloading = false;
          this.reloadBtn.disabled = false;
          this.reloadBtn.textContent = 'Reload captures';
          paintNote();
        }
      },
    });
    this.reloadBtn = btn;
    return h('div', btn, note);
  }

  /** Show the clear button only when there is something to clear. */
  paintQClear(value) {
    if (this.qClear) this.qClear.hidden = !value;
  }

  clearQ() {
    if (this.qInput) this.qInput.value = '';
    this.paintQClear('');
    this.set('q', '');
    // Focus stays in the field: clearing is usually the start of typing
    // something else, not the end of searching.
    this.qInput?.focus();
  }

  set(key, value) {
    this.pushSoon.cancel();
    update({ filters: { [key]: value } });
  }

  setDebounced(key, value) {
    this.pushSoon({ [key]: value });
  }

  /** Re-render only the pieces that reflect external state changes. */
  syncCount() {
    if (this.countEl) {
      const n = activeFilterCount();
      this.countEl.textContent = n ? String(n) : '';
      this.countEl.hidden = n === 0;
      this.clearBtn.disabled = n === 0;
    }
  }

  render() {
    const f = state.filters;
    clear(this.host);

    this.countEl = h('span.filter-count', { hidden: true });
    this.clearBtn = h('button.btn.sm.ghost', {
      text: 'Clear',
      onClick: () => {
        // Clears the VIEW, including the selection filter. It does not clear
        // the selection itself -- losing ticks to a button labelled "Clear
        // filters" would be a nasty surprise.
        state.manifestView = null;
        resetFilters();
        this.render();
      },
    });
    this.host.appendChild(h('div.filter-head', h('h2', 'Filters'), h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, this.countEl, this.clearBtn)));

    /* ---- free text ------------------------------------------------- */
    // The clear button is inside the field rather than beside it: a search you
    // have to select-all-and-delete to undo is a search people leave on by
    // accident and then wonder why the table is empty. Escape does it too.
    this.qInput = h('input', {
      type: 'text',
      value: f.q,
      placeholder: 'name or path contains…',
      spellcheck: 'false',
      onInput: (e) => {
        this.paintQClear(e.target.value);
        this.setDebounced('q', e.target.value.trim());
      },
      onKeyDown: (e) => {
        if (e.key === 'Escape' && e.target.value) {
          e.stopPropagation();
          this.clearQ();
        }
      },
    });
    this.qClear = h('button.field-x', {
      type: 'button',
      text: '✕',
      title: 'Clear the search (Esc)',
      'aria-label': 'Clear the search',
      hidden: !f.q,
      onClick: () => this.clearQ(),
    });
    this.host.appendChild(
      group(
        'Search',
        h('div.field-wrap', this.qInput, this.qClear),
        hint('q= — plain substring, case-insensitive'),
      ),
    );

    /* ---- song folder ------------------------------------------------ */
    this.host.appendChild(
      group(
        'Song folder',
        selectEl(
          [['', `All ${this.options.songFolders.length || ''} folders`.trim()], ...this.options.songFolders.map((s) => [s, s])],
          f.songFolder,
          (v) => this.set('songFolder', v),
        ),
      ),
    );

    /* ---- status ----------------------------------------------------- */
    this.host.appendChild(
      group(
        'Status at current keep-N',
        seg(
          [
            ['', 'All'],
            ['kept', 'Keep'],
            ['superseded', 'Slated for removal'],
          ],
          f.status,
          (v) => this.set('status', v),
          f.status === 'kept' ? 'kept' : f.status === 'superseded' ? 'superseded' : '',
        ),
        hint('status= — recomputed whenever the keep-latest-N slider moves'),
      ),
    );

    /* ---- programmed in the show ---------------------------------------- */
    this.host.appendChild(this.programmedGroup());

    /* ---- manifest view ------------------------------------------------ */
    // Separate from "Status at current keep-N" on purpose. That control is the
    // policy's verdict about the archive; this is a view of the manifest and
    // of the overrides you have made to it.
    this.selCountEl = h('span.fhint', { style: { marginTop: '4px' } });
    this.host.appendChild(
      group(
        'Manifest',
        seg(
          [
            ['', 'All rows'],
            ['manifest', 'In the manifest'],
            ['overrides', 'My overrides'],
          ],
          state.manifestView ?? '',
          (v) => {
            state.manifestView = v || null;
            this.paintSelectionHint();
            update({}, 'filters');
          },
        ),
        this.selCountEl,
      ),
    );
    this.paintSelectionHint();

    /* ---- patch / proxy+region0 --------------------------------------- */
    this.host.appendChild(
      group(
        'Render type',
        seg(
          [
            ['', 'All'],
            ['1', 'Patch only'],
            ['0', 'Full only'],
          ],
          f.isPatch,
          (v) => this.set('isPatch', v),
        ),
        h('div', { style: { height: '8px' } }),
        h('span.flabel', 'Proxy/region0'),
        seg(
          [
            ['', 'All'],
            ['1', 'Has proxy/region0'],
            ['0', 'No proxy/region0'],
            ['only', 'Has Region 0 only'],
          ],
          f.hasProxy,
          (v) => this.set('hasProxy', v),
          'wrap',
        ),
        hint(
          'Region 0 is the whole canvas, kept for offline editing. Has Region 0 only = a version with nothing behind it — no slices, so not a playable delivery.',
        ),
      ),
    );

    /* ---- family ------------------------------------------------------ */
    this.host.appendChild(
      group(
        'Family',
        selectEl([['', 'All families'], ...this.options.families.map((s) => [s, s])], f.family, (v) => this.set('family', v)),
        hint('Display label only — never a removal recommendation.'),
      ),
    );

    /* ---- extension --------------------------------------------------- */
    // /api/summary now reports which extensions actually exist, so this is a
    // picker of real values rather than a free-text box where a typo silently
    // matches nothing. The text input stays underneath for anything the list
    // does not cover -- a filter on a snapshot other than the current one, or
    // an extension that appears after the last scan.
    const known = this.options.extensions;
    const applyExt = (next) => {
      this.set('ext', [...next].join(','));
      // render() runs once at boot -- a full re-render on every change would
      // steal focus from whichever input the user is typing in -- so the chips
      // repaint themselves rather than waiting to be rebuilt.
      this.syncExtChips();
    };

    this.extChips = new Map();
    this.extInput = h('input', {
      type: 'text',
      value: f.ext,
      placeholder: known.join(',') || 'mov,tif',
      spellcheck: 'false',
      onInput: (e) => {
        this.setDebounced('ext', e.target.value.replace(/\s/g, '').toLowerCase());
        this.syncExtChips(e.target.value);
      },
    });

    const extChildren = ['Extension'];
    if (known.length) {
      for (const ext of known) {
        this.extChips.set(
          ext,
          h('button.chip', {
            type: 'button',
            text: ext,
            title: this.extTitle(ext),
            onClick: () => {
              const next = this.chosenExts();
              if (next.has(ext)) next.delete(ext);
              else next.add(ext);
              applyExt(next);
            },
          }),
        );
      }
      this.extClearChip = h('button.chip.clear', {
        type: 'button',
        text: 'all',
        title: 'Clear the extension filter',
        onClick: () => applyExt(new Set()),
      });
      extChildren.push(h('div.chips', ...this.extChips.values(), this.extClearChip));
    }
    extChildren.push(this.extInput, hint('ext= — comma-separated, no dots'));
    this.host.appendChild(group(...extChildren));
    this.syncExtChips();

    /* ---- size range --------------------------------------------------- */
    const sizeHint = hint('minSize= / maxSize= — accepts 500GB, 1.5TiB, 200MB');
    const onSize = (key, raw) => {
      const v = raw.trim();
      if (v === '') {
        sizeHint.classList.remove('bad');
        sizeHint.textContent = 'minSize= / maxSize= — accepts 500GB, 1.5TiB, 200MB';
        this.setDebounced(key, '');
        return;
      }
      const n = parseSize(v);
      if (n == null) {
        sizeHint.classList.add('bad');
        sizeHint.textContent = `Could not read "${v}" as a size`;
        return;
      }
      sizeHint.classList.remove('bad');
      sizeHint.textContent = `${key === 'minSize' ? '≥' : '≤'} ${fmtBytes(n)}`;
      this.setDebounced(key, String(n));
    };
    this.host.appendChild(
      group(
        'Size range',
        h(
          'div.frow',
          h('input', { type: 'text', value: f.minSize ? fmtBytes(Number(f.minSize)) : '', placeholder: 'min', spellcheck: 'false', onInput: (e) => onSize('minSize', e.target.value) }),
          h('input', { type: 'text', value: f.maxSize ? fmtBytes(Number(f.maxSize)) : '', placeholder: 'max', spellcheck: 'false', onInput: (e) => onSize('maxSize', e.target.value) }),
        ),
        sizeHint,
      ),
    );

    /* ---- date range ---------------------------------------------------- */
    this.host.appendChild(
      group(
        'Modified between',
        h(
          'div.frow',
          h('input', {
            type: 'date',
            value: f.mtimeFrom ? fmtDate(Number(f.mtimeFrom)) : '',
            onChange: (e) => this.set('mtimeFrom', e.target.value ? String(parseDateInput(e.target.value, false)) : ''),
          }),
          h('input', {
            type: 'date',
            value: f.mtimeTo ? fmtDate(Number(f.mtimeTo)) : '',
            onChange: (e) => this.set('mtimeTo', e.target.value ? String(parseDateInput(e.target.value, true)) : ''),
          }),
        ),
        hint('mtimeFrom= / mtimeTo= — epoch ms, inclusive'),
      ),
    );

    /* ---- path glob ------------------------------------------------------ */
    this.host.appendChild(
      group(
        'Path glob',
        h('input', {
          type: 'text',
          value: f.path,
          placeholder: '270_LANTERN/*_region3.mov',
          spellcheck: 'false',
          class: 'mono',
          onInput: (e) => this.setDebounced('path', e.target.value.trim()),
        }),
        hint('path= — * within a segment, ** across segments, ? one character'),
      ),
    );

    /* ---- path regex ------------------------------------------------------ */
    const reHint = hint('pathRe= — applied in JS over a bounded candidate set');
    this.host.appendChild(
      group(
        'Path regex',
        h('input', {
          type: 'text',
          value: f.pathRe,
          placeholder: '_v0*1[0-9]_region\\d+',
          spellcheck: 'false',
          class: 'mono',
          onInput: (e) => {
            const v = e.target.value.trim();
            if (v) {
              try {
                new RegExp(v);
              } catch (err) {
                reHint.classList.add('bad');
                reHint.textContent = String(err.message);
                return;
              }
            }
            reHint.classList.remove('bad');
            reHint.textContent = 'pathRe= — applied in JS over a bounded candidate set';
            this.setDebounced('pathRe', v);
          },
        }),
        reHint,
      ),
    );

    this.host.appendChild(
      h(
        'div.fgroup',
        h('span.flabel', 'Shareable view'),
        h('button.btn.sm', {
          text: 'Copy link to this view',
          style: { width: '100%' },
          onClick: async (e) => {
            try {
              await navigator.clipboard.writeText(location.href);
              e.target.textContent = 'Link copied';
              setTimeout(() => (e.target.textContent = 'Copy link to this view'), 1600);
            } catch {
              e.target.textContent = location.href;
            }
          },
        }),
        hint(`${FILTER_KEYS.length} filter params are mirrored in the URL`),
      ),
    );

    this.syncCount();
  }
}

/** Filter values for track and setlist lists are newline-separated: a track
 *  name is a file stem and may carry a comma. */
function lineSet(raw) {
  return new Set(String(raw || '').split('\n').filter(Boolean));
}

function toggleLine(raw, name) {
  const s = lineSet(raw);
  if (s.has(name)) s.delete(name);
  else s.add(name);
  return [...s].join('\n');
}

function group(label, ...children) {
  return h('div.fgroup', h('span.flabel', label), ...children);
}

function hint(text) {
  return h('div.fhint', { text });
}

function selectEl(options, value, onChange) {
  const el = h(
    'select',
    { onChange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, label)),
  );
  el.value = value ?? '';
  return el;
}

/**
 * A one-of-N segmented control.
 *
 * The control repaints ITSELF on click. It has to: render() runs once at boot
 * -- a full rebuild on every change would steal focus from whichever input is
 * being typed into -- so a button that only got its `.on` class at
 * construction would stay lit on `All` forever while the data underneath it
 * changed. That is exactly what happened to the status, render-type and proxy
 * filters: they worked, but they looked like they had not been touched.
 */
function seg(options, value, onChange, tone = '') {
  const buttons = [];
  const paint = (v) => {
    const want = String(v ?? '');
    for (const [btn, bv] of buttons) {
      const on = String(bv ?? '') === want;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
  const el = h(
    `div.seg${tone ? `.${tone}` : ''}`,
    options.map(([v, label]) => {
      const btn = h('button', {
        type: 'button',
        text: label,
        onClick: () => {
          paint(v);
          onChange(v);
        },
      });
      buttons.push([btn, v]);
      return btn;
    }),
  );
  paint(value);
  return el;
}

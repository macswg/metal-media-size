/**
 * Left filter panel. Every control maps to exactly one query param from
 * docs/api-contract.md, and every change is written into the URL so a filtered
 * view can be bookmarked or pasted to someone else.
 */

import { h, clear, debounce } from './dom.js';
import { state, update, resetFilters, activeFilterCount, FILTER_KEYS } from './state.js';
import { parseSize, bytes as fmtBytes, parseDateInput, date as fmtDate } from './format.js';

export class FilterPanel {
  constructor(host) {
    this.host = host;
    this.options = { songFolders: [], families: [], extensions: [], byExtension: [] };
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
    const sel = state.selection;
    if (sel.allMatched) {
      const minus = sel.except.size
        ? ` — minus ${sel.except.size} you un-ticked`
        : '';
      this.selCountEl.textContent = `Everything matching the filters above is marked${minus}.`;
      return;
    }
    const n = sel.ids.size;
    this.selCountEl.textContent =
      n === 0
        ? 'Nothing marked yet — tick rows in the table to build a manifest.'
        : `${n.toLocaleString()} version${n === 1 ? '' : 's'} marked for the export manifest.`;
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
        state.showSelectedOnly = false;
        resetFilters();
        this.render();
      },
    });
    this.host.appendChild(h('div.filter-head', h('h2', 'Filters'), h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, this.countEl, this.clearBtn)));

    /* ---- free text ------------------------------------------------- */
    this.host.appendChild(
      group(
        'Search',
        h('input', {
          type: 'text',
          value: f.q,
          placeholder: 'name or path contains…',
          spellcheck: 'false',
          onInput: (e) => this.setDebounced('q', e.target.value.trim()),
        }),
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

    /* ---- selection ---------------------------------------------------- */
    // Kept separate from "Status at current keep-N" on purpose. Superseded is
    // the tool's verdict about the archive; this is YOUR decision about what
    // goes in the manifest. Merging them into one control would suggest the
    // tool had marked something for removal, which it never does.
    this.selCountEl = h('span.fhint', { style: { marginTop: '4px' } });
    this.host.appendChild(
      group(
        'Manually marked for export',
        seg(
          [
            ['', 'All'],
            ['marked', 'Manually marked'],
          ],
          state.showSelectedOnly ? 'marked' : '',
          (v) => {
            state.showSelectedOnly = v === 'marked';
            this.paintSelectionHint();
            update({}, 'filters');
          },
        ),
        this.selCountEl,
      ),
    );
    this.paintSelectionHint();

    /* ---- patch / proxy ---------------------------------------------- */
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
        h('span.flabel', 'Proxy'),
        seg(
          [
            ['', 'All'],
            ['1', 'Has proxy'],
            ['0', 'No proxy'],
          ],
          f.hasProxy,
          (v) => this.set('hasProxy', v),
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

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

import { h, clear, debounce } from './dom.js';
import { state, update, emit, filterParams } from './state.js';
import { api } from './api.js';
import { bytesParts, tib, count, bytes as fmtBytes } from './format.js';
import { isNarrow } from './viewport.js';

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
    this.factMatched = fact('In view', '');

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
        this.factRegion0.node,
      ),
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
  }
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

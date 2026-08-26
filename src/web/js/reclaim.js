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
import { state, update, filterParams } from './state.js';
import { api } from './api.js';
import { bytesParts, tib, count, bytes as fmtBytes } from './format.js';

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
    this.factMatched = fact('In view', '');

    this.host.append(
      this.headlineEl,
      h(
        'div.slider-block',
        h('div.slider-head', h('span.label', 'Keep latest N versions of each asset'), this.sliderValue),
        this.slider,
        this.ticks,
      ),
      h('div.reclaim-facts', this.factMatched.node, this.factProtected.node, this.factKept.node),
    );

    this.paintSliderLabel();
    this.paintFill();
  }

  paintFill() {
    const pct = this.maxN > 1 ? ((state.keepN - 1) / (this.maxN - 1)) * 100 : 0;
    this.slider.style.setProperty('--fill', `${pct}%`);
    for (const [i, node] of [...this.ticks.children].entries()) node.classList.toggle('on', i + 1 === state.keepN);
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

  paint(r) {
    this.last = r;
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
  }
}

function fact(label, cls) {
  const v = h('div.v', { text: '—' });
  const k = h('div.k', { text: label });
  const node = h(`div.fact${cls ? `.${cls}` : ''}`, { title: label }, k, v);
  return {
    node,
    set(value, tooltip) {
      v.textContent = value;
      node.title = tooltip ? `${label} — ${tooltip}` : label;
    },
    /** Mark the figure as computed with one filter deliberately ignored. */
    flag(on) {
      k.textContent = on ? `${label} *` : label;
      node.classList.toggle('flagged', !!on);
    },
  };
}

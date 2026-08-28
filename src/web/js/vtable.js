/**
 * ============================================================================
 *  VIRTUALIZED TABLE
 * ============================================================================
 *
 * Renders only the rows inside the viewport (plus a small overscan) against a
 * spacer sized to the full result set, so 27k rows cost the same in DOM nodes
 * as 30 do. Row elements are recycled from a pool keyed by row index.
 *
 * Data is pulled from the API in pages (the contract caps a page at 2000), so
 * the table holds a sparse page cache and paints skeleton rows for windows it
 * has not fetched yet. Jumping the scrollbar to the far end fetches exactly one
 * page, never the whole table.
 *
 * TWO SCROLL CONTAINERS, ONE VIRTUALIZER. On desktop the table owns a scroller
 * of its own inside a fixed shell. On a phone the whole document scrolls, so
 * the chrome above can be pushed off-screen and the list gets the glass -- and
 * there the scroller is `overflow: visible` and the PAGE is what moves. The
 * Which one is in force comes from `viewport.js`, the one place the breakpoint
 * is written down for both the stylesheet and the JS. Reading it back off the
 * scroller's computed overflow was tried first and is a trap: at construction
 * the answer came back `auto` and the table then ignored the page scroll
 * entirely. Everything else -- the pool, the page cache, the spacer -- is
 * identical either way.
 * ============================================================================
 */

import { h, clear } from './dom.js';
import { isNarrow, onBreakpointChange } from './viewport.js';

const PAGE_SIZE = 500;
const OVERSCAN = 12;

/** Narrowest a column may be dragged. Below this a header reads as a smudge. */
const MIN_COL_PX = 36;
/** Where per-layout column widths live between visits. */
const WIDTH_STORE = 'aa.colWidths';

export class VirtualTable {
  /**
   * @param {HTMLElement} host
   * @param {object} opts
   */
  constructor(host, opts) {
    this.host = host;
    this.opts = opts;
    this.rowHeight = opts.rowHeight || 30;
    this.total = 0;
    this.matchedBytes = null;
    this.pages = new Map();
    this.inflight = new Map();
    this.generation = 0;
    this.pool = new Map();
    /** Column key -> pixel width the user dragged it to. */
    this.widths = new Map();
    this.loadWidths();
    this.build();
  }

  build() {
    clear(this.host);
    this.headEl = h('div.vt-head');
    this.canvas = h('div.vt-canvas');
    this.scroller = h('div.vt-scroller', this.canvas);
    this.emptyEl = h('div.vt-empty', { hidden: true });
    this.host.append(this.headEl, this.scroller, this.emptyEl);
    // Scroll handling is coalesced into an animation frame, and the viewport
    // height is cached, so a scroll never forces a synchronous layout.
    this.scroller.addEventListener(
      'scroll',
      () => {
        // Read the offset here, inside the scroll event, where layout is
        // already clean. paint() then only writes, so a steady scroll never
        // forces a synchronous layout at all.
        this.scrollTopHint = this.scroller.scrollTop;
        // Sideways: applied now, not in the frame below. A header that catches
        // up a frame later reads as the column labels sliding loose.
        this.syncHeadScroll();
        if (this.rafPending) return;
        this.rafPending = true;
        requestAnimationFrame(() => {
          this.rafPending = false;
          this.paint();
        });
      },
      { passive: true },
    );
    // In page-scroll mode the scroller above never fires: it does not scroll.
    // The document does, and the paint reads the canvas position instead of a
    // scrollTop, so there is no offset to capture here.
    this._onPageScroll = () => {
      if (!this.pageScrolled) return;
      if (this.rafPending) return;
      this.rafPending = true;
      requestAnimationFrame(() => {
        this.rafPending = false;
        this.paint();
      });
    };
    window.addEventListener('scroll', this._onPageScroll, { passive: true });

    if (!VirtualTable._resizeHooked) VirtualTable._resizeHooked = true;
    this._onResize = () => {
      this.viewH = 0;
      this.syncGutter();
      // A resize is also how the layout crosses the breakpoint, which is the
      // one thing that changes which container scrolls.
      this.syncScrollMode();
      this.paint();
    };
    window.addEventListener('resize', this._onResize);
    // Crossing the breakpoint swaps the scroll container under us. Resize
    // usually catches it, but the media query is the precise signal.
    this._unwatchBreakpoint = onBreakpointChange(() => {
      this.viewH = 0;
      this.syncScrollMode();
      this.paint();
    });
    this.syncScrollMode();
    this.renderHead();
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('scroll', this._onPageScroll);
    this._unwatchBreakpoint?.();
  }

  /**
   * Which container scrolls. The narrow layout hands the job to the page (see
   * THE PAGE SCROLLS in app.css) and this must agree with it -- which is what
   * `viewport.js` is for: one breakpoint, quoted by the stylesheet and by the
   * JS that has to know the same thing.
   */
  syncScrollMode() {
    this.pageScrolled = isNarrow();
  }

  setColumns(columns) {
    this.opts.columns = columns;
    this.pool.clear();
    clear(this.canvas);
    // Widths are remembered per layout (Files and Asset-versions are different
    // tables), so switching mode picks up that mode's own widths.
    this.loadWidths();
    this.renderHead();
  }

  // -------------------------------------------------------------------------
  // Column widths
  //
  // A column keeps the width declared in tableview.js until the user drags it;
  // from then on that one column is pinned in pixels and the flexible columns
  // around it absorb the difference, which is why a drag neither overflows the
  // pane nor disturbs anything to its left. Double-clicking a grip gives the
  // declared width back.
  // -------------------------------------------------------------------------

  storageKey() {
    return `${WIDTH_STORE}.${this.opts.layoutKey?.() ?? 'default'}`;
  }

  loadWidths() {
    this.widths = new Map();
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (!raw) return;
      for (const [key, px] of Object.entries(JSON.parse(raw))) {
        if (Number.isFinite(px) && px >= MIN_COL_PX) this.widths.set(key, px);
      }
    } catch {
      // A corrupt or unavailable store is not worth failing a table over.
    }
  }

  saveWidths() {
    try {
      if (this.widths.size === 0) localStorage.removeItem(this.storageKey());
      else localStorage.setItem(this.storageKey(), JSON.stringify(Object.fromEntries(this.widths)));
    } catch {
      // Private mode, quota, no storage: the drag still worked for this visit.
    }
  }

  gridTemplate() {
    return this.opts.columns
      .map((c) => (this.trackOf(c)))
      .join(' ');
  }

  /** The grid track for one column: a dragged pixel width wins over the declared one. */
  trackOf(col) {
    const px = this.widths.get(col.key);
    return px ? `${px}px` : col.width || '1fr';
  }

  /**
   * The narrowest the row can be drawn without a column going below what it
   * was declared to need. Columns flex down to this as the window narrows;
   * past it the table scrolls sideways rather than swallowing the columns on
   * its right-hand end.
   *
   * It has to be computed rather than measured. The canvas takes `contain:
   * strict`, which clips as well as isolates, so a row left to overflow it is
   * not merely hidden but absent from the scrollable area -- the scroller
   * would have nothing to scroll to. So the minimum is read off the track
   * list: `120px` and `minmax(120px, 2fr)` both floor at 120, a bare `1fr`
   * floors at 0, and a dragged column floors at the width it was dragged to.
   */
  contentMinWidth() {
    let total = 0;
    for (const col of this.opts.columns) {
      const track = this.trackOf(col);
      const m = /^minmax\(\s*([\d.]+)px/.exec(track) || /^([\d.]+)px$/.exec(track);
      total += m ? Number.parseFloat(m[1]) : 0;
    }
    return Math.ceil(total);
  }

  /** Push the current template into the head and every live row. */
  applyTemplate() {
    const tpl = this.gridTemplate();
    this.headEl.style.gridTemplateColumns = tpl;
    for (const el of this.pool.values()) el.style.gridTemplateColumns = tpl;
    // Rows are absolutely positioned against the canvas, so the canvas is what
    // decides how wide a row may be, and therefore what the scroller has to
    // scroll across.
    this.canvas.style.minWidth = `${this.contentMinWidth()}px`;
    this.syncGutter();
    this.syncHeadScroll();
  }

  /**
   * Keep the header aligned with a body that has been scrolled sideways.
   * Cheap enough to call from the scroll handler: a write of a property that
   * is already correct is a no-op, and the read is off the scroller, which the
   * handler has just touched anyway.
   */
  syncHeadScroll() {
    const sl = this.scroller.scrollLeft;
    if (this.headEl.scrollLeft !== sl) this.headEl.scrollLeft = sl;
  }

  /**
   * Reserve the body's vertical scrollbar on the header.
   *
   * The head is a sibling of the scroller, so it is 11px wider than the box
   * the rows resolve their columns in -- and every flexible column took a
   * share of those 11px, which is why a header cell used to sit up to 11px to
   * the right of the column it names. Reading the gutter off the scroller
   * covers the cases where there is none: the phone, where the page scrolls,
   * and a table short enough not to need one.
   */
  syncGutter() {
    const gutter = Math.max(0, this.scroller.offsetWidth - this.scroller.clientWidth);
    const px = `${gutter}px`;
    if (this.headEl.style.paddingRight !== px) this.headEl.style.paddingRight = px;
  }

  setColumnWidth(key, px) {
    this.widths.set(key, Math.round(px));
    this.applyTemplate();
  }

  resetColumnWidth(key) {
    if (!this.widths.delete(key)) return;
    this.applyTemplate();
    this.saveWidths();
  }

  /**
   * Drag one column edge. The pointer is captured, so the drag survives the
   * cursor leaving the 6px grip -- without that, a fast drag stops dead.
   */
  beginResize(event, col, cell) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startW = cell.getBoundingClientRect().width;
    // Never let a column be dragged wider than the pane it lives in.
    const maxW = Math.max(MIN_COL_PX, this.headEl.getBoundingClientRect().width - MIN_COL_PX);
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    grip.classList.add('dragging');
    this.host.classList.add('is-resizing');

    const move = (e) => {
      this.setColumnWidth(col.key, Math.min(maxW, Math.max(MIN_COL_PX, startW + (e.clientX - startX))));
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      grip.classList.remove('dragging');
      this.host.classList.remove('is-resizing');
      this.saveWidths();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  renderHead() {
    const { columns, getSort, onSort } = this.opts;
    const sort = getSort ? getSort() : {};
    clear(this.headEl);
    this.headEl.style.gridTemplateColumns = this.gridTemplate();
    for (const col of columns) {
      const active = sort.sort === col.key;
      const cell = h(
        `div.vt-th${col.align === 'right' ? '.num' : ''}${col.sortable === false ? '' : '.sortable'}${active ? '.active' : ''}`,
        {
          title: col.title || (col.sortable === false ? '' : `Sort by ${col.label}`),
          onClick: col.sortable === false ? null : () => onSort && onSort(col.key),
        },
        col.head ? col.head() : col.label,
        active ? h('span.sort-arrow', { text: sort.dir === 'asc' ? '▲' : '▼' }) : null,
      );
      cell.appendChild(
        h('div.vt-grip', {
          title: 'Drag to resize this column · double-click to reset it',
          onPointerDown: (e) => this.beginResize(e, col, cell),
          // The grip sits inside a sortable header; a click that got through
          // would re-sort the table the moment a drag ended.
          onClick: (e) => e.stopPropagation(),
          onDblClick: (e) => {
            e.stopPropagation();
            this.resetColumnWidth(col.key);
          },
        }),
      );
      this.headEl.appendChild(cell);
    }
    this.canvas.style.minWidth = `${this.contentMinWidth()}px`;
    this.syncGutter();
    this.syncHeadScroll();
  }

  /** Discard everything and refetch from offset 0. */
  reload() {
    this.generation += 1;
    this.pages.clear();
    this.inflight.clear();
    this.pool.clear();
    clear(this.canvas);
    this.viewH = 0;
    this.scrollTopHint = null;
    this.scroller.scrollTop = 0;
    // A new query means a new first row, so put it back in view. On a phone
    // that means scrolling the PAGE back to the top of the list -- but only if
    // the list has already been scrolled past, or every filter change would
    // yank the chrome off-screen while the user is still using it.
    if (this.pageScrolled) {
      const dy = this.canvas.getBoundingClientRect().top;
      if (dy < 0) window.scrollBy(0, dy);
    }
    this.total = 0;
    this.canvas.style.height = '0px';
    this.loading = true;
    this.host.classList.add('is-loading');
    return this.ensurePage(0, true).then(() => {
      this.host.classList.remove('is-loading');
      this.loading = false;
      this.paint();
    });
  }

  /** Refresh cells in place without losing scroll position (e.g. selection). */
  repaint() {
    for (const [index, el] of this.pool) this.fillRow(el, index);
  }

  async ensurePage(pageIndex, isFirst) {
    if (this.pages.has(pageIndex) || this.inflight.has(pageIndex)) return this.inflight.get(pageIndex);
    const gen = this.generation;
    const p = (async () => {
      try {
        const res = await this.opts.fetchPage(pageIndex * PAGE_SIZE, PAGE_SIZE);
        if (gen !== this.generation) return;
        this.pages.set(pageIndex, res.rows || []);
        this.total = res.total ?? (res.rows || []).length;
        this.matchedBytes = res.matchedBytes ?? null;
        this.canvas.style.height = `${this.total * this.rowHeight}px`;
        // A result set that now needs (or no longer needs) a vertical
        // scrollbar changes the width the rows resolve their columns in.
        this.syncGutter();
        this.emptyEl.hidden = this.total !== 0;
        if (this.total === 0) {
          clear(this.emptyEl);
          this.emptyEl.append(this.opts.emptyNode ? this.opts.emptyNode() : 'No rows match the current filters.');
        }
        this.opts.onTotals?.({ total: this.total, matchedBytes: this.matchedBytes });
        this.paint();
      } catch (err) {
        if (gen !== this.generation) return;
        this.opts.onError?.(err);
        this.pages.set(pageIndex, []);
      } finally {
        this.inflight.delete(pageIndex);
      }
    })();
    this.inflight.set(pageIndex, p);
    return p;
  }

  rowAt(index) {
    const page = this.pages.get(Math.floor(index / PAGE_SIZE));
    return page ? page[index % PAGE_SIZE] : undefined;
  }

  paint() {
    const { rowHeight } = this;
    let view;
    let top;
    if (this.pageScrolled) {
      // How far the top of the spacer has travelled above the top of the
      // window IS the scroll offset into the list -- no cached page offset to
      // go stale when the chrome above changes height. One rect read, taken
      // inside the frame before any write, which is where layout is clean.
      view = window.innerHeight || 600;
      top = Math.max(0, -this.canvas.getBoundingClientRect().top);
      this.scrollTopHint = null;
    } else {
      if (!this.viewH) this.viewH = this.scroller.clientHeight || 600;
      view = this.viewH;
      top = this.scrollTopHint ?? this.scroller.scrollTop;
      this.scrollTopHint = null;
    }
    const first = Math.max(0, Math.floor(top / rowHeight) - OVERSCAN);
    const last = Math.min(this.total - 1, Math.ceil((top + view) / rowHeight) + OVERSCAN);

    if (this.total > 0) {
      for (let pi = Math.floor(first / PAGE_SIZE); pi <= Math.floor(last / PAGE_SIZE); pi++) this.ensurePage(pi);
    }

    // Retire rows that scrolled out of the window.
    for (const [index, el] of this.pool) {
      if (index < first || index > last) {
        el.remove();
        this.pool.delete(index);
      }
    }
    // Materialise rows that scrolled in.
    for (let i = first; i <= last; i++) {
      let el = this.pool.get(i);
      if (!el) {
        el = h('div.vt-row');
        el.style.gridTemplateColumns = this.gridTemplate();
        el.style.height = `${rowHeight}px`;
        el.style.transform = `translateY(${i * rowHeight}px)`;
        this.pool.set(i, el);
        this.canvas.appendChild(el);
      }
      this.fillRow(el, i);
    }
  }

  fillRow(el, index) {
    const row = this.rowAt(index);
    // Default signature is the row object itself: a recycled element whose
    // index still maps to the same row needs no work at all. Modes that paint
    // mutable state (selection, active asset) supply a richer signature.
    const sig = row ? this.opts.rowSignature?.(row, index) ?? row : null;
    if (row && el._sig != null && el._sig === sig) return;
    el._sig = sig;
    el._row = row;
    clear(el);
    el.className = 'vt-row';
    if (index % 2) el.classList.add('odd');
    if (!row) {
      el.classList.add('skeleton');
      for (const col of this.opts.columns) el.appendChild(h(`div.vt-td${col.align === 'right' ? '.num' : ''}`, h('span.sk')));
      return;
    }
    const extra = this.opts.rowClass?.(row);
    if (extra) for (const c of extra.split(' ')) if (c) el.classList.add(c);
    if (this.opts.onRowClick && this.opts.rowIsClickable?.(row) !== false) {
      el.classList.add('clickable');
      el.onclick = (e) => {
        if (e.target.closest('[data-stop]')) return;
        this.opts.onRowClick(row, e);
      };
    } else {
      el.onclick = null;
    }
    for (const col of this.opts.columns) {
      const td = h(`div.vt-td${col.align === 'right' ? '.num' : ''}${col.cls ? `.${col.cls}` : ''}`);
      const content = col.render(row, index);
      if (content instanceof Node) td.appendChild(content);
      else if (content != null) td.textContent = String(content);
      if (col.tooltip) td.title = col.tooltip(row) || '';
      el.appendChild(td);
    }
  }
}

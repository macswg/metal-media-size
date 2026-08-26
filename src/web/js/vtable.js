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
 * ============================================================================
 */

import { h, clear } from './dom.js';

const PAGE_SIZE = 500;
const OVERSCAN = 12;

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
        if (this.rafPending) return;
        this.rafPending = true;
        requestAnimationFrame(() => {
          this.rafPending = false;
          this.paint();
        });
      },
      { passive: true },
    );
    if (!VirtualTable._resizeHooked) VirtualTable._resizeHooked = true;
    this._onResize = () => {
      this.viewH = 0;
      this.paint();
    };
    window.addEventListener('resize', this._onResize);
    this.renderHead();
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
  }

  setColumns(columns) {
    this.opts.columns = columns;
    this.pool.clear();
    clear(this.canvas);
    this.renderHead();
  }

  gridTemplate() {
    return this.opts.columns.map((c) => c.width || '1fr').join(' ');
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
      this.headEl.appendChild(cell);
    }
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
    if (!this.viewH) this.viewH = this.scroller.clientHeight || 600;
    const view = this.viewH;
    const top = this.scrollTopHint ?? this.scroller.scrollTop;
    this.scrollTopHint = null;
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

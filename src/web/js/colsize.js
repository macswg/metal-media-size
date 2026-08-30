/**
 * ============================================================================
 *  COLUMN WIDTHS  --  ONE IDEA OF WHAT DRAGGING A COLUMN EDGE MEANS
 * ============================================================================
 *
 * Two very different tables need resizable columns: the virtualized, API-paged
 * Files table (`vtable.js`) and the small in-memory lists on the Rig tab
 * (`gridtable.js`). They share nothing else — one recycles thirty row elements
 * over 27,000 rows, the other paints what it was handed — so the temptation is
 * to write the drag twice. That is how two tables end up with two minimum
 * widths, two ideas of what a double-click does, and one of them quietly
 * forgetting its widths between visits.
 *
 * So the drag lives here, once, and both tables own only the part that is
 * actually theirs: WHERE to write the resulting grid template.
 *
 * A column keeps the width its table declared until it is dragged; from then on
 * that one column is pinned in pixels and the flexible columns around it absorb
 * the difference, which is why a drag neither overflows the pane nor disturbs
 * anything to its left. Double-clicking a grip gives the declared width back.
 * Widths are remembered per table, in localStorage — a preference about
 * reading, not data, so losing it costs nothing and it is never worth an error.
 * ============================================================================
 */

import { h } from './dom.js';

/** Narrowest a column may be dragged. Below this a header reads as a smudge. */
export const MIN_COL_PX = 36;

/** Where per-table column widths live between visits. */
export const WIDTH_STORE = 'aa.colWidths';

export class ColumnSizer {
  /**
   * @param {object} opts
   * @param {() => string} opts.storageKey  Distinguishes one table's widths from another's.
   * @param {() => Array} opts.columns      Live column list: [{ key, width }].
   * @param {() => void} opts.apply         Push the new template wherever it belongs.
   * @param {() => HTMLElement} opts.host   Element that carries `is-resizing` during a drag.
   * @param {() => HTMLElement} opts.bounds Element whose width caps how wide a column may go.
   */
  constructor(opts) {
    this.opts = opts;
    /** Column key -> pixel width the user dragged it to. */
    this.widths = new Map();
    this.load();
  }

  storageKey() {
    return `${WIDTH_STORE}.${this.opts.storageKey()}`;
  }

  load() {
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

  save() {
    try {
      if (this.widths.size === 0) localStorage.removeItem(this.storageKey());
      else localStorage.setItem(this.storageKey(), JSON.stringify(Object.fromEntries(this.widths)));
    } catch {
      // Private mode, quota, no storage: the drag still worked for this visit.
    }
  }

  /** The grid track for one column: a dragged pixel width wins over the declared one. */
  trackOf(col) {
    const px = this.widths.get(col.key);
    return px ? `${px}px` : col.width || '1fr';
  }

  gridTemplate() {
    return this.opts.columns().map((c) => this.trackOf(c)).join(' ');
  }

  /**
   * The narrowest the row can be drawn without a column going below what it was
   * declared to need. Read off the track list rather than measured: `120px` and
   * `minmax(120px, 2fr)` both floor at 120, a bare `1fr` floors at 0, and a
   * dragged column floors at the width it was dragged to. Past this the table
   * scrolls sideways rather than swallowing the columns on its right-hand end.
   */
  contentMinWidth() {
    let total = 0;
    for (const col of this.opts.columns()) {
      const track = this.trackOf(col);
      const m = /^minmax\(\s*([\d.]+)px/.exec(track) || /^([\d.]+)px$/.exec(track);
      total += m ? Number.parseFloat(m[1]) : 0;
    }
    return Math.ceil(total);
  }

  setWidth(key, px) {
    this.widths.set(key, Math.round(px));
    this.opts.apply();
  }

  reset(key) {
    if (!this.widths.delete(key)) return;
    this.opts.apply();
    this.save();
  }

  /**
   * The 6px handle on a header's right edge.
   *
   * `cell` is the header cell being sized — its measured width is where the
   * drag starts from, so a flexible column resizes from where it actually is
   * rather than jumping to some declared width first.
   */
  grip(col, cell) {
    return h('div.vt-grip', {
      title: 'Drag to resize this column · double-click to reset it',
      onPointerDown: (e) => this.beginResize(e, col, cell),
      // The grip may sit inside a sortable header; a click that got through
      // would re-sort the table the moment a drag ended.
      onClick: (e) => e.stopPropagation(),
      onDblClick: (e) => {
        e.stopPropagation();
        this.reset(col.key);
      },
    });
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
    const maxW = Math.max(MIN_COL_PX, this.opts.bounds().getBoundingClientRect().width - MIN_COL_PX);
    const grip = event.currentTarget;
    const host = this.opts.host();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add('dragging');
    host.classList.add('is-resizing');

    const move = (e) => {
      this.setWidth(col.key, Math.min(maxW, Math.max(MIN_COL_PX, startW + (e.clientX - startX))));
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      grip.classList.remove('dragging');
      host.classList.remove('is-resizing');
      this.save();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }
}

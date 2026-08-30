/**
 * ============================================================================
 *  GRID TABLE  --  A SMALL LIST YOU ALREADY HAVE, IN COLUMNS YOU CAN RESIZE
 * ============================================================================
 *
 * The Files table is virtualized and paged because it is 27,000 rows fetched
 * from an API. The Rig tab's lists are neither: a survey result is already in
 * memory, a few hundred rows at most, and it is handed here whole. So this is
 * the plain version — every row painted, no pool, no page cache, no sort
 * control.
 *
 * WHAT IT DOES SHARE is the column behaviour, and deliberately: the same
 * `ColumnSizer`, the same 6px grip, the same drag, the same double-click to
 * reset, the same per-table widths remembered between visits. Two tables that
 * resize differently is worse than either.
 *
 * WHICH ROWS, THEN WHICH ORDER — and they are not the same decision. A list is
 * capped, and the cap has to keep the rows that matter, so rows arrive in the
 * order the SERVER chose (biggest first, alarms first) and `max` takes from the
 * top of that. `order` then decides how the survivors are DISPLAYED. So a
 * capped list is still the 300 largest, and it can still read in song order.
 *
 * There is no sort control: a column header that re-ordered the list would undo
 * the first half of that silently, and the cap would stop meaning anything.
 * ============================================================================
 */

import { h, clear, append } from './dom.js';
import { ColumnSizer } from './colsize.js';

/**
 * @typedef {object} GridColumn
 * @property {string} key      Stable id; what a dragged width is filed under.
 * @property {string} label    Header text.
 * @property {string} [width]  Declared grid track, e.g. `90px`, `minmax(140px, 2fr)`.
 * @property {'right'} [align] Right-align the cell (numbers).
 * @property {string} [cls]    Extra classes for every cell in the column.
 * @property {string} [title]  Header tooltip.
 * @property {(row: any) => any} cell  Cell content: a string, a Node, or null.
 */

/**
 * Build a resizable grid over rows that are already in hand.
 *
 * @param {object} opts
 * @param {string} opts.key             Distinguishes these widths from another table's.
 * @param {GridColumn[]} opts.columns
 * @param {any[]} opts.rows
 * @param {number} [opts.max]           Rows to paint, taken from the top. The rest are counted, not drawn.
 * @param {(a: any, b: any) => number} [opts.order]  How to display the survivors.
 * @param {number} [opts.maxHeight]     Height at which the list scrolls inside itself.
 * @param {(row: any) => string} [opts.rowClass]
 */
export function gridTable(opts) {
  const columns = opts.columns;
  const all = opts.rows || [];
  const max = opts.max ?? 500;
  // Cap first, then order: the cap keeps the rows the server put at the top,
  // and `order` only decides how those are read.
  const rows = all.slice(0, max);
  if (opts.order) rows.sort(opts.order);

  const host = h('div.gt');
  const head = h('div.vt-head.gt-head');
  const body = h('div.gt-body');
  // Head and body share one scroller, so a sideways scroll moves both with no
  // JS keeping them in step. The head stays put vertically by being sticky.
  const inner = h('div.gt-inner', head, body);
  const scroll = h('div.gt-scroll', inner);

  const sizer = new ColumnSizer({
    storageKey: () => opts.key,
    columns: () => columns,
    apply: () => applyTemplate(),
    host: () => host,
    bounds: () => scroll,
  });

  function applyTemplate() {
    const tpl = sizer.gridTemplate();
    head.style.gridTemplateColumns = tpl;
    for (const el of body.children) el.style.gridTemplateColumns = tpl;
    // A dragged column can make the row wider than the pane; that is what the
    // sideways scroll is for, and the inner box is what has to grow for the
    // scroller to have somewhere to go.
    inner.style.minWidth = `${sizer.contentMinWidth()}px`;
  }

  clear(head);
  for (const col of columns) {
    const cell = h(`div.vt-th${col.align === 'right' ? '.num' : ''}`, {
      title: col.title || col.label,
      text: col.label,
    });
    cell.appendChild(sizer.grip(col, cell));
    head.appendChild(cell);
  }

  for (const row of rows) {
    const el = h(`div.gt-row${opts.rowClass ? `.${opts.rowClass(row)}` : ''}`);
    for (const col of columns) {
      const value = col.cell(row);
      const td = h(`div.vt-td${col.align === 'right' ? '.num' : ''}${col.cls ? `.${col.cls}` : ''}`);
      if (value instanceof Node) td.appendChild(value);
      else if (value != null && value !== '') td.textContent = String(value);
      // A cell that has been clipped to its column is still readable on hover.
      if (typeof value === 'string' && value !== '') td.title = value;
      el.appendChild(td);
    }
    body.appendChild(el);
  }

  applyTemplate();
  if (opts.maxHeight) scroll.style.maxHeight = `${opts.maxHeight}px`;

  append(host, [scroll]);
  host.dataset.shown = String(rows.length);
  host.dataset.total = String(all.length);
  return host;
}

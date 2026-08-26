/**
 * Central UI state, mirrored into the URL query string so any view can be
 * bookmarked, reloaded or pasted to someone else and come back identical.
 */

/** Filter keys, in the exact spelling the API contract uses as query params. */
export const FILTER_KEYS = [
  'songFolder',
  'ext',
  'minSize',
  'maxSize',
  'mtimeFrom',
  'mtimeTo',
  'path',
  'pathRe',
  'family',
  'status',
  'isPatch',
  'hasProxy',
  'q',
];

const DEFAULT_SORT = {
  versions: { sort: 'bytes', dir: 'desc' },
  files: { sort: 'size', dir: 'desc' },
  songs: { sort: 'totalBytes', dir: 'desc' },
};

function emptyFilters() {
  const f = {};
  for (const k of FILTER_KEYS) f[k] = '';
  return f;
}

export const state = {
  mode: 'versions',
  tab: 'table',
  keepN: 1,
  snapshotId: null,
  compareId: null,
  sort: 'bytes',
  dir: 'desc',
  filters: emptyFilters(),
  /**
   * Selection is expressed as an explicit set, or "everything matched minus
   * exceptions". `meta` remembers the bytes/file counts of rows the user
   * actually clicked, so the running total is exact without a round trip.
   */
  selection: { allMatched: false, ids: new Set(), except: new Set(), meta: new Map() },
  /**
   * Show only the versions ticked for export. Not a FILTER_KEY: those are
   * archive predicates that also scope the reclaim figure, whereas this is a
   * view of your own selection and must never change what the policy says is
   * superseded.
   */
  showSelectedOnly: false,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let pending = null;
export function emit(reason) {
  if (pending) {
    pending.add(reason);
    return;
  }
  pending = new Set([reason]);
  queueMicrotask(() => {
    const reasons = pending;
    pending = null;
    for (const fn of listeners) fn(reasons);
  });
}

/** Merge a patch into state, sync the URL, notify. */
export function update(patch, reason = 'state') {
  let filtersChanged = false;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'filters') {
      for (const [fk, fv] of Object.entries(v)) {
        if (state.filters[fk] !== (fv ?? '')) {
          state.filters[fk] = fv ?? '';
          filtersChanged = true;
        }
      }
    } else {
      state[k] = v;
    }
  }
  if (patch.mode && !patch.sort) {
    const d = DEFAULT_SORT[patch.mode];
    state.sort = d.sort;
    state.dir = d.dir;
  }
  if (filtersChanged || patch.mode || patch.snapshotId || patch.keepN) clearSelection();
  writeUrl();
  emit(filtersChanged ? 'filters' : reason);
}

export function defaultSortFor(mode) {
  return DEFAULT_SORT[mode];
}

export function resetFilters() {
  state.filters = emptyFilters();
  clearSelection();
  writeUrl();
  emit('filters');
}

export function activeFilterCount() {
  return FILTER_KEYS.filter((k) => state.filters[k] !== '' && state.filters[k] != null).length;
}

/* ---------------------------------------------------------------- */
/* Selection                                                         */
/* ---------------------------------------------------------------- */

export function clearSelection() {
  state.selection = { allMatched: false, ids: new Set(), except: new Set(), meta: new Map() };
}

export function isSelected(id) {
  const s = state.selection;
  return s.allMatched ? !s.except.has(id) : s.ids.has(id);
}

export function toggleSelected(id, on, meta) {
  const s = state.selection;
  const want = on == null ? !isSelected(id) : on;
  if (meta) s.meta.set(id, meta);
  if (s.allMatched) {
    if (want) s.except.delete(id);
    else s.except.add(id);
  } else if (want) s.ids.add(id);
  else s.ids.delete(id);
  emit('selection');
}

export function selectAllMatched(on) {
  state.selection = { allMatched: !!on, ids: new Set(), except: new Set(), meta: new Map() };
  emit('selection');
}

/** How many versions are selected, and their summed bytes, where known. */
export function selectionTotals(matched) {
  const s = state.selection;
  if (!s.allMatched) {
    let bytes = 0;
    let files = 0;
    let known = 0;
    for (const id of s.ids) {
      const m = s.meta.get(id);
      if (!m) continue;
      bytes += m.bytes || 0;
      files += m.fileCount || 0;
      known += 1;
    }
    return { count: s.ids.size, bytes, files, exact: known === s.ids.size, allMatched: false };
  }
  let bytes = matched?.matchedBytes ?? null;
  let files = null;
  let known = 0;
  for (const id of s.except) {
    const m = s.meta.get(id);
    if (!m) continue;
    if (bytes != null) bytes -= m.bytes || 0;
    known += 1;
  }
  return {
    count: Math.max(0, (matched?.total ?? 0) - s.except.size),
    bytes,
    files,
    exact: bytes != null && known === s.except.size,
    allMatched: true,
  };
}

/* ---------------------------------------------------------------- */
/* URL <-> state                                                     */
/* ---------------------------------------------------------------- */

let suppressUrl = false;

export function writeUrl() {
  if (suppressUrl) return;
  const p = new URLSearchParams();
  if (state.mode !== 'versions') p.set('mode', state.mode);
  if (state.tab !== 'table') p.set('tab', state.tab);
  if (state.keepN !== 1) p.set('keepN', String(state.keepN));
  if (state.snapshotId != null) p.set('snapshotId', String(state.snapshotId));
  if (state.compareId != null) p.set('cmp', String(state.compareId));
  const d = DEFAULT_SORT[state.mode];
  if (state.sort !== d.sort || state.dir !== d.dir) {
    p.set('sort', state.sort);
    p.set('dir', state.dir);
  }
  for (const k of FILTER_KEYS) if (state.filters[k] !== '' && state.filters[k] != null) p.set(k, state.filters[k]);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

export function readUrl() {
  suppressUrl = true;
  const p = new URLSearchParams(location.search);
  if (p.has('mode')) state.mode = p.get('mode');
  if (p.has('tab')) state.tab = p.get('tab');
  if (p.has('keepN')) state.keepN = Math.max(1, Number(p.get('keepN')) || 1);
  if (p.has('snapshotId')) state.snapshotId = Number(p.get('snapshotId'));
  if (p.has('cmp')) state.compareId = Number(p.get('cmp'));
  const d = DEFAULT_SORT[state.mode] || DEFAULT_SORT.versions;
  state.sort = p.get('sort') || d.sort;
  state.dir = p.get('dir') || d.dir;
  for (const k of FILTER_KEYS) if (p.has(k)) state.filters[k] = p.get(k);
  suppressUrl = false;
}

/** The filter set as plain query params, for handing to the API layer. */
/**
 * Selection as query params, for the TABLE only.
 *
 * Two selection shapes to express:
 *   - explicit ticks           -> versionIds=<the ids>
 *   - select-all-matched       -> the current filters, minus excludeIds
 *
 * Returns null when the filter is off, and `{ empty: true }` when it is on but
 * nothing is ticked -- the caller renders an empty table rather than asking
 * the server, because an empty id list is indistinguishable from an omitted
 * one in a query string, and omitted means "no filter".
 */
export function selectionParams() {
  if (!state.showSelectedOnly) return null;
  const sel = state.selection;
  if (sel.allMatched) {
    return sel.except.size ? { excludeIds: [...sel.except].join(',') } : {};
  }
  if (sel.ids.size === 0) return { empty: true };
  return { versionIds: [...sel.ids].join(',') };
}

export function filterParams() {
  const out = {};
  for (const k of FILTER_KEYS) {
    const v = state.filters[k];
    if (v !== '' && v != null) out[k] = v;
  }
  if (state.snapshotId != null) out.snapshotId = state.snapshotId;
  return out;
}

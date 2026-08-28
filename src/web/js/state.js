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
  machines: { sort: 'name', dir: 'asc' },
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
  selection: { vetoed: new Set(), meta: new Map() },
  /**
   * Show only the versions ticked for export. Not a FILTER_KEY: those are
   * archive predicates that also scope the reclaim figure, whereas this is a
   * view of your own selection and must never change what the policy says is
   * superseded.
   */
  /**
   * Which slice of the table to show: null = everything, 'manifest' = only
   * what the export will cover, 'overrides' = only the rows you vetoed.
   * Not a FILTER_KEY: those are archive predicates that also scope the reclaim
   * figure, and this must never move the headline.
   */
  manifestView: null,
  /** Slated totals under the current filters, published by the reclaim strip. */
  slated: null,
  /**
   * How many files in this snapshot have had their pixel dimensions read.
   * Published by /api/summary. Zero until `npm run probe` has been run, and
   * the Files table leaves the Resolution column out entirely while it is --
   * a column of dashes tells you nothing except that a column exists.
   */
  mediaProbed: 0,
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
  // Only a SNAPSHOT change drops your overrides. Under the old opt-in model a
  // selection was tied to the view, so any filter change reset it. A veto is
  // not that: it is a standing "keep this one anyway", and having it evaporate
  // because you switched to Files or typed in the search box would put a
  // version you had protected back into the manifest without saying so.
  //
  // A snapshot change is different in kind -- version ids belong to one
  // snapshot, so a veto carried across would point at the wrong row.
  if (patch.snapshotId) clearSelection();
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
/* The manifest, and your overrides                                  */
/* ---------------------------------------------------------------- */

/**
 * THE MANIFEST IS OPT-OUT.
 *
 * It used to be opt-in: nothing was in until you ticked it. That reads as
 * careful, but at keep-1 there are hundreds of slated versions, so nobody
 * ticked them one at a time -- everyone pressed "select all", and the ceremony
 * made the outcome LESS considered rather than more.
 *
 * The real per-item judgement is not "should this go?" -- the keep-N policy
 * answered that, and the slider and filters are where you actually decide. It
 * is "the policy says go, but I know something it doesn't". That is a veto,
 * and it is rare.
 *
 * So: the manifest is every version slated for removal under the current
 * filters, MINUS the ones you vetoed. A tick box is that veto.
 *
 * Versions the policy says to KEEP cannot be added by hand. There is no
 * gesture that puts a live master into a removal manifest, which is the one
 * direction worth making impossible rather than merely discouraged.
 */
export function clearSelection() {
  state.selection = { vetoed: new Set(), meta: new Map() };
}

/**
 * The version id a row refers to. A version row calls it `versionId`; a FILE
 * row calls it `assetVersionId`, because a file belongs to a version rather
 * than being one. Both must resolve to the same veto.
 */
function versionIdOf(row) {
  return row.versionId ?? row.assetVersionId ?? null;
}

/** True when this version will appear in the manifest. */
export function inManifest(row) {
  if (row.status !== 'superseded') return false;
  const id = versionIdOf(row);
  return id !== null && !state.selection.vetoed.has(id);
}

/** True when the user has overridden the policy for this version. */
export function isVetoed(id) {
  return state.selection.vetoed.has(id);
}

/**
 * What the Status column should say, given the policy AND any override. The
 * point is that ticking visibly changes the outcome, so the box explains
 * itself without a tooltip.
 */
export function effectiveStatus(row) {
  // Returns WIRE values, not labels: the result is used as a CSS class as well
  // as a lookup key, and `.pill.kept` is what the stylesheet defines. Returning
  // the label 'keep' here silently dropped the green styling, because
  // `.pill.keep` matches nothing. statusLabel() does the display mapping.
  if (row.status !== 'superseded') return row.status === 'unknown' ? 'unknown' : 'kept';
  const id = versionIdOf(row);
  return id !== null && state.selection.vetoed.has(id) ? 'kept-by-you' : 'superseded';
}

/** Veto or un-veto a slated version. `on` is "in the manifest". */
export function setInManifest(row, on) {
  if (row.status !== 'superseded') return;
  const id = versionIdOf(row);
  if (id === null) return;
  const s = state.selection;
  if (on) s.vetoed.delete(id);
  else {
    s.vetoed.add(id);
    s.meta.set(id, {
      bytes: row.bytes,
      fileCount: row.fileCount,
      base: row.base,
      songFolder: row.songFolder,
      verLabel: row.verLabel,
      status: row.status,
    });
  }
  emit('selection');
}

/** Drop every override, putting the manifest back to exactly what the policy says. */
export function clearOverrides() {
  state.selection.vetoed.clear();
  emit('selection');
}

/**
 * What the manifest currently covers.
 *
 * `slated` comes from /api/reclaim under the SAME filters, so the count is
 * exact rather than inferred from whatever page the table happens to show.
 */
export function selectionTotals(slated) {
  const s = state.selection;
  const baseCount = slated?.supersededCount ?? 0;
  const baseBytes = slated?.reclaimBytes ?? null;
  const baseFiles = slated?.supersededFiles ?? null;

  let bytes = baseBytes;
  let files = baseFiles;
  let known = 0;
  for (const id of s.vetoed) {
    const m = s.meta.get(id);
    if (!m) continue;
    if (bytes != null) bytes -= m.bytes || 0;
    if (files != null) files -= m.fileCount || 0;
    known += 1;
  }
  return {
    count: Math.max(0, baseCount - s.vetoed.size),
    bytes,
    files,
    vetoed: s.vetoed.size,
    slated: baseCount,
    exact: bytes != null && known === s.vetoed.size,
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
 * The manifest as query params, for the TABLE only.
 *
 * "In the manifest" is expressible as one query because the manifest is
 * policy-driven: everything slated, minus the vetoes. "My overrides" is just
 * the veto list.
 *
 * Never sent to /api/reclaim. The headline answers "what does the POLICY say
 * is reclaimable" -- it must not move because you vetoed a row.
 */
export function selectionParams() {
  const view = state.manifestView;
  if (!view) return null;
  const vetoed = [...state.selection.vetoed];

  if (view === 'overrides') {
    if (vetoed.length === 0) return { empty: true };
    return { versionIds: vetoed.join(',') };
  }
  // view === 'manifest'
  const p = { status: 'superseded' };
  if (vetoed.length) p.excludeIds = vetoed.join(',');
  return p;
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

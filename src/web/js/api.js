/**
 * The one place that talks to the HTTP API described in docs/api-contract.md.
 *
 * The API is being built in parallel, so on start-up we probe /api/snapshots.
 * If it answers, we use it. If it does not, we transparently fall back to the
 * in-browser mock in ../mock/mock-api.js, which replays a fixture derived
 * read-only from the real index.db. The source in use is always shown in the
 * top bar — the UI never pretends mock data is live data.
 *
 * Force a source with ?api=live or ?api=mock.
 */

let impl = null;
let source = 'unknown';
let probeNote = '';
let sourceInfo = null;

export function apiSource() {
  return source;
}
export function apiNote() {
  return probeNote;
}
/** Provenance of the mock fixture, when the mock is in use. */
export function apiInfo() {
  return sourceInfo;
}

/**
 * How long a request may take before it is given up on.
 *
 * EVERY request gets a deadline, because a `fetch` that never settles is worse
 * than one that fails: the caller waits forever, and a UI that disables itself
 * while it waits stays disabled until the page is reloaded. That is not
 * hypothetical -- a `mount` wedged on an unresponsive SMB share leaves the
 * route hanging with no error to report, and the rig tab froze.
 *
 * Mounting is the slow one and it is slow HONESTLY: the shares are mounted in
 * sequence, and a machine that is off takes its full timeout before the next is
 * tried. So it gets a budget that a real rig cannot exceed, rather than a
 * number that would cut a working connect short. Everything else is a database
 * read on localhost and has no business taking a minute.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const SLOW_ROUTES = [
  // Sequential SMB mounts: twenty-three machines x a 25 s mount timeout plus
  // two mount-table reads each, with room to spare.
  ['/api/rig/connect', 15 * 60_000],
  ['/api/rig/disconnect', 5 * 60_000],
  // A probe of the whole archive, driven from the browser.
  ['/api/probe', 15 * 60_000],
];

function timeoutFor(path) {
  return SLOW_ROUTES.find(([prefix]) => path.startsWith(prefix))?.[1] ?? DEFAULT_TIMEOUT_MS;
}

/**
 * The caller's own signal (a Cancel button) OR the deadline, whichever fires
 * first. `AbortSignal.any` is what makes "cancel" and "give up" the same kind
 * of thing, so the request has exactly one way to end early.
 */
function abortSignalFor(path, signal) {
  const deadline = AbortSignal.timeout(timeoutFor(path));
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

const LIVE = {
  async request(path, params, init, opts) {
    const url = new URL(path, location.origin);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === '' || v == null) continue;
      url.searchParams.set(k, String(v));
    }
    let res;
    try {
      res = await fetch(url, { ...init, signal: abortSignalFor(path, opts?.signal) });
    } catch (err) {
      // A cancelled or timed-out request must not read as a server error: the
      // caller shows these to an operator, and "the server said no" and "we
      // stopped waiting" are different things.
      if (err?.name === 'TimeoutError') {
        const e = new Error(
          `${path} did not answer within ${Math.round(timeoutFor(path) / 1000)}s, so it was given up on. Nothing was changed by giving up; the server may still be working.`,
        );
        e.code = 'timeout';
        throw e;
      }
      if (err?.name === 'AbortError') {
        const e = new Error('Cancelled.');
        e.code = 'cancelled';
        e.cancelled = true;
        throw e;
      }
      throw err;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const err = new Error(body?.error?.message || `${res.status} ${res.statusText}`);
      err.code = body?.error?.code || String(res.status);
      err.status = res.status;
      throw err;
    }
    return body;
  },
  get(path, params, opts) {
    return LIVE.request(path, params, null, opts);
  },
  // The one route that is not JSON: the rig target list, rendered as the YAML
  // file the operator saves. Returned as text for the browser to download.
  async text(path, opts) {
    const res = await fetch(new URL(path, location.origin), {
      signal: abortSignalFor(path, opts?.signal),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
  },
  post(path, payload, params, opts) {
    // `params` matters for POST /api/probe: which snapshot is being probed is
    // resolved from the query string, exactly as every read route resolves it.
    return LIVE.request(
      path,
      params ?? null,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      opts,
    );
  },
  del(path, opts) {
    return LIVE.request(path, null, { method: 'DELETE' }, opts);
  },
};

export async function initApi() {
  const forced = new URLSearchParams(location.search).get('api');
  if (forced !== 'mock') {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch('/api/snapshots', { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        await res.json();
        impl = LIVE;
        source = 'live';
        return source;
      }
      probeNote = `/api/snapshots answered ${res.status}`;
    } catch (e) {
      probeNote = e.name === 'AbortError' ? 'API did not answer in 2.5 s' : 'API not reachable';
    }
    if (forced === 'live') {
      impl = LIVE;
      source = 'live';
      return source;
    }
  }
  const mod = await import('../mock/mock-api.js');
  impl = await mod.createMockApi();
  sourceInfo = impl.info || null;
  source = 'mock';
  if (forced === 'mock') probeNote = 'forced with ?api=mock';
  return source;
}

/* ------------------------------------------------------------------ */
/* Response normalisation.                                             */
/* The contract names the reclaim fields reclaimBytes / supersededCount*/
/* while src/scan/reclaim.ts calls them reclaimableBytes /             */
/* supersededVersions. Accept either so a mismatch in the API agent's  */
/* implementation degrades to a cosmetic issue, not a blank headline.  */
/* ------------------------------------------------------------------ */
function normaliseReclaim(r) {
  if (!r) return r;
  return {
    keepN: r.keepN,
    reclaimBytes: r.reclaimBytes ?? r.reclaimableBytes ?? 0,
    supersededCount: r.supersededCount ?? r.supersededVersions ?? 0,
    supersededFiles: r.supersededFiles ?? null,
    protectedPatchBytes: r.protectedPatchBytes ?? 0,
    protectedPatchVersions: r.protectedPatchVersions ?? null,
    totalBytes: r.totalBytes ?? 0,
    keptBytes: r.keptBytes ?? (r.totalBytes != null ? r.totalBytes - (r.reclaimBytes ?? r.reclaimableBytes ?? 0) : null),
    // Null, not 0: a server that does not report this has not told us there is
    // no offline-edit material, and the strip shows an em dash for that.
    region0Bytes: r.region0Bytes ?? null,
    regionlessBytes: r.regionlessBytes ?? null,
    // The show-file cross-check. `programmed` is null when no capture is
    // loaded, and NULL IS ALSO THE SAFE DEFAULT for a server too old to report
    // it: the strip's null branch is the warning, so an unknown state reads as
    // unchecked rather than as checked-and-clean. Whitelisting here is what
    // dropped these on their first outing -- a field the route returns does not
    // reach the strip unless it is named.
    programmed: r.programmed ?? null,
    programmedBytes: r.programmedBytes ?? 0,
    programmedCount: r.programmedCount ?? 0,
    bySong: r.bySong || [],
  };
}

function normaliseList(r) {
  if (Array.isArray(r)) return { rows: r, total: r.length, matchedBytes: null };
  return { rows: r?.rows || [], total: r?.total ?? 0, matchedBytes: r?.matchedBytes ?? null, ...r };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const api = {
  snapshots: () => impl.get('/api/snapshots').then((r) => (Array.isArray(r) ? r : r?.rows || [])),
  snapshot: (id) => impl.get(`/api/snapshots/${id}`),
  health: () => impl.get('/api/health'),
  scanStatus: () => impl.get('/api/scan/status'),
  startScan: (name) => impl.post('/api/scan', name ? { name } : {}),

  // The resolution pass. Unlike a scan it can be stopped: results are written
  // as they land, so cancelling loses nothing and the next run resumes.
  probeStatus: (params) => impl.get('/api/probe/status', params),
  startProbe: (payload, params) => impl.post('/api/probe', payload || {}, params),
  cancelProbe: () => impl.post('/api/probe/cancel', {}),
  // Removes an index entry, never a file. See the route docblock.
  deleteSnapshot: (id) => impl.del(`/api/snapshots/${id}`),
  diff: (a, b) => impl.get(`/api/snapshots/${a}/diff/${b}`),

  files: (params) => impl.get('/api/files', params).then(normaliseList),
  versions: (params) => impl.get('/api/versions', params).then(normaliseList),
  songs: (params) => impl.get('/api/songs', params).then(normaliseList),
  machines: (params) => impl.get('/api/machines', params).then(normaliseList),

  assetVersions: (assetId, params) => impl.get(`/api/assets/${assetId}/versions`, params),

  reclaim: (params) => impl.get('/api/reclaim', params).then(normaliseReclaim),
  summary: (params) => impl.get('/api/summary', params),

  duplicates: (params) => impl.get('/api/duplicates', params).then(normaliseList),
  anomalies: (params) => impl.get('/api/anomalies', params),
  // Versions holding some of the canvas but not all of it. Shape is fixed by
  // the route, so no normalisation: `rows` plus its own counts block.
  coverage: (params) => impl.get('/api/coverage', params),

  exportManifest: (payload) => impl.post('/api/export', payload),

  /* --------------------------------------------------------------------- */
  /* The rig survey. Every one of these is session state in the server's     */
  /* memory: nothing here reads or writes the index, and no address or       */
  /* password is persisted anywhere. `rigTargetsYaml` returns TEXT, which    */
  /* the browser turns into a download — the server never puts it on disk.   */
  /* --------------------------------------------------------------------- */
  rigStatus: () => impl.get('/api/rig/status'),
  rigTargets: (payload) => impl.post('/api/rig/targets', payload),
  rigCredentials: (payload) => impl.post('/api/rig/credentials', payload),
  // The two slow ones take a signal, so the button that started them can stop
  // waiting on them. See `RigPanel.act`.
  rigConnect: (payload, opts) => impl.post('/api/rig/connect', payload, null, opts),
  rigDisconnect: (opts) => impl.post('/api/rig/disconnect', {}, null, opts),
  rigMounts: () => impl.get('/api/rig/mounts'),
  // Directory entries on ONE mounted machine, one level deep, so the survey
  // path can be picked rather than typed. Lists directories; opens no file.
  rigBrowse: (params) => impl.get('/api/rig/browse', params),
  rigSurvey: (payload) => impl.post('/api/rig/survey', payload),
  rigCancelSurvey: () => impl.post('/api/rig/survey/cancel', {}),
  rigForget: () => impl.del('/api/rig/session'),
  rigTargetsYaml: () => impl.text('/api/rig/targets.yaml'),
  // The master missing list, rendered server-side and saved by the browser —
  // like the YAML above, nothing is written by this application.
  rigMissingCsv: () => impl.text('/api/rig/missing.csv'),
};

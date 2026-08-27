/**
 * ============================================================================
 *  IN-BROWSER MOCK API  --  DEVELOPMENT ONLY
 * ============================================================================
 *
 * Implements docs/api-contract.md against fixture.json, which was generated
 * read-only from the real data/index.db. The keep/supersede verdicts in the
 * fixture are the literal output of computeReclaim() in src/scan/reclaim.ts
 * for N = 1..8, so the mock cannot drift from the production patch rule — it
 * replays it rather than re-deriving it.
 *
 * This module is never loaded when the real API answers. It exists so the
 * frontend could be built before the HTTP layer landed, and so the UI can be
 * demonstrated without a mounted archive.
 *
 * It performs no I/O beyond fetching its own fixture, and its /api/export
 * returns a preview only — in mock mode nothing is produced on disk at all.
 * ============================================================================
 */

const REASONS = [
  'kept-full-latest',
  'kept-patch-newer-than-latest-full',
  'kept-patch-of-latest-full',
  'kept-no-full-versions',
  'superseded-full',
  'superseded-patch',
  'kept-proxy-only-newer-than-latest-full',
  'superseded-proxy-only',
];

const SORTABLE = {
  versions: new Set([
    'songFolder', 'base', 'family', 'verNum', 'verLabel', 'bytes', 'fileCount',
    'proxyBytes', 'region0Bytes', 'regionCount', 'latestMtime', 'status', 'isPatch',
  ]),
  files: new Set(['relPath', 'songFolder', 'name', 'ext', 'size', 'mtime', 'parseOk']),
  songs: new Set(['songFolder', 'fileCount', 'totalBytes', 'assetCount', 'versionCount', 'supersededBytes', 'latestMtime']),
};

function globToRe(glob) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = esc.replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\x00/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

export async function createMockApi() {
  const res = await fetch(new URL('./fixture.json', import.meta.url));
  if (!res.ok) throw new Error(`mock fixture unavailable (${res.status})`);
  const fx = await res.json();

  /** Per-snapshot derived caches, built on first touch. */
  const caches = new Map();

  function snapIdOf(params) {
    const id = Number(params?.snapshotId);
    return fx.bySnapshot[id] ? id : fx.latestSnapshotId;
  }

  function cacheFor(snapId) {
    if (caches.has(snapId)) return caches.get(snapId);
    const raw = fx.bySnapshot[snapId];
    const assets = raw.assets.map((a) => ({
      assetId: a.id,
      songFolder: raw.songs[a.s],
      base: a.b,
      family: raw.families[a.f],
    }));
    const assetById = new Map(assets.map((a) => [a.assetId, a]));

    const versions = raw.versions.map((v) => {
      const a = assets[v.a];
      return {
        versionId: v.id,
        assetId: a.assetId,
        songFolder: a.songFolder,
        base: a.base,
        family: a.family,
        verNum: v.vn,
        subLetter: v.sl,
        verLabel: v.lbl,
        isPatch: !!v.p,
        patchFrame: v.pf,
        bytes: v.by,
        fileCount: v.fc,
        proxyBytes: v.pb,
        // The fixture records a proxy subtotal, not a region0 one, so this is
        // summed from the file list -- which is what the real index does, one
        // layer down. On this archive the two agree to the byte.
        region0Bytes: v.fl.reduce((n, f) => (/_region0\./i.test(f[0]) ? n + f[1] : n), 0),
        regionCount: v.rc,
        latestMtime: v.mt,
        _reasons: v.r,
        _files: v.fl,
      };
    });
    const versionById = new Map(versions.map((v) => [v.versionId, v]));

    // File rows are materialised once: ~26.6k objects, cheap and stable.
    let files = null;
    const buildFiles = () => {
      if (files) return files;
      files = [];
      let id = 1;
      for (const v of versions) {
        for (const [suffix, size, mtimeOverride] of v._files) {
          const name = suffix.startsWith(' ') ? suffix.slice(1) : v.base + suffix;
          files.push({
            id: id++,
            relPath: `${v.songFolder}/${name}`,
            songFolder: v.songFolder,
            name,
            ext: extOf(name),
            size,
            mtime: mtimeOverride || v.latestMtime,
            parseOk: 1,
            assetVersionId: v.versionId,
            // Additive beyond the contract: the UI needs it to open the
            // version ladder straight from a file row. Flagged in the report.
            assetId: v.assetId,
            // Dimensions come from `npm run probe`, which the mock cannot run.
            // A proxy is square, a region slice is not: enough shape for the
            // Resolution column to be worth looking at in the mock UI.
            ...mockDimensions(name, id),
          });
        }
      }
      for (const u of raw.unparsed) {
        files.push({
          id: id++,
          relPath: u.relPath,
          songFolder: u.songFolder,
          name: u.name,
          ext: u.ext,
          size: u.size,
          mtime: u.mtime,
          parseOk: 0,
          assetVersionId: null,
          assetId: null,
          width: null,
          height: null,
          probed: false,
        });
      }
      return files;
    };

    const c = { raw, assets, assetById, versions, versionById, buildFiles };
    caches.set(snapId, c);
    return c;
  }

  /**
   * Stand-in dimensions for the mock. Every ninth file is left unprobed and
   * every seventeenth is probed-but-headerless, so the three states the
   * Resolution column has to render all appear without running a probe.
   */
  function mockDimensions(name, id) {
    if (id % 9 === 0) return { width: null, height: null, probed: false };
    if (id % 17 === 0) return { width: null, height: null, probed: true };
    if (/_proxy3_region0\./i.test(name)) return { width: 1500, height: 1500, probed: true };
    const shapes = [
      [8996, 2584],
      [4012, 3240],
      [3976, 3248],
      [3700, 3696],
      [1740, 3288],
    ];
    const shape = shapes[id % shapes.length];
    return { width: shape[0], height: shape[1], probed: true };
  }

  function verdict(v, keepN) {
    const n = Math.min(Math.max(1, Number(keepN) || 1), fx.maxKeepN);
    const reason = REASONS[Number(v._reasons[n - 1])];
    return { keepReason: reason, status: reason.startsWith('kept') ? 'kept' : 'superseded' };
  }

  /** Shared filter set from the contract, applied to a version row. */
  function versionPredicate(p) {
    const tests = [];
    if (p.songFolder) tests.push((v) => v.songFolder === p.songFolder);
    if (p.family) tests.push((v) => v.family === p.family);
    if (p.minSize) tests.push((v) => v.bytes >= Number(p.minSize));
    if (p.maxSize) tests.push((v) => v.bytes <= Number(p.maxSize));
    if (p.mtimeFrom) tests.push((v) => v.latestMtime >= Number(p.mtimeFrom));
    if (p.mtimeTo) tests.push((v) => v.latestMtime <= Number(p.mtimeTo));
    if (p.isPatch === '1' || p.isPatch === 1) tests.push((v) => v.isPatch);
    if (p.isPatch === '0' || p.isPatch === 0) tests.push((v) => !v.isPatch);
    // Proxy OR region0: the same union the server applies. See query.ts.
    const hasP = (v) => v.proxyBytes > 0 || v.region0Bytes > 0;
    if (p.hasProxy === '1' || p.hasProxy === 1) tests.push(hasP);
    if (p.hasProxy === '0' || p.hasProxy === 0) tests.push((v) => !hasP(v));
    // 'only' = a whole canvas with no slices behind it, never a playable delivery.
    if (p.hasProxy === 'only') tests.push((v) => hasP(v) && !v.regionCount);
    if (p.q) {
      const q = String(p.q).toLowerCase();
      tests.push((v) => `${v.songFolder}/${v.base} ${v.verLabel}`.toLowerCase().includes(q));
    }
    if (p.ext) {
      // A version's files are all .mov in this archive; the ext filter is a
      // file-level concept, so on versions it matches the version's own files.
      const set = new Set(String(p.ext).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
      tests.push((v) => v._files.some(([sfx]) => set.has(extOf(sfx))));
    }
    if (p.path) {
      const re = globToRe(p.path);
      tests.push((v) => re.test(`${v.songFolder}/${v.base}`) || v._files.some(([sfx]) => re.test(`${v.songFolder}/${v.base}${sfx}`)));
    }
    if (p.pathRe) {
      let re;
      try {
        re = new RegExp(p.pathRe, 'i');
      } catch {
        throw badRequest('BAD_REGEX', `pathRe is not a valid regular expression: ${p.pathRe}`);
      }
      tests.push((v) => re.test(`${v.songFolder}/${v.base}`));
    }
    return (v) => tests.every((t) => t(v));
  }

  function filePredicate(p) {
    const tests = [];
    if (p.songFolder) tests.push((f) => f.songFolder === p.songFolder);
    if (p.minSize) tests.push((f) => f.size >= Number(p.minSize));
    if (p.maxSize) tests.push((f) => f.size <= Number(p.maxSize));
    if (p.mtimeFrom) tests.push((f) => f.mtime >= Number(p.mtimeFrom));
    if (p.mtimeTo) tests.push((f) => f.mtime <= Number(p.mtimeTo));
    if (p.ext) {
      const set = new Set(String(p.ext).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
      tests.push((f) => set.has(f.ext));
    }
    if (p.q) {
      const q = String(p.q).toLowerCase();
      tests.push((f) => f.relPath.toLowerCase().includes(q));
    }
    if (p.path) {
      const re = globToRe(p.path);
      tests.push((f) => re.test(f.relPath));
    }
    if (p.pathRe) {
      let re;
      try {
        re = new RegExp(p.pathRe, 'i');
      } catch {
        throw badRequest('BAD_REGEX', `pathRe is not a valid regular expression: ${p.pathRe}`);
      }
      tests.push((f) => re.test(f.relPath));
    }
    return (f) => tests.every((t) => t(f));
  }

  function badRequest(code, message) {
    const e = new Error(message);
    e.code = code;
    e.status = 400;
    return e;
  }

  function sortRows(rows, mode, sort, dir) {
    if (!sort) return rows;
    if (!SORTABLE[mode].has(sort)) throw badRequest('BAD_SORT', `Unknown sort column '${sort}'`);
    const sign = dir === 'asc' ? 1 : -1;
    return rows.sort((a, b) => {
      const x = a[sort];
      const y = b[sort];
      if (x === y) return a.versionId && b.versionId ? a.versionId - b.versionId : 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x < y ? -1 : 1) * sign;
    });
  }

  function page(rows, p, bytesKey) {
    const limit = Math.min(Number(p.limit) || 200, 2000);
    const offset = Number(p.offset) || 0;
    let matchedBytes = 0;
    for (const r of rows) matchedBytes += r[bytesKey] || 0;
    return { rows: rows.slice(offset, offset + limit), total: rows.length, matchedBytes };
  }

  /** Versions matching the filter set, verdicts applied, status filter last. */
  function matchedVersions(p) {
    const c = cacheFor(snapIdOf(p));
    const keepN = p.keepN;
    const pred = versionPredicate(p);
    const out = [];
    for (const v of c.versions) {
      if (!pred(v)) continue;
      const d = verdict(v, keepN);
      if (p.status && p.status !== d.status) continue;
      out.push({ ...publicVersion(v), ...d });
    }
    return out;
  }

  function publicVersion(v) {
    return {
      versionId: v.versionId,
      assetId: v.assetId,
      songFolder: v.songFolder,
      base: v.base,
      family: v.family,
      verNum: v.verNum,
      subLetter: v.subLetter,
      verLabel: v.verLabel,
      isPatch: v.isPatch,
      patchFrame: v.patchFrame,
      bytes: v.bytes,
      fileCount: v.fileCount,
      proxyBytes: v.proxyBytes,
      region0Bytes: v.region0Bytes,
      regionCount: v.regionCount,
      latestMtime: v.latestMtime,
    };
  }

  const latency = () => new Promise((r) => setTimeout(r, 20 + Math.random() * 60));

  async function get(path, params = {}) {
    await latency();
    const p = params || {};

    if (path === '/api/snapshots') return fx.snapshots;

    let m = /^\/api\/snapshots\/(\d+)$/.exec(path);
    if (m) {
      const s = fx.snapshots.find((x) => x.id === Number(m[1]));
      if (!s) throw notFound('SNAPSHOT_NOT_FOUND', `No snapshot ${m[1]}`);
      return s;
    }

    m = /^\/api\/snapshots\/(\d+)\/diff\/(\d+)$/.exec(path);
    if (m) {
      const d = fx.diffs[`${m[1]}:${m[2]}`];
      if (!d) throw notFound('DIFF_UNAVAILABLE', `No diff for snapshots ${m[1]} → ${m[2]}`);
      return d;
    }

    if (path === '/api/scan/status') return { running: false };

    if (path === '/api/files') {
      const c = cacheFor(snapIdOf(p));
      const rows = c.buildFiles().filter(filePredicate(p));
      // status/isPatch/family are version-level; honour them by mapping through.
      let filtered = rows;
      if (p.status || p.family || p.isPatch != null || p.hasProxy != null) {
        const okIds = new Set(matchedVersions(p).map((v) => v.versionId));
        filtered = rows.filter((f) => f.assetVersionId != null && okIds.has(f.assetVersionId));
      }
      return page(sortRows(filtered.slice(), 'files', p.sort || 'size', p.dir || 'desc'), p, 'size');
    }

    if (path === '/api/versions') {
      const rows = matchedVersions(p);
      return page(sortRows(rows, 'versions', p.sort || 'bytes', p.dir || 'desc'), p, 'bytes');
    }

    if (path === '/api/songs') {
      const c = cacheFor(snapIdOf(p));
      const vs = matchedVersions(p);
      const bySong = new Map();
      for (const v of vs) {
        let s = bySong.get(v.songFolder);
        if (!s) {
          bySong.set(
            v.songFolder,
            (s = {
              songFolder: v.songFolder,
              fileCount: 0,
              totalBytes: 0,
              assets: new Set(),
              versionCount: 0,
              supersededBytes: 0,
              supersededCount: 0,
              latestMtime: 0,
            }),
          );
        }
        s.fileCount += v.fileCount;
        s.totalBytes += v.bytes;
        s.assets.add(v.assetId);
        s.versionCount += 1;
        if (v.status === 'superseded') {
          s.supersededBytes += v.bytes;
          s.supersededCount += 1;
        }
        if (v.latestMtime > s.latestMtime) s.latestMtime = v.latestMtime;
      }
      const rows = [...bySong.values()].map((s) => ({ ...s, assetCount: s.assets.size, assets: undefined }));
      return page(sortRows(rows, 'songs', p.sort || 'totalBytes', p.dir || 'desc'), p, 'totalBytes');
    }

    m = /^\/api\/assets\/(\d+)\/versions$/.exec(path);
    if (m) {
      const assetId = Number(m[1]);
      const c = cacheFor(snapIdOf(p));
      const asset = c.assetById.get(assetId);
      if (!asset) throw notFound('ASSET_NOT_FOUND', `No asset ${assetId}`);
      const versions = c.versions
        .filter((v) => v.assetId === assetId)
        .sort((a, b) => a.verNum - b.verNum || Number(a.isPatch) - Number(b.isPatch))
        .map((v) => ({ ...publicVersion(v), ...verdict(v, p.keepN) }));
      return { asset, versions };
    }

    if (path === '/api/reclaim') {
      const c = cacheFor(snapIdOf(p));
      const withoutStatus = { ...p };
      delete withoutStatus.status;
      const vs = matchedVersions(withoutStatus);
      let reclaimBytes = 0;
      let supersededCount = 0;
      let supersededFiles = 0;
      let protectedPatchBytes = 0;
      let protectedPatchVersions = 0;
      let totalBytes = 0;
      let region0Bytes = 0;
      const bySong = new Map();
      for (const v of vs) {
        totalBytes += v.bytes;
        region0Bytes += v.region0Bytes;
        let s = bySong.get(v.songFolder);
        if (!s) bySong.set(v.songFolder, (s = { songFolder: v.songFolder, reclaimBytes: 0, supersededCount: 0, totalBytes: 0 }));
        s.totalBytes += v.bytes;
        if (v.status === 'superseded') {
          reclaimBytes += v.bytes;
          supersededCount += 1;
          supersededFiles += v.fileCount;
          s.reclaimBytes += v.bytes;
          s.supersededCount += 1;
        } else if (v.isPatch && v.keepReason !== 'kept-no-full-versions') {
          protectedPatchBytes += v.bytes;
          protectedPatchVersions += 1;
        }
      }
      return {
        keepN: Math.min(Math.max(1, Number(p.keepN) || 1), fx.maxKeepN),
        reclaimBytes,
        supersededCount,
        supersededFiles,
        protectedPatchBytes,
        protectedPatchVersions,
        totalBytes,
        keptBytes: totalBytes - reclaimBytes,
        region0Bytes,
        bySong: [...bySong.values()].sort((a, b) => b.reclaimBytes - a.reclaimBytes),
      };
    }

    if (path === '/api/summary') {
      const snapId = snapIdOf(p);
      const c = cacheFor(snapId);
      const snap = fx.snapshots.find((s) => s.id === snapId);
      const songs = new Set(c.assets.map((a) => a.songFolder));
      return {
        snapshotId: snapId,
        root: snap.root,
        scannedAt: snap.finishedAt,
        fileCount: snap.fileCount,
        totalBytes: snap.totalBytes,
        assetCount: c.assets.length,
        versionCount: c.versions.length,
        region0Bytes: c.versions.reduce((n, v) => n + v.region0Bytes, 0),
        songCount: songs.size,
        unparsedCount: snap.unparsedCount,
        excludedCount: snap.excludedCount,
        excludedBytes: snap.excludedBytes,
        songFolders: [...songs].sort(),
        families: c.raw.families.slice().sort(),
        extensions: [...new Set(c.buildFiles().map((f) => f.ext))].sort(),
        maxKeepN: fx.maxKeepN,
        reclaimByKeepN: c.raw.totalsByN,
      };
    }

    if (path === '/api/duplicates') {
      const mode = 'name-size';
      const c = cacheFor(snapIdOf(p));
      const groups = c.raw.duplicates[mode];
      if (!groups) throw badRequest('BAD_MODE', `Unknown duplicates mode '${mode}'`);
      const limit = Math.min(Number(p.limit) || 200, 2000);
      const offset = Number(p.offset) || 0;
      return {
        mode,
        caveat: 'likely duplicate — content not verified',
        rows: groups.slice(offset, offset + limit),
        total: groups.length,
        matchedBytes: groups.reduce((t, g) => t + g.wastedBytes, 0),
      };
    }

    if (path === '/api/anomalies') {
      const a = cacheFor(snapIdOf(p)).raw.anomalies;
      const sev = p.severity;
      if (sev !== 'high' && sev !== 'low') return a;
      const keep = (rows) => (rows || []).filter((r) => r.severity === sev);
      return { ...a, missingRegions: keep(a.missingRegions), orphanRegions: keep(a.orphanRegions) };
    }

    throw notFound('NO_ROUTE', `Mock API has no route for ${path}`);
  }

  function notFound(code, message) {
    const e = new Error(message);
    e.code = code;
    e.status = 404;
    return e;
  }

  async function post(path, payload) {
    await latency();
    if (path === '/api/export') {
      if (!payload?.deletionPolicy) throw badRequest('POLICY_REQUIRED', 'deletionPolicy is required');
      if (payload.deletionPolicy === 'Permanent') throw badRequest('POLICY_FORBIDDEN', "deletionPolicy 'Permanent' is never accepted");
      if (!['Versioning', 'RecycleBin'].includes(payload.deletionPolicy)) {
        throw badRequest('POLICY_INVALID', `Unknown deletionPolicy '${payload.deletionPolicy}'`);
      }
      if (payload.deletionPolicy === 'Versioning' && !payload.versioningFolder) {
        throw badRequest('VERSIONING_FOLDER_REQUIRED', 'Versioning requires a versioning folder path');
      }
      const c = cacheFor(fx.latestSnapshotId);
      const ids = payload.versionIds || [];
      let totalBytes = 0;
      let fileCount = 0;
      for (const id of ids) {
        const v = c.versionById.get(id);
        if (!v) continue;
        totalBytes += v.bytes;
        fileCount += v.fileCount;
      }
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
      return {
        mock: true,
        files: (payload.formats || ['json']).map((format) => ({
          format,
          path:
            format === 'report'
              ? `exports/export_${stamp}/media_cleanup_report_${stamp}.html`
              : `exports/manifest_${stamp}.${format === 'ffs_gui' ? 'ffs_gui' : format === 'markdown' ? 'md' : 'json'}`,
          bytes: 0,
        })),
        summary: { fileCount, totalBytes, versionCount: ids.length },
      };
    }
    throw notFound('NO_ROUTE', `Mock API has no route for POST ${path}`);
  }

  return {
    get,
    post,
    info: {
      generatedAt: fx.generatedAt,
      note: fx.note,
      snapshotCount: fx.snapshots.length,
    },
  };
}

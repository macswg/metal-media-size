/**
 * ============================================================================
 *  HTTP API tests -- against the fixture index, never against the archive
 * ============================================================================
 *
 * The fixture is described in `fixture.ts`. Its numbers are small and stated
 * there, so these tests assert on real arithmetic rather than on whatever the
 * code happens to produce.
 *
 * Deliberately NOT asserted anywhere: the real archive's reclaim totals. Those
 * belong to the scanner's own tests and change when the grammar changes.
 * ============================================================================
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server/app.ts';
import type { AppContext } from '../../src/server/context.ts';
import { ReadOnlyFs } from '../../src/fs/readonly.ts';
import { makeFixture, type Fixture } from './fixture.ts';
import { MAX_ID_LIST } from '../../src/server/query.ts';

let fx: Fixture;
let app: FastifyInstance;
let ctx: AppContext;
/** Scratch export directory, so a test run never leaves files in `exports/`. */
let exportsDir: string;

// ---------------------------------------------------------------------------
// Fixture arithmetic, restated here so a drift in either place is caught.
// ---------------------------------------------------------------------------
const TOTAL_FILES = 33;
const TOTAL_FILE_BYTES = 75_840;
const TOTAL_VERSIONS = 14;
const TOTAL_VERSION_BYTES = 69_742;

/** The probeable population: the header parser only understands .mov. */
const TOTAL_MOV_FILES = 29;

/** 100_ALPHA: v001 3100, v002 3400, v003 3100, v004 11000, patches 300 + 400. */
const ALPHA_TOTAL = 21_300;

beforeAll(() => {
  fx = makeFixture();
  // realpath: on macOS /var/folders is a symlink to /private/var/folders, and
  // the export writer resolves its jail before reporting a path.
  exportsDir = realpathSync(mkdtempSync(join(tmpdir(), 'metal-media-size-api-')));
  const built = buildServer({ db: fx.db, cfg: fx.cfg, exportsDir });
  app = built.app;
  ctx = built.ctx;
});

afterAll(async () => {
  await app.close();
  fx.db.close();
  rmSync(exportsDir, { recursive: true, force: true });
});

async function get(url: string): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
}

async function post(url: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: 'POST', url, payload: payload as object });
  return { status: res.statusCode, body: res.json() };
}

async function del(url: string): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: 'DELETE', url });
  return { status: res.statusCode, body: res.json() };
}

// ===========================================================================
describe('server basics', () => {
  it('answers /api/health', async () => {
    const { status, body } = await get('/api/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('returns the contract error shape for an unknown route', async () => {
    const { status, body } = await get('/api/nope');
    expect(status).toBe(404);
    expect(body.error.code).toBe('route_not_found');
    expect(typeof body.error.message).toBe('string');
  });

  it('binds loopback only -- the host is not configurable', async () => {
    const src = await import('../../src/server/app.ts');
    expect(src.BIND_HOST).toBe('127.0.0.1');
  });
});

// ===========================================================================
describe('the browser app is served at /', () => {
  it('GET / returns the app HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>Media Allocation Analyzer</title>');
    expect(res.body).toContain('./js/main.js');
  });

  it('serves the JS entry point the HTML asks for', async () => {
    const res = await app.inject({ method: 'GET', url: '/js/main.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('serves the stylesheet', async () => {
    const res = await app.inject({ method: 'GET', url: '/app.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
  });

  it('the static mount does not shadow the API', async () => {
    expect((await get('/api/health')).status).toBe(200);
    expect((await get('/api/nope')).body.error.code).toBe('route_not_found');
  });

  it('a missing asset is a 404, not a directory listing', async () => {
    const res = await app.inject({ method: 'GET', url: '/js/not-a-file.js' });
    expect(res.statusCode).toBe(404);
  });
});

// ===========================================================================
describe('GET /api/snapshots', () => {
  it('lists both snapshots, newest first', async () => {
    const { status, body } = await get('/api/snapshots');
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe(fx.snapshotId);
    expect(body[0].status).toBe('complete');
  });

  it('fetches one by id and surfaces the excluded bookkeeping counts', async () => {
    const { body } = await get(`/api/snapshots/${fx.snapshotId}`);
    expect(body.id).toBe(fx.snapshotId);
    expect(body.excludedCount).toBe(7);
    expect(body.excludedBytes).toBe(2048);
    expect(body.skipped).toHaveLength(1);
  });

  it('404s an unknown id', async () => {
    const { status, body } = await get('/api/snapshots/9999');
    expect(status).toBe(404);
    expect(body.error.code).toBe('snapshot_not_found');
  });
});

// ===========================================================================
describe('GET /api/snapshots/:a/diff/:b', () => {
  it('reports what a live archive did between two scans', async () => {
    const { status, body } = await get(
      `/api/snapshots/${fx.snapshotIdPrev}/diff/${fx.snapshotId}`,
    );
    expect(status).toBe(200);

    // v004 arrived: two region files plus its patch.
    expect(body.summary.addedCount).toBe(3);
    expect(body.added.every((r: any) => r.relPath.includes('_v004'))).toBe(true);

    // A stale note was cleared away.
    expect(body.summary.removedCount).toBe(1);
    expect(body.removed[0].relPath).toBe('300_GAMMA/stale-note.txt');

    // 200_BETA's five renders each gained 5 bytes.
    expect(body.summary.grownCount).toBe(5);
    expect(body.summary.grownBytes).toBe(25);

    // 300_GAMMA's single render lost 42.
    expect(body.summary.shrunkCount).toBe(1);
    expect(body.summary.shrunkBytes).toBe(-42);

    expect(body.summary.netBytes).toBe(body.b.totalBytes - body.a.totalBytes);
    expect(body.summary.listsClipped).toBe(false);
  });

  it('404s when either side is unknown', async () => {
    expect((await get(`/api/snapshots/9999/diff/${fx.snapshotId}`)).status).toBe(404);
    expect((await get(`/api/snapshots/${fx.snapshotId}/diff/9999`)).status).toBe(404);
  });
});

// ===========================================================================
describe('GET /api/files -- filters', () => {
  it('returns everything with no filter', async () => {
    const { body } = await get('/api/files?limit=2000');
    expect(body.total).toBe(TOTAL_FILES);
    expect(body.matchedBytes).toBe(TOTAL_FILE_BYTES);
    expect(body.rows).toHaveLength(TOTAL_FILES);
  });

  it('carries assetId so a file row can open its version ladder', async () => {
    const { body } = await get('/api/files?limit=2000');
    const parsed = body.rows.filter((r: any) => r.parseOk);
    const unparsed = body.rows.filter((r: any) => !r.parseOk);

    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((r: any) => Number.isInteger(r.assetId))).toBe(true);
    // NULL exactly when there is no asset-version to hang it on.
    expect(unparsed.every((r: any) => r.assetId === null)).toBe(true);

    // The id actually resolves through /api/assets/:assetId/versions.
    const row = parsed.find((r: any) => r.songFolder === '100_ALPHA');
    const ladder = await get(`/api/assets/${row.assetId}/versions`);
    expect(ladder.status).toBe(200);
    expect(ladder.body.asset.base).toBe('100_ALPHA_MAIN_LL180');
  });

  it('filters by songFolder', async () => {
    const { body } = await get('/api/files?songFolder=100_ALPHA&limit=2000');
    expect(body.total).toBe(17);
    expect(body.rows.every((r: any) => r.songFolder === '100_ALPHA')).toBe(true);
  });

  it('filters by ext', async () => {
    expect((await get('/api/files?ext=mov&limit=2000')).body.total).toBe(29);
    expect((await get('/api/files?ext=txt,tif&limit=2000')).body.total).toBe(4);
  });

  it('COMPOSES filters as a conjunction', async () => {
    const { body } = await get('/api/files?ext=mov&minSize=5000&limit=2000');
    expect(body.total).toBe(7);
    expect(body.rows.every((r: any) => r.ext === 'mov' && r.size >= 5000)).toBe(true);

    const narrower = await get('/api/files?ext=mov&minSize=5000&songFolder=100_ALPHA&limit=2000');
    expect(narrower.body.total).toBe(2);

    const withMtime = await get(
      '/api/files?ext=mov&minSize=5000&songFolder=100_ALPHA&mtimeTo=1000&limit=2000',
    );
    expect(withMtime.body.total).toBe(0);
    expect(withMtime.body.matchedBytes).toBe(0);
  });

  it('applies q as a case-insensitive substring of the path', async () => {
    const { body } = await get('/api/files?q=render-log&limit=2000');
    expect(body.total).toBe(2);
  });

  it('applies pathRe in JS, not in SQL', async () => {
    const { body } = await get('/api/files?pathRe=_region2%5C.mov%24&limit=2000');
    expect(body.total).toBe(8);
    expect(body.rows.every((r: any) => /_region2\.mov$/.test(r.relPath))).toBe(true);
  });

  it('applies an anchored glob for path', async () => {
    const { body } = await get('/api/files?path=100_ALPHA/*_region1.mov&limit=2000');
    expect(body.total).toBe(6);
    expect(body.rows.every((r: any) => r.songFolder === '100_ALPHA')).toBe(true);
  });

  it('ANDs path and pathRe together', async () => {
    const { body } = await get('/api/files?path=100_ALPHA/**&pathRe=frame&limit=2000');
    expect(body.total).toBe(2);
  });

  it('rejects a malformed pathRe with a 400 instead of running it', async () => {
    const { status, body } = await get('/api/files?pathRe=%28%5B');
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_regex');
  });

  /**
   * Pixel dimensions come from `npm run probe`, which is a separate pass over
   * the archive. Three states have to survive the round trip, because the UI
   * says something different for each: dimensions on record, probed with none
   * (an interrupted render), and never probed.
   */
  it('reports pixel dimensions, and distinguishes unprobed from probed-and-empty', async () => {
    const { body } = await get('/api/files?songFolder=100_ALPHA&limit=2000');
    const byName = new Map(body.rows.map((r: any) => [r.name, r]));

    const measured: any = byName.get('100_ALPHA_MAIN_LL180_v001_region1.mov');
    expect(measured).toMatchObject({ width: 8996, height: 2584, probed: true });

    // Read cleanly, no header atom. NOT the same as 'not looked at'.
    const headerless: any = byName.get('100_ALPHA_MAIN_LL180_v001_proxy3_region0.mov');
    expect(headerless).toMatchObject({ width: null, height: null, probed: true });

    const untouched: any = byName.get('100_ALPHA_MAIN_LL180_v002_region1.mov');
    expect(untouched).toMatchObject({ width: null, height: null, probed: false });
  });

  it('sorts by resolution as pixel count, not by either axis alone', async () => {
    // 8996x2584 = 23.2M pixels beats 3976x3248 = 12.9M, though it is shorter.
    const { body } = await get('/api/files?sort=resolution&dir=desc&limit=2000');
    const withDims = body.rows.filter((r: any) => r.width);
    expect(withDims[0]).toMatchObject({ width: 8996, height: 2584 });
    expect(withDims[1]).toMatchObject({ width: 3976, height: 3248 });
    // Unprobed rows sort as zero pixels: they collect at one end rather than
    // scattering through the list.
    expect(body.rows.at(-1).width).toBeNull();
  });

  it('reports probe coverage on the summary, so the UI can say why a cell is empty', async () => {
    const { body } = await get('/api/summary?keepN=1');
    // `total` is the PROBEABLE population -- the .mov files, not every row.
    // Counting the .tif and .txt files would leave coverage permanently short
    // of 100% and the UI offering to resume a finished pass.
    expect(body.media).toMatchObject({ probed: 3, withDimensions: 2, total: TOTAL_MOV_FILES });
    expect(TOTAL_MOV_FILES).toBeLessThan(TOTAL_FILES);
  });

  it('filters by the version-derived columns through the join', async () => {
    expect((await get('/api/files?isPatch=1&limit=2000')).body.total).toBe(2);
    expect((await get('/api/files?hasProxy=1&limit=2000')).body.total).toBe(14);
    expect((await get('/api/files?family=ANIMATIC&limit=2000')).body.total).toBe(1);
  });
});

// ===========================================================================
describe('GET /api/files -- paging', () => {
  it('reports the FULL total and matchedBytes on every page', async () => {
    const first = await get('/api/files?sort=size&dir=desc&limit=5&offset=0');
    expect(first.body.rows).toHaveLength(5);
    expect(first.body.total).toBe(TOTAL_FILES);
    expect(first.body.matchedBytes).toBe(TOTAL_FILE_BYTES);

    const last = await get('/api/files?sort=size&dir=desc&limit=5&offset=30');
    expect(last.body.rows).toHaveLength(3);
    expect(last.body.total).toBe(TOTAL_FILES);
    expect(last.body.matchedBytes).toBe(TOTAL_FILE_BYTES);
  });

  it('pages are disjoint and cover the whole result', async () => {
    const ids: number[] = [];
    for (let offset = 0; offset < TOTAL_FILES; offset += 7) {
      const { body } = await get(`/api/files?sort=id&dir=asc&limit=7&offset=${offset}`);
      ids.push(...body.rows.map((r: any) => r.id));
    }
    expect(ids).toHaveLength(TOTAL_FILES);
    expect(new Set(ids).size).toBe(TOTAL_FILES);
  });

  it('pages correctly on the JS path too (pathRe forces it)', async () => {
    const all = await get('/api/files?pathRe=region&limit=2000');
    const page = await get('/api/files?pathRe=region&limit=3&offset=2');
    expect(page.body.total).toBe(all.body.total);
    expect(page.body.matchedBytes).toBe(all.body.matchedBytes);
    expect(page.body.rows).toHaveLength(3);
  });

  it('an offset past the end returns no rows but the same totals', async () => {
    const { body } = await get('/api/files?limit=10&offset=9999');
    expect(body.rows).toHaveLength(0);
    expect(body.total).toBe(TOTAL_FILES);
  });

  it('rejects a limit above the ceiling', async () => {
    const { status, body } = await get('/api/files?limit=2001');
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_param');
  });
});

// ===========================================================================
describe('sort column allowlisting', () => {
  it('accepts an allowlisted column and actually sorts', async () => {
    const asc = await get('/api/files?sort=size&dir=asc&limit=2000');
    const sizes = asc.body.rows.map((r: any) => r.size);
    expect([...sizes].sort((a: number, b: number) => a - b)).toEqual(sizes);
  });

  it('REJECTS an unknown column rather than interpolating it', async () => {
    const { status, body } = await get('/api/files?sort=bogus_column');
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_sort_column');
    expect(body.error.details.allowed).toContain('size');
  });

  it('rejects an injection attempt and leaves the database intact', async () => {
    const before = fx.db.prepare('SELECT COUNT(*) AS n FROM file').get() as { n: number };
    const attacks = [
      'size); DROP TABLE file;--',
      'size UNION SELECT 1',
      "size' OR '1'='1",
      'f.size',
    ];
    for (const attack of attacks) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/files?sort=${encodeURIComponent(attack)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_sort_column');
    }
    const after = fx.db.prepare('SELECT COUNT(*) AS n FROM file').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('rejects an unknown column on /versions and /songs too', async () => {
    expect((await get('/api/versions?sort=whatever')).body.error.code).toBe('bad_sort_column');
    expect((await get('/api/songs?sort=whatever')).body.error.code).toBe('bad_sort_column');
  });

  it('rejects a bad direction', async () => {
    const { status, body } = await get('/api/files?sort=size&dir=sideways');
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_sort_dir');
  });

  it('sorts /versions by the JS-only status column', async () => {
    const { body } = await get('/api/versions?keepN=1&sort=status&dir=asc&limit=2000');
    const statuses = body.rows.map((r: any) => r.status);
    expect([...statuses].sort()).toEqual(statuses);
  });
});

// ===========================================================================
describe('GET /api/versions', () => {
  it('returns every version with a verdict and a reason', async () => {
    const { body } = await get('/api/versions?keepN=1&limit=2000');
    expect(body.total).toBe(TOTAL_VERSIONS);
    expect(body.matchedBytes).toBe(TOTAL_VERSION_BYTES);
    for (const row of body.rows) {
      expect(['kept', 'superseded']).toContain(row.status);
      expect(typeof row.keepReason).toBe('string');
      expect(row.keepReason.startsWith(row.status === 'kept' ? 'kept-' : 'superseded-')).toBe(true);
    }
  });

  it('surfaces the patch reasons verbatim from computeReclaim', async () => {
    const { body } = await get('/api/versions?keepN=1&songFolder=100_ALPHA&isPatch=1&limit=2000');
    const byLabel = new Map(body.rows.map((r: any) => [r.verLabel, r]));
    expect(byLabel.get('v004 frame00200')).toMatchObject({
      status: 'kept',
      keepReason: 'kept-patch-of-latest-full',
    });
    expect(byLabel.get('v002 frame00100')).toMatchObject({
      status: 'superseded',
      keepReason: 'superseded-patch',
    });
  });

  it('never supersedes an asset that has only one version', async () => {
    const { body } = await get('/api/versions?keepN=1&songFolder=300_GAMMA&limit=2000');
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].status).toBe('kept');
  });

  /**
   * `hasProxy=only` is the proxy-only rule made visible: a version with a
   * preview and NO regions behind it. It is a strict subset of hasProxy=1, and
   * the point of having it is being able to see those rows without reading
   * every version's region count by eye.
   */
  it('filters proxy-only versions apart from versions that merely have a proxy', async () => {
    const { body } = await get('/api/versions?hasProxy=only&limit=2000');
    expect(body.total).toBe(1);
    expect(body.rows[0].base).toBe('500_ECHO_PREVIEW_LL180');
    expect(body.rows[0].verLabel).toBe('v002');
    expect(body.rows[0].regionCount).toBe(0);
    expect(body.rows[0].proxyBytes).toBeGreaterThan(0);
    // And it does not supersede the region-bearing version beneath it.
    expect(body.rows[0].status).toBe('kept');
    const echoV1 = (await get('/api/versions?songFolder=500_ECHO&keepN=1&limit=2000')).body.rows.find(
      (r: any) => r.verLabel === 'v001',
    );
    expect(echoV1.status).toBe('kept');
  });

  it('maps hasProxy=only through the join for files too', async () => {
    const { body } = await get('/api/files?hasProxy=only&limit=2000');
    expect(body.total).toBe(1);
    expect(body.rows[0].relPath).toContain('proxy3_region0');
  });

  it('rejects a hasProxy value that is neither a boolean nor only', async () => {
    const { status, body } = await get('/api/versions?hasProxy=proxyish');
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_param');
  });

  it('filters on version-domain columns', async () => {
    expect((await get('/api/versions?hasProxy=1&limit=2000')).body.total).toBe(5);
    expect((await get('/api/versions?isPatch=1&limit=2000')).body.total).toBe(2);
    expect((await get('/api/versions?family=ANIMATIC&limit=2000')).body.total).toBe(1);
    expect(
      (await get('/api/versions?songFolder=100_ALPHA&isPatch=0&minSize=3200&limit=2000')).body.total,
    ).toBe(2);
  });

  it('maps minSize/maxSize onto version bytes, not file bytes', async () => {
    const { body } = await get('/api/versions?maxSize=3150&songFolder=100_ALPHA&limit=2000');
    expect(body.rows.every((r: any) => r.bytes <= 3150)).toBe(true);
    expect(body.total).toBe(4);
  });

  it('resolves pathRe through the versions files', async () => {
    const { body } = await get('/api/versions?pathRe=frame00200&limit=2000');
    expect(body.total).toBe(1);
    expect(body.rows[0].verLabel).toBe('v004 frame00200');
  });

  it('filters by status', async () => {
    const kept = await get('/api/versions?keepN=1&status=kept&limit=2000');
    const superseded = await get('/api/versions?keepN=1&status=superseded&limit=2000');
    expect(kept.body.total + superseded.body.total).toBe(TOTAL_VERSIONS);
    expect(kept.body.rows.every((r: any) => r.status === 'kept')).toBe(true);
    expect(superseded.body.rows.every((r: any) => r.status === 'superseded')).toBe(true);
  });
});

// ===========================================================================
describe('GET /api/assets/:assetId/versions', () => {
  it('returns the ladder oldest first', async () => {
    const assetId = fx.assetIds.get('200_BETA_EDIT_LL180');
    const { status, body } = await get(`/api/assets/${assetId}/versions?keepN=1`);
    expect(status).toBe(200);
    expect(body.asset.base).toBe('200_BETA_EDIT_LL180');
    const labels = body.versions.map((v: any) => v.verLabel);
    // A bare version sorts before its lettered siblings.
    expect(labels).toEqual(['v001', 'v001a', 'v002']);
    expect(body.versions.every((v: any) => typeof v.keepReason === 'string')).toBe(true);
  });

  it('404s an unknown asset', async () => {
    const { status, body } = await get('/api/assets/99999/versions');
    expect(status).toBe(404);
    expect(body.error.code).toBe('asset_not_found');
  });
});

// ===========================================================================
describe('GET /api/reclaim -- honours the active filter set', () => {
  it('reports the whole archive when unfiltered', async () => {
    const { body } = await get('/api/reclaim?keepN=1');
    // 100_ALPHA loses v001+v002+v003 and its v002 patch; 200_BETA loses both
    // of its version-1 rows; 300_GAMMA loses nothing.
    expect(body.reclaimBytes).toBe(9_900 + 22_500 + 300);
    expect(body.supersededCount).toBe(7);
    expect(body.protectedPatchBytes).toBe(400);
    expect(body.totalBytes).toBe(TOTAL_VERSION_BYTES);
    expect(body.filtered).toBe(false);
  });

  it('narrows to the filtered view', async () => {
    const { body } = await get('/api/reclaim?keepN=1&songFolder=100_ALPHA');
    expect(body.reclaimBytes).toBe(9_900);
    expect(body.supersededCount).toBe(4);
    expect(body.totalBytes).toBe(ALPHA_TOTAL);
    expect(body.protectedPatchBytes).toBe(400);
    expect(body.filtered).toBe(true);
    // The whole-archive figure is still reported alongside.
    expect(body.archive.reclaimBytes).toBe(32_700);
  });

  it('THE SAFETY PROPERTY: hiding a successor does not make a version safe', async () => {
    // maxSize=3150 hides v004 (11000 bytes) -- the version that supersedes
    // v001 and v003. Both must STILL be reported as superseded, because the
    // verdict is computed over the whole asset, not over the view.
    const { body } = await get('/api/reclaim?keepN=1&songFolder=100_ALPHA&maxSize=3150');
    expect(body.versionCount).toBe(4);
    expect(body.reclaimBytes).toBe(3_100 + 3_100 + 300);
    expect(body.supersededCount).toBe(3);

    const rows = (await get('/api/versions?keepN=1&songFolder=100_ALPHA&maxSize=3150&limit=2000'))
      .body.rows;
    const v001 = rows.find((r: any) => r.verLabel === 'v001');
    expect(v001.status).toBe('superseded');
    expect(v001.keepReason).toBe('superseded-full');
  });

  it('IGNORES status, because that predicate would make the answer circular', async () => {
    // status=superseded would otherwise report "100% of the view is
    // reclaimable, 0 retained", and status=kept the mirror image. Neither
    // tells the operator anything, so the route strips it.
    const plain = (await get('/api/reclaim?keepN=1&songFolder=100_ALPHA')).body;

    for (const status of ['kept', 'superseded']) {
      const { body } = await get(
        `/api/reclaim?keepN=1&songFolder=100_ALPHA&status=${status}`,
      );
      expect(body.reclaimBytes).toBe(plain.reclaimBytes);
      expect(body.keptBytes).toBe(plain.keptBytes);
      expect(body.totalBytes).toBe(plain.totalBytes);
      expect(body.supersededCount).toBe(plain.supersededCount);
      expect(body.protectedPatchBytes).toBe(plain.protectedPatchBytes);
      expect(body.bySong).toEqual(plain.bySong);
      // ...and says so, rather than silently dropping it.
      expect(body.ignoredStatusFilter).toBe(status);
    }
    expect(plain.ignoredStatusFilter).toBeNull();
  });

  it('still composes every OTHER filter alongside an ignored status', async () => {
    const withStatus = (
      await get('/api/reclaim?keepN=1&songFolder=100_ALPHA&maxSize=3150&status=kept')
    ).body;
    const without = (await get('/api/reclaim?keepN=1&songFolder=100_ALPHA&maxSize=3150')).body;
    expect(withStatus.reclaimBytes).toBe(without.reclaimBytes);
    expect(withStatus.versionCount).toBe(4);
  });

  it('a bogus status is still a 400 -- ignored, not unvalidated', async () => {
    const { status, body } = await get('/api/reclaim?status=deleted');
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_param');
  });

  it('/api/versions DOES still honour status -- narrowing a list is reasonable', async () => {
    const kept = await get('/api/versions?keepN=1&status=kept&limit=2000');
    expect(kept.body.rows.every((r: any) => r.status === 'kept')).toBe(true);
    expect(kept.body.total).toBeLessThan(TOTAL_VERSIONS);
  });

  it('disjoint filters partition the unfiltered total', async () => {
    const whole = (await get('/api/reclaim?keepN=1')).body;
    let sum = 0;
    let count = 0;
    for (const song of ['100_ALPHA', '200_BETA', '300_GAMMA', '400_DELTA']) {
      const part = (await get(`/api/reclaim?keepN=1&songFolder=${song}`)).body;
      sum += part.reclaimBytes;
      count += part.supersededCount;
    }
    expect(sum).toBe(whole.reclaimBytes);
    expect(count).toBe(whole.supersededCount);
  });

  it('bySong adds up to the headline figure', async () => {
    const { body } = await get('/api/reclaim?keepN=1');
    const sum = body.bySong.reduce((n: number, s: any) => n + s.reclaimBytes, 0);
    expect(sum).toBe(body.reclaimBytes);
  });

  it('reclaim falls as keepN rises, and kept + reclaimed is invariant', async () => {
    const seen: number[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const { body } = await get(`/api/reclaim?keepN=${n}&songFolder=100_ALPHA`);
      seen.push(body.reclaimBytes);
      expect(body.keptBytes + body.reclaimBytes).toBe(ALPHA_TOTAL);
      // A patch on the current master is protected at EVERY N.
      expect(body.protectedPatchBytes).toBe(400);
    }
    expect(seen).toEqual([9_900, 6_800, 3_400, 300, 300]);
  });

  it('rejects keepN below 1', async () => {
    expect((await get('/api/reclaim?keepN=0')).status).toBe(400);
  });
});

// ===========================================================================
describe('GET /api/songs', () => {
  it('rolls up files and versions per folder', async () => {
    const { body } = await get('/api/songs?keepN=1');
    const bySong = new Map(body.rows.map((r: any) => [r.songFolder, r]));
    expect(bySong.size).toBe(5);

    const alpha: any = bySong.get('100_ALPHA');
    expect(alpha.fileCount).toBe(17);
    expect(alpha.assetCount).toBe(1);
    expect(alpha.versionCount).toBe(6);
    expect(alpha.supersededBytes).toBe(9_900);

    const gamma: any = bySong.get('300_GAMMA');
    expect(gamma.supersededBytes).toBe(0);
  });

  it('honours filters in both domains', async () => {
    const { body } = await get('/api/songs?songFolder=200_BETA');
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].songFolder).toBe('200_BETA');
  });
});

// ===========================================================================
describe('GET /api/summary', () => {
  it('gives the dashboard its headline numbers', async () => {
    const { body } = await get('/api/summary?keepN=1');
    expect(body.files.count).toBe(TOTAL_FILES);
    expect(body.files.totalBytes).toBe(TOTAL_FILE_BYTES);
    expect(body.songCount).toBe(5);
    expect(body.assetCount).toBe(5);
    expect(body.versionCount).toBe(TOTAL_VERSIONS);
    expect(body.patchVersionCount).toBe(2);
    expect(body.reclaim.reclaimBytes).toBe(32_700);
    expect(body.excluded).toEqual({ count: 7, bytes: 2048 });
  });

  it('carries the filter panel option lists, so the page needs no second call', async () => {
    // These exist so the song dropdown fills from the load the page already
    // does, instead of a /api/songs?limit=2000 round trip that fetches
    // thousands of statistics rows to read a handful of names off.
    const { body } = await get('/api/summary');

    expect(Array.isArray(body.songFolders)).toBe(true);
    expect(body.songFolders.length).toBe(body.songCount);
    expect([...body.songFolders]).toEqual([...body.songFolders].sort());
    expect(new Set(body.songFolders).size).toBe(body.songFolders.length);

    // Extensions, most common first, with counts alongside.
    expect(Array.isArray(body.extensions)).toBe(true);
    expect(body.extensions.length).toBeGreaterThan(0);
    expect(body.extensions).not.toContain('');
    expect(body.extensions.some((e: string) => e.startsWith('.'))).toBe(false);
    expect(body.byExtension.map((e: any) => e.ext)).toEqual(body.extensions);
    const counts = body.byExtension.map((e: any) => e.count);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
    expect(counts.reduce((a: number, b: number) => a + b, 0)).toBe(body.files.count);
  });

  it('scopes the option lists to the requested snapshot', async () => {
    const { body } = await get('/api/summary');
    const { body: other } = await get(`/api/summary?snapshotId=${body.snapshotId}`);
    expect(other.songFolders).toEqual(body.songFolders);
  });

  it('precomputes the slider curve, which is monotonically non-increasing', async () => {
    const { body } = await get('/api/summary');
    const values = body.reclaimByKeepN.map((p: any) => p.reclaimBytes);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
    }
  });
});

// ===========================================================================
describe('a file row carries its version\'s verdict', () => {
  // A file has no fate of its own: it goes or stays with its version. The
  // Files view shows the same keep/slated flag the versions view does, so the
  // two must come from the same computation and can never disagree.

  it('reports status and keepReason on every file that belongs to a version', async () => {
    const { body } = await get('/api/files?keepN=1&limit=50');
    const parsed = body.rows.filter((r: any) => r.assetVersionId !== null);
    expect(parsed.length).toBeGreaterThan(0);
    for (const r of parsed) {
      expect(['kept', 'superseded'], r.name).toContain(r.status);
      expect(r.keepReason, r.name).toBeTruthy();
    }
  });

  it('says unknown — not kept — for a file that belongs to no version', async () => {
    // Guessing either way would be wrong: an unparsed file has no verdict,
    // and calling it "kept" would imply the policy had considered it.
    const { body } = await get('/api/files?keepN=1&limit=200');
    const orphans = body.rows.filter((r: any) => r.assetVersionId === null);
    if (orphans.length === 0) return;
    for (const r of orphans) {
      expect(r.status, r.name).toBe('unknown');
      expect(r.keepReason, r.name).toBeNull();
    }
  });

  it('agrees with the versions view about the same version', async () => {
    const v = (await get('/api/versions?keepN=1&status=superseded&limit=1')).body.rows[0];
    const { body } = await get(`/api/files?keepN=1&limit=2000`);
    const mine = body.rows.filter((r: any) => r.assetVersionId === v.versionId);
    expect(mine.length).toBeGreaterThan(0);
    for (const r of mine) {
      expect(r.status).toBe(v.status);
      expect(r.keepReason).toBe(v.keepReason);
    }
  });

  it('moves with keepN, like the version verdict it mirrors', async () => {
    const at1 = (await get('/api/files?keepN=1&limit=200')).body.rows as any[];
    const at9 = (await get('/api/files?keepN=9&limit=200')).body.rows as any[];
    const slated1 = at1.filter((r) => r.status === 'superseded').length;
    const slated9 = at9.filter((r) => r.status === 'superseded').length;
    expect(slated9).toBeLessThanOrEqual(slated1);
  });
});

// ===========================================================================
describe('versionIds / excludeIds -- the "only what I marked" filter', () => {
  // A selection lives in the browser, so the server has to be told which rows
  // it is. Two shapes: explicit ticks (versionIds), and select-all-matched
  // with un-ticked exceptions (excludeIds).

  it('restricts to exactly the ids given', async () => {
    const all = (await get('/api/versions?keepN=1&limit=5')).body.rows as { versionId: number }[];
    const picked = all.slice(0, 3).map((r) => r.versionId);

    const { status, body } = await get(`/api/versions?keepN=1&versionIds=${picked.join(',')}`);
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.rows.map((r: any) => r.versionId).sort()).toEqual([...picked].sort());
  });

  it('excludeIds removes rows from whatever else matched', async () => {
    const all = (await get('/api/versions?keepN=1&limit=5')).body.rows as { versionId: number }[];
    const picked = all.slice(0, 3).map((r) => r.versionId);
    const dropped = picked[0] as number;

    const { body } = await get(
      `/api/versions?keepN=1&versionIds=${picked.join(',')}&excludeIds=${dropped}`,
    );
    expect(body.total).toBe(2);
    expect(body.rows.map((r: any) => r.versionId)).not.toContain(dropped);
  });

  it('composes with the other filters rather than overriding them', async () => {
    const kept = (await get('/api/versions?keepN=1&status=kept&limit=3')).body.rows as {
      versionId: number;
    }[];
    const ids = kept.map((r) => r.versionId).join(',');
    // Same ids, opposite status: the two must intersect, not replace.
    const { body } = await get(`/api/versions?keepN=1&status=superseded&versionIds=${ids}`);
    expect(body.total).toBe(0);
  });

  it('an unknown id simply matches nothing', async () => {
    const { status, body } = await get('/api/versions?keepN=1&versionIds=999999');
    expect(status).toBe(200);
    expect(body.total).toBe(0);
  });

  it('rejects non-numeric or non-positive ids', async () => {
    for (const bad of ['abc', '1,abc', '0', '-3', '1.5']) {
      const { status, body } = await get(`/api/versions?versionIds=${encodeURIComponent(bad)}`);
      expect(status, bad).toBe(400);
      expect(body.error.code, bad).toBe('bad_param');
    }
  });

  it('caps the id list so a malformed request cannot bind a huge statement', async () => {
    const tooMany = Array.from({ length: MAX_ID_LIST + 1 }, (_, i) => i + 1).join(',');
    const { status, body } = await get(`/api/versions?versionIds=${tooMany}`);
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_param');
  });

  it('scopes /api/reclaim like any other filter, without changing a verdict', async () => {
    // versionIds filters the OUTPUT, exactly as songFolder does: computeReclaim
    // still runs over the whole snapshot and only the counted rows change. So
    // this is safe, and "what do my ticked rows reclaim" is a fair question to
    // be able to ask.
    //
    // The UI nonetheless never sends it to this route -- the headline must
    // answer "what does the POLICY say is reclaimable", not "what have I
    // ticked" -- which is why selectionParams() is kept out of filterParams().
    const whole = (await get('/api/reclaim?keepN=1')).body.reclaimBytes;
    const superseded = (await get('/api/versions?keepN=1&status=superseded&limit=1')).body
      .rows as { versionId: number; bytes: number }[];
    const one = superseded[0] as (typeof superseded)[number];

    const scoped = (await get(`/api/reclaim?keepN=1&versionIds=${one.versionId}`)).body;
    expect(scoped.reclaimBytes).toBe(one.bytes);
    expect(scoped.reclaimBytes).toBeLessThan(whole);
    // The verdict itself is unchanged: still superseded, still the same bytes.
    const row = (await get(`/api/versions?keepN=1&versionIds=${one.versionId}`)).body.rows[0];
    expect(row.status).toBe('superseded');
    expect(row.bytes).toBe(one.bytes);
  });
});

// ===========================================================================
/**
 * The delete route destroys rows, so it gets its OWN fixture and its own
 * server. Sharing the module-level one would have every later test in this
 * file run against an index this describe had already emptied -- which is
 * exactly what happened on the first attempt: 21 unrelated failures.
 */
describe('DELETE /api/snapshots/:id', () => {
  let dfx: Fixture;
  let dapp: FastifyInstance;
  let ddir: string;

  beforeAll(() => {
    dfx = makeFixture();
    ddir = realpathSync(mkdtempSync(join(tmpdir(), 'metal-media-size-del-')));
    dapp = buildServer({ db: dfx.db, cfg: dfx.cfg, exportsDir: ddir }).app;
  });

  afterAll(async () => {
    await dapp.close();
    dfx.db.close();
    rmSync(ddir, { recursive: true, force: true });
  });

  const dget = async (url: string) => {
    const res = await dapp.inject({ method: 'GET', url });
    return { status: res.statusCode, body: res.json() };
  };
  const ddel = async (url: string) => {
    const res = await dapp.inject({ method: 'DELETE', url });
    return { status: res.statusCode, body: res.json() };
  };

  it('404s on a snapshot that does not exist', async () => {
    const { status, body } = await ddel('/api/snapshots/99999');
    expect(status).toBe(404);
    expect(body.error.code).toBe('snapshot_not_found');
  });

  it('never reaches the archive', async () => {
    const openRead = vi.spyOn(ReadOnlyFs.prototype, 'openRead');
    const readdir = vi.spyOn(ReadOnlyFs.prototype, 'readdir');
    const lstat = vi.spyOn(ReadOnlyFs.prototype, 'lstat');
    try {
      await ddel('/api/snapshots/99999');
      expect(openRead).not.toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();
      expect(lstat).not.toHaveBeenCalled();
    } finally {
      openRead.mockRestore();
      readdir.mockRestore();
      lstat.mockRestore();
    }
  });

  it('the route cannot write to the filesystem at all', async () => {
    // The one destructive route in the server. It removes DATABASE ROWS; it
    // must not be able to remove anything else, so it may not reach node:fs.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/server/routes/snapshots.ts', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"]node:fs/);
    expect(src).not.toMatch(/ReadOnlyFs/);
  });

  // Ordered last: it empties the fixture index.
  it('removes the snapshot and everything hanging off it, and says what went', async () => {
    const before = (await dget('/api/snapshots')).body as { id: number }[];
    expect(before.length).toBeGreaterThan(0);
    const target = before[0]?.id as number;

    const { status, body } = await ddel(`/api/snapshots/${target}`);
    expect(status).toBe(200);
    expect(body.deleted.snapshotId).toBe(target);
    // Counted BEFORE the delete, so they describe what was removed.
    expect(body.deleted.files).toBeGreaterThan(0);
    expect(body.deleted.assets).toBeGreaterThan(0);
    expect(body.deleted.versions).toBeGreaterThan(0);
    expect(body.remaining).toBe(before.length - 1);
    // The wording is load-bearing: this removes an index entry, and the UI
    // must never let a user believe it removed a render.
    expect(body.note).toMatch(/No file in the archive was touched/i);

    // ON DELETE CASCADE really fired -- nothing orphaned behind it.
    const after = (await dget('/api/snapshots')).body as { id: number }[];
    expect(after.some((s) => s.id === target)).toBe(false);
    expect((await dget(`/api/snapshots/${target}`)).status).toBe(404);
    expect((await dget(`/api/versions?snapshotId=${target}`)).status).toBe(404);
    expect(dfx.db.prepare('SELECT COUNT(*) AS n FROM file WHERE snapshot_id = ?').get(target)).toEqual({ n: 0 });
    expect(dfx.db.prepare('SELECT COUNT(*) AS n FROM asset WHERE snapshot_id = ?').get(target)).toEqual({ n: 0 });
  });
});

// ===========================================================================
describe('GET /api/duplicates', () => {
  it('NEVER opens a file', async () => {
    const readdir = vi.spyOn(ReadOnlyFs.prototype, 'readdir');
    const lstat = vi.spyOn(ReadOnlyFs.prototype, 'lstat');
    const openRead = vi.spyOn(ReadOnlyFs.prototype, 'openRead');
    try {
      const { status } = await get('/api/duplicates?mode=name-size');
      expect(status).toBe(200);
      expect(openRead).not.toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();
      expect(lstat).not.toHaveBeenCalled();
    } finally {
      readdir.mockRestore();
      lstat.mockRestore();
      openRead.mockRestore();
    }
  });

  it('the duplicates route imports no filesystem capability at all', async () => {
    // A static check to back up the runtime one: the module must not even be
    // able to reach the archive.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../../src/server/routes/duplicates.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    expect(source).not.toMatch(/ReadOnlyFs/);
    expect(source).not.toMatch(/openRead/);
    expect(source).not.toMatch(/from ['"]node:fs/);
  });

  it('labels every result as unverified', async () => {
    const { body } = await get('/api/duplicates?mode=name-size');
    expect(body.verified).toBe(false);
    expect(body.label).toBe('likely duplicate — content not verified');
    expect(body.rows.every((g: any) => g.verified === false)).toBe(true);
    expect(body.rows.every((g: any) => g.label === body.label)).toBe(true);
  });

  it('name-size finds the same basename at the same size in two folders', async () => {
    const { body } = await get('/api/duplicates?mode=name-size');
    expect(body.total).toBe(1);
    expect(body.rows[0].count).toBe(2);
    expect(body.rows[0].songFolders.sort()).toEqual(['100_ALPHA', '200_BETA']);
    expect(body.rows[0].wastedBytes).toBe(512);
  });

  it('ignores zero-byte files, which are an anomaly not a duplicate', async () => {
    const { body } = await get('/api/duplicates?mode=name-size');
    const members = body.rows.flatMap((g: any) => g.members);
    expect(members.every((m: any) => m.size > 0)).toBe(true);
  });

  it('name-size is the only mode, and the default', async () => {
    const { body } = await get('/api/duplicates');
    expect(body.mode).toBe('name-size');
  });

  it('a link saved with a retired mode still opens, on the surviving mode', async () => {
    // `version-shape` was the default before it was removed, so bookmarked
    // views and "Copy link to this view" URLs carry it. Those should land
    // somewhere sensible rather than on an error.
    for (const retired of ['version-shape', 'size-mtime']) {
      const { status, body } = await get(`/api/duplicates?mode=${retired}`);
      expect(status).toBe(200);
      expect(body.mode).toBe('name-size');
    }
  });

  it('rejects an unknown mode', async () => {
    const { status, body } = await get('/api/duplicates?mode=checksum');
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_mode');
  });
});

// ===========================================================================
describe('GET /api/anomalies', () => {
  it('reports every category', async () => {
    const { status, body } = await get('/api/anomalies');
    expect(status).toBe(200);

    // 200_BETA v001a has region 1 but the asset's layout is regions 1 and 2;
    // 400_DELTA v002 is missing region 2 on the current master.
    expect(body.counts.missingRegions).toBe(2);
    const missing = new Map(body.missingRegions.map((m: any) => [m.base, m]));
    expect((missing.get('200_BETA_EDIT_LL180') as any).missing).toEqual([2]);
    expect((missing.get('400_DELTA_FULL_LL180') as any).missing).toEqual([2]);

    // 100_ALPHA v002 carries a region-9 file no other version has.
    expect(body.orphanRegions).toHaveLength(1);
    expect(body.orphanRegions[0].region).toBe(9);

    expect(body.counts.unparsed).toBe(6);
    expect(body.counts.zeroByte).toBe(1);
    expect(body.zeroByte[0].name).toBe('empty.txt');

    // FreeFileSync bookkeeping stays visible.
    expect(body.excluded.count).toBe(7);
    expect(body.excluded.bytes).toBe(2048);
    expect(body.excluded.skippedDirs).toHaveLength(1);
  });

  /**
   * The one anomaly that needs a probe. A file that read cleanly and carries
   * no header atom is a render interrupted before its header was written --
   * bytes on disk that nothing can play. It must not be conflated with a file
   * nobody has probed, and an unprobed archive must not report 'none found' as
   * though the question had been asked.
   */
  it('reports files that were probed and turned out to have no header', async () => {
    const { body } = await get('/api/anomalies');
    expect(body.counts.noHeader).toBe(1);
    expect(body.noHeader[0].name).toBe('100_ALPHA_MAIN_LL180_v001_proxy3_region0.mov');
    expect(body.noHeader[0].reason).toContain('no header atom');
    // 100_ALPHA has a v004 full render above v001, so this is not a live master.
    expect(body.noHeader[0].severity).toBe('low');
    expect(body.noHeader[0].supersededBy).toBe('v004');
    // The size is the point of the row -- a 140 GB unplayable file is not a
    // footnote -- so it has to survive to the client.
    expect(body.noHeader[0].size).toBeGreaterThan(0);
  });

  it('says what the header check actually covered, so an empty list is not a clean bill of health', async () => {
    const { body } = await get('/api/anomalies');
    expect(body.probeCoverage).toMatchObject({ probed: 3, total: TOTAL_MOV_FILES });
    expect(body.probeCoverage.probed).toBeLessThan(body.probeCoverage.total);
  });

  it('counts headerless files in the severity totals like every other category', async () => {
    const { body } = await get('/api/anomalies');
    expect(body.severity.byCategory.noHeader).toEqual({ high: 0, low: 1 });
    const cats = body.severity.byCategory;
    const summed = Object.values(cats).reduce((n: number, c: any) => n + c.high + c.low, 0);
    expect(body.severity.high + body.severity.low).toBe(summed);
  });

  it('leaves a zero-byte file to the zeroByte category rather than reporting it twice', async () => {
    const { body } = await get('/api/anomalies');
    const zeroNames = new Set(body.zeroByte.map((z: any) => z.name));
    for (const row of body.noHeader) expect(zeroNames.has(row.name)).toBe(false);
  });

  it('distinguishes a failed .mov from a file the grammar never covered', async () => {
    const { body } = await get('/api/anomalies');
    const byName = new Map(body.unparsed.map((u: any) => [u.name, u]));
    expect((byName.get('100_ALPHA_QC_A_LL180_v001.tif') as any).reason).toContain(
      'out of grammar scope',
    );
    expect((byName.get('100_ALPHA_MAIN_LL180_v0002b_region4_.mov') as any).reason).toContain(
      'did not match the filename grammar',
    );
  });
});

// ===========================================================================
describe('anomaly severity', () => {
  it("a defect on a CURRENT MASTER is 'high' with no supersededBy", async () => {
    const { body } = await get('/api/anomalies');
    // 400_DELTA v002 is the newest full version of its asset. Nothing fixes it.
    const row = body.missingRegions.find((m: any) => m.base === '400_DELTA_FULL_LL180');
    expect(row.verLabel).toBe('v002');
    expect(row.severity).toBe('high');
    expect(row.supersededBy).toBeNull();
  });

  it("the SAME defect on a version with a newer full sibling is 'low'", async () => {
    const { body } = await get('/api/anomalies');
    // 200_BETA v001a is missing region 2 too, but v002 came after it.
    const row = body.missingRegions.find((m: any) => m.base === '200_BETA_EDIT_LL180');
    expect(row.verLabel).toBe('v001a');
    expect(row.severity).toBe('low');
    expect(row.supersededBy).toBe('v002');
  });

  it('orphan regions are graded the same way', async () => {
    const { body } = await get('/api/anomalies');
    // The stray region-9 file sits on 100_ALPHA v002; v004 is the newest full.
    expect(body.orphanRegions[0].severity).toBe('low');
    expect(body.orphanRegions[0].supersededBy).toBe('v004');
  });

  it('an unparsed file is attributed by base prefix and graded', async () => {
    const { body } = await get('/api/anomalies');
    const byName = new Map(body.unparsed.map((u: any) => [u.name, u]));

    // Mirrors the real 520_THICKET case: grammar rejected it, but the base still
    // identifies the asset and v003/v004 are newer than the v002b it names.
    const low: any = byName.get('100_ALPHA_MAIN_LL180_v0002b_region4_.mov');
    expect(low.base).toBe('100_ALPHA_MAIN_LL180');
    expect(low.severity).toBe('low');
    expect(low.supersededBy).toBe('v004');

    // Attributable, but nothing in the asset ranks newer than v002b.
    const high: any = byName.get('400_DELTA_FULL_LL180_v0002b_region9_.mov');
    expect(high.base).toBe('400_DELTA_FULL_LL180');
    expect(high.severity).toBe('high');
    expect(high.supersededBy).toBeNull();
  });

  it("an UNATTRIBUTABLE unparsed file is 'high' -- the conservative answer", async () => {
    const { body } = await get('/api/anomalies');
    const byName = new Map(body.unparsed.map((u: any) => [u.name, u]));
    for (const name of ['render-log.txt', '100_ALPHA_QC_A_LL180_v001.tif']) {
      const row: any = byName.get(name);
      expect(row.assetId).toBeNull();
      expect(row.base).toBeNull();
      expect(row.severity).toBe('high');
      expect(row.supersededBy).toBeNull();
    }
  });

  it('zero-byte files are graded too', async () => {
    const { body } = await get('/api/anomalies');
    expect(body.zeroByte[0].severity).toBe('high');
    expect(body.zeroByte[0].supersededBy).toBeNull();
  });

  it('THE INVARIANT: severity does not move when keepN moves', async () => {
    // Severity is a property of the archive -- "does a newer full version
    // exist" -- not of the reclaim view. If it tracked keepN, the same defect
    // would change importance as the operator dragged the slider.
    const fingerprint = (body: any): string =>
      JSON.stringify([
        ...body.missingRegions,
        ...body.orphanRegions,
        ...body.unparsed,
        ...body.zeroByte,
      ].map((r: any) => [r.fileId ?? r.versionId, r.severity, r.supersededBy]));

    const base = fingerprint((await get('/api/anomalies?keepN=1')).body);
    for (const keepN of [2, 3, 4, 5, 50]) {
      expect(fingerprint((await get(`/api/anomalies?keepN=${keepN}`)).body)).toBe(base);
    }
    // And identical to the request that names no keepN at all.
    expect(fingerprint((await get('/api/anomalies')).body)).toBe(base);
  });

  it('summarises the counts so the UI need not pull every row', async () => {
    const { body } = await get('/api/anomalies');
    expect(body.severity.byCategory).toEqual({
      missingRegions: { high: 1, low: 1 },
      orphanRegions: { high: 0, low: 1 },
      unparsed: { high: 5, low: 1 },
      zeroByte: { high: 1, low: 0 },
      noHeader: { high: 0, low: 1 },
    });
    expect(body.severity.high).toBe(7);
    expect(body.severity.low).toBe(4);
  });

  it('filters rows by severity, without moving the counts', async () => {
    const high = (await get('/api/anomalies?severity=high')).body;
    expect(high.severityFilter).toBe('high');
    const highRows = [
      ...high.missingRegions,
      ...high.orphanRegions,
      ...high.unparsed,
      ...high.zeroByte,
      ...high.noHeader,
    ];
    expect(highRows).toHaveLength(7);
    expect(highRows.every((r: any) => r.severity === 'high')).toBe(true);

    const low = (await get('/api/anomalies?severity=low')).body;
    const lowRows = [...low.missingRegions, ...low.orphanRegions, ...low.unparsed, ...low.zeroByte];
    expect(lowRows).toHaveLength(3);
    expect(lowRows.every((r: any) => r.severity === 'low')).toBe(true);

    // The chips must not move when one of them is clicked.
    expect(low.severity).toEqual(high.severity);
    expect(low.counts).toEqual(high.counts);
  });

  it('rejects an unknown severity', async () => {
    const { status, body } = await get('/api/anomalies?severity=medium');
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_severity');
  });
});

// ===========================================================================
describe('POST /api/export', () => {
  const validIds = (): number[] => [fx.versionIds.get('alpha-v1') as number];

  it("REJECTS deletionPolicy 'Permanent' with a 400", async () => {
    const { status, body } = await post('/api/export', {
      versionIds: validIds(),
      formats: ['ffs_gui'],
      deletionPolicy: 'Permanent',
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('deletion_policy_forbidden');
    expect(body.error.message).toContain('Permanent');
  });

  it("rejects 'Permanent' before any other validation, so it can never slip through", async () => {
    // Everything else about this request is also invalid; the policy still wins.
    const { status, body } = await post('/api/export', { deletionPolicy: 'Permanent' });
    expect(status).toBe(400);
    expect(body.error.code).toBe('deletion_policy_forbidden');
  });

  it('requires deletionPolicy', async () => {
    const { status, body } = await post('/api/export', {
      versionIds: validIds(),
      formats: ['json'],
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('deletion_policy_required');
  });

  it('rejects any other policy value', async () => {
    const { body } = await post('/api/export', {
      versionIds: validIds(),
      formats: ['json'],
      deletionPolicy: 'Bin',
    });
    expect(body.error.code).toBe('bad_deletion_policy');
  });

  it("requires a versioningFolder when the policy is 'Versioning'", async () => {
    const { status, body } = await post('/api/export', {
      versionIds: validIds(),
      formats: ['json'],
      deletionPolicy: 'Versioning',
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('versioning_folder_required');
  });

  it('rejects an unknown format', async () => {
    const { body } = await post('/api/export', {
      versionIds: validIds(),
      formats: ['csv'],
      deletionPolicy: 'RecycleBin',
    });
    expect(body.error.code).toBe('bad_formats');
  });

  it('rejects an empty or non-integer versionIds', async () => {
    expect(
      (await post('/api/export', { versionIds: [], formats: ['json'], deletionPolicy: 'RecycleBin' }))
        .body.error.code,
    ).toBe('bad_version_ids');
    expect(
      (
        await post('/api/export', {
          versionIds: ['1'],
          formats: ['json'],
          deletionPolicy: 'RecycleBin',
        })
      ).body.error.code,
    ).toBe('bad_version_ids');
  });

  it('rejects a versionId that is not in the snapshot', async () => {
    const { status, body } = await post('/api/export', {
      versionIds: [999_999],
      formats: ['json'],
      deletionPolicy: 'RecycleBin',
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('unknown_version_ids');
  });

  it('rejects versionIds that span two snapshots', async () => {
    // Same version in both snapshots -- alpha-v1 exists in the earlier one too.
    const prevId = fx.db
      .prepare(
        `SELECT av.version_id AS id FROM v_asset_version av
          WHERE av.snapshot_id = ? AND av.ver_label = 'v001' AND av.song_folder = '100_ALPHA'`,
      )
      .get(fx.snapshotIdPrev) as { id: number };
    const { status, body } = await post('/api/export', {
      versionIds: [...validIds(), prevId.id],
      formats: ['json'],
      deletionPolicy: 'RecycleBin',
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('mixed_snapshots');
  });

  it('a valid request reaches the exporter, or 503s while it is unbuilt', async () => {
    // `src/export/index.ts` belongs to another agent. Either answer is correct:
    // 503 before it ships, 201 after. What must NOT happen is this route
    // inventing an exporter of its own.
    const { status, body } = await post('/api/export', {
      versionIds: validIds(),
      formats: ['json', 'ffs_gui'],
      deletionPolicy: 'RecycleBin',
      note: 'test',
    });
    expect([201, 503]).toContain(status);
    if (status === 503) {
      expect(body.error.code).toBe('exporter_unavailable');
      return;
    }
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files.length).toBeGreaterThan(0);
    expect(body.summary.totalBytes).toBeGreaterThan(0);
    expect(body.selection.versionCount).toBe(1);
    expect(body.note).toContain('Nothing in the archive was changed');
    // Every artefact landed inside the scratch export directory, never in the
    // archive and never in the project's own exports/ folder during a test.
    for (const f of body.files) {
      expect(f.path.startsWith(exportsDir)).toBe(true);
      expect(existsSync(f.path)).toBe(true);
    }
  });
});

// ===========================================================================
describe('scan control', () => {
  it('reports an idle scanner before anything starts', async () => {
    const { status, body } = await get('/api/scan/status');
    expect(status).toBe(200);
    expect(body.running).toBe(false);
  });

  it('starts a scan without blocking and returns the snapshot id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/scan', payload: { name: 'probe' } });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(Number.isInteger(body.snapshotId)).toBe(true);
    expect(body.running).toBe(true);

    // The fixture root does not exist, so the walk ends quickly one way or the
    // other. Either outcome proves the request did not wait for it.
    await ctx.scans.settle();
    const after = (await get('/api/scan/status')).body;
    expect(after.running).toBe(false);
    expect(after.snapshotId).toBe(body.snapshotId);

    const row = fx.db
      .prepare('SELECT id, name FROM snapshot WHERE id = ?')
      .get(body.snapshotId) as { id: number; name: string };
    expect(row.name).toBe('probe');
  });

  it('rejects a non-string name', async () => {
    const { status, body } = await post('/api/scan', { name: 42 });
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_param');
  });
});

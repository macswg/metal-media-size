/**
 * ============================================================================
 *  REGION COVERAGE -- versions holding some of the canvas but not all
 * ============================================================================
 *
 * The thing this view can get wrong is inventing a gap. Every other figure in
 * the tool is measured in bytes and degrades gracefully when a filter narrows
 * it; a REGION SET does not. Narrow the evidence and a complete version reads
 * as a version missing thirteen slices, which is a defect report against a file
 * that is fine. So most of what follows is about where the evidence comes from:
 * the region index is built over the whole snapshot, always, and the filters
 * only decide which verdicts are reported.
 *
 * THE FIXTURE'S SLICE LAYOUT in the latest snapshot, which the expectations are
 * derived from rather than guessed at (region 0 is never a slice):
 *
 *   100_ALPHA_MAIN_LL180   v001 {1,2}  v002 {1,2,9}  v003 {1,2}  v004 {1,2}
 *                          v002 patch {1}   v004 patch {1}
 *   200_BETA_EDIT_LL180    v001 {1,2}  v001a {1}     v002 {1,2}
 *   300_GAMMA_ANIMATIC     v001 {1}
 *   400_DELTA_FULL_LL180   v001 {1,2}  v002 {1}
 *   500_ECHO_PREVIEW       v001 {1,2}  v002 {} (region0 only)
 *
 * The tests run against a required set of {1,2} -- a two-slice canvas -- so the
 * fixture's own layout is the interesting variable rather than the real rig's
 * fourteen. `requiredRegionsOf` is tested against the real rig separately.
 * ============================================================================
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server/app.ts';
import type { AppContext } from '../../src/server/context.ts';
import { makeFixture, type Fixture } from './fixture.ts';
import {
  buildCoverage,
  regionIndexOf,
  requiredRegionsOf,
  type CoverageReport,
} from '../../src/server/routes/coverage.ts';
import { selectVersions } from '../../src/server/select.ts';
import { buildSeverityIndex, loadVersionMeta } from '../../src/server/severity.ts';
import { DEFAULT_MACHINES, resolveMachines, type MachineSpec } from '../../src/machines.ts';
import type { FilterSpec } from '../../src/server/query.ts';

let fx: Fixture;
let app: FastifyInstance;
let ctx: AppContext;

/** The canvas the fixture is cut into. Two slices, not fourteen. */
const REQUIRED = [1, 2];

beforeAll(() => {
  fx = makeFixture();
  const built = buildServer({ db: fx.db, cfg: fx.cfg });
  app = built.app;
  ctx = built.ctx;
});

afterAll(async () => {
  await app.close();
  fx.db.close();
});

async function get(url: string): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
}

/**
 * Drive the report directly, the way the route does. `filters` narrows the
 * VERSIONS; the region index is always whole-snapshot, which is the point.
 */
function report(
  opts: { filters?: FilterSpec; includePatches?: boolean; required?: number[]; keepN?: number } = {},
): CoverageReport {
  const keepN = opts.keepN ?? 3;
  const versions = selectVersions(
    ctx,
    fx.snapshotId,
    opts.filters ?? {},
    keepN,
    'ORDER BY av.version_id ASC',
  );
  const { severityOfVersion } = buildSeverityIndex(loadVersionMeta(ctx.db, fx.snapshotId));
  return buildCoverage(
    versions,
    regionIndexOf(ctx, fx.snapshotId),
    opts.required ?? REQUIRED,
    severityOfVersion,
    { includePatches: opts.includePatches ?? false },
  );
}

const labelsOf = (r: CoverageReport): string[] => r.rows.map((x) => `${x.base} ${x.verLabel}`);

// ===========================================================================
describe('what a complete delivery requires', () => {
  it('is the non-zero regions the rig carries -- fourteen slices', () => {
    expect(requiredRegionsOf(DEFAULT_MACHINES)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
  });

  it('never requires region 0, which is the whole canvas and not a slice', () => {
    // 306 and 307 carry region 0 and nothing else. If region 0 were treated as
    // a slice, every version in the archive without an offline-edit copy would
    // be reported as incomplete.
    expect(requiredRegionsOf(DEFAULT_MACHINES)).not.toContain(0);
    expect(requiredRegionsOf([{ id: 'd', name: 'd', role: 'director', regions: [0] }])).toEqual([]);
  });

  it('follows the allocation rather than a hard-coded 14', () => {
    const rig: MachineSpec[] = [
      { id: 'a', name: 'a', role: 'actor', regions: [1, 2] },
      { id: 'b', name: 'b', role: 'understudy', regions: [2, 3] },
      { id: 'c', name: 'c', role: 'director', regions: [0] },
    ];
    // Deduplicated across machines and sorted: the rig is not a partition.
    expect(requiredRegionsOf(rig)).toEqual([1, 2, 3]);
  });

  it('is reported by the route together with where it came from', async () => {
    const { status, body } = await get('/api/coverage');
    expect(status).toBe(200);
    expect(body.requiredRegions).toEqual(requiredRegionsOf(resolveMachines().machines));
    expect(body.requiredCount).toBe(14);
    // 'built-in' is the real rig compiled into the source, not a placeholder.
    expect(body.allocationSource).toBe('built-in');
  });
});

// ===========================================================================
describe('which versions have gaps', () => {
  it('lists exactly the versions with some slices but not all', () => {
    expect(labelsOf(report()).sort()).toEqual([
      '200_BETA_EDIT_LL180 v001a',
      '300_GAMMA_ANIMATIC_LL180 v001',
      '400_DELTA_FULL_LL180 v002',
    ]);
  });

  it('says which slices are missing, not just how many', () => {
    const row = report().rows.find((r) => r.base === '400_DELTA_FULL_LL180');
    expect(row?.present).toEqual([1]);
    expect(row?.missing).toEqual([2]);
    expect(row?.missingCount).toBe(1);
  });

  it('does not report a version that has every required slice', () => {
    expect(labelsOf(report())).not.toContain('100_ALPHA_MAIN_LL180 v001');
  });

  it('reports a slice no machine carries as extra, never as a gap', () => {
    // alpha v002 is {1,2,9}: complete against a {1,2} canvas, with a region 9
    // that no machine holds. That is a fact about the rig, not a hole in the
    // delivery, and it must not put the version in the list.
    expect(labelsOf(report())).not.toContain('100_ALPHA_MAIN_LL180 v002');
    const wider = report({ required: [1, 2, 3] });
    const row = wider.rows.find((r) => r.verLabel === 'v002' && r.base === '100_ALPHA_MAIN_LL180');
    expect(row?.missing).toEqual([3]);
    expect(row?.extra).toEqual([9]);
  });

  it('never counts region 0 as a slice a version has', () => {
    // Every alpha version but v004 carries a proxy3_region0. If that counted,
    // `present` would include 0 and the arithmetic below would drift.
    for (const r of report({ required: [1, 2, 3] }).rows) {
      expect(r.present).not.toContain(0);
    }
  });
});

// ===========================================================================
describe('a version with no slices at all is not a version with gaps', () => {
  it('counts a region0-only version as a preview, and does not list it', () => {
    const r = report();
    // 500_ECHO v002 is nothing but its whole-canvas preview.
    expect(labelsOf(r)).not.toContain('500_ECHO_PREVIEW_LL180 v002');
    expect(r.counts.proxyOnlyVersions).toBe(1);
  });

  it('keeps the four buckets a partition of every version in view', () => {
    // The gesture the UI depends on: a reader can add these up and get the
    // whole archive, so a partial list never raises "what about the rest?".
    const r = report();
    const total =
      r.counts.completeVersions +
      r.counts.incompleteVersions +
      r.counts.proxyOnlyVersions +
      r.counts.regionlessVersions;
    const versionCount = (
      ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM v_asset_version WHERE snapshot_id = ?`)
        .get(fx.snapshotId) as { n: number }
    ).n;
    expect(total).toBe(versionCount);
  });

  it('keeps that partition whichever way the patch toggle is set', () => {
    const off = report({ includePatches: false }).counts;
    const on = report({ includePatches: true }).counts;
    expect(on.completeVersions).toBe(off.completeVersions);
    expect(on.incompleteVersions).toBe(off.incompleteVersions);
    expect(on.proxyOnlyVersions).toBe(off.proxyOnlyVersions);
    expect(on.regionlessVersions).toBe(off.regionlessVersions);
    // Only what is LISTED moves.
    expect(on.listedVersions).toBe(off.listedVersions + off.incompletePatchVersions);
  });
});

// ===========================================================================
describe('patches', () => {
  it('leaves a partial patch out of the list by default', () => {
    // A `_frameNNNNN` render covers a frame range, so touching one slice is
    // what a patch DOES. Listing every patch in the archive as broken would
    // make the view useless.
    const r = report();
    expect(r.counts.incompletePatchVersions).toBe(2);
    expect(r.rows.every((x) => !x.isPatch)).toBe(true);
  });

  it('shows them when asked, marked as patches', () => {
    const r = report({ includePatches: true });
    const patches = r.rows.filter((x) => x.isPatch);
    expect(patches).toHaveLength(2);
    expect(patches.every((x) => x.missing.includes(2))).toBe(true);
  });

  it('counts them either way, so they are never invisible', () => {
    expect(report({ includePatches: false }).counts.incompletePatchVersions).toBe(2);
    expect(report({ includePatches: true }).counts.incompletePatchVersions).toBe(2);
  });
});

// ===========================================================================
describe('severity', () => {
  it("is high when nothing newer exists -- the gap is on a current master", () => {
    const rows = report().rows;
    expect(rows.find((r) => r.base === '400_DELTA_FULL_LL180')?.severity).toBe('high');
    expect(rows.find((r) => r.base === '400_DELTA_FULL_LL180')?.supersededBy).toBeNull();
    // 300_GAMMA has exactly one version, so nothing can have fixed it.
    expect(rows.find((r) => r.base === '300_GAMMA_ANIMATIC_LL180')?.severity).toBe('high');
  });

  it('is low when a newer full version presumably re-rendered it away', () => {
    const beta = report().rows.find((r) => r.base === '200_BETA_EDIT_LL180');
    expect(beta?.severity).toBe('low');
    expect(beta?.supersededBy).toBe('v002');
  });

  it('does not move with keepN', async () => {
    // The invariant the anomalies panel already holds, restated here because
    // this route DOES read keepN (for `status`) and could drift into using it.
    const fingerprint = (b: any) =>
      JSON.stringify(b.rows.map((r: any) => [r.versionId, r.severity, r.supersededBy]));
    const base = fingerprint((await get('/api/coverage?keepN=1')).body);
    for (const keepN of [2, 3, 5, 8]) {
      expect(fingerprint((await get(`/api/coverage?keepN=${keepN}`)).body)).toBe(base);
    }
  });

  it('orders the worst first: live masters, then the widest gaps', () => {
    // A three-slice canvas puts every fixture version in the list, so this
    // ordering is exercised with both severities and several gap widths
    // actually present rather than vacuously.
    const r = report({ required: [1, 2, 3] });
    const severities = r.rows.map((x) => x.severity);
    expect(severities).toContain('high');
    expect(severities).toContain('low');
    // No 'low' may appear before a 'high'.
    expect(severities.lastIndexOf('high')).toBeLessThan(severities.indexOf('low'));
    // Within one severity, the widest gap first.
    const highs = r.rows.filter((x) => x.severity === 'high').map((x) => x.missingCount);
    expect([...highs].sort((a, b) => b - a)).toEqual(highs);
  });

  it('narrows the list but not the counts', async () => {
    const all = (await get('/api/coverage')).body;
    const high = (await get('/api/coverage?severity=high')).body;
    expect(high.rows.every((r: any) => r.severity === 'high')).toBe(true);
    // The chips must not move when one of them is clicked.
    expect(high.counts).toEqual(all.counts);
    expect(high.severity).toEqual(all.severity);
    expect(high.listedBytes).toBe(all.listedBytes);
  });

  it('rejects a severity it does not know', async () => {
    const { status, body } = await get('/api/coverage?severity=medium');
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_severity');
  });
});

// ===========================================================================
describe('filtering narrows the report, never the evidence', () => {
  /**
   * THE ONE THAT MATTERS. `/api/reclaim` has "hiding a successor does not make
   * a version safe"; this is the same failure in a different currency. If the
   * region index were built from the filtered file set, then asking to see
   * only region1 files -- or only large ones, or only one song -- would strip
   * the slices out from under every version on screen and report the entire
   * archive as full of holes.
   */
  it('a path filter matching one slice does not make complete versions look broken', () => {
    const filtered = report({ filters: { path: '*_region1.mov' } });
    const unfiltered = report();
    for (const row of filtered.rows) {
      const same = unfiltered.rows.find((r) => r.versionId === row.versionId);
      expect(same).toBeDefined();
      expect(row.present).toEqual(same?.present);
      expect(row.missing).toEqual(same?.missing);
    }
    // And nothing NEW appeared: the filter can only ever remove rows.
    const ids = new Set(unfiltered.rows.map((r) => r.versionId));
    expect(filtered.rows.every((r) => ids.has(r.versionId))).toBe(true);
  });

  it('a song filter reports only that song, with its slices intact', () => {
    const r = report({ filters: { songFolder: '400_DELTA' } });
    expect(labelsOf(r)).toEqual(['400_DELTA_FULL_LL180 v002']);
    expect(r.rows[0]?.present).toEqual([1]);
  });

  it('a filter that matches nothing reports nothing, not everything', () => {
    const r = report({ filters: { songFolder: '900_NOPE' } });
    expect(r.rows).toEqual([]);
    expect(r.counts.listedVersions).toBe(0);
    expect(r.counts.completeVersions).toBe(0);
  });
});

// ===========================================================================
describe('the recovered slice set agrees with the index', () => {
  it('matches asset_version.region_count for every version', () => {
    // `presentCount` is re-derived from file names with the scan's own parser,
    // while `region_count` was written by the scanner. Two implementations of
    // one rule -- "a slice is a non-zero, non-proxy region" -- so they are
    // pinned to each other here. A divergence means the grammar moved under
    // one of them.
    const index = regionIndexOf(ctx, fx.snapshotId);
    const stored = ctx.db
      .prepare(
        `SELECT version_id AS id, region_count AS rc FROM v_asset_version WHERE snapshot_id = ?`,
      )
      .all(fx.snapshotId) as { id: number; rc: number }[];
    expect(stored.length).toBeGreaterThan(0);
    for (const v of stored) {
      expect((index.slices.get(v.id) ?? new Set()).size).toBe(v.rc);
    }
  });
});

// ===========================================================================
describe('the route', () => {
  it('carries the reclaim verdict without letting it decide anything', async () => {
    const { body } = await get('/api/coverage?keepN=1');
    for (const r of body.rows) expect(['kept', 'superseded', 'unknown']).toContain(r.status);
  });

  it('pages without moving the totals', async () => {
    const all = (await get('/api/coverage?includePatches=1')).body;
    const page = (await get('/api/coverage?includePatches=1&limit=1')).body;
    expect(page.rows).toHaveLength(Math.min(1, all.rows.length));
    expect(page.total).toBe(all.total);
    expect(page.counts).toEqual(all.counts);
  });

  it('rejects a malformed includePatches rather than guessing', async () => {
    const { status, body } = await get('/api/coverage?includePatches=maybe');
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_param');
  });
});

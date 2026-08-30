/**
 * ============================================================================
 *  `GET /api/coverage` -- versions that carry SOME of the canvas but not all
 * ============================================================================
 *
 * A playable delivery is the whole canvas: every slice, region1..region14.
 * A version holding four of them is not a smaller delivery, it is a delivery
 * with holes in it -- and nothing in the tool said so until this route, because
 * every other figure is measured in BYTES and a version missing ten slices can
 * still be enormous.
 *
 * WHAT COUNTS AS REQUIRED, AND WHY IT COMES FROM THE RIG
 *
 * `requiredRegions` is the set of NON-ZERO regions the playback machines carry
 * -- `src/machines.ts`, the same allocation `/api/machines` reads. On the real
 * rig that is 1..14: fourteen actors carrying one slice each. It is derived
 * rather than a `14` written down here, so a rig described by
 * `config/machines.json` moves this view with it, and `allocationSource` says
 * which one answered.
 *
 * REGION 0 IS NOT A SLICE and is never required. It is the whole-canvas copy
 * the offline edit is cut against -- a different fact wearing the same token.
 * A version consisting of nothing but region0 has no gaps to report; it is not
 * a delivery of the asset at all, and `proxyOnlyVersions` counts it separately.
 * That is the same rule `derive.ts` applies to `region_count`, applied here
 * with the same parser, so `presentCount` and `region_count` cannot disagree.
 *
 * HOW THIS DIFFERS FROM THE `missingRegions` ANOMALY, which is a real question
 * because both say "missing regions":
 *
 *   /api/anomalies compares a version against ITS OWN ASSET'S modal layout. It
 *   finds versions that disagree with their siblings. An asset whose every
 *   version has ten slices is self-consistent and invisible there.
 *
 *   /api/coverage compares a version against THE CANVAS. That same asset is
 *   ten-fourteenths of a delivery in every version it has, and shows up here.
 *
 * Neither subsumes the other and both are reported.
 *
 * THE REGION INDEX IS BUILT OVER THE WHOLE SNAPSHOT, never over the filtered
 * rows. Filters narrow WHICH versions are reported; they must never narrow the
 * evidence about a version, or typing a path into the search box would make a
 * complete version look like it was missing thirteen slices. Same principle as
 * "`/api/reclaim` filters the OUTPUT, not the input", for the same reason.
 *
 * SEVERITY comes from `../severity.ts` and does not move with keepN: 'high'
 * means no newer full version of the asset exists, so the gap is on a current
 * master. `status` is the ordinary whole-snapshot reclaim verdict, carried so
 * the reader can see that a gap on a superseded version is not urgent.
 *
 * THIS ROUTE PROPOSES NOTHING FOR REMOVAL. An incomplete version may be a
 * delivery still in flight, and a gap is a reason to go and look, never a
 * reason to delete.
 * ============================================================================
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { resolveSnapshot, type VersionRow } from '../context.ts';
import {
  boolIntParam,
  listInJs,
  parseFilters,
  parseKeepN,
  parsePaging,
  type Query,
} from '../query.ts';
import { selectVersions } from '../select.ts';
import { makeParser } from '../../scan/parse.ts';
import { resolveMachines, type AllocationSource, type MachineSpec } from '../../machines.ts';
import {
  buildSeverityIndex,
  loadVersionMeta,
  parseSeverityFilter,
  Tally,
  type Severity,
} from '../severity.ts';

export interface CoverageRow {
  versionId: number;
  assetId: number;
  songFolder: string;
  base: string;
  family: string;
  verLabel: string;
  isPatch: boolean;
  bytes: number;
  fileCount: number;
  /** Slices this version actually has, ascending. Never includes region 0. */
  present: number[];
  presentCount: number;
  /** Required slices this version does not have, ascending. */
  missing: number[];
  missingCount: number;
  /**
   * Slices present that the rig does not carry. Not a gap -- reported so a
   * count that does not add up has a visible reason rather than looking wrong.
   */
  extra: number[];
  /** Bytes of whole-canvas / offline-edit material sitting on this version. */
  region0Bytes: number;
  latestMtime: number;
  status: 'kept' | 'superseded' | 'unknown';
  severity: Severity;
  supersededBy: string | null;
}

/**
 * THE FIRST FOUR ARE A PARTITION. Every version the filters matched lands in
 * exactly one of `completeVersions`, `incompleteVersions`, `proxyOnlyVersions`
 * and `regionlessVersions`, whatever the `includePatches` toggle is set to --
 * so the UI can show that the whole archive is accounted for and have the
 * arithmetic hold. The two `listed*` figures describe the narrower thing this
 * view actually LISTS, and are the ones the headline is drawn from.
 */
export interface CoverageCounts {
  /** Versions holding every required slice. */
  completeVersions: number;
  /** Versions with at least one slice, but not every required one. */
  incompleteVersions: number;
  /**
   * Of `incompleteVersions`, how many are patches. A `_frameNNNNN` render
   * covers a frame range and is expected to touch only some slices, so a patch
   * with gaps is a patch, not a defect -- they are excluded from `rows` unless
   * `includePatches=1`. Counted here either way, so they are never invisible.
   */
  incompletePatchVersions: number;
  /** Versions with no slices but a whole-canvas file: a preview, not a delivery. */
  proxyOnlyVersions: number;
  /**
   * Versions with no region token at all. A legal whole-canvas deliverable --
   * see src/scan/parse.ts -- and NOT the same thing as a version with holes.
   */
  regionlessVersions: number;
  /** Versions this view lists: `incompleteVersions`, patches in or out. */
  listedVersions: number;
  /** Distinct assets those listed versions belong to. */
  listedAssets: number;
}

/** Everything the route computes, exported so a test can drive it directly. */
export interface CoverageReport {
  requiredRegions: number[];
  rows: CoverageRow[];
  counts: CoverageCounts;
  severity: { high: number; low: number };
  /**
   * Σ bytes and Σ missing slices over the LISTED versions -- `counts.listed*`,
   * not the partition bucket. Never narrowed by `?severity=` or `?limit=`, so
   * the headline figures do not move when a chip is clicked.
   */
  listedBytes: number;
  listedMissingSlices: number;
}

/** The slices the rig carries. Region 0 is the whole canvas, never a slice. */
export function requiredRegionsOf(machines: readonly MachineSpec[]): number[] {
  const set = new Set<number>();
  for (const m of machines) {
    for (const r of m.regions) if (r !== 0) set.add(r);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * The slices each version actually holds, over the WHOLE snapshot.
 *
 * Region numbers are a property of the file NAME, not of the index -- the
 * scanner parses them only to roll versions up into a `region_count`. They are
 * recovered here with the SAME parser the scan used, built from the same config
 * pattern, for the reason `/api/machines` gives: a second, hand-rolled way of
 * reading a region out of a filename would be a divergent source of truth for
 * the one thing this route keys on.
 *
 * The membership rule is `derive.ts`'s rule verbatim: a slice is a region that
 * is present, non-zero, and not a proxy.
 */
export interface RegionIndex {
  /** version id -> the slices it holds. Absent means no slices at all. */
  slices: Map<number, Set<number>>;
  /**
   * Version ids carrying at least one whole-canvas file: a region0, or a
   * `_proxyN` at any region. Counted by FILE rather than by byte subtotal, so
   * a preview that happens to be zero bytes is still recognised as a preview
   * rather than read as a version with no files.
   */
  wholeCanvas: Set<number>;
}

export function regionIndexOf(ctx: AppContext, snapshotId: number): RegionIndex {
  const parse = makeParser(ctx.cfg.parse.pattern, ctx.cfg.parse.flags);
  const rows = ctx.db
    .prepare(
      `SELECT asset_version_id AS versionId, name
         FROM file
        WHERE snapshot_id = ? AND asset_version_id IS NOT NULL`,
    )
    .all(snapshotId) as { versionId: number; name: string }[];

  const slices = new Map<number, Set<number>>();
  const wholeCanvas = new Set<number>();
  for (const r of rows) {
    const p = parse(r.name);
    if (!p.ok) continue;
    if (p.region === 0 || p.isProxy) {
      wholeCanvas.add(r.versionId);
      continue;
    }
    if (p.region === null) continue;
    let set = slices.get(r.versionId);
    if (!set) {
      set = new Set<number>();
      slices.set(r.versionId, set);
    }
    set.add(p.region);
  }
  return { slices, wholeCanvas };
}

export interface CoverageOptions {
  includePatches: boolean;
  severity?: Severity | undefined;
}

/**
 * Classify every version in view against `requiredRegions`.
 *
 * `versions` is the FILTERED set -- what the operator asked to see.
 * `regionIndex` must be the whole-snapshot index, so a filter can never invent
 * a gap.
 */
export function buildCoverage(
  versions: readonly VersionRow[],
  regionIndex: RegionIndex,
  requiredRegions: readonly number[],
  severityOfVersion: (versionId: number) => { severity: Severity; supersededBy: string | null },
  opts: CoverageOptions,
): CoverageReport {
  const required = [...requiredRegions].sort((a, b) => a - b);
  const requiredSet = new Set(required);

  const rows: CoverageRow[] = [];
  const tally = new Tally();
  const assets = new Set<number>();
  const counts: CoverageCounts = {
    completeVersions: 0,
    incompleteVersions: 0,
    incompletePatchVersions: 0,
    proxyOnlyVersions: 0,
    regionlessVersions: 0,
    listedVersions: 0,
    listedAssets: 0,
  };
  let listedBytes = 0;
  let listedMissingSlices = 0;

  for (const v of versions) {
    const present = [...(regionIndex.slices.get(v.versionId) ?? [])].sort((a, b) => a - b);

    if (present.length === 0) {
      // No slices at all. Two different things, kept apart: a preview of the
      // whole canvas, and a deliverable that carries no region token. Neither
      // is a version with holes in it.
      if (regionIndex.wholeCanvas.has(v.versionId)) counts.proxyOnlyVersions += 1;
      else counts.regionlessVersions += 1;
      continue;
    }

    const missing = required.filter((r) => !present.includes(r));
    if (missing.length === 0) {
      counts.completeVersions += 1;
      continue;
    }

    // Some slices, not all: the thing this view exists to show. The bucket is
    // counted before the patch toggle is consulted, so the four buckets stay a
    // partition of every version in view whichever way the toggle is set.
    counts.incompleteVersions += 1;
    if (v.isPatch) {
      counts.incompletePatchVersions += 1;
      if (!opts.includePatches) continue;
    }

    const sev = severityOfVersion(v.versionId);
    counts.listedVersions += 1;
    assets.add(v.assetId);
    listedBytes += v.bytes;
    listedMissingSlices += missing.length;
    tally.add(sev);

    if (opts.severity !== undefined && sev.severity !== opts.severity) continue;

    rows.push({
      versionId: v.versionId,
      assetId: v.assetId,
      songFolder: v.songFolder,
      base: v.base,
      family: v.family,
      verLabel: v.verLabel,
      isPatch: v.isPatch,
      bytes: v.bytes,
      fileCount: v.fileCount,
      present,
      presentCount: present.length,
      missing,
      missingCount: missing.length,
      extra: present.filter((r) => !requiredSet.has(r)),
      region0Bytes: v.region0Bytes,
      latestMtime: v.latestMtime,
      status: v.status,
      severity: sev.severity,
      supersededBy: sev.supersededBy,
    });
  }

  counts.listedAssets = assets.size;

  // Worst first: a gap on a current master, then the widest gap, then the
  // biggest version. No `?sort=` -- this is a report, not a grid, and the order
  // it is read in is part of what it says.
  rows.sort(
    (a, b) =>
      Number(b.severity === 'high') - Number(a.severity === 'high') ||
      b.missingCount - a.missingCount ||
      b.bytes - a.bytes ||
      a.versionId - b.versionId,
  );

  return {
    requiredRegions: required,
    rows,
    counts,
    severity: tally.toJSON(),
    listedBytes,
    listedMissingSlices,
  };
}

export function registerCoverageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/coverage', (req) => {
    const q = req.query as Query;
    const snapshot = resolveSnapshot(ctx, q);
    const filters = parseFilters(q);
    const keepN = parseKeepN(q);
    const paging = parsePaging(q);
    const want = parseSeverityFilter(q);
    const includePatches = boolIntParam(q, 'includePatches') === 1;

    const { machines, source } = resolveMachines();
    const requiredRegions = requiredRegionsOf(machines);

    const versions = selectVersions(
      ctx,
      snapshot.id,
      filters,
      keepN,
      'ORDER BY av.version_id ASC',
    );
    const regionIndex = regionIndexOf(ctx, snapshot.id);
    const { severityOfVersion } = buildSeverityIndex(loadVersionMeta(ctx.db, snapshot.id));

    const report = buildCoverage(versions, regionIndex, requiredRegions, severityOfVersion, {
      includePatches,
      ...(want === undefined ? {} : { severity: want }),
    });

    const listed = listInJs(report.rows, { bytesOf: (r) => r.bytes, paging });

    return {
      snapshotId: snapshot.id,
      keepN,
      limit: paging.limit,
      offset: paging.offset,
      includePatches,
      /** The requested severity, or null when unfiltered. */
      severityFilter: want ?? null,
      /**
       * The slices a delivery must have, and where that list came from.
       * 'built-in' is the real rig compiled into the source -- it is not a
       * guess, and the UI must not disclaim it as one.
       */
      requiredRegions: report.requiredRegions,
      requiredCount: report.requiredRegions.length,
      allocationSource: source satisfies AllocationSource,
      /**
       * Over everything the filters matched, never narrowed by ?severity= or
       * ?limit=, so the headline figures do not move when a chip is clicked.
       */
      counts: report.counts,
      severity: report.severity,
      listedBytes: report.listedBytes,
      listedMissingSlices: report.listedMissingSlices,
      ...listed,
    };
  });
}

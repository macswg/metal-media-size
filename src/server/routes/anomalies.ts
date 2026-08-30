/**
 * `GET /api/anomalies` -- everything the index knows is odd.
 *
 * `{ missingRegions[], orphanRegions[], unparsed[], zeroByte[], noHeader[],
 *    excluded{} }`
 *
 * ---------------------------------------------------------------------------
 * `noHeader` IS THE ONE CATEGORY THAT NEEDS A PROBE
 *
 * Every other anomaly here is derived from names, sizes and counts. `noHeader`
 * comes from `npm run probe`: a file that read cleanly and turned out to carry
 * no `moov` atom is a render interrupted before its header was written. The
 * bytes are on disk and no player can open them -- 140 GB of nothing, in the
 * worst case found so far.
 *
 * It is reported ONLY for files that have actually been probed. An unprobed
 * archive reports an empty list, never a clean bill of health inferred from
 * not having looked. Zero-byte files are left to `zeroByte`, which already
 * describes them better.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * SEVERITY lives in `../severity.ts`, shared with `/api/coverage`. Every row
 * here carries `severity` ('high' = no newer full version exists) and
 * `supersededBy`. It DOES NOT DEPEND ON keepN, and this route never consults
 * the reclaim policy at all -- which is what makes that invariant structural
 * rather than a promise. Unattributable files get the conservative answer.
 * ---------------------------------------------------------------------------
 *
 * REGION ANOMALIES need a definition, because the schema stores a region COUNT
 * but not the region NUMBERS. The numbers are recovered from the file names in
 * JS (metadata only -- no file is opened), and then, per asset:
 *
 *   expected set = the MODAL region set across that asset's versions, i.e. the
 *   region layout the asset actually uses. An asset with one version has nothing
 *   to disagree with and is never flagged.
 *
 *   missingRegions = a version lacking a region the expected set has.
 *                    That version cannot be played back whole.
 *   orphanRegions  = a file whose region number is NOT in the expected set.
 *                    A leftover from a different layout, or a typo in a name.
 *
 * `_proxyN` files are excluded from both: a proxy is tagged `region0` but is a
 * whole-canvas preview, not a region.
 *
 * The `excluded` block carries `snapshot.excluded_*` so the FreeFileSync
 * bookkeeping files stay visible rather than silently dropped.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { resolveSnapshot } from '../context.ts';
import { intParam, type Query } from '../query.ts';
import {
  buildSeverityIndex,
  loadVersionMeta,
  parseSeverityFilter,
  Tally,
  UNATTRIBUTED,
  type SeverityVerdict,
} from '../severity.ts';
import { toSnapshotView } from './snapshots.ts';
import { mediaCoverage } from '../../db/index.ts';

const DEFAULT_ANOMALY_LIMIT = 500;
const MAX_ANOMALY_LIMIT = 20_000;

interface NameRow {
  id: number;
  rel_path: string;
  song_folder: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;
  parse_ok: number;
  asset_version_id: number | null;
  /** 1 once `npm run probe` has read this file's header. */
  probed: number;
  /** NULL when unprobed OR when probed and headerless -- `probed` separates them. */
  width: number | null;
}

/** Region number from a file name, or null for proxies and region-less files. */
export function regionOf(name: string): number | null {
  if (/_proxy\d+/i.test(name)) return null;
  const m = /_region(\d+)/i.exec(name);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Recover `(verNum, subLetter)` from the tail of a name whose base has already
 * been stripped, e.g. `_v0003b_region4_.mov` -> `{ verNum: 3, subLetter: 'b' }`.
 *
 * DELIBERATELY MORE PERMISSIVE THAN THE SCAN GRAMMAR. These are the files the
 * grammar already rejected; the point is to attribute them well enough to say
 * whether something newer exists, not to re-derive an asset-version from them.
 * Nothing here feeds the reclaim policy.
 */
export function looseVersionOf(tail: string): { verNum: number; subLetter: string | null } | null {
  const m = /^_v(\d+)([A-Za-z])?/i.exec(tail);
  if (!m?.[1]) return null;
  const verNum = Number.parseInt(m[1], 10);
  if (!Number.isFinite(verNum)) return null;
  return { verNum, subLetter: m[2] ? m[2].toLowerCase() : null };
}

/** The most common region set among an asset's versions, as a sorted array. */
function modalRegionSet(sets: number[][]): number[] {
  const tally = new Map<string, { count: number; regions: number[] }>();
  for (const s of sets) {
    if (s.length === 0) continue;
    const key = s.join(',');
    const hit = tally.get(key);
    if (hit) hit.count += 1;
    else tally.set(key, { count: 1, regions: s });
  }
  let best: { count: number; regions: number[] } | undefined;
  for (const entry of tally.values()) {
    if (
      !best ||
      entry.count > best.count ||
      (entry.count === best.count && entry.regions.length > best.regions.length)
    ) {
      best = entry;
    }
  }
  return best?.regions ?? [];
}

export function registerAnomalyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/anomalies', (req) => {
    const q = req.query as Query;
    const snapshot = resolveSnapshot(ctx, q);
    const limit = Math.min(intParam(q, 'limit') ?? DEFAULT_ANOMALY_LIMIT, MAX_ANOMALY_LIMIT);
    const want = parseSeverityFilter(q);

    const files = ctx.db
      .prepare(
        `SELECT f.id, f.rel_path, f.song_folder, f.name, f.ext, f.size, f.mtime,
                f.parse_ok, f.asset_version_id,
                (fm.file_id IS NOT NULL) AS probed, fm.width AS width
           FROM file f
           LEFT JOIN file_media fm ON fm.file_id = f.id
          WHERE f.snapshot_id = ? ORDER BY f.id ASC`,
      )
      .all(snapshot.id) as NameRow[];

    // Built over the WHOLE snapshot, never the filtered view -- see
    // `buildSeverityIndex`. The same index answers /api/coverage.
    const { metaById, severityAt, severityOfVersion } = buildSeverityIndex(
      loadVersionMeta(ctx.db, snapshot.id),
    );

    // -----------------------------------------------------------------------
    // Attribution for files that carry no asset_version_id: match the longest
    // asset base that prefixes the file name within the same song folder, then
    // read a version off whatever is left.
    // -----------------------------------------------------------------------
    const assetsBySong = new Map<string, { assetId: number; base: string }[]>();
    for (const row of ctx.db
      .prepare(`SELECT id, song_folder, base FROM asset WHERE snapshot_id = ?`)
      .all(snapshot.id) as { id: number; song_folder: string; base: string }[]) {
      const list = assetsBySong.get(row.song_folder) ?? [];
      list.push({ assetId: row.id, base: row.base });
      assetsBySong.set(row.song_folder, list);
    }
    // Longest base first, so a base that is a prefix of another never wins.
    for (const list of assetsBySong.values()) list.sort((a, b) => b.base.length - a.base.length);

    interface Attribution extends SeverityVerdict {
      assetId: number | null;
      base: string | null;
    }

    function attribute(file: NameRow): Attribution {
      if (file.asset_version_id !== null) {
        const meta = metaById.get(file.asset_version_id);
        if (meta) {
          return { assetId: meta.assetId, base: meta.base, ...severityOfVersion(meta.versionId) };
        }
      }
      for (const candidate of assetsBySong.get(file.song_folder) ?? []) {
        if (!file.name.startsWith(candidate.base)) continue;
        const at = looseVersionOf(file.name.slice(candidate.base.length));
        return {
          assetId: candidate.assetId,
          base: candidate.base,
          ...severityAt(candidate.assetId, at),
        };
      }
      return { assetId: null, base: null, ...UNATTRIBUTED };
    }

    // -----------------------------------------------------------------------
    // One pass over the files: unparsed, zero-byte, and the region inventory.
    // -----------------------------------------------------------------------
    const regionsByVersion = new Map<number, Set<number>>();
    const regionFiles: { file: NameRow; region: number; versionId: number }[] = [];
    const unparsed: unknown[] = [];
    const zeroByte: unknown[] = [];
    const noHeader: unknown[] = [];
    const unparsedTally = new Tally();
    const zeroByteTally = new Tally();
    const noHeaderTally = new Tally();

    const keep = (v: SeverityVerdict): boolean => want === undefined || v.severity === want;

    for (const f of files) {
      // Probed, non-empty, and no dimensions: the header atom is missing.
      // Zero-byte files are left to `zeroByte`, which says it better.
      if (f.probed === 1 && f.width === null && f.size > 0) {
        const a = attribute(f);
        noHeaderTally.add(a);
        if (keep(a) && noHeader.length < limit) {
          noHeader.push({
            fileId: f.id,
            relPath: f.rel_path,
            songFolder: f.song_folder,
            name: f.name,
            ext: f.ext,
            size: f.size,
            mtime: f.mtime,
            assetId: a.assetId,
            base: a.base,
            severity: a.severity,
            supersededBy: a.supersededBy,
            reason: 'read cleanly but carries no header atom — an interrupted render',
          });
        }
      }

      if (f.parse_ok !== 1 || f.size === 0) {
        const a = attribute(f);
        if (f.parse_ok !== 1) {
          unparsedTally.add(a);
          if (keep(a) && unparsed.length < limit) {
            unparsed.push({
              fileId: f.id,
              relPath: f.rel_path,
              songFolder: f.song_folder,
              name: f.name,
              ext: f.ext,
              size: f.size,
              mtime: f.mtime,
              assetId: a.assetId,
              base: a.base,
              severity: a.severity,
              supersededBy: a.supersededBy,
              reason:
                f.ext === 'mov'
                  ? 'a .mov that did not match the filename grammar'
                  : `out of grammar scope (the grammar covers .mov, this is .${f.ext || '?'})`,
            });
          }
        }
        if (f.size === 0) {
          zeroByteTally.add(a);
          if (keep(a) && zeroByte.length < limit) {
            zeroByte.push({
              fileId: f.id,
              relPath: f.rel_path,
              songFolder: f.song_folder,
              name: f.name,
              ext: f.ext,
              mtime: f.mtime,
              assetId: a.assetId,
              base: a.base,
              severity: a.severity,
              supersededBy: a.supersededBy,
            });
          }
        }
      }

      if (f.asset_version_id === null) continue;
      const region = regionOf(f.name);
      if (region === null) continue;
      let set = regionsByVersion.get(f.asset_version_id);
      if (!set) {
        set = new Set<number>();
        regionsByVersion.set(f.asset_version_id, set);
      }
      set.add(region);
      regionFiles.push({ file: f, region, versionId: f.asset_version_id });
    }

    // Expected region layout per asset.
    const setsByAsset = new Map<number, number[][]>();
    for (const [versionId, set] of regionsByVersion) {
      const meta = metaById.get(versionId);
      if (!meta) continue;
      // A patch covers a frame range, not necessarily every region, so it must
      // not vote on the layout and must not be flagged against it.
      if (meta.isPatch) continue;
      const list = setsByAsset.get(meta.assetId) ?? [];
      list.push([...set].sort((a, b) => a - b));
      setsByAsset.set(meta.assetId, list);
    }
    const expectedByAsset = new Map<number, number[]>();
    for (const [assetId, sets] of setsByAsset) {
      expectedByAsset.set(assetId, modalRegionSet(sets));
    }

    const missingRegions: unknown[] = [];
    const missingTally = new Tally();
    for (const [versionId, set] of regionsByVersion) {
      const meta = metaById.get(versionId);
      if (!meta || meta.isPatch) continue;
      const expected = expectedByAsset.get(meta.assetId) ?? [];
      if (expected.length === 0) continue;
      const missing = expected.filter((r) => !set.has(r));
      if (missing.length === 0) continue;
      const sev = severityOfVersion(versionId);
      missingTally.add(sev);
      if (keep(sev) && missingRegions.length < limit) {
        missingRegions.push({
          versionId,
          assetId: meta.assetId,
          songFolder: meta.songFolder,
          base: meta.base,
          verLabel: meta.verLabel,
          expected,
          present: [...set].sort((a, b) => a - b),
          missing,
          severity: sev.severity,
          supersededBy: sev.supersededBy,
        });
      }
    }

    const orphanRegions: unknown[] = [];
    const orphanTally = new Tally();
    for (const { file, region, versionId } of regionFiles) {
      const meta = metaById.get(versionId);
      if (!meta) continue;
      const expected = expectedByAsset.get(meta.assetId);
      if (!expected || expected.length === 0) continue;
      if (expected.includes(region)) continue;
      const sev = severityOfVersion(versionId);
      orphanTally.add(sev);
      if (keep(sev) && orphanRegions.length < limit) {
        orphanRegions.push({
          fileId: file.id,
          relPath: file.rel_path,
          songFolder: file.song_folder,
          name: file.name,
          size: file.size,
          region,
          expected,
          versionId,
          assetId: meta.assetId,
          base: meta.base,
          verLabel: meta.verLabel,
          severity: sev.severity,
          supersededBy: sev.supersededBy,
        });
      }
    }

    const view = toSnapshotView(snapshot);

    return {
      snapshotId: snapshot.id,
      limit,
      /** The requested severity, or null when unfiltered. */
      severityFilter: want ?? null,
      missingRegions,
      orphanRegions,
      unparsed,
      zeroByte,
      noHeader,
      excluded: {
        // Straight from snapshot.excluded_*: FreeFileSync bookkeeping and
        // AppleDouble files are COUNTED, never silently dropped.
        count: snapshot.excluded_count,
        bytes: snapshot.excluded_bytes,
        globs: ctx.cfg.exclusions.globs,
        skippedDirs: view.skipped,
      },
      // `counts` and `severity` are ALWAYS over the whole snapshot, never
      // narrowed by ?severity= or ?limit=, so the UI's "3 high, 41 low" chips
      // do not move when one of them is clicked.
      counts: {
        missingRegions: missingTally.total,
        orphanRegions: orphanTally.total,
        unparsed: unparsedTally.total,
        unparsedRecordedBySnapshot: snapshot.unparsed_count,
        zeroByte: zeroByteTally.total,
        noHeader: noHeaderTally.total,
        excluded: snapshot.excluded_count,
        skippedDirs: view.skipped.length,
      },
      /**
       * What `noHeader` was computed over. Without this the UI cannot tell
       * 'no interrupted renders' from 'nobody has probed yet', and would
       * report the second as though it were the first.
       */
      probeCoverage: mediaCoverage(ctx.db, snapshot.id),
      severity: {
        high:
          missingTally.high + orphanTally.high + unparsedTally.high + zeroByteTally.high +
          noHeaderTally.high,
        low:
          missingTally.low + orphanTally.low + unparsedTally.low + zeroByteTally.low +
          noHeaderTally.low,
        byCategory: {
          missingRegions: missingTally.toJSON(),
          orphanRegions: orphanTally.toJSON(),
          unparsed: unparsedTally.toJSON(),
          zeroByte: zeroByteTally.toJSON(),
          noHeader: noHeaderTally.toJSON(),
        },
      },
    };
  });
}

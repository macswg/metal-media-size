/**
 * `GET /api/anomalies` -- everything the index knows is odd.
 *
 * `{ missingRegions[], orphanRegions[], unparsed[], zeroByte[], excluded{} }`
 *
 * ---------------------------------------------------------------------------
 * SEVERITY
 *
 * A defect on a live master matters; the same defect on a version that a later
 * full render has already replaced almost certainly does not. Every anomaly row
 * therefore carries:
 *
 *   severity: 'high'  no full version of this asset is NEWER than the version
 *                     the defect sits on. This is a current master with a
 *                     problem, and someone has to look at it.
 *   severity: 'low'   a newer FULL version exists, so whatever this row
 *                     describes has presumably been re-rendered away. Still
 *                     reported, never hidden -- just de-emphasised.
 *   supersededBy      ver_label of that asset's newest full version, or null
 *                     when severity is 'high'.
 *
 * SEVERITY DOES NOT DEPEND ON keepN. A newer full version either exists or it
 * does not; that is a property of the archive, not of the view. If severity
 * moved with the reclaim slider, the same defect would change importance as the
 * operator dragged it, and the panel would stop being trustworthy. This route
 * never consults the reclaim policy at all, which is what makes the invariant
 * structural rather than a promise.
 *
 * UNATTRIBUTABLE IS 'high'. A file we cannot tie to an asset cannot be proved
 * superseded by anything, so it gets the conservative answer.
 * ---------------------------------------------------------------------------
 *
 * REGION ANOMALIES need a definition, because the schema stores a region COUNT
 * but not the region NUMBERS. The numbers are recovered from the file names in
 * JS (metadata only -- no file is opened), and then, per asset:
 *
 *   expected set = the MODAL region set across that asset's versions, i.e. the
 *   tile layout the asset actually uses. An asset with one version has nothing
 *   to disagree with and is never flagged.
 *
 *   missingRegions = a version lacking a tile the expected set has.
 *                    That version cannot be played back whole.
 *   orphanRegions  = a file whose tile number is NOT in the expected set.
 *                    A leftover from a different layout, or a typo in a name.
 *
 * `_proxyN` files are excluded from both: a proxy is tagged `region0` but is a
 * whole-canvas preview, not an LED tile.
 *
 * The `excluded` block carries `snapshot.excluded_*` so the FreeFileSync
 * bookkeeping files stay visible rather than silently dropped.
 */

import type { FastifyInstance } from 'fastify';
import { compareVersions } from '../../scan/derive.ts';
import type { AppContext } from '../context.ts';
import { resolveSnapshot } from '../context.ts';
import { badRequest } from '../errors.ts';
import { intParam, type Query } from '../query.ts';
import { toSnapshotView } from './snapshots.ts';

const DEFAULT_ANOMALY_LIMIT = 500;
const MAX_ANOMALY_LIMIT = 20_000;

export const SEVERITIES = ['high', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The verdict attached to every anomaly row. */
export interface SeverityVerdict {
  severity: Severity;
  supersededBy: string | null;
}

const UNATTRIBUTED: SeverityVerdict = { severity: 'high', supersededBy: null };

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
}

/**
 * Version metadata in the shape this route works in. `verNum` / `subLetter`
 * are camelCase because `compareVersions` -- the single ordering authority,
 * shared with reclaim.ts -- takes them that way, and re-implementing the
 * comparison here to match the column names is exactly the sort of drift that
 * ends with two different ideas of which version is newest.
 */
interface VersionMeta {
  versionId: number;
  assetId: number;
  songFolder: string;
  base: string;
  verLabel: string;
  verNum: number;
  subLetter: string | null;
  regionCount: number;
  isPatch: boolean;
}

/** Tile number from a file name, or null for proxies and region-less files. */
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

function parseSeverityFilter(q: Query): Severity | undefined {
  const raw = q['severity'];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const s = String(raw);
  if (!(SEVERITIES as readonly string[]).includes(s)) {
    throw badRequest(
      'bad_severity',
      `severity must be one of: ${SEVERITIES.join(', ')}. Got ${JSON.stringify(s)}.`,
    );
  }
  return s as Severity;
}

/** Running high/low tallies for one anomaly category. */
class Tally {
  high = 0;
  low = 0;
  add(v: SeverityVerdict): void {
    if (v.severity === 'high') this.high += 1;
    else this.low += 1;
  }
  get total(): number {
    return this.high + this.low;
  }
  toJSON(): { high: number; low: number } {
    return { high: this.high, low: this.low };
  }
}

export function registerAnomalyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/anomalies', (req) => {
    const q = req.query as Query;
    const snapshot = resolveSnapshot(ctx, q);
    const limit = Math.min(intParam(q, 'limit') ?? DEFAULT_ANOMALY_LIMIT, MAX_ANOMALY_LIMIT);
    const want = parseSeverityFilter(q);

    const files = ctx.db
      .prepare(
        `SELECT id, rel_path, song_folder, name, ext, size, mtime, parse_ok, asset_version_id
           FROM file WHERE snapshot_id = ? ORDER BY id ASC`,
      )
      .all(snapshot.id) as NameRow[];

    const versionMeta = (
      ctx.db
        .prepare(
          `SELECT av.version_id  AS versionId,
                  av.asset_id    AS assetId,
                  av.song_folder AS songFolder,
                  av.base        AS base,
                  av.ver_label   AS verLabel,
                  av.ver_num     AS verNum,
                  av.sub_letter  AS subLetter,
                  av.region_count AS regionCount,
                  av.is_patch    AS isPatch
             FROM v_asset_version av WHERE av.snapshot_id = ?`,
        )
        .all(snapshot.id) as (Omit<VersionMeta, 'isPatch'> & { isPatch: number })[]
    ).map((v): VersionMeta => ({ ...v, isPatch: v.isPatch === 1 }));

    const metaById = new Map(versionMeta.map((v) => [v.versionId, v]));

    // -----------------------------------------------------------------------
    // Severity: for each asset, the FULL versions in order. A defect is 'low'
    // exactly when some full version ranks strictly newer than the version it
    // sits on. Patches never count -- a patch is a partial re-render and does
    // not replace anything (the same rule reclaim.ts enforces).
    // -----------------------------------------------------------------------
    const fullsByAsset = new Map<number, VersionMeta[]>();
    for (const v of versionMeta) {
      if (v.isPatch) continue;
      const list = fullsByAsset.get(v.assetId);
      if (list) list.push(v);
      else fullsByAsset.set(v.assetId, [v]);
    }
    for (const list of fullsByAsset.values()) list.sort(compareVersions);

    function severityAt(
      assetId: number | null,
      at: { verNum: number; subLetter: string | null } | null,
    ): SeverityVerdict {
      if (assetId === null || at === null) return UNATTRIBUTED;
      const fulls = fullsByAsset.get(assetId);
      if (!fulls || fulls.length === 0) return UNATTRIBUTED;
      const newest = fulls[fulls.length - 1] as VersionMeta;
      if (compareVersions(newest, at) <= 0) return UNATTRIBUTED;
      return { severity: 'low', supersededBy: newest.verLabel };
    }

    /** Severity of a defect sitting on a known asset-version row. */
    function severityOfVersion(versionId: number): SeverityVerdict {
      const meta = metaById.get(versionId);
      if (!meta) return UNATTRIBUTED;
      return severityAt(meta.assetId, meta);
    }

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
    // One pass over the files: unparsed, zero-byte, and the tile inventory.
    // -----------------------------------------------------------------------
    const regionsByVersion = new Map<number, Set<number>>();
    const regionFiles: { file: NameRow; region: number; versionId: number }[] = [];
    const unparsed: unknown[] = [];
    const zeroByte: unknown[] = [];
    const unparsedTally = new Tally();
    const zeroByteTally = new Tally();

    const keep = (v: SeverityVerdict): boolean => want === undefined || v.severity === want;

    for (const f of files) {
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

    // Expected tile layout per asset.
    const setsByAsset = new Map<number, number[][]>();
    for (const [versionId, set] of regionsByVersion) {
      const meta = metaById.get(versionId);
      if (!meta) continue;
      // A patch covers a frame range, not necessarily every tile, so it must
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
        excluded: snapshot.excluded_count,
        skippedDirs: view.skipped.length,
      },
      severity: {
        high: missingTally.high + orphanTally.high + unparsedTally.high + zeroByteTally.high,
        low: missingTally.low + orphanTally.low + unparsedTally.low + zeroByteTally.low,
        byCategory: {
          missingRegions: missingTally.toJSON(),
          orphanRegions: orphanTally.toJSON(),
          unparsed: unparsedTally.toJSON(),
          zeroByte: zeroByteTally.toJSON(),
        },
      },
    };
  });
}

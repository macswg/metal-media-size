/**
 * `GET /api/summary` -- headline totals for the dashboard strip.
 *
 * Unfiltered by design: this is the "what is in the archive" band above the
 * filtered views. `reclaimByKeepN` gives the slider its curve in one request
 * instead of one request per notch.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { resolveSnapshot } from '../context.ts';
import { intParam, parseKeepN, type Query } from '../query.ts';
import { toGiB, toTiB } from '../../scan/reclaim.ts';
import { toSnapshotView } from './snapshots.ts';

/**
 * The keep-N slider used to stop at a hard-coded 5. It now scales to the data:
 * the number of versions held by the asset that has the most, so the control
 * can always express "keep every version of everything".
 *
 * Note that the last few notches may not move the reclaim figure. Ranking
 * counts full, region-bearing versions only -- patches and proxy-only versions
 * never occupy a keep slot -- so on an archive whose deepest asset is 7
 * versions but only 5 masters, keep-6 and keep-7 read the same as keep-5. That
 * flattening is visible in the curve and is the honest shape of the data.
 *
 * Capped at MAX_CURVE_N so one pathological asset cannot make the dashboard
 * precompute hundreds of curves.
 */
const MAX_CURVE_N = 20;

export function registerSummaryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/summary', (req) => {
    const q = req.query as Query;
    const snapshot = resolveSnapshot(ctx, q);
    const keepN = parseKeepN(q);
    // Versions held by the asset that has the most -- every row it owns, so
    // patches and proxy-only versions are counted too. The slider can then
    // always be pushed to "keep everything".
    const deepest = (
      ctx.db
        .prepare(
          `SELECT COALESCE(MAX(n), 0) AS n
             FROM (SELECT COUNT(*) AS n FROM v_asset_version
                    WHERE snapshot_id = ? GROUP BY asset_id)`,
        )
        .get(snapshot.id) as { n: number }
    ).n;
    const maxKeepN = Math.min(MAX_CURVE_N, Math.max(1, deepest));

    const maxCurve = Math.min(intParam(q, 'curveMax') ?? 0, MAX_CURVE_N);
    const curveLen = maxCurve > 0 ? maxCurve : maxKeepN;
    const curve = Array.from({ length: curveLen }, (_, i) => i + 1);

    const totals = ctx.db
      .prepare(
        `SELECT COUNT(*) AS files,
                COALESCE(SUM(size), 0) AS bytes,
                COALESCE(MAX(mtime), 0) AS latest_mtime,
                COALESCE(MIN(mtime), 0) AS earliest_mtime,
                COUNT(DISTINCT song_folder) AS songs,
                SUM(CASE WHEN parse_ok = 0 THEN 1 ELSE 0 END) AS unparsed,
                SUM(CASE WHEN size = 0 THEN 1 ELSE 0 END) AS zero_byte
           FROM file WHERE snapshot_id = ?`,
      )
      .get(snapshot.id) as {
      files: number;
      bytes: number;
      latest_mtime: number;
      earliest_mtime: number;
      songs: number;
      unparsed: number;
      zero_byte: number;
    };

    const versionTotals = ctx.db
      .prepare(
        `SELECT COUNT(*) AS versions,
                COUNT(DISTINCT asset_id) AS assets,
                COALESCE(SUM(bytes), 0) AS bytes,
                COALESCE(SUM(proxy_bytes), 0) AS proxy_bytes,
                SUM(CASE WHEN is_patch = 1 THEN 1 ELSE 0 END) AS patches,
                COALESCE(SUM(CASE WHEN is_patch = 1 THEN bytes ELSE 0 END), 0) AS patch_bytes
           FROM v_asset_version WHERE snapshot_id = ?`,
      )
      .get(snapshot.id) as {
      versions: number;
      assets: number;
      bytes: number;
      proxy_bytes: number;
      patches: number;
      patch_bytes: number;
    };

    const byFamily = ctx.db
      .prepare(
        `SELECT family, COUNT(*) AS versions, COALESCE(SUM(bytes), 0) AS bytes
           FROM v_asset_version WHERE snapshot_id = ?
          GROUP BY family ORDER BY bytes DESC`,
      )
      .all(snapshot.id) as { family: string; versions: number; bytes: number }[];

    // The filter panel's two option lists. Both are cheap aggregates over the
    // index, and returning them here is what lets the page fill its song
    // dropdown from the load it already does instead of a second
    // /api/songs?limit=2000 round trip -- 2,000 rows of statistics fetched to
    // read 65 strings off. It also turns the extension box from a free-text
    // field into a picker of values that actually exist.
    const songFolders = (
      ctx.db
        .prepare(
          `SELECT DISTINCT song_folder AS s FROM file
            WHERE snapshot_id = ? AND song_folder IS NOT NULL AND song_folder <> ''
            ORDER BY song_folder`,
        )
        .all(snapshot.id) as { s: string }[]
    ).map((r) => r.s);

    const byExtension = ctx.db
      .prepare(
        `SELECT ext, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
           FROM file
          WHERE snapshot_id = ? AND ext IS NOT NULL AND ext <> ''
          GROUP BY ext ORDER BY count DESC, ext`,
      )
      .all(snapshot.id) as { ext: string; count: number; bytes: number }[];

    const current = ctx.reclaim.get(snapshot.id, keepN).whole;

    return {
      snapshot: toSnapshotView(snapshot),
      snapshotId: snapshot.id,
      keepN,
      files: {
        count: totals.files,
        totalBytes: totals.bytes,
        totalTiB: toTiB(totals.bytes),
        unparsedCount: totals.unparsed,
        zeroByteCount: totals.zero_byte,
        earliestMtime: totals.earliest_mtime || null,
        latestMtime: totals.latest_mtime || null,
      },
      /**
       * How far the keep-N slider should go. Beyond this every asset keeps
       * every ranked version, so the reclaim figure cannot move again.
       */
      maxKeepN,
      songCount: totals.songs,
      /** Every song folder in the snapshot, sorted. Fills the filter dropdown. */
      songFolders,
      /** Extensions present, most common first. Fills the extension picker. */
      extensions: byExtension.map((e) => e.ext),
      /** The same list with counts, alongside `byFamily`. Display only. */
      byExtension,
      assetCount: versionTotals.assets,
      versionCount: versionTotals.versions,
      patchVersionCount: versionTotals.patches,
      patchBytes: versionTotals.patch_bytes,
      versionBytes: versionTotals.bytes,
      proxyBytes: versionTotals.proxy_bytes,
      excluded: { count: snapshot.excluded_count, bytes: snapshot.excluded_bytes },
      // `family` is a DISPLAY LABEL. This breakdown is for the eye only and
      // must never drive a delete decision.
      byFamily,
      reclaim: {
        keepN,
        reclaimBytes: current.reclaimableBytes,
        reclaimTiB: toTiB(current.reclaimableBytes),
        supersededCount: current.supersededVersions,
        supersededFiles: current.supersededFiles,
        protectedPatchBytes: current.protectedPatchBytes,
        protectedPatchGiB: toGiB(current.protectedPatchBytes),
        keptBytes: current.keptBytes,
      },
      reclaimByKeepN: curve.map((n) => {
        const r = ctx.reclaim.get(snapshot.id, n).whole;
        return {
          keepN: n,
          reclaimBytes: r.reclaimableBytes,
          reclaimTiB: toTiB(r.reclaimableBytes),
          supersededCount: r.supersededVersions,
          protectedPatchBytes: r.protectedPatchBytes,
        };
      }),
    };
  });
}

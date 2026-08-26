/**
 * `GET /api/reclaim` -- the number under the "keep latest N" slider.
 *
 * ---------------------------------------------------------------------------
 * HOW FILTERS COMPOSE WITH `computeReclaim`
 *
 * `computeReclaim` ranks versions WITHIN an asset. Handing it a filtered
 * subset would change the ranking: hide the newest version with a filter and
 * the next one down is promoted to "latest kept", so a version that the whole
 * archive says is superseded would be reported as safe -- or the reverse. The
 * verdict must not depend on what the operator happens to be looking at.
 *
 * So the pipeline is:
 *
 *   1. `computeReclaim` runs over EVERY asset and EVERY version in the
 *      snapshot, unfiltered (memoised per snapshot and N).
 *   2. The filter set selects which of those verdict rows are COUNTED.
 *   3. The totals here are sums over the selected rows only.
 *
 * The number therefore reads: "of the versions currently in view, this many
 * bytes are superseded ACCORDING TO THE WHOLE ARCHIVE". A partially filtered
 * asset keeps the correct per-version verdict; only the summation is narrowed.
 *
 * TRADE-OFF, stated plainly: the totals are not additive across disjoint
 * filters in the naive way an operator might assume in one specific case --
 * filtering to a single old version still reports it as superseded even though
 * its successor is not in view. That is the conservative direction (the
 * successor genuinely exists), and it is the only direction that cannot cause
 * a kept master to be reported as reclaimable.
 *
 * `protectedPatchBytes` is likewise summed over the filtered set. Over the
 * unfiltered archive it is constant across N by construction; filtered, it
 * moves only because the view moved, never because N moved.
 *
 * ---------------------------------------------------------------------------
 * `status` IS STRIPPED FROM THE FILTER SET HERE
 *
 * `status=kept|superseded` is a predicate ON THE ANSWER this route computes.
 * Applying it would make the figure circular: with `status=superseded` the
 * reclaimable total becomes 100% of the view and retained shows zero; with
 * `status=kept` it is always zero. Neither tells the operator anything.
 *
 * So the route removes `status` before selecting, and the answer always reads
 * "of the versions matching everything EXCEPT the kept/superseded predicate,
 * this much is reclaimable". `/api/versions` still honours `status` -- that is
 * a list, and narrowing a list to one verdict is a reasonable thing to ask.
 * The stripped value is echoed back as `ignoredStatusFilter` so a client can
 * see it was deliberate rather than lost.
 * ---------------------------------------------------------------------------
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { resolveSnapshot } from '../context.ts';
import { isEmptyFilter, parseFilters, parseKeepN, type Query } from '../query.ts';
import { selectVersions } from '../select.ts';

interface SongTally {
  songFolder: string;
  reclaimBytes: number;
  supersededCount: number;
  totalBytes: number;
  versionCount: number;
}

export function registerReclaimRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/reclaim', (req) => {
    const q = req.query as Query;
    const snapshot = resolveSnapshot(ctx, q);
    const parsed = parseFilters(q);
    const keepN = parseKeepN(q);

    // Parsed (so a bogus value is still a 400), then discarded: see the header.
    const ignoredStatusFilter = parsed.status ?? null;
    const { status: _status, ...filters } = parsed;

    const rows = selectVersions(
      ctx,
      snapshot.id,
      filters,
      keepN,
      'ORDER BY av.song_folder ASC, av.version_id ASC',
    );

    let reclaimBytes = 0;
    let reclaimProxyBytes = 0;
    let supersededCount = 0;
    let supersededFiles = 0;
    let protectedPatchBytes = 0;
    let protectedPatchCount = 0;
    let keptBytes = 0;
    let totalBytes = 0;
    let totalFiles = 0;

    const bySongMap = new Map<string, SongTally>();

    for (const r of rows) {
      totalBytes += r.bytes;
      totalFiles += r.fileCount;

      let tally = bySongMap.get(r.songFolder);
      if (!tally) {
        tally = {
          songFolder: r.songFolder,
          reclaimBytes: 0,
          supersededCount: 0,
          totalBytes: 0,
          versionCount: 0,
        };
        bySongMap.set(r.songFolder, tally);
      }
      tally.totalBytes += r.bytes;
      tally.versionCount += 1;

      if (r.status === 'superseded') {
        reclaimBytes += r.bytes;
        reclaimProxyBytes += r.proxyBytes;
        supersededCount += 1;
        supersededFiles += r.fileCount;
        tally.reclaimBytes += r.bytes;
        tally.supersededCount += 1;
      } else {
        keptBytes += r.bytes;
        if (r.keepReason === 'kept-patch-newer-than-latest-full' || r.keepReason === 'kept-patch-of-latest-full') {
          protectedPatchBytes += r.bytes;
          protectedPatchCount += 1;
        }
      }
    }

    const bySong = [...bySongMap.values()].sort((a, b) => b.reclaimBytes - a.reclaimBytes);
    const whole = ctx.reclaim.get(snapshot.id, keepN).whole;

    return {
      snapshotId: snapshot.id,
      keepN,
      reclaimBytes,
      supersededCount,
      protectedPatchBytes,
      totalBytes,
      bySong,
      // Additions beyond the contract, all derived from the same verdicts.
      filtered: !isEmptyFilter(filters),
      /** `status` was supplied and deliberately not applied. Null otherwise. */
      ignoredStatusFilter,
      versionCount: rows.length,
      totalFiles,
      keptBytes,
      supersededFiles,
      protectedPatchCount,
      reclaimProxyBytes,
      /** Whole-snapshot totals, so the UI can show "of the archive" alongside. */
      archive: {
        reclaimBytes: whole.reclaimableBytes,
        supersededCount: whole.supersededVersions,
        supersededFiles: whole.supersededFiles,
        protectedPatchBytes: whole.protectedPatchBytes,
        totalBytes: whole.keptBytes + whole.reclaimableBytes,
      },
    };
  });
}

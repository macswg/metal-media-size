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
import { makeParser } from '../../scan/parse.ts';

/**
 * Bytes per version held in files whose name parsed but carries no region
 * token -- legal whole-canvas deliverables (e.g. `888_IMAG_*_RECT_v001.mov`).
 * Read with the scan's own parser, the same test `/api/machines` uses for its
 * `regionless` bucket, so the two figures cannot disagree. Memoised per
 * snapshot: snapshots are insert-only, so the map never goes stale.
 */
const regionlessCache = new Map<number, Map<number, number>>();

function regionlessBytesByVersion(ctx: AppContext, snapshotId: number): Map<number, number> {
  const hit = regionlessCache.get(snapshotId);
  if (hit) return hit;
  const parse = makeParser(ctx.cfg.parse.pattern, ctx.cfg.parse.flags);
  const out = new Map<number, number>();
  const files = ctx.db
    .prepare(
      `SELECT name, size, asset_version_id AS v FROM file
        WHERE snapshot_id = ? AND asset_version_id IS NOT NULL`,
    )
    .all(snapshotId) as { name: string; size: number; v: number }[];
  for (const f of files) {
    const p = parse(f.name);
    if (p.ok && p.region === null) out.set(f.v, (out.get(f.v) ?? 0) + f.size);
  }
  regionlessCache.set(snapshotId, out);
  return out;
}

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
    let region0Bytes = 0;
    let regionlessBytes = 0;
    const regionlessByVersion = regionlessBytesByVersion(ctx, snapshot.id);
    let supersededCount = 0;
    let supersededFiles = 0;
    let protectedPatchBytes = 0;
    let protectedPatchCount = 0;
    let programmedBytes = 0;
    let programmedCount = 0;
    let keptBytes = 0;
    let totalBytes = 0;
    let totalFiles = 0;

    const bySongMap = new Map<string, SongTally>();

    for (const r of rows) {
      totalBytes += r.bytes;
      totalFiles += r.fileCount;
      // Counted over every row in view, kept and superseded alike: the figure
      // answers "how much of what I am looking at is the whole-canvas copy the
      // offline edit needs", which is a property of the archive and not of the
      // keep-N verdict.
      region0Bytes += r.region0Bytes;
      regionlessBytes += regionlessByVersion.get(r.versionId) ?? 0;

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
        // Versions the SHOW is cued to play, which the supersession rules had
        // decided against. Summed over the rows in view like every other figure
        // here, so it reads "of what I am looking at" -- the whole-snapshot
        // count is on `programmed.protectedVersions` for the other question.
        if (r.keepReason === 'kept-programmed') {
          programmedBytes += r.bytes;
          programmedCount += 1;
        }
      }
    }

    const bySong = [...bySongMap.values()].sort((a, b) => b.reclaimBytes - a.reclaimBytes);
    const entry = ctx.reclaim.get(snapshot.id, keepN);
    const whole = entry.whole;
    const prot = entry.programmed;

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
      /**
       * Bytes held in `region0` files across the rows in view -- the
       * whole-canvas copy each version keeps for offline editing. In this
       * archive those files are also the `_proxy3` previews; the grammar does
       * not guarantee it, so the subtotal is counted on the region and not on
       * the proxy token.
       */
      region0Bytes,
      /**
       * Bytes in files with a valid name and NO region token, across the rows
       * in view. Separate from `region0Bytes`: a regionless file is a legal
       * whole-canvas deliverable, not a region 0. Unparsed names are in
       * neither. The UI shows the two summed as "Region 0 + untagged".
       */
      regionlessBytes,
      /** Bytes and versions the cross-check rescued, within the rows in view. */
      programmedBytes,
      programmedCount,
      /**
       * THE CROSS-CHECK'S OWN STATUS. **Null means no show-file capture is
       * loaded**, which is NOT the same as a capture that protected nothing --
       * the reclaim figures are identical in both cases and this field is the
       * only thing that tells them apart. The UI must state which it is; an
       * unchecked archive is not a clean bill of health.
       */
      programmed: prot
        ? {
            captures: prot.captures.map((c) => ({
              sourceFile: c.sourceFile,
              capturedAt: c.capturedAt,
              project: c.project,
            })),
            /** Version rows held back across the WHOLE snapshot. */
            protectedVersions: prot.protectedVersionIds.size,
            matchedNames: prot.matchedNames,
            totalNames: prot.totalNames,
            /** Names in the capture the archive has no asset for. */
            unmatchedNames: prot.unmatchedNames.length,
            /** Versions the capture named that the archive does not hold. */
            unmatchedVersions: prot.unmatchedVersions.length,
            /** False when a capture is loaded but resolved to nothing at all. */
            usable: prot.usable,
          }
        : null,
      /** Whole-snapshot totals, so the UI can show "of the archive" alongside. */
      archive: {
        reclaimBytes: whole.reclaimableBytes,
        supersededCount: whole.supersededVersions,
        supersededFiles: whole.supersededFiles,
        protectedPatchBytes: whole.protectedPatchBytes,
        programmedBytes: whole.programmedProtectedBytes,
        programmedCount: whole.programmedProtectedVersions,
        totalBytes: whole.keptBytes + whole.reclaimableBytes,
      },
    };
  });
}

/**
 * ============================================================================
 *  RECLAIM VERDICTS  --  computed over WHOLE ASSETS, cached per (snapshot, N)
 * ============================================================================
 *
 * THE RULE THAT MAKES FILTERING SAFE:
 *
 *   `computeReclaim` ranks the versions of an asset against each other. Feed it
 *   a FILTERED subset and the ranking changes -- an old version can be promoted
 *   to "latest kept" simply because the filter hid the newer one that
 *   supersedes it. That would let the UI report bytes as reclaimable on the
 *   strength of a view, which is exactly the mistake that loses a master.
 *
 *   So the verdict is ALWAYS computed over the ENTIRE snapshot, unfiltered.
 *   Filters are applied to the OUTPUT: routes keep the verdict rows whose
 *   version passes the filter, and sum those. "Reclaims X TB of what I am
 *   looking at" therefore means "of the versions in view, these are the ones
 *   the FULL archive says are superseded" -- never "these would be superseded
 *   if the archive contained only what I can see".
 *
 * A completed snapshot is immutable (a scan only ever INSERTs a new one), so
 * the verdict map for a given (snapshotId, keepN) can be memoised for the life
 * of the process. `invalidate()` exists for the one case that is not immutable:
 * a snapshot that was still running when it was first queried.
 * ============================================================================
 */

import type { Database as Db } from 'better-sqlite3';
import { loadReclaimInput } from '../db/index.ts';
import { computeReclaim, type ReclaimResult, type VersionVerdict } from '../scan/reclaim.ts';

export interface Verdicts {
  keepN: number;
  snapshotId: number;
  /** The whole-snapshot result. Filtered routes must not report these totals. */
  whole: ReclaimResult;
  /** versionId -> verdict, for annotating any row the routes select. */
  byVersionId: Map<number, VersionVerdict>;
}

/** Small bounded memo. There are only ever a handful of live (snapshot, N) pairs. */
const MAX_ENTRIES = 32;

export class ReclaimCache {
  private readonly db: Db;
  private readonly entries = new Map<string, Verdicts>();

  constructor(db: Db) {
    this.db = db;
  }

  get(snapshotId: number, keepN: number): Verdicts {
    const key = `${snapshotId}:${keepN}`;
    const hit = this.entries.get(key);
    if (hit) {
      // Refresh recency.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }

    const input = loadReclaimInput(this.db, snapshotId);
    const whole = computeReclaim(input, keepN);
    const byVersionId = new Map<number, VersionVerdict>();
    for (const v of whole.verdicts) byVersionId.set(v.versionId, v);
    const entry: Verdicts = { keepN, snapshotId, whole, byVersionId };

    this.entries.set(key, entry);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return entry;
  }

  /** Drop memoised verdicts, for one snapshot or all of them. */
  invalidate(snapshotId?: number): void {
    if (snapshotId === undefined) {
      this.entries.clear();
      return;
    }
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${snapshotId}:`)) this.entries.delete(key);
    }
  }
}

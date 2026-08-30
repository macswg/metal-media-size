/**
 * ============================================================================
 *  SEVERITY -- IS THERE ANYTHING NEWER THAT WOULD ALREADY HAVE FIXED THIS?
 * ============================================================================
 *
 * Shared by every route that reports a DEFECT on an asset-version. A defect on
 * a live master matters; the same defect on a version that a later full render
 * has already replaced almost certainly does not.
 *
 *   severity: 'high'  no FULL version of this asset ranks strictly newer than
 *                     the version the defect sits on. A current master with a
 *                     problem, and someone has to look at it.
 *   severity: 'low'   a newer full version exists, so whatever this describes
 *                     has presumably been re-rendered away. Still reported,
 *                     never hidden -- just de-emphasised.
 *   supersededBy      ver_label of that newest full version, or null at 'high'.
 *
 * SEVERITY DOES NOT DEPEND ON keepN, and nothing in this module may consult the
 * reclaim policy. A newer full version either exists or it does not; that is a
 * property of the archive, not of the view. If severity moved with the reclaim
 * slider, the same defect would change importance as the operator dragged it.
 *
 * PATCHES NEVER COUNT AS A FIX. A `_frameNNNNN` render is a partial re-render
 * layered on the full version below it, so it replaces nothing -- the same rule
 * `reclaim.ts` enforces. Only full versions are ranked here.
 *
 * WHY IT LIVES IN ITS OWN MODULE. It was written inside `/api/anomalies`, and
 * `/api/coverage` needs exactly the same verdict. A second implementation would
 * be a second idea of which version is newest, and the two would disagree the
 * first time the version grammar moved. `compareVersions` -- the single
 * ordering authority, shared with `reclaim.ts` -- does the comparing here too.
 * ============================================================================
 */

import type { Database as Db } from 'better-sqlite3';
import { compareVersions } from '../scan/derive.ts';
import { badRequest } from './errors.ts';
import type { Query } from './query.ts';

export const SEVERITIES = ['high', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The verdict attached to every defect row. */
export interface SeverityVerdict {
  severity: Severity;
  supersededBy: string | null;
}

/**
 * The conservative answer, and the one given whenever attribution fails. A
 * file we cannot tie to an asset cannot be proved superseded by anything.
 */
export const UNATTRIBUTED: SeverityVerdict = { severity: 'high', supersededBy: null };

/**
 * Version metadata in the shape the defect routes work in.
 *
 * `verNum` / `subLetter` are camelCase because `compareVersions` takes them
 * that way, and re-implementing the comparison to match the column names is
 * exactly the sort of drift that ends with two different ideas of which
 * version is newest.
 */
export interface VersionMeta {
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

/** Every asset-version in a snapshot, in the shape above. */
export function loadVersionMeta(db: Db, snapshotId: number): VersionMeta[] {
  const rows = db
    .prepare(
      `SELECT av.version_id   AS versionId,
              av.asset_id     AS assetId,
              av.song_folder  AS songFolder,
              av.base         AS base,
              av.ver_label    AS verLabel,
              av.ver_num      AS verNum,
              av.sub_letter   AS subLetter,
              av.region_count AS regionCount,
              av.is_patch     AS isPatch
         FROM v_asset_version av WHERE av.snapshot_id = ?`,
    )
    .all(snapshotId) as (Omit<VersionMeta, 'isPatch'> & { isPatch: number })[];
  return rows.map((v): VersionMeta => ({ ...v, isPatch: v.isPatch === 1 }));
}

export interface SeverityIndex {
  /** Every version in the snapshot, by id. */
  metaById: Map<number, VersionMeta>;
  /**
   * Severity of a defect sitting at an arbitrary version position within an
   * asset -- used for files whose own version row could not be identified.
   */
  severityAt(
    assetId: number | null,
    at: { verNum: number; subLetter: string | null } | null,
  ): SeverityVerdict;
  /** Severity of a defect sitting on a known asset-version row. */
  severityOfVersion(versionId: number): SeverityVerdict;
}

/**
 * Build the index over the WHOLE snapshot's versions.
 *
 * It must be the whole snapshot, never a filtered subset: hiding an asset's
 * newest version would otherwise promote the next one down to "nothing newer
 * exists" and report a superseded defect as a live one.
 */
export function buildSeverityIndex(versionMeta: readonly VersionMeta[]): SeverityIndex {
  const metaById = new Map(versionMeta.map((v) => [v.versionId, v]));

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

  function severityOfVersion(versionId: number): SeverityVerdict {
    const meta = metaById.get(versionId);
    if (!meta) return UNATTRIBUTED;
    return severityAt(meta.assetId, meta);
  }

  return { metaById, severityAt, severityOfVersion };
}

/** `?severity=high|low`, or undefined when unfiltered. */
export function parseSeverityFilter(q: Query): Severity | undefined {
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

/** Running high/low tallies for one category of defect. */
export class Tally {
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

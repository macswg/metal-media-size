/**
 * =============================================================================
 *  KEEP-N SCENARIOS  --  THE EXECUTIVE QUESTION. PURE, NO I/O.
 * =============================================================================
 *
 * The manifest answers "what does THIS export move?". A person deciding
 * whether the exercise is worth doing at all is asking a different question
 * first:
 *
 *     If we keep only the current version, how much comes back?
 *     And if we keep one previous version as insurance? Two? Three?
 *
 * That is four runs of the SAME policy at four values of N, so this module is
 * a thin loop over `computeReclaim` plus the two derived figures the question
 * actually turns on:
 *
 *   `reclaimBytes`        -- what each choice returns, and
 *   `costVsRowAbove`      -- what the NEXT rung of insurance costs, which is
 *                            the number an executive is really weighing.
 *
 * TWO PROPERTIES THIS MODULE MUST PRESERVE
 *
 *  1. **Every scenario is computed over the WHOLE snapshot.** Not over the
 *     export's selection, not over the operator's filters. `computeReclaim`
 *     ranks versions against each other, so a narrowed input promotes an old
 *     version to "latest kept" and reports a live master as reclaimable. The
 *     same rule that governs `/api/reclaim` governs this table; see CLAUDE.md.
 *     The scenario figures therefore describe the archive, and the report says
 *     so beside them rather than letting them be read as this export's totals.
 *
 *  2. **Monotonicity is asserted, not assumed.** Keeping more versions cannot
 *     return more space. If a future change to the ranking rules ever breaks
 *     that, the report is the last place it should surface quietly, so
 *     `buildScenarios` throws instead of rendering an impossible table.
 *
 * `protectedPatchBytes` is constant across every N by construction (the patch
 * rule keeps a patch iff no kept full version is newer, and the latest full is
 * kept at every N). It is carried per row anyway, because a column that is
 * visibly identical down all four rows is how a reader learns the protection
 * does not depend on the choice they are making.
 * =============================================================================
 */

import { computeReclaim, type ReclaimAssetInput } from '../scan/reclaim.ts';
import type { ExportScenario, ExportScenarioBasis, ExportScenarioSong } from './types.ts';

/**
 * The four choices the report puts on page one: the current version alone,
 * then one, two and three previous versions kept behind it.
 *
 * "Keep N" counts the current version, so "current plus two previous" is N=3.
 * The labels are generated from that arithmetic rather than written out, so
 * the two can never drift apart.
 */
export const REPORT_KEEP_NS: readonly number[] = Object.freeze([1, 2, 3, 4]);

/** How many songs get their own row in the per-scenario song table. */
export const SCENARIO_SONG_LIMIT = 500;

/** "Current version only" / "Current + 2 previous". Derived from N, never typed twice. */
export function scenarioLabel(keepN: number): string {
  if (keepN <= 1) return 'Current version only';
  const prev = keepN - 1;
  return `Current + ${prev} previous version${prev === 1 ? '' : 's'}`;
}

/** The one-line plain-English version, for a caption under the number. */
export function scenarioSubLabel(keepN: number): string {
  if (keepN <= 1) return 'Everything older than the newest delivery is proposed for removal.';
  const prev = keepN - 1;
  return `The newest delivery plus ${prev} older one${prev === 1 ? '' : 's'} stay on the archive.`;
}

/**
 * Run the keep-latest-N policy at each requested N over the whole snapshot.
 *
 * @param assets  Every asset in the snapshot, with every version. Unfiltered.
 * @param keepNs  Which N values to report. Deduplicated and sorted ascending.
 * @param exportKeepN  The N this export's verdicts were computed under, so the
 *                     matching row can be marked as the one being acted on.
 *                     It is added to the table if it is not already there: a
 *                     report that marked no row as current, or marked a row it
 *                     had not computed, would be worse than a longer table.
 */
export function buildScenarios(
  assets: readonly ReclaimAssetInput[],
  keepNs: readonly number[],
  exportKeepN: number,
): ExportScenario[] {
  const wanted = [...new Set([...keepNs, exportKeepN])]
    .filter((n) => Number.isInteger(n) && n >= 1)
    .sort((a, b) => a - b);
  if (wanted.length === 0) {
    throw new Error('buildScenarios needs at least one keep-N value >= 1.');
  }

  const songOfAsset = new Map<number, string>();
  for (const a of assets) songOfAsset.set(a.id, a.songFolder);
  const assetOfVersion = new Map<number, number>();
  for (const a of assets) for (const v of a.versions) assetOfVersion.set(v.id, a.id);

  const rows: ExportScenario[] = [];
  for (const keepN of wanted) {
    const r = computeReclaim(assets, keepN);

    const songMap = new Map<string, ExportScenarioSong>();
    for (const v of r.verdicts) {
      if (v.keep) continue;
      const song = songOfAsset.get(assetOfVersion.get(v.versionId) ?? -1) ?? '';
      let s = songMap.get(song);
      if (!s) {
        s = { songFolder: song, reclaimBytes: 0, supersededVersions: 0, supersededFiles: 0 };
        songMap.set(song, s);
      }
      s.reclaimBytes += v.bytes;
      s.supersededVersions += 1;
      s.supersededFiles += v.fileCount;
    }

    rows.push({
      keepN,
      label: scenarioLabel(keepN),
      subLabel: scenarioSubLabel(keepN),
      reclaimBytes: r.reclaimableBytes,
      reclaimVersions: r.supersededVersions,
      reclaimFiles: r.supersededFiles,
      reclaimProxyBytes: r.reclaimableProxyBytes,
      keptBytes: r.keptBytes,
      keptVersions: r.keptVersions,
      protectedPatchBytes: r.protectedPatchBytes,
      protectedPatchVersions: r.protectedPatchVersions,
      // Filled in below, once the neighbouring rows exist.
      costVsRowAbove: 0,
      isExportPolicy: keepN === exportKeepN,
      bySong: [...songMap.values()].sort((a, b) => b.reclaimBytes - a.reclaimBytes),
    });
  }

  // What each extra kept version costs, relative to the row above it. Row one
  // has nothing above it, so it costs nothing: it IS the maximum.
  for (let i = 1; i < rows.length; i += 1) {
    const above = rows[i - 1] as ExportScenario;
    const row = rows[i] as ExportScenario;
    if (row.reclaimBytes > above.reclaimBytes) {
      throw new Error(
        `Keep-${row.keepN} reports MORE reclaim (${row.reclaimBytes}) than keep-${above.keepN} ` +
          `(${above.reclaimBytes}). Keeping more versions cannot free more space; the ranking ` +
          'rules are inconsistent and the report would be misleading. Refusing to build it.',
      );
    }
    row.costVsRowAbove = above.reclaimBytes - row.reclaimBytes;
  }

  return rows;
}

/**
 * What the scenario table is computed over, stated so the reader can see that
 * it is the whole archive rather than this export's selection.
 */
export function scenarioBasis(
  assets: readonly ReclaimAssetInput[],
  snapshotTotalBytes: number,
): ExportScenarioBasis {
  let versionCount = 0;
  let versionedBytes = 0;
  let versionedFiles = 0;
  for (const a of assets) {
    for (const v of a.versions) {
      versionCount += 1;
      versionedBytes += v.bytes;
      versionedFiles += v.fileCount;
    }
  }
  return {
    assetCount: assets.length,
    versionCount,
    versionedBytes,
    versionedFiles,
    songCount: new Set(assets.map((a) => a.songFolder)).size,
    // Whatever the snapshot holds that no version claims: files whose names the
    // grammar could not parse. Excluded bookkeeping files are not in the
    // snapshot total at all, so they are not double-counted here.
    unversionedBytes: Math.max(0, snapshotTotalBytes - versionedBytes),
  };
}

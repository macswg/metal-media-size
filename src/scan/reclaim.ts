/**
 * ============================================================================
 *  RECLAIM POLICY  --  "keep latest N" with THE PATCH RULE
 * ============================================================================
 *
 * PURE -- no I/O. This is the function the UI's "keep latest N" slider calls.
 *
 * THE PATCH RULE, in full. Get this wrong and the tool overstates reclaimable
 * space and could recommend deleting a master that a patch still depends on.
 *
 *   1. A version carrying `_frameNNNNN` is a PARTIAL re-render covering a frame
 *      range. It is NOT a replacement for the version before it.
 *
 *   2. Version RANKING therefore considers FULL (non-patch) versions ONLY.
 *      "Keep latest N" keeps the latest N FULL versions of each asset.
 *      A sub-revision letter makes a DISTINCT version: `v002`, `v002d` and
 *      `v002f` are three versions, ordered `v002 < v002d < v002f < v003`. They
 *      occupy three slots in the keep-N window, so "keep latest 1" on that
 *      asset keeps `v002f` alone.
 *
 *   3. A PATCH IS KEPT IFF NO KEPT FULL VERSION IS NEWER THAN IT.
 *
 *      The latest full version is kept at every N, so this reduces to a rule
 *      that does not depend on N at all:
 *
 *          keep the patch  <=>  patch.verNum >= latestFull.verNum
 *
 *      Read plainly: a patch at or above the current master is a live fix and
 *      is ALWAYS KEPT (its bytes are reported as `protectedPatchBytes`, which
 *      is therefore constant across N). A patch below the current master has
 *      been overtaken by a later FULL re-render that already contains the
 *      fixed frames, so it is superseded.
 *
 *      This also delivers the brief's requirement that "a patch belonging to a
 *      superseded version is superseded along with it": if a patch's own
 *      version has been pushed out of the keep window, a newer full version
 *      necessarily exists and is kept, so the patch goes too.
 *
 *      JUDGEMENT CALL, recorded because it resolves a real ambiguity: a patch
 *      below the latest full version is superseded EVEN IF a full version at
 *      or below the patch is still inside the keep window. The archive settles
 *      this. `140_RIVER_INTRO_LL180` has full versions v001, v002, v006, v007
 *      and a 225 GiB patch at v004. At keep-3 the kept fulls are v002, v006
 *      and v007 -- so v002, which is OLDER than the patch, is kept. This rule
 *      counts that patch as reclaimable, putting keep-3 at 5.97 TiB; treating
 *      the retained v002 as a reason to keep the patch would give 5.75 TiB.
 *      The later full re-renders at v006/v007 supersede the v004 fix
 *      regardless of whether an older full is retained.
 *
 *   3b. A KEPT PATCH ALWAYS KEEPS ITS BASE FULL. **Confirmed directly by the
 *      user:** "v004 and a v005 patch are both needed. A v006 replaces v004
 *      and the v005 patch." A patch layers on the newest full BELOW it -- its
 *      base -- and the two are only playable together. Retaining a patch whose
 *      base had been deleted would retain something unplayable.
 *
 *      This needs NO extra code, and that is worth understanding rather than
 *      trusting. It falls out of rule 3:
 *
 *          a kept patch has no kept full newer than it        (rule 3)
 *          the latest full is kept at every N >= 1            (rule 2)
 *          => the latest full is NOT newer than the patch
 *          => the newest full below the patch IS the latest full
 *          => the patch's base is kept, at every N
 *
 *      So the guarantee is structural, not incidental. It is asserted anyway,
 *      in `patch-rule.test.ts` and against the real archive in the integration
 *      suite, because it is exactly the property that would break silently if
 *      rule 3 were ever "simplified" into keying patches off their own version
 *      number instead of off the kept fulls.
 *
 *   4. A FULL VERSION IS NEVER MARKED SUPERSEDED BY A PATCH ALONE. Because
 *      ranking ignores patches entirely (rule 2), this falls out structurally
 *      rather than resting on a special case -- but it is asserted directly in
 *      `test/patch-rule.test.ts`.
 *
 *   5. An asset with no full versions at all keeps everything: there is nothing
 *      that could supersede its patches.
 *
 * A `_proxyN` file shares the fate of the version it belongs to. Its bytes are
 * inside that version's `bytes` and are also tracked in `proxyBytes` so the UI
 * can show the proxy subtotal separately.
 *
 * ----------------------------------------------------------------------------
 * THE PROXY-ONLY RULE -- the patch rule's sibling. Same danger, same shape.
 * ----------------------------------------------------------------------------
 *
 * A version may consist of NOTHING BUT its `proxy3_region0` preview: no LED
 * region files at all (`regionCount === 0`). That is not a delivery of the
 * asset. It is a low-res whole-canvas preview, and it CANNOT stand in for the
 * region-bearing masters it appears to sit above.
 *
 *   6. RANKING CONSIDERS REGION-BEARING FULL VERSIONS ONLY. A proxy-only
 *      version is left out of the line-up that decides supersession: it can
 *      never occupy one of the N kept slots, and it can never push a
 *      region-bearing version out of one. Its own verdict is decided
 *      afterwards, by rule 7.
 *
 *   7. A PROXY-ONLY VERSION IS KEPT IFF NO KEPT REGION-BEARING VERSION IS
 *      NEWER THAN IT -- exactly the patch test in rule 3. A preview above the
 *      current master is live (the masters for it have not landed yet); a
 *      preview below a newer master is a stale thumbnail and is reclaimable.
 *
 * WHY THIS EXISTS, recorded so it is never "simplified" away. Without rule 6
 * this policy marked 85 region-bearing versions -- 3.86 TiB, of which 3.17 TiB
 * was the LAST full-resolution copy of its asset -- as superseded by a preview.
 * `580_CAUSEWAY_0000A_LL180` was the clearest: v002 is 15 files and 475 GiB of LED
 * masters, v003 is a single 1.5 GiB proxy, and keep-1 proposed deleting v002
 * and retaining v003. The at-risk previews cluster on 2026-08-20 and
 * 2026-08-25 -- days old at the time of writing, against masters from July --
 * so they are previews of IN-PROGRESS work whose regions have not been
 * delivered. Removing the master would have left no playable asset at all, on
 * an archive with no backup.
 *
 * `regionCount` is REQUIRED on the input for this reason, and a missing value
 * is read as 0 (proxy-only). That direction is deliberate: an unplumbed caller
 * loses reclaim it could have had, which is visible and harmless, instead of
 * silently regaining the power to delete masters.
 * ============================================================================
 */

import { compareVersions } from './derive.ts';

/** The minimum a version must expose for the policy to rank it. */
export interface ReclaimVersionInput {
  /** Opaque identifier passed straight through to the output. */
  id: number;
  verNum: number;
  subLetter: string | null;
  isPatch: boolean;
  patchFrame: number | null;
  bytes: number;
  proxyBytes: number;
  fileCount: number;
  /**
   * Distinct LED region tiles in this version, EXCLUDING the proxy. Zero means
   * the version is a preview and nothing else -- see THE PROXY-ONLY RULE. A
   * missing value is read as 0, which is the safe direction.
   */
  regionCount: number;
}

export interface ReclaimAssetInput {
  /** Opaque identifier passed straight through to the output. */
  id: number;
  songFolder: string;
  base: string;
  versions: ReclaimVersionInput[];
}

/** Why a version ended up kept or superseded. Surfaced to the UI as a reason. */
export type KeepReason =
  /** A full version inside the latest-N window. */
  | 'kept-full-latest'
  /** A patch above the latest full version: a live fix. Protected at every N. */
  | 'kept-patch-newer-than-latest-full'
  /** A patch at the latest full version. Protected at every N. */
  | 'kept-patch-of-latest-full'
  /** The asset has no full versions, so nothing can supersede this. */
  | 'kept-no-full-versions'
  /**
   * A proxy-only version at or above the latest region-bearing version: the
   * preview of work whose masters have not landed. Protected at every N.
   */
  | 'kept-proxy-only-newer-than-latest-full'
  /** A proxy-only version overtaken by a kept region-bearing version. */
  | 'superseded-proxy-only'
  /** A full version pushed out of the latest-N window by newer full versions. */
  | 'superseded-full'
  /** A patch overtaken by a kept full version newer than it. */
  | 'superseded-patch';

export interface VersionVerdict {
  versionId: number;
  assetId: number;
  keep: boolean;
  reason: KeepReason;
  bytes: number;
  proxyBytes: number;
  fileCount: number;
}

export interface ReclaimResult {
  keepN: number;
  /** Bytes freed by removing every superseded version. */
  reclaimableBytes: number;
  /** How many version rows are superseded. */
  supersededVersions: number;
  /** Files inside those superseded versions. */
  supersededFiles: number;
  /** Proxy bytes inside the reclaimable total (a subset of it). */
  reclaimableProxyBytes: number;
  /**
   * Bytes of patches at or above their asset's latest full version. Always
   * kept, at every N -- reported so the protection is visible, not implied.
   * This total is INDEPENDENT of keepN by construction; the UI can show it as
   * a fixed "protected" band beneath the slider.
   */
  protectedPatchBytes: number;
  protectedPatchVersions: number;
  /** Bytes retained (kept versions). */
  keptBytes: number;
  keptVersions: number;
  /** Per-version verdicts, in input order. */
  verdicts: VersionVerdict[];
}

/**
 * Compute the keep/supersede verdict for every version under a keep-latest-N
 * policy.
 *
 * @param assets  Assets with their versions. Version order does not matter.
 * @param keepN   How many FULL versions to keep per asset. Must be >= 1.
 */
export function computeReclaim(
  assets: readonly ReclaimAssetInput[],
  keepN: number,
): ReclaimResult {
  if (!Number.isInteger(keepN) || keepN < 1) {
    throw new Error(`keepN must be an integer >= 1, got ${keepN}`);
  }

  const verdicts: VersionVerdict[] = [];
  let reclaimableBytes = 0;
  let reclaimableProxyBytes = 0;
  let supersededVersions = 0;
  let supersededFiles = 0;
  let protectedPatchBytes = 0;
  let protectedPatchVersions = 0;
  let keptBytes = 0;
  let keptVersions = 0;

  for (const asset of assets) {
    // Rule 2: rank using FULL versions only. Patches never enter the ranking.
    const nonPatch = asset.versions.filter((v) => !v.isPatch);

    // Rule 6: a preview cannot supersede a master. Whenever the asset has any
    // region-bearing version, ONLY those go into the line-up that decides
    // supersession. Proxy-only versions are left out of it entirely -- they
    // take no kept slot and push nothing out -- and their own keep/delete
    // verdict is decided below by the rule-7 test.
    //
    // When an asset has NO region-bearing version at all, its previews ARE the
    // deliverable and rank against each other as normal. There is no master to
    // protect, so holding them out would forfeit real reclaim for nothing.
    const regionBearing = nonPatch.filter((v) => (v.regionCount ?? 0) > 0);
    const ranks = regionBearing.length > 0 ? regionBearing : nonPatch;
    const rankedIds = new Set(ranks.map((v) => v.id));

    const fulls = [...ranks].sort(compareVersions);

    // Rule 5: nothing can supersede anything here.
    if (fulls.length === 0) {
      for (const v of asset.versions) {
        verdicts.push({
          versionId: v.id,
          assetId: asset.id,
          keep: true,
          reason: 'kept-no-full-versions',
          bytes: v.bytes,
          proxyBytes: v.proxyBytes,
          fileCount: v.fileCount,
        });
        keptBytes += v.bytes;
        keptVersions += 1;
      }
      continue;
    }

    const latestFull = fulls[fulls.length - 1] as ReclaimVersionInput;

    // The keep window is over DISTINCT VERSION IDENTITIES -- (number, letter) --
    // because `v002`, `v002d` and `v002f` are three separate versions. Keying on
    // identity rather than on row id means that if a caller ever hands us two
    // rows with the same identity, they are kept or dropped together instead of
    // one being silently discarded.
    const identityOf = (v: ReclaimVersionInput) => `${v.verNum}|${v.subLetter ?? ''}`;
    const distinctIds: string[] = [];
    const seenIds = new Set<string>();
    for (const v of fulls) {
      // `fulls` is already sorted oldest -> newest, so this stays ordered.
      const k = identityOf(v);
      if (!seenIds.has(k)) {
        seenIds.add(k);
        distinctIds.push(k);
      }
    }
    const keptIds = new Set(distinctIds.slice(Math.max(0, distinctIds.length - keepN)));
    const keptFulls = fulls.filter((v) => keptIds.has(identityOf(v)));

    for (const v of asset.versions) {
      let keep: boolean;
      let reason: KeepReason;

      if (!v.isPatch && rankedIds.has(v.id)) {
        // Rule 4: a full version's fate depends only on other FULL versions.
        keep = keptIds.has(identityOf(v));
        reason = keep ? 'kept-full-latest' : 'superseded-full';
      } else if (!v.isPatch) {
        // Rule 7: a proxy-only version, left out of the line-up above. Same
        // test as a patch: kept unless a KEPT region-bearing version is newer.
        keep = !keptFulls.some((f) => compareVersions(f, v) > 0);
        reason = keep ? 'kept-proxy-only-newer-than-latest-full' : 'superseded-proxy-only';
      } else if (keptFulls.some((f) => compareVersions(f, v) > 0)) {
        // Rule 3: a kept full version is newer, so it already contains the fix.
        keep = false;
        reason = 'superseded-patch';
      } else {
        // Rule 3: nothing kept is newer -- a live fix on the current master.
        keep = true;
        reason =
          compareVersions(v, latestFull) > 0
            ? 'kept-patch-newer-than-latest-full'
            : 'kept-patch-of-latest-full';
        protectedPatchBytes += v.bytes;
        protectedPatchVersions += 1;
      }

      verdicts.push({
        versionId: v.id,
        assetId: asset.id,
        keep,
        reason,
        bytes: v.bytes,
        proxyBytes: v.proxyBytes,
        fileCount: v.fileCount,
      });

      if (keep) {
        keptBytes += v.bytes;
        keptVersions += 1;
      } else {
        reclaimableBytes += v.bytes;
        reclaimableProxyBytes += v.proxyBytes;
        supersededVersions += 1;
        supersededFiles += v.fileCount;
      }
    }
  }

  return {
    keepN,
    reclaimableBytes,
    supersededVersions,
    supersededFiles,
    reclaimableProxyBytes,
    protectedPatchBytes,
    protectedPatchVersions,
    keptBytes,
    keptVersions,
    verdicts,
  };
}

/** Bytes to TiB, the unit used throughout this project (bytes / 1024^4). */
export function toTiB(bytes: number): number {
  return bytes / 1024 ** 4;
}

/** Bytes to GiB (bytes / 1024^3). */
export function toGiB(bytes: number): number {
  return bytes / 1024 ** 3;
}

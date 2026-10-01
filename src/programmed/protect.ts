/**
 * =============================================================================
 *  RESOLVING A CAPTURE ONTO THE SNAPSHOT  --  which version rows are protected
 * =============================================================================
 *
 * Turns `ProgrammedRef`s into a set of `asset_version.id`s that must never be
 * marked superseded, plus a report of everything that did NOT resolve.
 *
 * THE REPORT IS NOT DECORATION. A capture that matches nothing produces an
 * empty protection set, which is byte-for-byte what "the show plays nothing"
 * produces, and an export would proceed happily on either. So every reference
 * that fails to land is counted and named, and `ProgrammedProtection.usable`
 * says whether the result is fit to run an export against.
 *
 * WHY A BASE MAY PROTECT MORE THAN ONE ASSET
 *
 * `asset` is unique on (snapshot, song_folder, base), not on base alone -- four
 * bases in this archive live in two song folders each, all `999_TECH_*`. A
 * capture names the base and not the song folder, so a matching base protects
 * the version in EVERY folder that carries it. That over-protects by at most a
 * duplicate and it cannot under-protect, which is the only direction that
 * matters here.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not touch ranking. A protected version keeps its own bytes and
 * nothing else: it takes no slot in the keep-N window and pushes no other
 * version out. See the note on `protectedVersionIds` in `src/scan/reclaim.ts`.
 * =============================================================================
 */

import type { ReclaimAssetInput } from '../scan/reclaim.ts';
import type { ProgrammedCapture, ProgrammedRef } from './parse.ts';

/** A reference that named an asset the archive has not got. */
export interface UnmatchedName {
  rawName: string;
  base: string;
  trackName: string | null;
  /** How many references shared this name. */
  count: number;
}

/** A reference whose asset exists but whose version does not. */
export interface UnmatchedVersion {
  rawName: string;
  base: string;
  rawVersion: string | null;
  /** Versions the archive DOES hold for that asset, as labels. */
  archiveHas: string[];
  count: number;
}

/** One place a version is programmed: a track, and the setlists it is on. */
export interface ProgrammedUse {
  /** Track id in the capture. */
  track: string;
  /** Setlists carrying that track. Empty only when the capture had none. */
  setlists: string[];
}

/** A track in the loaded captures, for the filter panel's picker. */
export interface ProgrammedTrackSummary {
  track: string;
  setlists: string[];
  /** Archive versions this track's references resolved to. */
  versions: number;
}

/** A setlist in the loaded captures. */
export interface ProgrammedSetlistSummary {
  setlist: string;
  /** Transports it is loaded on, across every capture. */
  transports: string[];
  /** Distinct tracks on it. */
  tracks: number;
}

export interface ProgrammedProtection {
  /** `asset_version.id`s that must be kept whatever the supersession rules say. */
  protectedVersionIds: ReadonlySet<number>;
  /** Assets protected in full because a reference named no version. */
  wholeAssetIds: ReadonlySet<number>;
  /** Captures that fed this, newest `capturedAt` first. */
  captures: Array<{
    sourceFile: string;
    capturedAt: string | null;
    capturedAtSource: 'capture' | 'file-mtime';
    kind: 'summary' | 'project';
    project: string | null;
    refs: number;
    warnings: number;
  }>;
  /**
   * Where each protected version is programmed, by `asset_version.id`. Drives
   * the drill-down and the track/setlist filters. A version protected because
   * a reference named no version is listed under that reference's track too:
   * it is what the track asks for, as far as the capture can say.
   */
  programmedOn: ReadonlyMap<number, readonly ProgrammedUse[]>;
  /** Every track that carries media, in name order. */
  tracks: ProgrammedTrackSummary[];
  /** Every setlist, in name order. */
  setlists: ProgrammedSetlistSummary[];
  /** Distinct media names in the captures. */
  totalNames: number;
  /** Distinct names that resolved to at least one archive asset. */
  matchedNames: number;
  /** Names the archive has no asset for. Reported, never swallowed. */
  unmatchedNames: UnmatchedName[];
  /** Names whose asset exists but whose version does not. The loud case. */
  unmatchedVersions: UnmatchedVersion[];
  /**
   * False when the result is not fit to protect an export: no capture at all,
   * or a capture that resolved to nothing. An export must refuse rather than
   * proceed on a protection set that is empty for an unknown reason.
   */
  usable: boolean;
}

/** Version identity key, matching `compareVersions`' notion of identity. */
const identity = (verNum: number, subLetter: string | null): string =>
  `${verNum}|${subLetter ?? ''}`;

/** `v002d` / `v002` -- for reporting what the archive actually holds. */
const label = (verNum: number, subLetter: string | null): string =>
  `v${String(verNum).padStart(3, '0')}${subLetter ?? ''}`;

/**
 * Resolve captures against the WHOLE snapshot.
 *
 * `assets` must be the entire snapshot, unfiltered, for the same reason
 * `computeReclaim` demands it: a filtered input would silently fail to find
 * assets that are present, and every such miss removes protection.
 */
export function resolveProgrammed(
  captures: readonly ProgrammedCapture[],
  assets: readonly ReclaimAssetInput[],
): ProgrammedProtection {
  // base (lower case) -> the assets carrying it, in any song folder.
  const byBase = new Map<string, ReclaimAssetInput[]>();
  for (const a of assets) {
    const k = a.base.toLowerCase();
    const list = byBase.get(k);
    if (list) list.push(a);
    else byBase.set(k, [a]);
  }

  const protectedVersionIds = new Set<number>();
  const wholeAssetIds = new Set<number>();
  const unmatchedNames = new Map<string, UnmatchedName>();
  const unmatchedVersions = new Map<string, UnmatchedVersion>();
  const names = new Set<string>();
  const matched = new Set<string>();

  const allRefs: ProgrammedRef[] = [];
  for (const c of captures) allRefs.push(...c.refs);

  // versionId -> track -> setlists. Sets, because the same track reaches the
  // same version once per layer that plays it and once per capture loaded.
  const uses = new Map<number, Map<string, Set<string>>>();
  const trackVersions = new Map<string, Set<number>>();
  const trackSetlists = new Map<string, Set<string>>();
  const use = (versionId: number, ref: ProgrammedRef): void => {
    protectedVersionIds.add(versionId);
    const track = ref.trackId ?? ref.trackName;
    if (track === null) return;
    let byTrack = uses.get(versionId);
    if (!byTrack) uses.set(versionId, (byTrack = new Map()));
    let lists = byTrack.get(track);
    if (!lists) byTrack.set(track, (lists = new Set()));
    for (const sl of ref.setlists) lists.add(sl);
    let tv = trackVersions.get(track);
    if (!tv) trackVersions.set(track, (tv = new Set()));
    tv.add(versionId);
  };
  for (const ref of allRefs) {
    const track = ref.trackId ?? ref.trackName;
    if (track === null) continue;
    let ts = trackSetlists.get(track);
    if (!ts) trackSetlists.set(track, (ts = new Set()));
    for (const sl of ref.setlists) ts.add(sl);
  }

  for (const ref of allRefs) {
    names.add(ref.base);
    const hits = byBase.get(ref.base);
    if (!hits || hits.length === 0) {
      const prev = unmatchedNames.get(ref.base);
      if (prev) prev.count += 1;
      else
        unmatchedNames.set(ref.base, {
          rawName: ref.rawName,
          base: ref.base,
          trackName: ref.trackName,
          count: 1,
        });
      continue;
    }
    matched.add(ref.base);

    for (const asset of hits) {
      if (ref.verNum === null) {
        // No readable version: the show plays this asset and the capture will
        // not say which render. Protect all of them -- see the header.
        wholeAssetIds.add(asset.id);
        for (const v of asset.versions) use(v.id, ref);
        continue;
      }
      const want = identity(ref.verNum, ref.subLetter);
      const rows = asset.versions.filter((v) => identity(v.verNum, v.subLetter) === want);
      if (rows.length === 0) {
        // The asset is here and the programmed version is not. Either the
        // capture is newer than the scan, or a render was removed by hand.
        // Both are worth an operator's attention; neither is silently fine.
        const key = `${ref.base}|${ref.rawVersion ?? ''}`;
        const prev = unmatchedVersions.get(key);
        if (prev) prev.count += 1;
        else
          unmatchedVersions.set(key, {
            rawName: ref.rawName,
            base: ref.base,
            rawVersion: ref.rawVersion,
            archiveHas: [...new Set(asset.versions.map((v) => label(v.verNum, v.subLetter)))].sort(),
            count: 1,
          });
        continue;
      }
      for (const v of rows) use(v.id, ref);
    }
  }

  const byName = (a: string, b: string): number => a.localeCompare(b);
  const programmedOn = new Map<number, ProgrammedUse[]>();
  for (const [versionId, byTrack] of uses) {
    programmedOn.set(
      versionId,
      [...byTrack]
        .map(([track, lists]) => ({ track, setlists: [...lists].sort(byName) }))
        .sort((a, b) => byName(a.track, b.track)),
    );
  }

  const tracks: ProgrammedTrackSummary[] = [...trackSetlists]
    .map(([track, lists]) => ({
      track,
      setlists: [...lists].sort(byName),
      versions: trackVersions.get(track)?.size ?? 0,
    }))
    .sort((a, b) => byName(a.track, b.track));

  const setlistMap = new Map<string, { transports: Set<string>; tracks: Set<string> }>();
  for (const c of captures) {
    for (const sl of c.setlists) {
      let e = setlistMap.get(sl.setlist);
      if (!e) setlistMap.set(sl.setlist, (e = { transports: new Set(), tracks: new Set() }));
      if (sl.transport !== null) e.transports.add(sl.transport);
      for (const t of sl.trackIds) e.tracks.add(t);
    }
  }
  const setlists: ProgrammedSetlistSummary[] = [...setlistMap]
    .map(([setlist, e]) => ({
      setlist,
      transports: [...e.transports].sort(byName),
      tracks: e.tracks.size,
    }))
    .sort((a, b) => byName(a.setlist, b.setlist));

  const captureSummaries = captures
    .map((c) => ({
      sourceFile: c.sourceFile,
      capturedAt: c.capturedAt,
      capturedAtSource: c.capturedAtSource,
      kind: c.kind,
      project: c.project,
      refs: c.refs.length,
      warnings: c.warnings.length,
    }))
    .sort((a, b) => (b.capturedAt ?? '').localeCompare(a.capturedAt ?? ''));

  return {
    protectedVersionIds,
    wholeAssetIds,
    captures: captureSummaries,
    programmedOn,
    tracks,
    setlists,
    totalNames: names.size,
    matchedNames: matched.size,
    unmatchedNames: [...unmatchedNames.values()].sort((a, b) => b.count - a.count),
    unmatchedVersions: [...unmatchedVersions.values()].sort((a, b) => b.count - a.count),
    usable: captures.length > 0 && protectedVersionIds.size > 0,
  };
}

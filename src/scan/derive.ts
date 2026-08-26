/**
 * Derive assets and asset-versions from parsed file records. PURE -- no I/O.
 *
 * ASSET IDENTITY is the pair (song_folder, base). `base` is used VERBATIM:
 * never normalised, stemmed, lowercased or fuzzy-matched. Two bases that share
 * a prefix are two different deliverables.
 *
 * A VERSION groups every file sharing (ver, sub, isPatch, patchFrame) within an
 * asset -- i.e. all of a version's LED-tile regions plus its proxy roll up into
 * one version row. A `_frameNNNNN` patch is its OWN version row, distinct from
 * the full version of the same number, because it is a partial re-render and
 * NOT a replacement for it.
 *
 * A SUB-REVISION LETTER MAKES A DISTINCT VERSION. `v002`, `v002d` and `v002f`
 * are THREE separate versions of the asset, each its own row, ordered
 * `v002 < v002d < v002f < v003`: an absent letter sorts first, because the
 * letter marks a later refinement of the numbered render.
 *
 * They are NOT rolled together. An earlier revision of this module folded them
 * into a single `ver_num` row; that was wrong, and the reasoning that justified
 * it (matching a prototype's reclaim totals) was itself derived from a
 * prototype that discarded the letter. Do not reinstate the folding.
 */

import type { FileRecord } from './walk.ts';
import { familyOf, type ParseResult } from './parse.ts';

export interface DerivedVersion {
  verNum: number;
  /**
   * Lower-cased sub-revision letter, or null for the bare `vNNN` form. Part of
   * this version's IDENTITY: `v002`, `v002d` and `v002f` are three versions.
   */
  subLetter: string | null;
  isPatch: boolean;
  patchFrame: number | null;
  /** Total bytes of every file in this version, proxies included. */
  bytes: number;
  fileCount: number;
  /** Subtotal of `bytes` contributed by `_proxyN` files. */
  proxyBytes: number;
  /**
   * Distinct LED-tile regions present, EXCLUDING proxy files (region0 is the
   * whole-canvas proxy, not a tile). A region-less version has 0.
   */
  regionCount: number;
  latestMtime: number;
  /** Indices into the caller's file array, for linking rows back to files. */
  fileIndexes: number[];
}

export interface DerivedAsset {
  songFolder: string;
  base: string;
  family: string;
  versions: DerivedVersion[];
}

export interface DeriveResult {
  assets: DerivedAsset[];
  /** Indices of files whose names did not match the grammar. */
  unparsedIndexes: number[];
}

/**
 * Order versions oldest to newest: by version number, then by sub-revision
 * letter with an ABSENT letter sorting FIRST.
 *
 *   v002 < v002a < v002d < v002f < v003
 *
 * The letter marks a later refinement of the numbered render, so the bare form
 * is the earliest member of its number.
 */
export function compareVersions(
  a: { verNum: number; subLetter: string | null },
  b: { verNum: number; subLetter: string | null },
): number {
  if (a.verNum !== b.verNum) return a.verNum - b.verNum;
  const as = a.subLetter ?? '';
  const bs = b.subLetter ?? '';
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Identity of a version within an asset: number, letter, and patch frame. */
export function versionIdentity(v: {
  verNum: number;
  subLetter: string | null;
  isPatch: boolean;
  patchFrame: number | null;
}): string {
  return `${v.verNum}|${v.subLetter ?? ''}|${v.isPatch ? `f${v.patchFrame ?? 'x'}` : ''}`;
}

function versionKey(p: Extract<ParseResult, { ok: true }>): string {
  // The sub-letter is part of the identity. Patches are keyed apart from the
  // full version of the same number, because a patch never replaces it.
  return versionIdentity({
    verNum: p.ver,
    subLetter: p.sub,
    isPatch: p.isPatch,
    patchFrame: p.patchFrame,
  });
}

export function deriveAssets(
  files: readonly FileRecord[],
  parsed: readonly ParseResult[],
  families: Record<string, string[]>,
  defaultFamily = 'OTHER',
): DeriveResult {
  if (files.length !== parsed.length) {
    throw new Error('deriveAssets: files and parsed arrays must be the same length');
  }

  const assets = new Map<string, DerivedAsset>();
  const versionMaps = new Map<string, Map<string, DerivedVersion>>();
  const regionSets = new Map<string, Set<number>>();
  const unparsedIndexes: number[] = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i] as FileRecord;
    const p = parsed[i] as ParseResult;

    if (!p.ok) {
      unparsedIndexes.push(i);
      continue;
    }

    const assetKey = `${f.songFolder} ${p.base}`;
    let asset = assets.get(assetKey);
    if (!asset) {
      asset = {
        songFolder: f.songFolder,
        base: p.base,
        family: familyOf(p.base, families, defaultFamily),
        versions: [],
      };
      assets.set(assetKey, asset);
      versionMaps.set(assetKey, new Map());
    }

    const vmap = versionMaps.get(assetKey) as Map<string, DerivedVersion>;
    const vkey = versionKey(p);
    let version = vmap.get(vkey);
    if (!version) {
      version = {
        verNum: p.ver,
        subLetter: p.sub,
        isPatch: p.isPatch,
        patchFrame: p.patchFrame,
        bytes: 0,
        fileCount: 0,
        proxyBytes: 0,
        regionCount: 0,
        latestMtime: 0,
        fileIndexes: [],
      };
      vmap.set(vkey, version);
      asset.versions.push(version);
      regionSets.set(`${assetKey} ${vkey}`, new Set());
    }

    version.bytes += f.size;
    version.fileCount += 1;
    if (p.isProxy) version.proxyBytes += f.size;
    if (f.mtime > version.latestMtime) version.latestMtime = f.mtime;
    version.fileIndexes.push(i);

    // region0 belongs to the proxy canvas, not to the LED tile set.
    if (p.region !== null && !p.isProxy) {
      (regionSets.get(`${assetKey} ${vkey}`) as Set<number>).add(p.region);
    }
  }

  // Fold region sets into counts and put versions in a stable order.
  for (const [assetKey, asset] of assets) {
    const vmap = versionMaps.get(assetKey) as Map<string, DerivedVersion>;
    for (const [vkey, version] of vmap) {
      version.regionCount = (regionSets.get(`${assetKey} ${vkey}`) as Set<number>).size;
    }
    asset.versions.sort((a, b) => {
      const c = compareVersions(a, b);
      if (c !== 0) return c;
      if (a.isPatch !== b.isPatch) return a.isPatch ? 1 : -1;
      return (a.patchFrame ?? 0) - (b.patchFrame ?? 0);
    });
  }

  const out = [...assets.values()].sort(
    (a, b) => a.songFolder.localeCompare(b.songFolder) || a.base.localeCompare(b.base),
  );

  return { assets: out, unparsedIndexes };
}

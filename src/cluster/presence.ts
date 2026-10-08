/**
 * Which archive files are on the cluster -- the catalog's listing laid over a
 * snapshot. Pure: no I/O, no database.
 *
 * A file is on the cluster when some seat holds a file of the same NAME
 * (ignoring case, as the catalog itself matches) at the same SIZE. A copy at
 * the wrong size is not a copy -- the rig survey's rule, for the same reason --
 * and is counted on its own rather than folded into either side.
 *
 * The cluster is ONE location: an archive file held by two seats is on the
 * cluster once, and its bytes are counted once.
 */

import type { ClusterListing } from './catalog.ts';

export interface ArchiveFileRef {
  id: number;
  name: string;
  size: number;
  versionId: number | null;
}

export interface ClusterPresence {
  /** Archive file ids on the cluster. */
  fileIds: ReadonlySet<number>;
  /** Per version: how many of its files, and how many of its bytes, are there. */
  byVersion: ReadonlyMap<number, { files: number; bytes: number }>;
  matchedFiles: number;
  matchedBytes: number;
  /** Archive files whose name is on the cluster only at another size. */
  sizeMismatchFiles: number;
  /** Cluster files whose name the archive has not got. */
  strangerFiles: number;
  strangerBytes: number;
  /**
   * Per machine, each file it holds that the archive has at that name and
   * size, with the versions it belongs to -- usually one; more only where two
   * archive files share a name and a size. Summed per machine, a file counts
   * once however many versions claim it.
   */
  byMachine: ReadonlyMap<string, ReadonlyArray<{ size: number; versionIds: readonly number[] }>>;
}

export function resolveClusterPresence(
  listing: ClusterListing,
  archive: readonly ArchiveFileRef[],
): ClusterPresence {
  const sizesByName = new Map<string, Set<number>>();
  for (const f of listing.files) {
    const k = f.name.toLowerCase();
    let s = sizesByName.get(k);
    if (!s) sizesByName.set(k, (s = new Set()));
    s.add(f.size);
  }

  const fileIds = new Set<number>();
  const byVersion = new Map<number, { files: number; bytes: number }>();
  const archiveNames = new Set<string>();
  let matchedFiles = 0;
  let matchedBytes = 0;
  let sizeMismatchFiles = 0;

  for (const f of archive) {
    const k = f.name.toLowerCase();
    archiveNames.add(k);
    const sizes = sizesByName.get(k);
    if (!sizes) continue;
    if (!sizes.has(f.size)) {
      sizeMismatchFiles += 1;
      continue;
    }
    fileIds.add(f.id);
    matchedFiles += 1;
    matchedBytes += f.size;
    if (f.versionId !== null) {
      const v = byVersion.get(f.versionId) ?? { files: 0, bytes: 0 };
      v.files += 1;
      v.bytes += f.size;
      byVersion.set(f.versionId, v);
    }
  }

  // name|size -> the versions of the archive files carrying it.
  const versionsByKey = new Map<string, number[]>();
  for (const f of archive) {
    if (f.versionId === null) continue;
    const k = `${f.name.toLowerCase()}|${f.size}`;
    const list = versionsByKey.get(k);
    if (list) list.push(f.versionId);
    else versionsByKey.set(k, [f.versionId]);
  }

  let strangerFiles = 0;
  let strangerBytes = 0;
  const byMachine = new Map<string, Array<{ size: number; versionIds: number[] }>>();
  for (const f of listing.files) {
    const name = f.name.toLowerCase();
    if (!archiveNames.has(name)) {
      strangerFiles += 1;
      strangerBytes += f.size;
      continue;
    }
    const versionIds = versionsByKey.get(`${name}|${f.size}`);
    if (!versionIds) continue;
    let list = byMachine.get(f.machine);
    if (!list) byMachine.set(f.machine, (list = []));
    list.push({ size: f.size, versionIds });
  }

  return {
    fileIds,
    byVersion,
    matchedFiles,
    matchedBytes,
    sizeMismatchFiles,
    strangerFiles,
    strangerBytes,
    byMachine,
  };
}

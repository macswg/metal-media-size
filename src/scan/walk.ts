/**
 * Breadth-first walk of the archive, through the read-only chokepoint ONLY.
 *
 * The tree is shallow (root -> song folder -> files), so this is a simple BFS
 * with a bounded stat concurrency. There is no worker pool and no
 * checkpointing: at 26k files the whole walk takes ~12 seconds and the extra
 * machinery would only add failure modes.
 *
 * A directory that times out is recorded and skipped -- the scan continues and
 * the skip is reported, rather than the whole run hanging.
 */

import { join, relative, sep } from 'node:path';
import { ReadOnlyFs, DirTimeoutError, PathNotAllowedError } from '../fs/readonly.ts';
import { ExclusionMatcher, type ExcludedTally } from './exclude.ts';
import { extensionOf } from './parse.ts';

export interface FileRecord {
  /** Path relative to the scan root, using `/` separators. */
  relPath: string;
  /** First path segment: the song folder. Empty string for root-level files. */
  songFolder: string;
  /** Basename. */
  name: string;
  /** Lower-cased extension without the dot. */
  ext: string;
  size: number;
  /** mtime in milliseconds since epoch. */
  mtime: number;
}

export interface WalkSkip {
  path: string;
  reason: string;
}

export interface WalkResult {
  root: string;
  files: FileRecord[];
  totalBytes: number;
  /** Directories visited, including the root. */
  dirCount: number;
  /** Directories abandoned (timeout, permission, etc). */
  skipped: WalkSkip[];
  /** Excluded FreeFileSync/AppleDouble bookkeeping -- counted, not analysed. */
  excluded: ExcludedTally;
  /** Wall-clock milliseconds. */
  elapsedMs: number;
}

export interface WalkOptions {
  /** Max concurrent lstat calls. Default 64. Measured: helps on a net mount. */
  statConcurrency?: number;
  /** Called once per directory listed, for progress reporting. */
  onDir?: (dir: string, entryCount: number) => void;
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i] as T);
    }
  });
  await Promise.all(runners);
  return out;
}

export async function walk(
  rofs: ReadOnlyFs,
  root: string,
  exclusions: ExclusionMatcher,
  options: WalkOptions = {},
): Promise<WalkResult> {
  const started = Date.now();
  const statConcurrency = options.statConcurrency ?? 64;

  rofs.assertAllowed(root);

  const files: FileRecord[] = [];
  const skipped: WalkSkip[] = [];
  let totalBytes = 0;
  let dirCount = 0;

  // Breadth-first: a FIFO of directories still to list.
  const queue: string[] = [root];

  while (queue.length > 0) {
    const dir = queue.shift() as string;

    let entries;
    try {
      entries = await rofs.readdir(dir);
      dirCount += 1;
    } catch (err) {
      if (err instanceof DirTimeoutError) {
        skipped.push({ path: dir, reason: `timeout after ${rofs.dirTimeoutMs}ms` });
        continue;
      }
      if (err instanceof PathNotAllowedError) throw err;
      skipped.push({ path: dir, reason: (err as Error).message });
      continue;
    }

    options.onDir?.(dir, entries.length);

    // Queue subdirectories; stat the files.
    const toStat: { name: string; full: string }[] = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory) {
        // Excluded names apply to directories too (e.g. a stray `._foo` dir).
        if (exclusions.isExcluded(e.name)) continue;
        queue.push(full);
        continue;
      }
      // Symlinks are recorded via lstat but never followed.
      toStat.push({ name: e.name, full });
    }

    await pooled(toStat, statConcurrency, async ({ name, full }) => {
      let st;
      try {
        st = await rofs.lstat(full);
      } catch (err) {
        skipped.push({ path: full, reason: (err as Error).message });
        return;
      }
      if (!st.isFile) return;

      // Excluded entries are still counted so they are not silently invisible.
      const excludedBy = exclusions.match(name);
      if (excludedBy !== null) {
        exclusions.record(excludedBy, st.size);
        return;
      }

      const rel = relative(root, full).split(sep).join('/');
      const slash = rel.indexOf('/');
      files.push({
        relPath: rel,
        songFolder: slash === -1 ? '' : rel.slice(0, slash),
        name,
        ext: extensionOf(name),
        size: st.size,
        mtime: st.mtimeMs,
      });
      totalBytes += st.size;
    });
  }

  // Merge skips recorded inside the fs layer (deduplicated by path).
  const seen = new Set(skipped.map((s) => s.path));
  for (const s of rofs.getSkipped()) {
    if (!seen.has(s.path)) skipped.push({ path: s.path, reason: s.reason });
  }

  return {
    root,
    files,
    totalBytes,
    dirCount,
    skipped,
    excluded: exclusions.tally,
    elapsedMs: Date.now() - started,
  };
}

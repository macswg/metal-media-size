/**
 * =============================================================================
 *  RIG BROWSE  --  WHICH DIRECTORIES ARE THERE, AND NOTHING ELSE
 * =============================================================================
 *
 * The survey takes a directory relative to the share root, and until now the
 * only way to give it one was to type it correctly from memory. A typo does not
 * fail loudly: an empty directory surveys clean, and a clean survey is exactly
 * the answer an operator wants to see, which makes a mistyped path the most
 * dangerous kind of wrong answer this feature can give. So the path can be
 * picked from the machine itself.
 *
 * THIS LISTS DIRECTORIES. It calls `readdir` on one directory, one level deep,
 * and that is the whole of it -- no recursion, no `lstat`, and no file is
 * opened at any point. It is strictly less than the survey already does, and it
 * goes through the same `ReadOnlyFs` chokepoint fenced to the one mountpoint,
 * so a path cannot reach past the share even if the route's own check were
 * wrong. See `src/rig/mounts.ts` for why the mount underneath it is read-only.
 *
 * THE FILE COUNT IS FROM THE DIRECTORY ENTRIES, not from the files. A listing
 * says what kind of place this is -- 300 files means media, 0 files and 65
 * folders means a level above it -- and it comes free with the entries that
 * were already read. Sizes are deliberately absent: they would cost one
 * round trip per file on an SMB share, and the survey is where sizes belong.
 * =============================================================================
 */

import { join } from 'node:path';
import { ReadOnlyFs } from '../fs/readonly.ts';

/**
 * How many subdirectories a single listing will return.
 *
 * A picker is a human-sized list; a directory with more entries than this is
 * not one an operator is going to scroll. The cap is reported rather than
 * applied silently, so a truncated list can never read as a complete one.
 */
export const MAX_BROWSE_ENTRIES = 500;

export interface BrowseEntry {
  name: string;
  /** Path relative to the SHARE ROOT, `/` separated -- what the survey takes. */
  path: string;
}

export interface BrowseListing {
  /** The directory listed, relative to the share root. `''` is the share root. */
  directory: string;
  /** The directory above this one, or null at the share root. */
  parent: string | null;
  /** Subdirectories, name-ordered. Symlinks are not among them: not followed. */
  directories: BrowseEntry[];
  /** Files sitting directly here. Counted from the entries; never opened. */
  fileCount: number;
  /** True when there were more subdirectories than the cap allows. */
  truncated: boolean;
}

/** Case- and number-aware ordering, so `10` sorts after `9` and not after `1`. */
const byName = (a: BrowseEntry, b: BrowseEntry): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * List the subdirectories of one directory on one mounted machine.
 *
 * `directory` is relative to the share root and must already have been through
 * the route's `assertRelativeDirectory`. The fence here is the second check,
 * not the first: `ReadOnlyFs` is constructed with this machine's mountpoint as
 * its only allowed root, so an escape is refused structurally.
 */
export async function browseDirectory(opts: {
  mountPoint: string;
  directory: string;
  dirTimeoutMs?: number | undefined;
}): Promise<BrowseListing> {
  const directory = opts.directory;
  const rofs = new ReadOnlyFs({
    allowedRoots: [opts.mountPoint],
    ...(opts.dirTimeoutMs === undefined ? {} : { dirTimeoutMs: opts.dirTimeoutMs }),
  });

  const abs = directory === '' ? opts.mountPoint : join(opts.mountPoint, directory);
  const entries = await rofs.readdir(abs);

  const directories: BrowseEntry[] = [];
  let fileCount = 0;
  for (const e of entries) {
    // A `Dirent` reports a symlink as a symlink, whatever it points at. One is
    // neither descended into nor counted as a file: following it is how a
    // listing leaves the share, and this walks nothing.
    if (e.isSymbolicLink) continue;
    if (e.isDirectory) {
      directories.push({ name: e.name, path: directory === '' ? e.name : `${directory}/${e.name}` });
    } else if (e.isFile) {
      fileCount += 1;
    }
  }
  directories.sort(byName);

  const segments = directory === '' ? [] : directory.split('/');
  return {
    directory,
    parent: segments.length === 0 ? null : segments.slice(0, -1).join('/'),
    directories: directories.slice(0, MAX_BROWSE_ENTRIES),
    fileCount,
    truncated: directories.length > MAX_BROWSE_ENTRIES,
  };
}

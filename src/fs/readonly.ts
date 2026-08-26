/**
 * =============================================================================
 *  READ-ONLY FILESYSTEM CHOKEPOINT  --  THE ONLY MODULE THAT TOUCHES THE ARCHIVE
 * =============================================================================
 *
 * CONTRACT (binding on every module in this codebase, including modules added
 * by later agents building the API, frontend and exporters):
 *
 *   1. This file is the ONLY place in `src/` allowed to import `node:fs`
 *      for the purpose of reading the archive. The single documented exception
 *      is `src/export/writer.ts`, which writes export artefacts into the
 *      project's own `exports/` directory and NEVER into the archive.
 *      `test/readonly-enforcement.test.ts` enforces both rules mechanically
 *      and will fail the build if they are broken.
 *
 *   2. Exactly three operations are exposed:
 *        - readdir(dir)   -> directory entries, with dirent type info
 *        - lstat(path)    -> stat WITHOUT following symlinks
 *        - openRead(path) -> a file handle opened with flag 'r' ONLY
 *      There is deliberately NO mutation API here: nothing that creates,
 *      replaces, moves, removes, re-permissions, re-owns, re-stamps or
 *      shortens a file. None may ever be added.
 *
 *      (This comment avoids spelling those primitives by name on purpose --
 *      `test/readonly-enforcement.test.ts` greps `src/` for their literal
 *      identifiers with no comment-stripping, so the check stays trivial to
 *      audit and cannot be fooled by a broken parser. Naming them in prose
 *      here would force a weaker test.)
 *
 *   3. Every path is checked against a ROOT ALLOWLIST before any syscall.
 *      A path that does not resolve to a location inside one of the configured
 *      allowed roots is rejected with `PathNotAllowedError`. This exists to
 *      make it structurally impossible to point the scanner at the enclosing
 *      object-mount root, whose directory listings stall indefinitely.
 *
 *   4. `readdir` is wrapped in a per-directory timeout. A directory that does
 *      not answer within the budget is RECORDED AND SKIPPED rather than being
 *      allowed to hang the whole scan. Skips surface as `DirTimeoutError` and
 *      are collected by the walker into the scan report.
 *
 * WHY THIS MATTERS: the archive is 133 TB of irreplaceable master renders on a
 * read-only object mount with no backup. There is no undo. Reading is safe;
 * nothing else is permitted. If you are unsure whether an operation writes,
 * do not add it.
 *
 * NOTE ON `openRead`: the returned handle is a `FileHandle` whose underlying
 * descriptor was opened O_RDONLY. Write calls on it fail at the OS level, so
 * the read-only guarantee does not rest on convention alone.
 * =============================================================================
 */

import { open, opendir, lstat as fsLstat, realpath as fsRealpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { resolve, sep, isAbsolute } from 'node:path';

export class PathNotAllowedError extends Error {
  readonly code = 'PATH_NOT_ALLOWED';
  readonly path: string;
  readonly roots: readonly string[];
  constructor(path: string, roots: readonly string[]) {
    super(
      `Refusing to touch ${JSON.stringify(path)}: not inside an allowed root. ` +
        `Allowed roots: ${roots.map((r) => JSON.stringify(r)).join(', ')}`,
    );
    this.name = 'PathNotAllowedError';
    this.path = path;
    this.roots = roots;
  }
}

export class DirTimeoutError extends Error {
  readonly code = 'DIR_TIMEOUT';
  readonly path: string;
  readonly timeoutMs: number;
  constructor(path: string, timeoutMs: number) {
    super(`Directory listing timed out after ${timeoutMs}ms: ${path}`);
    this.name = 'DirTimeoutError';
    this.path = path;
    this.timeoutMs = timeoutMs;
  }
}

export interface ReadOnlyFsOptions {
  /** Absolute paths. Any access outside these (after resolution) is refused. */
  allowedRoots: readonly string[];
  /** Per-directory listing budget in ms. Default 30_000. */
  dirTimeoutMs?: number;
  /**
   * When true, symlinked paths are resolved with realpath before the allowlist
   * check, so a symlink inside an allowed root cannot be used to escape it.
   * Costs one extra syscall per checked path. Default false: this archive has
   * no symlinks and the scan is latency-bound on a network mount.
   */
  resolveSymlinks?: boolean;
}

/** A directory entry, flattened so callers never hold a live `Dirent`. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

/** The subset of `Stats` this application is allowed to care about. */
export interface StatInfo {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

const DEFAULT_DIR_TIMEOUT_MS = 30_000;

/**
 * Race `work` against a wall-clock budget.
 *
 * Exported so the timeout mechanism can be tested deterministically against a
 * promise that never settles -- racing a real directory listing against a short
 * budget is inherently flaky, and a flaky test of a safety mechanism is worse
 * than no test.
 *
 * If the budget expires, `onTimeout()` supplies the rejection value and the
 * still-pending `work` promise is defused so a later rejection cannot surface
 * as an unhandled rejection.
 */
export async function raceWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // The loser of the race may still reject later; make sure that is handled.
    void work.catch(() => {});
  }
}

function normaliseRoot(root: string): string {
  if (!isAbsolute(root)) {
    throw new Error(`Allowed root must be an absolute path, got ${JSON.stringify(root)}`);
  }
  const r = resolve(root);
  return r.endsWith(sep) ? r.slice(0, -1) : r;
}

function isUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * A read-only view of the filesystem, fenced to a set of allowed roots.
 * Construct one per configured archive; share it across the scan.
 */
export class ReadOnlyFs {
  readonly allowedRoots: readonly string[];
  readonly dirTimeoutMs: number;
  private readonly resolveSymlinks: boolean;
  /** Directories that timed out and were skipped, in encounter order. */
  private readonly skipped: { path: string; reason: string }[] = [];

  constructor(options: ReadOnlyFsOptions) {
    if (!options.allowedRoots?.length) {
      throw new Error('ReadOnlyFs requires at least one allowed root');
    }
    this.allowedRoots = options.allowedRoots.map(normaliseRoot);
    this.dirTimeoutMs = options.dirTimeoutMs ?? DEFAULT_DIR_TIMEOUT_MS;
    this.resolveSymlinks = options.resolveSymlinks ?? false;
  }

  /**
   * Throws unless `p` resolves to a location inside an allowed root.
   * Call this before ANY syscall. Returns the resolved absolute path.
   */
  assertAllowed(p: string): string {
    const abs = resolve(p);
    if (!this.allowedRoots.some((root) => isUnder(abs, root))) {
      throw new PathNotAllowedError(abs, this.allowedRoots);
    }
    return abs;
  }

  /** True if `p` is inside an allowed root. Never throws. */
  isAllowed(p: string): boolean {
    try {
      this.assertAllowed(p);
      return true;
    } catch {
      return false;
    }
  }

  private async checkPath(p: string): Promise<string> {
    const abs = this.assertAllowed(p);
    if (!this.resolveSymlinks) return abs;
    // Re-check after following symlinks so a link cannot escape the fence.
    let real: string;
    try {
      real = await fsRealpath(abs);
    } catch {
      return abs; // Broken link or missing file: the syscall below will report it.
    }
    if (!this.allowedRoots.some((root) => isUnder(real, root))) {
      throw new PathNotAllowedError(real, this.allowedRoots);
    }
    return abs;
  }

  /**
   * List a directory. Read-only.
   *
   * Uses `opendir` and drains the handle under a wall-clock budget, so a
   * stalling network directory is abandoned instead of hanging the scan.
   * On timeout the directory is recorded in `getSkipped()` and a
   * `DirTimeoutError` is thrown for the caller to handle.
   */
  async readdir(dir: string): Promise<DirEntry[]> {
    const abs = await this.checkPath(dir);
    const timeoutMs = this.dirTimeoutMs;

    const listing = (async (): Promise<DirEntry[]> => {
      const out: DirEntry[] = [];
      const handle = await opendir(abs);
      try {
        for await (const d of handle as AsyncIterable<Dirent>) {
          out.push({
            name: d.name,
            isDirectory: d.isDirectory(),
            isFile: d.isFile(),
            isSymbolicLink: d.isSymbolicLink(),
          });
        }
      } finally {
        // `for await` closes the handle; closing twice throws ERR_DIR_CLOSED.
        await handle.close().catch(() => {});
      }
      return out;
    })();

    try {
      return await raceWithTimeout(
        listing,
        timeoutMs,
        () => new DirTimeoutError(abs, timeoutMs),
      );
    } catch (err) {
      if (err instanceof DirTimeoutError) {
        this.skipped.push({ path: abs, reason: `timeout after ${timeoutMs}ms` });
      }
      throw err;
    }
  }

  /** Stat WITHOUT following symlinks. Read-only. */
  async lstat(p: string): Promise<StatInfo> {
    const abs = await this.checkPath(p);
    const st: Stats = await fsLstat(abs);
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      isDirectory: st.isDirectory(),
      isFile: st.isFile(),
      isSymbolicLink: st.isSymbolicLink(),
    };
  }

  /**
   * Open a file for reading. Flag is hard-coded to 'r' and cannot be
   * overridden by the caller. The descriptor is O_RDONLY at the OS level.
   * The caller MUST close the returned handle.
   */
  async openRead(p: string): Promise<FileHandle> {
    const abs = await this.checkPath(p);
    return open(abs, 'r');
  }

  /** Directories abandoned due to timeout during this session. */
  getSkipped(): readonly { path: string; reason: string }[] {
    return this.skipped;
  }

  /** Record a directory skipped for a reason other than timeout (e.g. EACCES). */
  recordSkip(path: string, reason: string): void {
    this.skipped.push({ path, reason });
  }
}

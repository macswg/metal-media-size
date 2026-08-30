/**
 * =============================================================================
 *  EXPORT WRITER  --  THE ONLY MODULE IN THE CODEBASE PERMITTED TO WRITE
 * =============================================================================
 *
 * The archive is 133 TB of irreplaceable master renders on a read-only mount
 * with no backup. `src/fs/readonly.ts` guarantees nothing READS outside the
 * allowlist. This module is the mirror of that guarantee for WRITES: it is the
 * single sanctioned exception in `test/readonly-enforcement.test.ts`, and it is
 * the only place a write primitive may appear.
 *
 * THE EXPORT JAIL
 * ---------------
 * Every path handed to this module is put through `assertExportPath` before any
 * syscall that could create or replace a byte on disk. The check is:
 *
 *   1. Resolve the path to an absolute path (this alone defeats `../../`
 *      traversal, because the escape shows up in the resolved result).
 *   2. Resolve SYMLINKS on the longest existing ancestor and re-attach the
 *      not-yet-existing tail, so a symlink planted inside `exports/` cannot be
 *      used to aim a write at the archive.
 *   3. Reject if the real path is at or under ANY forbidden root. Forbidden
 *      roots always include the object mount, `/Volumes`, and FreeFileSync's
 *      application-support directory; the caller adds the configured scan
 *      roots on top. This check runs FIRST and cannot be waived by pointing
 *      `exportsDir` somewhere dangerous.
 *   4. Reject anything named `LastRun.ffs_gui`, anywhere, at any time. The user
 *      has a live FreeFileSync job in that file.
 *   5. Reject unless the real path is strictly INSIDE the export directory.
 *
 * `exportsDir` is overridable only so the jail itself can be tested against a
 * scratch directory; the override is validated by rules 3 and 4 as well, so a
 * caller cannot use it to unlock the archive.
 *
 * There is no delete, no move and no in-place mutation API here, and none may
 * ever be added. Exports go into a fresh timestamped directory and files are
 * created with an exclusive flag, so an export can never clobber an earlier
 * one by accident.
 * =============================================================================
 */

import { writeFile, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Absolute path of the project root (the directory containing package.json). */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The one directory exports may land in. Ships with a `.gitkeep`. */
export const DEFAULT_EXPORTS_DIR = join(PROJECT_ROOT, 'exports');

/**
 * Locations that are never writable, whatever the caller asks for.
 *
 * - the object mount holding the archive, and its parent, so no sibling
 *   archive on the same mount is reachable either;
 * - `/Volumes`, which is where every other removable/network volume on macOS
 *   appears -- including the `d3 Projects` server named in the user's own
 *   FreeFileSync job. A project checked out under `/Volumes` would be unable
 *   to export; that is the intended trade, and it is safe by construction;
 * - FreeFileSync's configuration directory, which holds the live
 *   `LastRun.ffs_gui` job.
 *
 * ---------------------------------------------------------------------------
 * THE LAST TWO ARE PLATFORM-SPECIFIC, AND GETTING THAT WRONG IS SILENT.
 *
 * This list was written for macOS and every entry in it was a POSIX path. On
 * Windows none of them can ever match: FreeFileSync keeps `LastRun.ffs_gui` in
 * `%APPDATA%\FreeFileSync`, not in `~/Library/Application Support`, so the
 * guard that stops the exporter writing over a live job simply did not apply.
 * Nothing failed -- the export succeeded, which is precisely the problem.
 *
 * The POSIX entries are kept on every platform. They cost nothing where they
 * cannot match, and a list that changes shape per platform is a list somebody
 * eventually reads wrong.
 *
 * `\\server\share` is the Windows analogue of `/Volumes`: the place every
 * network volume appears. It cannot be expressed as a root prefix, so it is
 * enforced as its own rule in `assertResolvedPathAllowed` rather than bolted
 * into this list, where it would silently never match.
 * ---------------------------------------------------------------------------
 */
export const DEFAULT_FORBIDDEN_ROOTS: readonly string[] = Object.freeze([
  '/Users/Shared/ObjectMount.noindex',
  '/Volumes',
  '/System/Volumes/Data/Users/Shared/ObjectMount.noindex',
  ...freeFileSyncConfigDirs(),
]);

/**
 * Every directory FreeFileSync might keep `LastRun.ffs_gui` in, on any platform.
 *
 * All of them, not just this platform's: the cost of a root that cannot match
 * is nothing, and the cost of missing the one that can is a clobbered job.
 * `%APPDATA%` is read from the environment when it is set and reconstructed
 * from the home directory when it is not, so the Windows path is protected even
 * on a machine where the variable is missing.
 */
export function freeFileSyncConfigDirs(): string[] {
  const home = homedir();
  const appData = process.env['APPDATA'];
  const dirs = [
    // macOS
    join(home, 'Library', 'Application Support', 'FreeFileSync'),
    // Windows, from the environment and from the conventional location.
    ...(appData ? [join(appData, 'FreeFileSync')] : []),
    join(home, 'AppData', 'Roaming', 'FreeFileSync'),
    // Linux
    join(home, '.config', 'FreeFileSync'),
  ];
  return [...new Set(dirs)];
}

/**
 * True for a Windows UNC path -- `\\server\share\...`.
 *
 * The direct analogue of the `/Volumes` rule: it is where a network volume
 * appears, and the `d3 Projects` share on a playback machine is exactly such a
 * path. Detected by shape rather than by platform, because a path is a UNC path
 * whoever is looking at it.
 */
export function isUncPath(p: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(String(p ?? ''));
}

/** Never touch this file name, wherever it appears. */
export const PROTECTED_FILENAMES: readonly string[] = Object.freeze(['LastRun.ffs_gui']);

export class ExportJailError extends Error {
  readonly code = 'EXPORT_JAIL';
  readonly path: string;
  readonly reason: string;
  constructor(path: string, reason: string) {
    super(`Refusing to write ${JSON.stringify(path)}: ${reason}`);
    this.name = 'ExportJailError';
    this.path = path;
    this.reason = reason;
  }
}

export interface JailOptions {
  /**
   * The directory exports may land in. Defaults to `<project>/exports`.
   * Overridable for tests only; still subject to every other jail rule.
   */
  exportsDir?: string;
  /**
   * Extra forbidden roots, added to `DEFAULT_FORBIDDEN_ROOTS`. The caller is
   * expected to pass the configured scan roots here. They can only ever be
   * added; the defaults cannot be removed.
   */
  forbiddenRoots?: readonly string[];
}

function normaliseRoot(p: string): string {
  const r = resolve(p);
  return r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r;
}

function isAtOrUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function isStrictlyUnder(candidate: string, root: string): boolean {
  return candidate.startsWith(root + sep);
}

/** The full forbidden set for a call: the defaults plus the caller's additions. */
export function forbiddenRootsFor(opts: JailOptions = {}): string[] {
  const extra = (opts.forbiddenRoots ?? []).filter((r) => r && isAbsolute(r));
  return [...DEFAULT_FORBIDDEN_ROOTS, ...extra].map(normaliseRoot);
}

/**
 * The jail rules, applied to an ALREADY-RESOLVED real path. Pure and
 * synchronous, so the policy can be unit-tested without touching a disk.
 *
 * @throws ExportJailError
 */
export function assertResolvedPathAllowed(realPath: string, opts: JailOptions = {}): void {
  if (!isAbsolute(realPath)) {
    throw new ExportJailError(realPath, 'not an absolute path');
  }
  const target = normaliseRoot(realPath);
  const exportsDir = normaliseRoot(opts.exportsDir ?? DEFAULT_EXPORTS_DIR);

  // Rule 4 first: this name is off limits no matter where it turns up.
  if (PROTECTED_FILENAMES.includes(basename(target))) {
    throw new ExportJailError(
      target,
      `${basename(target)} is a live FreeFileSync job and is never writable`,
    );
  }

  // Rule 3a: never onto a network volume. On macOS those live under `/Volumes`
  // and the root check below catches them; a Windows UNC path has no such
  // parent directory to forbid, so it is refused by its shape.
  if (isUncPath(realPath) || isUncPath(exportsDir)) {
    throw new ExportJailError(
      target,
      'it is on a network share (a UNC path). Exports may only be written to ' +
        'local storage, under ' + JSON.stringify(exportsDir) + '.',
    );
  }

  // Rule 3: forbidden roots beat everything, including a bad exportsDir.
  for (const root of forbiddenRootsFor(opts)) {
    if (isAtOrUnder(target, root)) {
      throw new ExportJailError(
        target,
        `it is inside the protected location ${JSON.stringify(root)}. ` +
          `Exports may only be written under ${JSON.stringify(exportsDir)}.`,
      );
    }
    if (isAtOrUnder(exportsDir, root)) {
      throw new ExportJailError(
        target,
        `the export directory ${JSON.stringify(exportsDir)} is itself inside the ` +
          `protected location ${JSON.stringify(root)}.`,
      );
    }
  }

  // Rule 5: and it must be inside the export directory, not merely outside the
  // archive. `..` traversal lands here, because it resolved out of the jail.
  if (!isStrictlyUnder(target, exportsDir)) {
    throw new ExportJailError(
      target,
      `it is outside the export directory ${JSON.stringify(exportsDir)}. ` +
        `Exports may only be written there.`,
    );
  }
}

/**
 * Resolve a path the way the OS will, including symlinks, for a path whose
 * leaf does not exist yet: realpath the longest existing ancestor, then
 * re-attach the missing tail.
 */
export async function resolveRealPath(p: string): Promise<string> {
  const abs = resolve(p);
  const tail: string[] = [];
  let head = abs;
  for (;;) {
    try {
      const real = await realpath(head);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs; // reached the filesystem root
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * Resolve the jail's own boundaries through symlinks, so the comparison is
 * real-path against real-path. Without this, a scratch directory under
 * `/var/...` (which macOS resolves to `/private/var/...`) would never look like
 * it was inside itself, and -- far worse -- a symlinked forbidden root would
 * not be recognised as forbidden.
 */
async function resolveJail(opts: JailOptions): Promise<JailOptions> {
  const exportsDir = await resolveRealPath(opts.exportsDir ?? DEFAULT_EXPORTS_DIR);
  const roots: string[] = [];
  for (const r of forbiddenRootsFor(opts)) {
    roots.push(r);
    const real = await resolveRealPath(r);
    if (real !== r) roots.push(real);
  }
  return { exportsDir, forbiddenRoots: roots };
}

/**
 * Full check: resolve symlinks on both the target and the jail, then apply the
 * rules. Returns the real path that passed, which is the path callers should
 * actually write to.
 *
 * @throws ExportJailError
 */
export async function assertExportPath(p: string, opts: JailOptions = {}): Promise<string> {
  const real = await resolveRealPath(p);
  assertResolvedPathAllowed(real, await resolveJail(opts));
  return real;
}

/** Create a directory (and parents) inside the jail. Returns the real path. */
export async function ensureExportDir(p: string, opts: JailOptions = {}): Promise<string> {
  const real = await assertExportPath(p, opts);
  await mkdir(real, { recursive: true });
  // Re-check after creation: the directory that now exists is the one we
  // verified only if no component was a symlink pointing elsewhere.
  return assertExportPath(real, opts);
}

export interface WrittenFile {
  /** Absolute real path of the file created. */
  path: string;
  /** Size in bytes of what was written. */
  bytes: number;
}

/**
 * Write a UTF-8 text artefact into the export jail.
 *
 * Created with an exclusive flag by default, so an export can never silently
 * replace an earlier one. There is deliberately no option to remove or move an
 * existing file.
 */
export async function writeExportText(
  p: string,
  contents: string,
  opts: JailOptions & { allowOverwrite?: boolean } = {},
): Promise<WrittenFile> {
  const real = await assertExportPath(p, opts);
  await ensureExportDir(dirname(real), opts);
  // The parent may have been a symlink; re-verify the final target.
  const verified = await assertExportPath(real, opts);
  await writeFile(verified, contents, {
    encoding: 'utf8',
    flag: opts.allowOverwrite ? 'w' : 'wx',
  });
  return { path: verified, bytes: Buffer.byteLength(contents, 'utf8') };
}

/**
 * Prove a directory exists and is empty.
 *
 * This is not housekeeping. The left-hand side of every generated FreeFileSync
 * folder pair is an empty directory, and its emptiness IS the removal set: with
 * `Delete="right"`, whatever is absent on the left is what comes off the right.
 * A left folder that is missing, or that has somehow acquired content, changes
 * what the job means, so it is checked immediately before the job is written
 * rather than assumed.
 *
 * @throws Error
 */
export async function assertDirectoryEmpty(p: string, opts: JailOptions = {}): Promise<void> {
  const real = await assertExportPath(p, opts);
  let entries: string[];
  try {
    entries = await readdir(real);
  } catch (err) {
    throw new Error(
      `The empty-left folder ${JSON.stringify(real)} could not be read: ${String(err)}. ` +
        'Refusing to emit a FreeFileSync job whose left-hand side may not exist.',
    );
  }
  if (entries.length > 0) {
    throw new Error(
      `The empty-left folder ${JSON.stringify(real)} is not empty (${entries.length} entry/ies: ` +
        `${entries.slice(0, 5).join(', ')}). Its emptiness is what defines the removal set, ` +
        'so a FreeFileSync job must not be generated against it.',
    );
  }
}

/** True if something exists at `p`. Read-only; used to pick a free run id. */
export async function exportPathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

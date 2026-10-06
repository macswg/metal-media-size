/**
 * =============================================================================
 *  LOADING CAPTURES  --  through the read-only chokepoint, never `node:fs`
 * =============================================================================
 *
 * The capture is a PROJECT file, not archive media, so this reads it the same
 * way `src/config.ts` reads `config/local.json`: a `ReadOnlyFs` fenced to the
 * project root. No write primitive exists on that interface and `node:fs` is
 * not imported here, so `test/readonly-enforcement.test.ts` stays satisfied
 * without an exception being carved for this feature.
 *
 * A CAPTURE IS A POINT IN TIME. It records what the show was cued to play at
 * `capturedAt`, and it stops being true the moment somebody re-programmes.
 * Nothing here can detect that, so the date is carried through to the UI and
 * into every export banner rather than being read once and discarded.
 *
 * TWO KINDS OF FILE ARE READ: a Susan summary (`.json`) and a d3 project
 * archive (`.d3`, through `d3.ts`). Both become the same `ProgrammedCapture`.
 * Anything else in the directory is ignored, `.DS_Store` included.
 *
 * EVERY CAPTURE IN THE DIRECTORY IS READ, and the protections are UNIONED.
 * Two captures from two dates protect what either one plays. That is the
 * conservative reading and it is the right one: an operator who drops in a
 * second capture is adding knowledge, not replacing it, and a loader that
 * silently used only the newest file would quietly drop protection the
 * operator believed they had just added.
 * =============================================================================
 */

import { ReadOnlyFs } from '../fs/readonly.ts';
import { parseProgrammedCapture, type ProgrammedCapture } from './parse.ts';
import { parseD3Project } from './d3.ts';

/** File types read as captures. Lower-cased extension, leading dot. */
const CAPTURE_EXTENSIONS = ['.json', '.d3'];

/** Directory, relative to the project root, the operator drops captures into. */
export const PROGRAMMED_DIR = 'programmed_media_crosscheck';

export interface LoadProgrammedResult {
  /** Every capture that parsed, in filename order. */
  captures: ProgrammedCapture[];
  /** Absolute directory that was read, for reporting. */
  directory: string;
  /**
   * Files that are present but were NOT read, with why. A capture that failed
   * to parse lands here AND throws unless `tolerant` is set -- see below.
   */
  skipped: Array<{ file: string; reason: string }>;
}

/**
 * Read every capture in `directory`.
 *
 * THROWS if a `.json` or `.d3` file is present and unreadable. A capture that half-loads
 * protects half of what the show plays and the other half looks exactly like
 * ordinary superseded media, so the only safe response to a broken capture is
 * to stop. An EMPTY directory is not an error -- it means the cross-check is
 * not in use, which callers must distinguish from "in use and matched nothing".
 */
export async function loadProgrammedCaptures(
  projectRoot: string,
  directory: string,
): Promise<LoadProgrammedResult> {
  const fs = new ReadOnlyFs({ allowedRoots: [projectRoot], dirTimeoutMs: 10_000 });
  const skipped: Array<{ file: string; reason: string }> = [];
  const captures: ProgrammedCapture[] = [];

  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch {
    // No directory at all is the same as no captures: the feature is not in use.
    return { captures, directory, skipped };
  }

  const files = entries
    .filter((e) => e.isFile && CAPTURE_EXTENSIONS.some((x) => e.name.toLowerCase().endsWith(x)))
    .map((e) => e.name)
    .sort();

  for (const name of files) {
    const full = `${directory}/${name}`;
    const isProject = name.toLowerCase().endsWith('.d3');
    let bytes: Buffer;
    let modifiedMs = 0;
    try {
      if (isProject) modifiedMs = (await fs.lstat(full)).mtimeMs;
      const handle = await fs.openRead(full);
      try {
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (e) {
      throw new Error(
        `Programmed-media capture ${name} could not be read: ${(e as Error).message}. ` +
          'Refusing to continue: an unread capture protects nothing, and nothing is ' +
          'what an empty directory also produces.',
      );
    }
    // Both parsers throw on anything they cannot read. Deliberately not
    // caught -- see the header.
    const capture = isProject
      ? parseD3Project(bytes, name, modifiedMs)
      : parseProgrammedCapture(bytes.toString('utf8'), name);
    captures.push({ ...capture, location: full });
  }

  return { captures, directory, skipped };
}

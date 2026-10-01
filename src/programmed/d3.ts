/**
 * =============================================================================
 *  READING A d3 PROJECT ARCHIVE  --  a `.d3` dropped straight into the folder
 * =============================================================================
 *
 * A Susan summary is the plugin's export of a project; a `.d3` is the project.
 * Reading the archive directly removes the step where someone has to remember
 * to export, and the export's date with it -- the capture is whatever was last
 * saved.
 *
 * THE EXTRACTOR IS NOT OURS. `vendor/d3extract.cjs` is a byte-for-byte copy of
 * `d3_snapshot_diff/vendor/d3extract.js`, itself a port of `d3_extract.py` in
 * `d3_proj_analyzer`. It is renamed `.cjs` only because this package is ESM and
 * the file is a UMD module. Never edit it here: change it upstream and copy it
 * over. `test/programmed-d3.test.ts` fails on drift when the sibling checkout
 * is present.
 *
 * It builds the SAME document the plugin writes -- schema 7, `tracks` holding
 * only what the setlists reference -- so it goes through `parseProgrammedCapture`
 * like any summary and every rule there applies unchanged. Measured on
 * `moose_sphere_backup_1Oct2026_0648`: the `.d3` and the summary exported from
 * it in the same minute yield the same 959 media references from the same 47
 * tracks on the same six setlists, with nothing on either side the other lacks.
 *
 * IT GOES THROUGH JSON, deliberately, as `d3_snapshot_diff` does (its rule 13).
 * The extractor's layer `uid` is a BigInt that the object cannot be parsed past
 * without special handling, and the round trip makes a dropped `.d3` byte-equal
 * to the summary the extractor would have written.
 *
 * It does no I/O. It is handed bytes that `load.ts` read through `ReadOnlyFs`,
 * and the test asserts the vendored file contains no `require` or `import`.
 *
 * THE DATE IS THE FILE'S. An archive does not record when it was captured, and
 * the extractor would otherwise stamp it with the moment the server started --
 * a date that looks exactly like a capture time and is not one. The file's
 * modification time is when the project was saved, and `capturedAtSource`
 * says that is what it is.
 * =============================================================================
 */

import { createRequire } from 'node:module';
import { parseProgrammedCapture, type ProgrammedCapture } from './parse.ts';

interface D3ExtractModule {
  buildSnapshot(
    buffer: ArrayBuffer,
    options: { fileName?: string; capturedAt?: string; project?: string },
  ): { debug?: string[]; tracks?: Array<{ name?: string; error?: string | null }> };
  toJson(snapshot: unknown): string;
}

const D3Extract = createRequire(import.meta.url)('./vendor/d3extract.cjs') as D3ExtractModule;

/**
 * A debug line the extractor always writes about the build banner. Not a
 * shortfall in what the capture protects, so it is not a warning.
 */
const NOT_A_WARNING = /^system\.build /;

/** ISO 8601 in local time with offset -- the shape a summary's `capturedAt` has. */
export function localIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`
  );
}

/**
 * Parse a `.d3` project archive into a capture.
 *
 * THROWS on an archive it cannot read, for the reason `parseProgrammedCapture`
 * does: half a project protects half a show.
 */
export function parseD3Project(
  bytes: Uint8Array,
  sourceFile: string,
  modifiedMs: number,
): ProgrammedCapture {
  // The extractor wants an ArrayBuffer it owns from offset 0. A Buffer from
  // readFile usually is one; copy only when it is a view into a larger pool.
  const buffer =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

  let text: string;
  let snapshot: ReturnType<D3ExtractModule['buildSnapshot']>;
  try {
    snapshot = D3Extract.buildSnapshot(buffer, {
      fileName: sourceFile,
      capturedAt: localIso(modifiedMs),
    });
    text = D3Extract.toJson(snapshot);
  } catch (e) {
    throw new Error(
      `d3 project ${sourceFile} could not be read: ${(e as Error).message}. ` +
        'Refusing to continue: an unread project protects nothing, and nothing is ' +
        'what an empty directory also produces.',
    );
  }

  const capture = parseProgrammedCapture(text, sourceFile);
  const warnings = (snapshot.debug ?? []).filter((line) => !NOT_A_WARNING.test(line));
  return { ...capture, kind: 'project', capturedAtSource: 'file-mtime', warnings };
}

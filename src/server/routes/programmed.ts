/**
 * `POST /api/programmed/reload` -- re-read `programmed_media_crosscheck/`
 * without restarting the server.
 *
 * Captures used to be read once, at startup, so adding or removing a `.d3` or
 * `.json` did nothing until a relaunch. That made "drop the file in" a two-step
 * job whose second step was easy to forget -- and forgetting it leaves the
 * screen describing a capture the operator believes they removed.
 *
 * A FAILED RELOAD CHANGES NOTHING. At startup an unreadable capture stops the
 * server, because a half-read capture protects half a show. A reload cannot
 * stop a running server, so it does the other safe thing: it refuses, and the
 * captures already in force stay in force. It never swaps in a partial or
 * empty set because one file would not parse -- that would quietly unprotect
 * everything the rest of the folder named. The 409 says the old set is still
 * loaded, in words.
 *
 * A successful reload swaps the whole set in one assignment and drops every
 * memoised verdict (`ReclaimCache.setCaptures`), so the next request from any
 * route -- board, lists, ladder, export -- sees the new protection. No route
 * can be left reading the old one.
 *
 * It reads only the project's own folder, through the same `ReadOnlyFs`
 * fence the startup load uses. Nothing is written.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { conflict, messageOf } from '../errors.ts';
import { loadProgrammedCaptures } from '../../programmed/load.ts';

/** Where captures are read from. Absent in tests that hand captures in directly. */
export interface CaptureSource {
  projectRoot: string;
  directory: string;
}

export function registerProgrammedRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  source: CaptureSource | undefined,
): void {
  // Two reloads racing could finish out of order and leave the older read in
  // force. One at a time.
  let running = false;

  app.post('/api/programmed/reload', async () => {
    if (source === undefined) {
      throw conflict(
        'reload_unavailable',
        'This server was started without a capture directory, so there is nothing to reload.',
      );
    }
    if (running) throw conflict('reload_running', 'A reload is already running.');
    running = true;
    try {
      const before = ctx.reclaim.loadedCaptures().length;
      let loaded;
      try {
        loaded = await loadProgrammedCaptures(source.projectRoot, source.directory);
      } catch (e) {
        throw conflict(
          'capture_unreadable',
          `${messageOf(e)} Nothing was changed: the ${before} capture(s) loaded before ` +
            'this reload are still in force. Fix or remove the file and reload again.',
        );
      }
      ctx.reclaim.setCaptures(loaded.captures);
      return {
        previous: before,
        captures: loaded.captures.map((c) => ({
          sourceFile: c.sourceFile,
          location: c.location ?? null,
          kind: c.kind,
          capturedAt: c.capturedAt,
          capturedAtSource: c.capturedAtSource,
          refs: c.refs.length,
          setlists: c.setlists.length,
          warnings: c.warnings,
        })),
      };
    } finally {
      running = false;
    }
  });
}

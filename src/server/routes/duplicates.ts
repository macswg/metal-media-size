/**
 * ============================================================================
 *  `GET /api/duplicates` -- METADATA ONLY
 * ============================================================================
 *
 * NOTHING HERE OPENS A FILE. The archive sits on object storage: reading a
 * byte costs egress, and reading 133 TB of bytes to checksum it costs a great
 * deal of egress. Every mode below is computed from the SQLite index alone --
 * names, sizes, mtimes and the derived version rows.
 *
 * The consequence has to be stated in the payload, not just in a comment: a
 * match here is a LIKELY duplicate, never a confirmed one. Two renders can
 * share a name, a size and an mtime and still differ. Every group carries
 * `verified: false` and the label the UI must show verbatim.
 *
 * One mode:
 *
 *   name-size      Files sharing (basename, size) at two or more paths. Catches
 *                  the same deliverable copied into two song folders.
 *
 * `size-mtime` and `version-shape` were removed at the user's request. Both
 * are recoverable from git history if they are ever wanted back; neither is
 * referenced anywhere else, and `version-shape` was the previous default, so
 * a stale `?dup=version-shape` link now falls back to `name-size` rather than
 * failing (see `parseMode`).
 * ============================================================================
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { resolveSnapshot } from '../context.ts';
import { badRequest } from '../errors.ts';
import { parseFilters, parseKeepN, parsePaging, type Query } from '../query.ts';
import { selectFilesFiltered } from '../select.ts';

export const DUPLICATE_MODES = ['name-size'] as const;
export type DuplicateMode = (typeof DUPLICATE_MODES)[number];

/** Shown verbatim by the UI. The tool must never imply certainty here. */
export const DUPLICATE_LABEL = 'likely duplicate — content not verified';

/**
 * Modes that used to exist. A `?mode=` link saved before they were removed
 * still opens -- it just lands on the surviving mode. A genuinely unknown
 * value is still a 400, so the contract's guarantee is unchanged.
 */
const RETIRED_MODES = new Set(['size-mtime', 'version-shape']);

function parseMode(q: Query): DuplicateMode {
  const raw = q['mode'];
  if (raw === undefined || raw === null || raw === '') return 'name-size';
  const s = String(raw);
  if (RETIRED_MODES.has(s)) return 'name-size';
  if (!(DUPLICATE_MODES as readonly string[]).includes(s)) {
    throw badRequest(
      'bad_mode',
      `Unknown duplicates mode ${JSON.stringify(s)}. Allowed: ${DUPLICATE_MODES.join(', ')}`,
    );
  }
  return s as DuplicateMode;
}

export function registerDuplicateRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/duplicates', (req) => {
    const q = req.query as Query;
    const snapshot = resolveSnapshot(ctx, q);
    const mode = parseMode(q);
    const filters = parseFilters(q);
    const paging = parsePaging(q);
    const keepN = parseKeepN(q);

    const groups = fileGroups(ctx, snapshot.id, filters, keepN);

    groups.sort((a, b) => b.wastedBytes - a.wastedBytes);

    let matchedBytes = 0;
    let wastedBytes = 0;
    for (const g of groups) {
      matchedBytes += g.totalBytes;
      wastedBytes += g.wastedBytes;
    }

    return {
      snapshotId: snapshot.id,
      mode,
      keepN,
      limit: paging.limit,
      offset: paging.offset,
      verified: false,
      label: DUPLICATE_LABEL,
      note:
        'Computed from the index only. No file was opened and no bytes were read; ' +
        'sizes and names can coincide, so treat every group as a candidate.',
      rows: groups.slice(paging.offset, paging.offset + paging.limit),
      total: groups.length,
      matchedBytes,
      wastedBytes,
    };
  });
}

interface DuplicateGroup {
  key: string;
  kind: DuplicateMode;
  count: number;
  /** Bytes of every member added together. */
  totalBytes: number;
  /** Bytes that would be freed if all but one member were removed. */
  wastedBytes: number;
  verified: false;
  label: string;
  members: unknown[];
  songFolders: string[];
}

function fileGroups(
  ctx: AppContext,
  snapshotId: number,
  filters: ReturnType<typeof parseFilters>,
  keepN: number,
): DuplicateGroup[] {
  const files = selectFilesFiltered(ctx, snapshotId, filters, keepN, 'ORDER BY f.id ASC');
  const buckets = new Map<string, typeof files>();

  for (const f of files) {
    // A zero-byte file is not a duplicate finding, it is an anomaly.
    if (f.size === 0) continue;
    const key = `${f.name}\x00${f.size}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(f);
    else buckets.set(key, [f]);
  }

  const out: DuplicateGroup[] = [];
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    const first = members[0];
    if (!first) continue;
    const totalBytes = members.reduce((n, m) => n + m.size, 0);
    out.push({
      key: `${first.name} @ ${first.size}`,
      kind: 'name-size',
      count: members.length,
      totalBytes,
      wastedBytes: totalBytes - first.size,
      verified: false,
      label: DUPLICATE_LABEL,
      songFolders: [...new Set(members.map((m) => m.songFolder))],
      members: members.map((m) => ({
        fileId: m.id,
        relPath: m.relPath,
        songFolder: m.songFolder,
        name: m.name,
        size: m.size,
        mtime: m.mtime,
        assetVersionId: m.assetVersionId,
      })),
    });
  }
  return out;
}

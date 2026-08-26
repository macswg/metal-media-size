/**
 * `GET /api/songs` -- per-song-folder rollup.
 *
 * A song row mixes two domains: `fileCount` / `totalBytes` / `latestMtime`
 * come from the FILE domain, `assetCount` / `versionCount` / `supersededBytes`
 * from the VERSION domain. The shared filter params are mapped into each
 * domain per the table in `query.ts`, so e.g. `minSize` bounds file size for
 * the first three and version bytes for the last three. That is stated here
 * because it is the one place the two readings of a filter meet.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { resolveSnapshot } from '../context.ts';
import {
  fileWhere,
  guardCandidateCount,
  listInJs,
  parseFilters,
  parseKeepN,
  parsePaging,
  parseSort,
  SONG_SORT_COLUMNS,
  type FilterSpec,
  type Query,
} from '../query.ts';
import { fileNeedsJsPass, selectFilesFiltered, selectVersions } from '../select.ts';

export interface SongRow {
  songFolder: string;
  fileCount: number;
  totalBytes: number;
  assetCount: number;
  versionCount: number;
  supersededBytes: number;
  supersededCount: number;
  latestMtime: number | null;
}

function emptyRow(songFolder: string): SongRow {
  return {
    songFolder,
    fileCount: 0,
    totalBytes: 0,
    assetCount: 0,
    versionCount: 0,
    supersededBytes: 0,
    supersededCount: 0,
    latestMtime: null,
  };
}

/** File-domain aggregate, in SQL when it can be and in JS when `path` is set. */
function fileAggregate(
  ctx: AppContext,
  snapshotId: number,
  filters: FilterSpec,
  keepN: number,
): Map<string, { fileCount: number; totalBytes: number; latestMtime: number }> {
  const out = new Map<string, { fileCount: number; totalBytes: number; latestMtime: number }>();

  if (fileNeedsJsPass(filters, '')) {
    for (const f of selectFilesFiltered(ctx, snapshotId, filters, keepN, 'ORDER BY f.id ASC')) {
      const cur = out.get(f.songFolder) ?? { fileCount: 0, totalBytes: 0, latestMtime: 0 };
      cur.fileCount += 1;
      cur.totalBytes += f.size;
      if (f.mtime > cur.latestMtime) cur.latestMtime = f.mtime;
      out.set(f.songFolder, cur);
    }
    return out;
  }

  const where = fileWhere(snapshotId, filters);
  const rows = ctx.db
    .prepare(
      `SELECT f.song_folder AS song_folder, COUNT(*) AS n,
              COALESCE(SUM(f.size), 0) AS b, COALESCE(MAX(f.mtime), 0) AS m
         FROM file f LEFT JOIN v_asset_version av ON av.version_id = f.asset_version_id
        WHERE ${where.sql}
        GROUP BY f.song_folder`,
    )
    .all(...where.params) as { song_folder: string; n: number; b: number; m: number }[];
  for (const r of rows) {
    out.set(r.song_folder, { fileCount: r.n, totalBytes: r.b, latestMtime: r.m });
  }
  return out;
}

export function buildSongRows(
  ctx: AppContext,
  snapshotId: number,
  filters: FilterSpec,
  keepN: number,
): SongRow[] {
  const byFolder = new Map<string, SongRow>();

  for (const [songFolder, agg] of fileAggregate(ctx, snapshotId, filters, keepN)) {
    const row = byFolder.get(songFolder) ?? emptyRow(songFolder);
    row.fileCount = agg.fileCount;
    row.totalBytes = agg.totalBytes;
    row.latestMtime = agg.latestMtime === 0 ? null : agg.latestMtime;
    byFolder.set(songFolder, row);
  }

  const versions = selectVersions(
    ctx,
    snapshotId,
    filters,
    keepN,
    'ORDER BY av.song_folder ASC, av.version_id ASC',
  );
  const assetsSeen = new Map<string, Set<number>>();
  for (const v of versions) {
    const row = byFolder.get(v.songFolder) ?? emptyRow(v.songFolder);
    row.versionCount += 1;
    if (v.status === 'superseded') {
      row.supersededBytes += v.bytes;
      row.supersededCount += 1;
    }
    let seen = assetsSeen.get(v.songFolder);
    if (!seen) {
      seen = new Set<number>();
      assetsSeen.set(v.songFolder, seen);
    }
    seen.add(v.assetId);
    byFolder.set(v.songFolder, row);
  }
  for (const [songFolder, seen] of assetsSeen) {
    const row = byFolder.get(songFolder);
    if (row) row.assetCount = seen.size;
  }

  return [...byFolder.values()];
}

export function registerSongRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/songs', (req) => {
    const q = req.query as Query;
    const snapshot = resolveSnapshot(ctx, q);
    const filters = parseFilters(q);
    const keepN = parseKeepN(q);
    const paging = parsePaging(q);
    const sort = parseSort(q, Object.keys(SONG_SORT_COLUMNS), { key: 'totalBytes', dir: 'desc' });

    // Bounded by the number of song folders (tens), but guarded anyway.
    const rows = buildSongRows(ctx, snapshot.id, filters, keepN);
    guardCandidateCount(rows.length, 'song rollup');

    const listed = listInJs(rows, {
      sort,
      accessor: (row, key) => (row as unknown as Record<string, unknown>)[key],
      bytesOf: (r) => r.totalBytes,
      paging,
    });

    return {
      snapshotId: snapshot.id,
      keepN,
      limit: paging.limit,
      offset: paging.offset,
      sort: sort.key,
      dir: sort.dir,
      ...listed,
    };
  });
}

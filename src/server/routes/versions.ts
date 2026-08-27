/**
 * `GET /api/versions`          -- the primary view: one row per asset-version.
 * `GET /api/assets/:id/versions` -- the ladder for a single asset.
 *
 * Every row carries `status` and `keepReason` straight from `computeReclaim`,
 * so the UI can explain WHY a version is kept or superseded rather than just
 * colouring it. The verdict is computed over the whole snapshot; see
 * `reclaim-cache.ts` for why that matters.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { requireIntParam, resolveSnapshot, versionSortValue } from '../context.ts';
import { notFound } from '../errors.ts';
import {
  JS_ONLY_SORT_KEYS,
  listInJs,
  orderByClause,
  parseFilters,
  parseKeepN,
  parsePaging,
  parseSort,
  VERSION_SORT_COLUMNS,
  type Query,
} from '../query.ts';
import { selectVersions } from '../select.ts';
import { toVersionRow, type VersionDbRow } from '../context.ts';

export function registerVersionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/versions', (req) => {
    const q = req.query as Query;
    const snapshot = resolveSnapshot(ctx, q);
    const filters = parseFilters(q);
    const paging = parsePaging(q);
    const keepN = parseKeepN(q);
    const sort = parseSort(q, Object.keys(VERSION_SORT_COLUMNS), { key: 'bytes', dir: 'desc' });

    // SQL orders the rows unless the key only exists in JS, in which case the
    // SQL order is just a stable base and the JS comparator does the work.
    const orderBy = orderByClause(VERSION_SORT_COLUMNS, sort, 'av.version_id ASC');
    const rows = selectVersions(ctx, snapshot.id, filters, keepN, orderBy);

    const listed = listInJs(rows, {
      sort: JS_ONLY_SORT_KEYS.has(sort.key) ? sort : undefined,
      accessor: versionSortValue,
      bytesOf: (r) => r.bytes,
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

  app.get('/api/assets/:assetId/versions', (req) => {
    const q = req.query as Query;
    const params = req.params as { assetId?: string };
    const assetId = requireIntParam(params.assetId, 'assetId');
    const keepN = parseKeepN(q);

    const asset = ctx.db
      .prepare(`SELECT id, snapshot_id, song_folder, base, family FROM asset WHERE id = ?`)
      .get(assetId) as
      | { id: number; snapshot_id: number; song_folder: string; base: string; family: string }
      | undefined;
    if (!asset) throw notFound('asset_not_found', `No asset with id ${assetId}`);

    const verdicts = ctx.reclaim.get(asset.snapshot_id, keepN).byVersionId;

    // Oldest first. `v002 < v002a < v002d < v003`: a bare version sorts before
    // its lettered siblings, which SQLite gives us because NULL sorts first in
    // an ASC ordering.
    const dbRows = ctx.db
      .prepare(
        `SELECT av.version_id, av.asset_id, av.snapshot_id, av.song_folder, av.base, av.family,
                av.ver_num, av.sub_letter, av.ver_label, av.is_patch, av.patch_frame,
                av.bytes, av.file_count, av.proxy_bytes, av.region0_bytes,
                av.region_count, av.latest_mtime
           FROM v_asset_version av
          WHERE av.asset_id = ?
          ORDER BY av.ver_num ASC, av.sub_letter ASC, av.is_patch ASC,
                   av.patch_frame ASC, av.version_id ASC`,
      )
      .all(assetId) as VersionDbRow[];

    const versions = dbRows.map((r) => toVersionRow(r, verdicts.get(r.version_id)));
    let totalBytes = 0;
    let supersededBytes = 0;
    for (const v of versions) {
      totalBytes += v.bytes;
      if (v.status === 'superseded') supersededBytes += v.bytes;
    }

    return {
      asset: {
        assetId: asset.id,
        snapshotId: asset.snapshot_id,
        songFolder: asset.song_folder,
        base: asset.base,
        family: asset.family,
        versionCount: versions.length,
        totalBytes,
        supersededBytes,
      },
      keepN,
      versions,
    };
  });
}

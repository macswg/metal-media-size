/**
 * `GET /api/files` -- the raw file list, filtered, sorted and paged.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { resolveSnapshot } from '../context.ts';
import {
  FILE_SORT_COLUMNS,
  orderByClause,
  parseFilters,
  parseKeepN,
  parsePaging,
  parseSort,
  type Query,
} from '../query.ts';
import { fileNeedsJsPass, selectFilesFiltered, selectFilesPaged } from '../select.ts';

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/files', (req) => {
    const q = req.query as Query;
    const snapshot = resolveSnapshot(ctx, q);
    const filters = parseFilters(q);
    const paging = parsePaging(q);
    const keepN = parseKeepN(q);
    const sort = parseSort(q, Object.keys(FILE_SORT_COLUMNS), { key: 'size', dir: 'desc' });
    const orderBy = orderByClause(FILE_SORT_COLUMNS, sort, 'f.id ASC');

    const head = {
      snapshotId: snapshot.id,
      keepN,
      limit: paging.limit,
      offset: paging.offset,
      sort: sort.key,
      dir: sort.dir,
    };

    if (!fileNeedsJsPass(filters, sort.key)) {
      const page = selectFilesPaged(
        ctx,
        snapshot.id,
        filters,
        keepN,
        orderBy,
        paging.limit,
        paging.offset,
      );
      return { ...head, ...page };
    }

    const all = selectFilesFiltered(ctx, snapshot.id, filters, keepN, orderBy);
    let matchedBytes = 0;
    for (const r of all) matchedBytes += r.size;
    return {
      ...head,
      rows: all.slice(paging.offset, paging.offset + paging.limit),
      total: all.length,
      matchedBytes,
    };
  });
}

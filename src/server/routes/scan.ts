/**
 * `POST /api/scan` and `GET /api/scan/status`.
 *
 * The scan is started and the request returns immediately with the snapshot
 * id; the walk continues in the background and is polled through the status
 * route. Only one scan at a time -- a second POST while one is in flight is a
 * 409, not a queued job.
 *
 * The scan is the only thing in the whole server that reaches the archive, and
 * it does so through `runScan`, which uses the read-only chokepoint.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { badRequest } from '../errors.ts';

interface ScanBody {
  name?: unknown;
}

export function registerScanRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/scan', async (req, reply) => {
    const body = (req.body ?? {}) as ScanBody;
    let name: string | undefined;
    if (body.name !== undefined && body.name !== null) {
      if (typeof body.name !== 'string') {
        throw badRequest('bad_param', 'name must be a string');
      }
      if (body.name.length > 200) {
        throw badRequest('bad_param', 'name must be at most 200 characters');
      }
      name = body.name;
    }

    const snapshotId = await ctx.scans.start(name);
    reply.code(202);
    return { snapshotId, running: true, root: ctx.cfg.root };
  });

  app.get('/api/scan/status', () => ctx.scans.status());
}

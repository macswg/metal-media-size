/**
 * `POST /api/probe`, `POST /api/probe/cancel` and `GET /api/probe/status`.
 *
 * The resolution pass reads pixel dimensions out of each file's own header.
 * It takes hours against the real archive, so the POST starts it and returns
 * immediately; the browser polls the status route.
 *
 * UNLIKE A SCAN, THIS CAN BE CANCELLED. A scan is one atomic walk that is
 * either a snapshot or nothing. A probe is tens of thousands of independent
 * header reads whose results are written in batches as they land, so stopping
 * halfway is a legitimate outcome that loses none of the work already done --
 * the next run picks up exactly where this one stopped.
 *
 * Only one probe at a time: two runs would claim the same work and double the
 * round trips to the mount for nothing.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { resolveSnapshot } from '../context.ts';
import { badRequest } from '../errors.ts';
import { intParam, type Query } from '../query.ts';

/** Above this, extra lanes stop buying throughput and just queue. */
const MAX_CONCURRENCY = 256;

interface ProbeBody {
  concurrency?: unknown;
}

export function registerProbeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/probe', (req, reply) => {
    const body = (req.body ?? {}) as ProbeBody;
    let concurrency: number | undefined;
    if (body.concurrency !== undefined && body.concurrency !== null) {
      const n = Number(body.concurrency);
      if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
        throw badRequest('bad_param', `concurrency must be an integer 1..${MAX_CONCURRENCY}`);
      }
      concurrency = n;
    }

    // Probing a snapshot other than the one being looked at is a footgun, so
    // the target is resolved exactly the way every read route resolves it.
    const snapshot = resolveSnapshot(ctx, req.query as Query);
    const status = ctx.probes.start(snapshot.id, concurrency === undefined ? {} : { concurrency });
    reply.code(202);
    return status;
  });

  app.post('/api/probe/cancel', () => ctx.probes.cancel());

  app.get('/api/probe/status', (req) => {
    const q = req.query as Query;
    // Coverage is per snapshot, so the status can be asked about the one on
    // screen even when no run is in flight.
    const wanted = intParam(q, 'snapshotId');
    if (wanted !== undefined) return ctx.probes.status(wanted);
    const snapshot = resolveSnapshot(ctx, q);
    return ctx.probes.status(snapshot.id);
  });
}

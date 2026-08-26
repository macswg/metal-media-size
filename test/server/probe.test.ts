/**
 * ============================================================================
 *  RESOLUTION SCAN CONTROL  --  POST /api/probe, /cancel, GET /status
 * ============================================================================
 *
 * In its own file with its own fixture on purpose: a probe WRITES to
 * `file_media`, and the other API tests assert on exactly which fixture files
 * have been probed. Sharing an index would make those tests depend on the
 * order this one happens to run in.
 *
 * The fixture root does not exist on disk, so every read fails. That is the
 * point here -- what is under test is the supervisor (start, refuse a second
 * run, stop on request, record what was reached), not the header parser, which
 * `test/media.test.ts` covers byte by byte.
 * ============================================================================
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server/app.ts';
import type { AppContext } from '../../src/server/context.ts';
import { makeFixture, type Fixture } from './fixture.ts';

let fx: Fixture;
let app: FastifyInstance;
let ctx: AppContext;

beforeAll(() => {
  fx = makeFixture();
  const built = buildServer({ db: fx.db, cfg: fx.cfg });
  app = built.app;
  ctx = built.ctx;
});

afterAll(async () => {
  await app.close();
  fx.db.close();
});

async function get(url: string) {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as any };
}

async function post(url: string, payload: unknown = {}) {
  const res = await app.inject({ method: 'POST', url, payload: payload as object });
  return { status: res.statusCode, body: res.json() as any };
}

function probedCount(): number {
  return (fx.db.prepare('SELECT COUNT(*) AS n FROM file_media').get() as { n: number }).n;
}

describe('resolution scan control', () => {
  it('reports an idle probe, with the coverage of the snapshot on screen', async () => {
    const { status, body } = await get('/api/probe/status');
    expect(status).toBe(200);
    expect(body.running).toBe(false);
    // The three the fixture pre-probes. Coverage outlives any single run.
    expect(body.coverage).toMatchObject({ probed: 3, withDimensions: 2 });
    expect(body.coverage.total).toBeGreaterThan(3);
  });

  it('rejects a concurrency that is not a sane integer', async () => {
    for (const concurrency of [0, -1, 1000, 1.5, 'lots']) {
      const { status, body } = await post('/api/probe', { concurrency });
      expect(status).toBe(400);
      expect(body.error.code).toBe('bad_param');
    }
    expect(ctx.probes.isRunning()).toBe(false);
  });

  it('refuses a second run rather than queueing one', async () => {
    const first = await post('/api/probe', { concurrency: 1 });
    expect(first.status).toBe(202);
    expect(first.body.running).toBe(true);

    const second = await post('/api/probe', { concurrency: 1 });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('probe_already_running');

    await post('/api/probe/cancel');
    await ctx.probes.settle();
  });

  /**
   * The property that makes cancelling safe to offer at all: work already done
   * is on disk, so stopping costs only what was in flight and starting again
   * resumes rather than restarting.
   */
  it('stops when asked, and keeps everything read up to that point', async () => {
    const before = probedCount();

    const started = await post('/api/probe', { concurrency: 1 });
    expect(started.status).toBe(202);

    const cancelled = await post('/api/probe/cancel');
    expect(cancelled.status).toBe(200);

    await ctx.probes.settle();
    const after = await get('/api/probe/status');
    expect(after.body.running).toBe(false);
    expect(after.body.cancelled).toBe(true);

    // It stopped early: not every file was reached.
    expect(after.body.done).toBeLessThan(after.body.total);
    // And it kept what it had. Rows only ever go up.
    expect(probedCount()).toBeGreaterThanOrEqual(before);
  });

  it('a cancel with nothing running is not an error', async () => {
    expect(ctx.probes.isRunning()).toBe(false);
    const { status, body } = await post('/api/probe/cancel');
    expect(status).toBe(200);
    expect(body.running).toBe(false);
  });

  it('runs to completion and records every file it reached', async () => {
    const { status } = await post('/api/probe', {});
    expect(status).toBe(202);
    await ctx.probes.settle();

    const { body } = await get('/api/probe/status');
    expect(body.running).toBe(false);
    expect(body.cancelled).toBe(false);
    expect(body.done).toBe(body.total);

    // Every .mov now has a row: the root does not exist, so all of them came
    // back unreadable -- and a file that cannot be read is recorded as probed
    // rather than being retried on every future run.
    const movs = (
      fx.db
        .prepare(`SELECT COUNT(*) AS n FROM file WHERE snapshot_id = ? AND ext = 'mov'`)
        .get(fx.snapshotId) as { n: number }
    ).n;
    const rows = (
      fx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM file_media fm
             JOIN file f ON f.id = fm.file_id
            WHERE f.snapshot_id = ? AND f.ext = 'mov'`,
        )
        .get(fx.snapshotId) as { n: number }
    ).n;
    expect(rows).toBe(movs);
  });

  it('has nothing left to do once everything is probed', async () => {
    await post('/api/probe', {});
    await ctx.probes.settle();
    const { body } = await get('/api/probe/status');
    expect(body.total).toBe(0);
    expect(body.done).toBe(0);
  });
});

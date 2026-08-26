/**
 * ============================================================================
 *  SERVER FACTORY
 * ============================================================================
 *
 * Read-only HTTP API over the SQLite index. Two properties are structural, not
 * conventions:
 *
 *   1. IT BINDS 127.0.0.1 ONLY. `startServer` hard-codes the loopback host, so
 *      there is no configuration path that exposes this to a network. No auth,
 *      no CORS, no external exposure -- because there is no external surface.
 *
 *   2. IT DOES NOT TOUCH THE ARCHIVE. Every route reads the project's own
 *      SQLite index. The single exception is `POST /api/scan`, which delegates
 *      to `runScan` and therefore to the read-only chokepoint.
 *
 * `buildServer` takes an ALREADY OPEN database so tests can hand it a fixture
 * instead of the real 133 TB index.
 * ============================================================================
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { PROJECT_ROOT, type AppConfig } from '../config.ts';
import { createContext, type AppContext } from './context.ts';
import { hasStatusCode, isHttpError, messageOf } from './errors.ts';
import { registerAnomalyRoutes } from './routes/anomalies.ts';
import { registerDuplicateRoutes } from './routes/duplicates.ts';
import { registerExportRoutes } from './routes/export.ts';
import { registerFileRoutes } from './routes/files.ts';
import { registerReclaimRoutes } from './routes/reclaim.ts';
import { registerProbeRoutes } from './routes/probe.ts';
import { registerScanRoutes } from './routes/scan.ts';
import { registerSnapshotRoutes } from './routes/snapshots.ts';
import { registerSongRoutes } from './routes/songs.ts';
import { registerSummaryRoutes } from './routes/summary.ts';
import { registerVersionRoutes } from './routes/versions.ts';
import pkg from '../../package.json' with { type: 'json' };

/** The only host this server may ever bind. */
export const BIND_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;

/**
 * Shown at the bottom of the app window, so a person can say which build they
 * are looking at. Read from package.json rather than duplicated here -- one
 * place to bump, and it cannot drift from what npm reports.
 */
export const APP_VERSION: string = pkg.version;

/**
 * The browser app, served at `/`. It is a plain ES-module frontend with no
 * build step, so the source directory IS the served directory.
 *
 * `@fastify/static` does the file reading. That does not weaken the read-only
 * fence: the fence forbids `src/` from importing `node:fs` or naming a write
 * primitive, and this file does neither -- it hands a directory to a plugin.
 * The directory is inside the PROJECT, never the archive, and the plugin only
 * ever reads.
 */
export const WEB_ROOT = resolve(PROJECT_ROOT, 'src', 'web');

export interface BuildServerOptions {
  db: Db;
  cfg: AppConfig;
  /** Fastify logger option. Off by default so tests stay quiet. */
  logger?: boolean;
  /**
   * Override the directory the exporter writes into. Tests only -- leaving it
   * unset lets the exporter use its own jailed `exports/` default.
   */
  exportsDir?: string;
  /** Override the directory the browser app is served from. Tests only. */
  webRoot?: string;
}

export interface BuiltServer {
  app: FastifyInstance;
  ctx: AppContext;
}

export function buildServer(opts: BuildServerOptions): BuiltServer {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Song folders and asset bases are long, and they appear in path params.
    routerOptions: { maxParamLength: 500 },
  });

  const ctx = createContext(opts.db, opts.cfg, opts.exportsDir);

  // Fastify types the thrown value as `unknown`, which is correct: a route can
  // throw anything. Each shape is narrowed with a real guard rather than cast,
  // because this is the code that runs when something has already gone wrong.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (isHttpError(err)) {
      const payload: { error: { code: string; message: string; details?: unknown } } = {
        error: { code: err.code, message: err.message },
      };
      if (err.details !== undefined) payload.error.details = err.details;
      void reply.code(err.statusCode).send(payload);
      return;
    }
    const status = hasStatusCode(err) ? err.statusCode : 500;
    void reply.code(status).send({
      error: {
        code: status >= 400 && status < 500 ? 'bad_request' : 'internal_error',
        message: messageOf(err),
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({
      error: { code: 'route_not_found', message: `No route for ${req.method} ${req.url}` },
    });
  });

  // The frontend, at `/`. Registered BEFORE the API routes only for reading
  // order; find-my-way matches the explicit `/api/...` routes ahead of this
  // plugin's `/*` wildcard regardless of registration order, and a miss inside
  // the wildcard falls through to the JSON not-found handler above.
  app.register(fastifyStatic, {
    root: opts.webRoot ?? WEB_ROOT,
    prefix: '/',
    index: ['index.html'],
    // No caching: the app is edited in place and reloaded during a session.
    cacheControl: false,
    dotfiles: 'deny',
  });

  app.get('/api/health', () => ({
    ok: true,
    version: APP_VERSION,
    root: ctx.cfg.root,
    scanRunning: ctx.scans.isRunning(),
  }));

  registerSnapshotRoutes(app, ctx);
  registerScanRoutes(app, ctx);
  registerProbeRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerVersionRoutes(app, ctx);
  registerReclaimRoutes(app, ctx);
  registerSongRoutes(app, ctx);
  registerSummaryRoutes(app, ctx);
  registerDuplicateRoutes(app, ctx);
  registerAnomalyRoutes(app, ctx);
  registerExportRoutes(app, ctx);

  return { app, ctx };
}

/** Listen on loopback. The host is not configurable, deliberately. */
export async function startServer(built: BuiltServer, port = DEFAULT_PORT): Promise<string> {
  return built.app.listen({ host: BIND_HOST, port });
}

/**
 * CLI: serve the read-only analysis API on loopback.
 *
 *   npm run serve -- [--config config/d3-delivery.json] [--port 8787]
 *
 * Binds 127.0.0.1 only. Nothing here writes to the archive; the only file the
 * process opens for output is the project's own SQLite index, and the SQLite
 * driver does that itself.
 */

// MUST BE THE FIRST IMPORT: it sets UV_THREADPOOL_SIZE before anything can
// submit work to libuv's pool. See the module for why, and for the
// measurement. Previously this lived in the npm script as shell syntax,
// which meant it did not run at all on Windows.
import './threadpool.ts';
import { loadConfig, resolveDbPath, PROJECT_ROOT } from '../config.ts';
import { loadProgrammedCaptures, PROGRAMMED_DIR } from '../programmed/load.ts';
import { openDb, latestSnapshot } from '../db/index.ts';
import { buildServer, startServer, BIND_HOST, DEFAULT_PORT } from '../server/app.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

async function main(): Promise<void> {
  const configPath = arg('config', 'config/d3-delivery.json');
  const port = Number.parseInt(arg('port', String(DEFAULT_PORT)), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be a valid TCP port, got ${arg('port', '')}`);
  }

  const cfg = await loadConfig(configPath);
  const dbPath = resolveDbPath(cfg);
  const db = openDb(dbPath);

  // Loaded before the server is built, and deliberately NOT caught: a capture
  // that is present and unreadable must stop the server rather than start one
  // that silently protects nothing. An absent or empty directory is fine and
  // simply means the cross-check is not in use.
  const programmed = await loadProgrammedCaptures(PROJECT_ROOT, `${PROJECT_ROOT}/${PROGRAMMED_DIR}`);

  const built = buildServer({ db, cfg, logger: false, captures: programmed.captures });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} -- closing`);
    await built.app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const address = await startServer(built, port);

  const latest = latestSnapshot(db);
  console.log(`config   : ${configPath}`);
  console.log(`root     : ${cfg.root}  (read-only)`);
  console.log(`db       : ${dbPath}`);
  console.log(
    latest
      ? `snapshot : ${latest.id} (${latest.file_count.toLocaleString()} files)`
      : 'snapshot : none yet -- POST /api/scan to build one',
  );
  console.log(
    programmed.captures.length === 0
      ? `programmed: no capture in ${PROGRAMMED_DIR}/ -- cross-check NOT in use`
      : `programmed: ${programmed.captures.length} capture(s), ` +
          `${programmed.captures.reduce((n, c) => n + c.refs.length, 0)} media reference(s), ` +
          `newest ${programmed.captures.map((c) => c.capturedAt ?? '?').sort().at(-1)}`,
  );
  console.log(`listening: ${address}  (bound to ${BIND_HOST} only)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

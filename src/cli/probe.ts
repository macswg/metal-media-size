/**
 * CLI: read pixel dimensions from the archive's file headers.
 *
 *   npm run probe -- [--config config/d3-delivery.json] [--snapshot 7]
 *                    [--concurrency 64] [--limit 500] [--retry]
 *
 * THE ONLY COMMAND IN THIS PROJECT THAT OPENS AN ARCHIVE FILE. It reads the
 * QuickTime atom table -- about 210 bytes per file -- and never sample data.
 * It is resumable: results land in `file_media`, and a second run picks up
 * exactly the files the first one did not reach.
 *
 * Nothing is written to the archive. The only thing written at all is the
 * project's own SQLite index.
 */

import { loadConfig, resolveDbPath } from '../config.ts';
import { openDb, latestSnapshot, mediaCoverage } from '../db/index.ts';
import { ReadOnlyFs } from '../fs/readonly.ts';
import { runProbe, DEFAULT_CONCURRENCY } from '../scan/probe.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

function intArg(name: string, fallback: number): number {
  const raw = arg(name, '');
  if (raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

function pct(n: number, of: number): string {
  return of === 0 ? '0%' : `${((n / of) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const configPath = arg('config', 'config/d3-delivery.json');
  const concurrency = intArg('concurrency', DEFAULT_CONCURRENCY);
  const limit = intArg('limit', 0);

  const cfg = await loadConfig(configPath);
  const dbPath = resolveDbPath(cfg);
  const db = openDb(dbPath);

  try {
    const snapArg = intArg('snapshot', 0);
    const snapshot = snapArg ? { id: snapArg } : latestSnapshot(db, cfg.root);
    if (!snapshot) throw new Error('No completed snapshot to probe. Run `npm run scan` first.');

    console.log(`root       : ${cfg.root}  (read-only)`);
    console.log(`db         : ${dbPath}`);
    console.log(`snapshot   : ${snapshot.id}`);
    console.log(`concurrency: ${concurrency}${limit ? `  limit: ${limit}` : ''}`);
    console.log('');

    const before = mediaCoverage(db, snapshot.id);
    console.log(`already probed: ${before.probed.toLocaleString()} of ${before.total.toLocaleString()}`);

    let lastPrint = 0;
    const result = await runProbe(db, new ReadOnlyFs({ allowedRoots: cfg.allowedRoots }), cfg.root, {
      snapshotId: snapshot.id,
      concurrency,
      limit: limit || undefined,
      retryEmpty: process.argv.includes('--retry'),
      onProgress: (p) => {
        // One line every two seconds. A line per file would out-scroll the
        // information it carries.
        const now = Date.now();
        if (now - lastPrint < 2000 && p.done !== p.total) return;
        lastPrint = now;
        const rate = p.done / Math.max(1, p.elapsedMs / 1000);
        const left = rate > 0 ? (p.total - p.done) / rate : 0;
        process.stdout.write(
          `\r  ${p.done.toLocaleString()}/${p.total.toLocaleString()} ` +
            `(${pct(p.done, p.total)})  ${rate.toFixed(1)}/s  ` +
            `eta ${(left / 60).toFixed(1)} min  ${p.failed} without dimensions   `,
        );
      },
    });
    process.stdout.write('\n\n');

    if (result.carriedForward) {
      console.log(
        `carried forward: ${result.carriedForward.toLocaleString()} unchanged files kept their ` +
          `dimensions from an earlier snapshot (no reads)`,
      );
    }
    console.log(`probed         : ${result.done.toLocaleString()} files in ${(result.elapsedMs / 1000 / 60).toFixed(1)} min`);
    console.log(`with dimensions: ${result.withDimensions.toLocaleString()} (${pct(result.withDimensions, result.done)})`);
    console.log(`without        : ${result.failed.toLocaleString()}`);

    if (result.noDimensions.length) {
      // Not a footnote. A .mov with no header atom is an interrupted render:
      // the bytes are there and nothing can play them.
      console.log('');
      console.log(`NO DIMENSIONS  : ${result.failed.toLocaleString()} files read cleanly but carry no header`);
      const bySize = [...result.noDimensions].sort((a, b) => b.size - a.size);
      for (const f of bySize.slice(0, 20)) {
        console.log(`   ${(f.size / 1e9).toFixed(1).padStart(7)} GB  ${f.relPath}`);
      }
      if (result.failed > bySize.length) console.log(`   ... and ${result.failed - bySize.length} more`);
    }

    if (result.errors.length) {
      console.log('');
      console.log(`unreadable     : ${result.errors.length}`);
      for (const e of result.errors.slice(0, 20)) console.log(`   ${e.relPath}: ${e.reason}`);
      if (result.errors.length > 20) console.log(`   ... and ${result.errors.length - 20} more`);
    }

    const after = mediaCoverage(db, snapshot.id);
    console.log('');
    console.log(
      `coverage       : ${after.probed.toLocaleString()}/${after.total.toLocaleString()} probed, ` +
        `${after.withDimensions.toLocaleString()} with dimensions`,
    );
    if (after.probed < after.total) console.log(`Run it again to finish the remaining ${(after.total - after.probed).toLocaleString()}.`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

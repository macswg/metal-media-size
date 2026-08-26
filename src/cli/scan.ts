/**
 * CLI: run a scan and print the headline numbers.
 *
 *   npm run scan -- [--config config/d3-delivery.json] [--keep 1,2,3]
 *
 * Read-only against the archive. The only thing written is the project's own
 * SQLite index at `data/index.db`, and even that is created by the SQLite
 * driver rather than by any fs call in this codebase -- which is why nothing
 * here needs a write primitive.
 */

import { loadConfig, resolveDbPath } from '../config.ts';
import { openDb, loadReclaimInput } from '../db/index.ts';
import { runScan } from '../scan/run.ts';
import { computeReclaim, toTiB, toGiB } from '../scan/reclaim.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

async function main(): Promise<void> {
  const configPath = arg('config', 'config/d3-delivery.json');
  const keeps = arg('keep', '1,2,3')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1);

  const cfg = await loadConfig(configPath);
  const dbPath = resolveDbPath(cfg);
  console.log(`config : ${configPath}`);
  console.log(`root   : ${cfg.root}`);
  console.log(`db     : ${dbPath}`);

  const db = openDb(dbPath);
  try {
    const result = await runScan(db, cfg, { onProgress: (m) => console.log(`  ${m}`) });

    const { walk, derived } = result;
    const proxyBytes = walk.files.reduce(
      (n, f) => (/_proxy3_region0\./i.test(f.name) ? n + f.size : n),
      0,
    );

    console.log('');
    console.log(`snapshot     : ${result.snapshotId}`);
    console.log(
      `files        : ${walk.files.length.toLocaleString()} analysed ` +
        `+ ${walk.excluded.count} excluded ` +
        `= ${(walk.files.length + walk.excluded.count).toLocaleString()} walked`,
    );
    console.log(
      `total        : ${toTiB(walk.totalBytes).toFixed(2)} TiB (${walk.totalBytes} bytes)`,
    );
    console.log(`dirs         : ${walk.dirCount}`);
    console.log(`walk time    : ${(walk.elapsedMs / 1000).toFixed(1)}s`);
    console.log(`total time   : ${(result.elapsedMs / 1000).toFixed(1)}s`);
    console.log(`assets       : ${derived.assets.length.toLocaleString()}`);
    // Separate genuine grammar failures from files the grammar never covered:
    // the pattern is .mov-only, so a .tif or .txt is out of scope, not broken.
    const unparsedMov = derived.unparsedIndexes.filter((i) => walk.files[i]?.ext === 'mov');
    const unparsedOther = derived.unparsedIndexes.filter((i) => walk.files[i]?.ext !== 'mov');
    console.log(
      `unparsed     : ${derived.unparsedIndexes.length} ` +
        `(${unparsedMov.length} .mov failing the grammar, ` +
        `${unparsedOther.length} non-.mov out of grammar scope)`,
    );
    for (const i of unparsedMov) console.log(`   GRAMMAR FAIL -> ${walk.files[i]?.relPath}`);
    for (const i of unparsedOther) console.log(`   out of scope -> ${walk.files[i]?.relPath}`);
    console.log(
      `excluded     : ${walk.excluded.count} files, ${(walk.excluded.bytes / 1024).toFixed(0)} KiB`,
    );
    console.log(`skipped dirs : ${walk.skipped.length}`);
    for (const s of walk.skipped) console.log(`   skipped -> ${s.path}: ${s.reason}`);
    console.log(`proxy3_region0: ${toTiB(proxyBytes).toFixed(2)} TiB`);

    const mov = walk.files.filter((f) => f.ext === 'mov').length;
    console.log(`.mov files   : ${mov.toLocaleString()} of ${walk.files.length.toLocaleString()}`);

    const reclaimInput = loadReclaimInput(db, result.snapshotId);
    console.log('');
    for (const keepN of keeps) {
      const r = computeReclaim(reclaimInput, keepN);
      console.log(
        `keep latest ${keepN}: ${toTiB(r.reclaimableBytes).toFixed(2)} TiB reclaimable, ` +
          `${r.supersededVersions} superseded versions, ` +
          `${r.supersededFiles} files, ` +
          `protected patches ${toGiB(r.protectedPatchBytes).toFixed(1)} GiB`,
      );
    }
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

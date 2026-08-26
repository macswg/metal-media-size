/**
 * Scan orchestration: walk -> parse -> derive -> persist.
 *
 * This is the entry point the CLI and (later) the API's "rescan" endpoint use.
 * It is the only place that wires the read-only fs layer to the database.
 */

import type { Database as Db } from 'better-sqlite3';
import type { AppConfig } from '../config.ts';
import { ReadOnlyFs } from '../fs/readonly.ts';
import { ExclusionMatcher } from './exclude.ts';
import { walk, type WalkResult } from './walk.ts';
import { makeParser, type ParseResult } from './parse.ts';
import { deriveAssets, type DeriveResult } from './derive.ts';
import { beginSnapshot, finishSnapshot, writeSnapshotData } from '../db/index.ts';

export interface ScanResult {
  snapshotId: number;
  walk: WalkResult;
  parsed: ParseResult[];
  derived: DeriveResult;
  /** Wall-clock ms for the whole scan, including the database write. */
  elapsedMs: number;
}

export interface ScanOptions {
  statConcurrency?: number;
  onProgress?: (message: string) => void;
}

export async function runScan(
  db: Db,
  cfg: AppConfig,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const started = Date.now();
  const log = options.onProgress ?? (() => {});

  const rofs = new ReadOnlyFs({
    allowedRoots: cfg.allowedRoots,
    dirTimeoutMs: cfg.dirTimeoutMs,
  });
  const exclusions = new ExclusionMatcher(cfg.exclusions.globs, cfg.exclusions.caseInsensitive);

  const snapshotId = beginSnapshot(db, cfg.root, cfg.name, started);

  try {
    log(`walking ${cfg.root}`);
    const walkResult = await walk(rofs, cfg.root, exclusions, {
      statConcurrency: options.statConcurrency,
    });
    log(
      `walked ${walkResult.files.length} files in ${walkResult.elapsedMs}ms ` +
        `(${walkResult.dirCount} dirs, ${walkResult.skipped.length} skipped)`,
    );

    const parse = makeParser(cfg.parse.pattern, cfg.parse.flags);
    const parsed = walkResult.files.map((f) => parse(f.name));

    const derived = deriveAssets(
      walkResult.files,
      parsed,
      cfg.families,
      cfg.defaultFamily,
    );
    log(`derived ${derived.assets.length} assets, ${derived.unparsedIndexes.length} unparsed`);

    writeSnapshotData(db, snapshotId, walkResult.files, derived.assets, derived.unparsedIndexes);

    finishSnapshot(db, snapshotId, {
      fileCount: walkResult.files.length,
      totalBytes: walkResult.totalBytes,
      elapsedMs: Date.now() - started,
      dirCount: walkResult.dirCount,
      excludedCount: walkResult.excluded.count,
      excludedBytes: walkResult.excluded.bytes,
      unparsedCount: derived.unparsedIndexes.length,
      skipped: walkResult.skipped,
      status: 'complete',
    });

    return { snapshotId, walk: walkResult, parsed, derived, elapsedMs: Date.now() - started };
  } catch (err) {
    finishSnapshot(db, snapshotId, {
      fileCount: 0,
      totalBytes: 0,
      elapsedMs: Date.now() - started,
      dirCount: 0,
      excludedCount: 0,
      excludedBytes: 0,
      unparsedCount: 0,
      skipped: [{ path: cfg.root, reason: (err as Error).message }],
      status: 'failed',
    });
    throw err;
  }
}

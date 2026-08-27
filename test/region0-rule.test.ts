/**
 * REGION 0 IS THE WHOLE CANVAS, NOT A SLICE.
 *
 * A delivery is cut into `region1`..`regionN` for the venue. `region0` is the
 * whole canvas in one piece -- the copy the offline edit is cut against.
 *
 * In THIS archive every region0 file also carries `_proxy3`, so a region0
 * subtotal and a proxy subtotal are the same number to the byte. That is a
 * fact about this delivery and not about the grammar: region0 says WHICH part
 * of the canvas, `_proxyN` says AT WHAT RESOLUTION, and a delivery that ships
 * a full-resolution region0 is a legal reading of the same filename rule.
 *
 * So the two subtotals are counted separately, and everything that asks "is
 * there a whole-canvas copy here?" asks about BOTH. These tests pin that:
 * region0 never counts as a slice, with or without the proxy token, and the
 * filter that finds whole-canvas material finds it either way.
 *
 * Confirmed by the user: *"the region0 files are also proxies, but that will
 * not always be the case. The region0 files are necessary for offline
 * editing."*
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { deriveAssets } from '../src/scan/derive.ts';
import { makeParser } from '../src/scan/parse.ts';
import type { FileRecord } from '../src/scan/walk.ts';
import { migrate, openDb, writeSnapshotData, beginSnapshot } from '../src/db/index.ts';
import { versionWhere } from '../src/server/query.ts';

const parse = makeParser();
const SONG = '100_ALPHA';

function file(name: string, size: number, mtime = 1_700_000_000_000): FileRecord {
  return { relPath: `${SONG}/${name}`, songFolder: SONG, name, ext: 'mov', size, mtime };
}

function derive(files: FileRecord[]) {
  return deriveAssets(
    files,
    files.map((f) => parse(f.name)),
    { LL180: ['LL180'] },
    'OTHER',
  );
}

describe('deriveAssets: the region0 subtotal', () => {
  it('sums region0 bytes and keeps them out of the slice count', () => {
    const files = [
      file('100_ALPHA_MAIN_LL180_v001_region1.mov', 1000),
      file('100_ALPHA_MAIN_LL180_v001_region2.mov', 2000),
      file('100_ALPHA_MAIN_LL180_v001_proxy3_region0.mov', 70),
    ];
    const v = derive(files).assets[0]?.versions[0];
    expect(v?.bytes).toBe(3070);
    expect(v?.region0Bytes).toBe(70);
    expect(v?.proxyBytes).toBe(70);
    expect(v?.regionCount).toBe(2);
  });

  it('counts a region0 with NO proxy token as region0, and still not as a slice', () => {
    // The case this archive does not have and the next one might: a
    // full-resolution whole-canvas render for the offline edit.
    const files = [
      file('100_ALPHA_MAIN_LL180_v001_region1.mov', 1000),
      file('100_ALPHA_MAIN_LL180_v001_region2.mov', 2000),
      file('100_ALPHA_MAIN_LL180_v001_region0.mov', 4000),
    ];
    const v = derive(files).assets[0]?.versions[0];
    expect(v?.region0Bytes).toBe(4000);
    // No `_proxyN` token, so nothing to report as a proxy.
    expect(v?.proxyBytes).toBe(0);
    // THE POINT: the whole canvas is not a fifteenth slice. If this ever reads
    // 3, a version carrying nothing but its offline-edit copy starts ranking
    // as a playable delivery and can supersede a master.
    expect(v?.regionCount).toBe(2);
  });

  it('reports a version that is nothing but its region0 as having no slices', () => {
    const files = [file('100_ALPHA_MAIN_LL180_v002_region0.mov', 4000)];
    const v = derive(files).assets[0]?.versions[0];
    expect(v?.region0Bytes).toBe(4000);
    expect(v?.regionCount).toBe(0);
  });

  it('leaves a version with no whole-canvas copy at zero', () => {
    const files = [
      file('100_ALPHA_MAIN_LL180_v003_region1.mov', 1000),
      file('100_ALPHA_MAIN_LL180_v003_region2.mov', 2000),
    ];
    const v = derive(files).assets[0]?.versions[0];
    expect(v?.region0Bytes).toBe(0);
  });
});

/** An index holding one asset with three deliberately different versions. */
function indexedSnapshot() {
  const files = [
    // v001: slices plus a PROXY region0 -- this archive's shape.
    file('100_ALPHA_MAIN_LL180_v001_region1.mov', 1000),
    file('100_ALPHA_MAIN_LL180_v001_proxy3_region0.mov', 70),
    // v002: slices plus a FULL-RESOLUTION region0 -- no proxy token at all.
    file('100_ALPHA_MAIN_LL180_v002_region1.mov', 1000),
    file('100_ALPHA_MAIN_LL180_v002_region0.mov', 4000),
    // v003: slices only.
    file('100_ALPHA_MAIN_LL180_v003_region1.mov', 1000),
    // v004: the whole canvas and nothing behind it.
    file('100_ALPHA_MAIN_LL180_v004_region0.mov', 4000),
  ];
  const db = openDb(':memory:');
  const snapshotId = beginSnapshot(db, '/nonexistent/fixture', 'region0-test');
  const { assets, unparsedIndexes } = derive(files);
  writeSnapshotData(db, snapshotId, files, assets, unparsedIndexes);
  return { db, snapshotId };
}

function labelsMatching(hasProxy: 0 | 1 | 'only'): string[] {
  const { db, snapshotId } = indexedSnapshot();
  const where = versionWhere(snapshotId, { hasProxy });
  const rows = db
    .prepare(`SELECT ver_label FROM v_asset_version av WHERE ${where.sql} ORDER BY ver_num`)
    .all(...(where.params as unknown[])) as { ver_label: string }[];
  db.close();
  return rows.map((r) => r.ver_label);
}

describe('the proxy/region0 filter', () => {
  it('finds whole-canvas material whether or not it is a proxy', () => {
    // v002 and v004 have no proxy token at all. Before region0 was counted in
    // its own right they were invisible to this filter.
    expect(labelsMatching(1)).toEqual(['v001', 'v002', 'v004']);
  });

  it('excludes those versions from the negative form', () => {
    expect(labelsMatching(0)).toEqual(['v003']);
  });

  it("'only' means a whole canvas with no slices behind it", () => {
    expect(labelsMatching('only')).toEqual(['v004']);
  });
});

describe('the region0_bytes migration', () => {
  it('backfills an index written before the column existed', () => {
    const { db, snapshotId } = indexedSnapshot();
    const before = db
      .prepare(`SELECT ver_label, region0_bytes AS b FROM v_asset_version WHERE snapshot_id = ?`)
      .all(snapshotId) as { ver_label: string; b: number }[];
    expect(before.find((r) => r.ver_label === 'v002')?.b).toBe(4000);

    // Rewind the schema to version 1: the view has to go first, because a
    // column a view names cannot be dropped out from under it.
    db.exec(`DROP VIEW IF EXISTS v_asset_version`);
    db.exec(`ALTER TABLE asset_version DROP COLUMN region0_bytes`);
    expect(
      (db.pragma('table_info(asset_version)') as { name: string }[]).map((c) => c.name),
    ).not.toContain('region0_bytes');

    migrate(db);

    const after = db
      .prepare(
        `SELECT av.ver_label, av.region0_bytes AS b
           FROM asset_version av JOIN asset a ON a.id = av.asset_id
          WHERE a.snapshot_id = ?`,
      )
      .all(snapshotId) as { ver_label: string; b: number }[];
    const byLabel = new Map(after.map((r) => [r.ver_label, r.b]));
    // Derived from the files on record, so the proxy and the full-resolution
    // whole canvas both come back -- and a version with neither stays at 0.
    expect(byLabel.get('v001')).toBe(70);
    expect(byLabel.get('v002')).toBe(4000);
    expect(byLabel.get('v003')).toBe(0);
    expect(byLabel.get('v004')).toBe(4000);
    db.close();
  });

  it('is a no-op the second time', () => {
    const { db } = indexedSnapshot();
    const sum = () =>
      (db.prepare(`SELECT COALESCE(SUM(region0_bytes), 0) AS n FROM asset_version`).get() as {
        n: number;
      }).n;
    const first = sum();
    migrate(db);
    expect(sum()).toBe(first);
    db.close();
  });

  it('adds the column to an index that has never seen it', () => {
    // A bare v1 table: no rows, nothing to backfill, just the ALTER.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE asset_version (id INTEGER PRIMARY KEY, proxy_bytes INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE file (id INTEGER PRIMARY KEY, name TEXT, size INTEGER, asset_version_id INTEGER)`);
    migrate(db);
    expect(
      (db.pragma('table_info(asset_version)') as { name: string }[]).map((c) => c.name),
    ).toContain('region0_bytes');
    db.close();
  });
});

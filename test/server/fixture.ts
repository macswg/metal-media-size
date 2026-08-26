/**
 * A small, fully deterministic fixture index for the API tests.
 *
 * WHY IT IS BUILT WITH DIRECT INSERTS rather than by running the scanner:
 *
 *   - The tests must never touch the real 133 TB mount. Anything that walks a
 *     filesystem belongs in an `*.integration.test.ts`, not here.
 *   - The version grammar is being revised (sub-revision letters are becoming
 *     distinct versions). Building the fixture through `deriveAssets` would
 *     couple these API tests to that change; building it from explicit rows
 *     does not. The API layer's contract is with the SCHEMA, so the fixture is
 *     written against the schema.
 *   - Anomalies, shape-duplicates and patches all need shapes that are awkward
 *     to conjure from filenames but trivial to state as rows.
 *
 * The archive root points at a path that does not exist. If any route ever
 * tried to read a file, it would fail loudly instead of quietly succeeding.
 */

import type { Database as Db } from 'better-sqlite3';
import { openDb } from '../../src/db/index.ts';
import type { AppConfig } from '../../src/config.ts';

export const FIXTURE_ROOT = '/nonexistent/fixture-archive/00_D3_Delivery';

export const FIXTURE_CONFIG: AppConfig = {
  name: 'fixture',
  root: FIXTURE_ROOT,
  allowedRoots: [FIXTURE_ROOT],
  dbPath: ':memory:',
  dirTimeoutMs: 1000,
  parse: {
    pattern:
      '^(?<base>.+?)_[vV](?<ver>\\d+)(?<sub>[a-zA-Z])?(?<frame>_frame_?\\d+)?(?<proxy>_proxy\\d+)?(?:_region(?<region>\\d+))?\\.mov$',
    flags: 'i',
  },
  exclusions: { globs: ['*.ffs_db', '.DS_Store'], caseInsensitive: true },
  families: { LL180: ['LL180'], FULL: ['FULL'], ANIMATIC: ['ANIMATIC'] },
  defaultFamily: 'OTHER',
};

interface VersionSpec {
  /** Stable handle used by the tests. */
  tag: string;
  verNum: number;
  subLetter: string | null;
  isPatch: boolean;
  patchFrame: number | null;
  verLabel: string;
  mtime: number;
  /** `region -> size`. Region 0 with `proxy: true` is the whole-canvas proxy. */
  files: { region: number; size: number; proxy?: boolean }[];
}

interface AssetSpec {
  songFolder: string;
  base: string;
  family: string;
  versions: VersionSpec[];
}

/**
 * The fixture archive.
 *
 * 100_ALPHA_MAIN_LL180 -- four full versions, one superseded patch, one live
 *   patch, and v003 whose per-region sizes are identical to v001 (the
 *   version-shape duplicate case).
 * 200_BETA_EDIT_LL180  -- carries a sub-revision letter and a version that is
 *   missing a tile (the missing-region case).
 * 300_GAMMA_ANIMATIC_LL180 -- a single version, so nothing can supersede it.
 */
export const FIXTURE_ASSETS: AssetSpec[] = [
  {
    songFolder: '100_ALPHA',
    base: '100_ALPHA_MAIN_LL180',
    family: 'LL180',
    versions: [
      {
        tag: 'alpha-v1',
        verNum: 1,
        subLetter: null,
        isPatch: false,
        patchFrame: null,
        verLabel: 'v001',
        mtime: 1_000_000,
        files: [
          { region: 1, size: 1000 },
          { region: 2, size: 2000 },
          { region: 0, size: 100, proxy: true },
        ],
      },
      {
        tag: 'alpha-v2',
        verNum: 2,
        subLetter: null,
        isPatch: false,
        patchFrame: null,
        verLabel: 'v002',
        mtime: 2_000_000,
        files: [
          { region: 1, size: 1100 },
          { region: 2, size: 2100 },
          // Region 9 exists in no other version of this asset: an ORPHAN tile.
          { region: 9, size: 90 },
          { region: 0, size: 110, proxy: true },
        ],
      },
      {
        // Same per-region sizes as v001, different mtimes: a re-render that
        // produced identical output. This is the version-shape duplicate.
        tag: 'alpha-v3',
        verNum: 3,
        subLetter: null,
        isPatch: false,
        patchFrame: null,
        verLabel: 'v003',
        mtime: 3_000_000,
        files: [
          { region: 1, size: 1000 },
          { region: 2, size: 2000 },
          { region: 0, size: 100, proxy: true },
        ],
      },
      {
        tag: 'alpha-v4',
        verNum: 4,
        subLetter: null,
        isPatch: false,
        patchFrame: null,
        verLabel: 'v004',
        mtime: 4_000_000,
        files: [
          { region: 1, size: 5000 },
          { region: 2, size: 6000 },
        ],
      },
      {
        // A patch below the latest full version: superseded.
        tag: 'alpha-patch-v2',
        verNum: 2,
        subLetter: null,
        isPatch: true,
        patchFrame: 100,
        verLabel: 'v002 frame00100',
        mtime: 2_500_000,
        files: [{ region: 1, size: 300 }],
      },
      {
        // A patch at the latest full version: a live fix, protected at every N.
        tag: 'alpha-patch-v4',
        verNum: 4,
        subLetter: null,
        isPatch: true,
        patchFrame: 200,
        verLabel: 'v004 frame00200',
        mtime: 4_500_000,
        files: [{ region: 1, size: 400 }],
      },
    ],
  },
  {
    songFolder: '200_BETA',
    base: '200_BETA_EDIT_LL180',
    family: 'FULL',
    versions: [
      {
        tag: 'beta-v1',
        verNum: 1,
        subLetter: null,
        isPatch: false,
        patchFrame: null,
        verLabel: 'v001',
        mtime: 1_500_000,
        files: [
          { region: 1, size: 7000 },
          { region: 2, size: 8000 },
        ],
      },
      {
        // Missing region 2: the layout says two tiles, this version has one.
        tag: 'beta-v1a',
        verNum: 1,
        subLetter: 'a',
        isPatch: false,
        patchFrame: null,
        verLabel: 'v001a',
        mtime: 1_600_000,
        files: [{ region: 1, size: 7500 }],
      },
      {
        tag: 'beta-v2',
        verNum: 2,
        subLetter: null,
        isPatch: false,
        patchFrame: null,
        verLabel: 'v002',
        mtime: 2_600_000,
        files: [
          { region: 1, size: 9000 },
          { region: 2, size: 9500 },
        ],
      },
    ],
  },
  {
    songFolder: '300_GAMMA',
    base: '300_GAMMA_ANIMATIC_LL180',
    family: 'ANIMATIC',
    versions: [
      {
        tag: 'gamma-v1',
        verNum: 1,
        subLetter: null,
        isPatch: false,
        patchFrame: null,
        verLabel: 'v001',
        mtime: 900_000,
        files: [{ region: 1, size: 4242 }],
      },
    ],
  },
  {
    // The HIGH-severity case: the newest full version is the broken one, so
    // nothing downstream fixes it.
    songFolder: '400_DELTA',
    base: '400_DELTA_FULL_LL180',
    family: 'FULL',
    versions: [
      {
        tag: 'delta-v1',
        verNum: 1,
        subLetter: null,
        isPatch: false,
        patchFrame: null,
        verLabel: 'v001',
        mtime: 7_000_000,
        files: [
          { region: 1, size: 100 },
          { region: 2, size: 200 },
        ],
      },
      {
        // Missing region 2, and it is the current master.
        tag: 'delta-v2',
        verNum: 2,
        subLetter: null,
        isPatch: false,
        patchFrame: null,
        verLabel: 'v002',
        mtime: 7_100_000,
        files: [{ region: 1, size: 150 }],
      },
    ],
  },
];

/**
 * Files with no asset-version: unparsed, zero-byte, and name-size duplicates.
 *
 * The last two mirror the real `520_THICKET_..._v0003b_region4_.mov` defect -- a
 * .mov the grammar rejects (trailing underscore) that can still be attributed
 * to an asset by base prefix. One sits under a newer full version (LOW), the
 * other is on the current master (HIGH).
 */
const LOOSE_FILES = [
  { songFolder: '100_ALPHA', name: 'render-log.txt', ext: 'txt', size: 512, mtime: 5_000_000 },
  { songFolder: '200_BETA', name: 'render-log.txt', ext: 'txt', size: 512, mtime: 5_000_000 },
  { songFolder: '200_BETA', name: 'empty.txt', ext: 'txt', size: 0, mtime: 5_100_000 },
  {
    songFolder: '100_ALPHA',
    name: '100_ALPHA_QC_A_LL180_v001.tif',
    ext: 'tif',
    size: 4242,
    mtime: 5_200_000,
  },
  {
    // Attributable to 100_ALPHA_MAIN_LL180 at v002b; v003 and v004 are newer.
    songFolder: '100_ALPHA',
    name: '100_ALPHA_MAIN_LL180_v0002b_region4_.mov',
    ext: 'mov',
    size: 777,
    mtime: 5_300_000,
  },
  {
    // Attributable to 400_DELTA_FULL_LL180 at v002b. The asset's newest full is
    // the bare v002, which does NOT rank newer than v002b -- so this stays HIGH.
    songFolder: '400_DELTA',
    name: '400_DELTA_FULL_LL180_v0002b_region9_.mov',
    ext: 'mov',
    size: 55,
    mtime: 5_400_000,
  },
];

export interface Fixture {
  db: Db;
  cfg: AppConfig;
  /** The LATEST complete snapshot -- what routes use when none is named. */
  snapshotId: number;
  /** An earlier scan of the same archive, for the diff tests. */
  snapshotIdPrev: number;
  /** tag -> asset_version.id in the LATEST snapshot. */
  versionIds: Map<string, number>;
  /** asset base -> asset.id in the LATEST snapshot. */
  assetIds: Map<string, number>;
}

function fileNameFor(base: string, ver: VersionSpec, f: { region: number; proxy?: boolean }): string {
  const sub = ver.subLetter ?? '';
  const frame = ver.isPatch ? `_frame${String(ver.patchFrame ?? 0).padStart(5, '0')}` : '';
  const proxy = f.proxy ? '_proxy3' : '';
  return `${base}_v${String(ver.verNum).padStart(3, '0')}${sub}${frame}${proxy}_region${f.region}.mov`;
}

function insertSnapshot(db: Db, name: string, startedAt: number): number {
  const info = db
    .prepare(
      `INSERT INTO snapshot (root, started_at, status, name) VALUES (?, ?, 'running', ?)`,
    )
    .run(FIXTURE_ROOT, startedAt, name);
  return Number(info.lastInsertRowid);
}

/** Populate one snapshot. The options let two snapshots differ meaningfully. */
function populate(
  db: Db,
  snapshotId: number,
  opts: {
    /** Per-song byte delta applied to every render in that folder. */
    sizeDeltaBySong?: Record<string, number>;
    skipTags?: Set<string>;
    extraFile?: { songFolder: string; name: string; ext: string; size: number; mtime: number };
    versionIds?: Map<string, number>;
    assetIds?: Map<string, number>;
  } = {},
): { fileCount: number; totalBytes: number } {
  const deltas = opts.sizeDeltaBySong ?? {};
  const skip = opts.skipTags ?? new Set<string>();

  const insertAsset = db.prepare(
    `INSERT INTO asset (snapshot_id, song_folder, base, family) VALUES (?, ?, ?, ?)`,
  );
  const insertVersion = db.prepare(
    `INSERT INTO asset_version
       (asset_id, ver_num, sub_letter, is_patch, patch_frame, bytes, file_count,
        proxy_bytes, region_count, latest_mtime, ver_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFile = db.prepare(
    `INSERT INTO file (snapshot_id, rel_path, song_folder, name, ext, size, mtime, parse_ok,
                       asset_version_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let fileCount = 0;
  let totalBytes = 0;

  for (const asset of FIXTURE_ASSETS) {
    const assetId = Number(
      insertAsset.run(snapshotId, asset.songFolder, asset.base, asset.family).lastInsertRowid,
    );
    opts.assetIds?.set(asset.base, assetId);

    for (const ver of asset.versions) {
      if (skip.has(ver.tag)) continue;
      const delta = deltas[asset.songFolder] ?? 0;
      const sizes = ver.files.map((f) => ({ ...f, size: f.size + delta }));
      const bytes = sizes.reduce((n, f) => n + f.size, 0);
      const proxyBytes = sizes.filter((f) => f.proxy).reduce((n, f) => n + f.size, 0);
      const regionCount = sizes.filter((f) => !f.proxy).length;

      const versionId = Number(
        insertVersion.run(
          assetId,
          ver.verNum,
          ver.subLetter,
          ver.isPatch ? 1 : 0,
          ver.patchFrame,
          bytes,
          sizes.length,
          proxyBytes,
          regionCount,
          ver.mtime,
          ver.verLabel,
        ).lastInsertRowid,
      );
      opts.versionIds?.set(ver.tag, versionId);

      for (const f of sizes) {
        const name = fileNameFor(asset.base, ver, f);
        insertFile.run(
          snapshotId,
          `${asset.songFolder}/${name}`,
          asset.songFolder,
          name,
          'mov',
          f.size,
          ver.mtime,
          1,
          versionId,
        );
        fileCount += 1;
        totalBytes += f.size;
      }
    }
  }

  for (const f of LOOSE_FILES) {
    insertFile.run(
      snapshotId,
      `${f.songFolder}/${f.name}`,
      f.songFolder,
      f.name,
      f.ext,
      f.size,
      f.mtime,
      0,
      null,
    );
    fileCount += 1;
    totalBytes += f.size;
  }

  if (opts.extraFile) {
    const f = opts.extraFile;
    insertFile.run(
      snapshotId,
      `${f.songFolder}/${f.name}`,
      f.songFolder,
      f.name,
      f.ext,
      f.size,
      f.mtime,
      0,
      null,
    );
    fileCount += 1;
    totalBytes += f.size;
  }

  return { fileCount, totalBytes };
}

function finish(
  db: Db,
  snapshotId: number,
  totals: { fileCount: number; totalBytes: number },
): void {
  db.prepare(
    `UPDATE snapshot SET finished_at = ?, file_count = ?, total_bytes = ?, status = 'complete',
       elapsed_ms = ?, dir_count = ?, excluded_count = ?, excluded_bytes = ?, unparsed_count = ?,
       skipped_json = ? WHERE id = ?`,
  ).run(
    9_000_000,
    totals.fileCount,
    totals.totalBytes,
    1234,
    4,
    7,
    2048,
    LOOSE_FILES.length,
    JSON.stringify([{ path: `${FIXTURE_ROOT}/x_slow`, reason: 'timed out' }]),
    snapshotId,
  );
}

/**
 * Build the fixture.
 *
 * The EARLIER snapshot is the archive before the newest render landed:
 * `100_ALPHA` had no v004 and no v004 patch, `200_BETA` renders were 5 bytes
 * smaller, `300_GAMMA` was 42 bytes larger, and a stale note sat in 300_GAMMA.
 * The LATEST snapshot is the reference the other tests use.
 */
export function makeFixture(): Fixture {
  const db = openDb(':memory:');
  const versionIds = new Map<string, number>();
  const assetIds = new Map<string, number>();

  const prev = insertSnapshot(db, 'fixture-prev', 1_000);
  finish(
    db,
    prev,
    populate(db, prev, {
      skipTags: new Set(['alpha-v4', 'alpha-patch-v4']),
      // Negative for BETA so those files GREW by the latest scan; positive for
      // GAMMA so that one SHRANK. Both buckets of the diff get exercised.
      sizeDeltaBySong: { '200_BETA': -5, '300_GAMMA': 42 },
      extraFile: {
        songFolder: '300_GAMMA',
        name: 'stale-note.txt',
        ext: 'txt',
        size: 64,
        mtime: 800_000,
      },
    }),
  );

  const latest = insertSnapshot(db, 'fixture-latest', 2_000);
  finish(db, latest, populate(db, latest, { versionIds, assetIds }));

  return { db, cfg: FIXTURE_CONFIG, snapshotId: latest, snapshotIdPrev: prev, versionIds, assetIds };
}

/**
 * INTEGRATION / SLOW TEST -- scans the real archive and asserts the measured
 * ground truth. Excluded from `npm test`; run it with `npm run test:integration`
 * (or `npm run test:all`).
 *
 * READ-ONLY. It walks and stats the archive and writes only to a throwaway
 * SQLite file inside the project's own `data/` directory.
 *
 * ON TOLERANCES: the archive is LIVE -- FreeFileSync syncs into it while we
 * work, and directories appear and disappear between runs (two empty folders,
 * BIGDOME and TST, vanished mid-development, and the file count moved by one).
 * So these assertions bracket the ground truth tightly rather than demanding
 * bit-exact equality, and every bound is annotated with the measured value it
 * is protecting. A real regression in the grammar or the patch rule moves these
 * numbers by far more than the tolerance.
 *
 * RE-PINNED 2026-08-26 against snapshot 8. A delivery landed during the
 * resolution work: +30 files and +0.20 TiB against snapshot 7, which pushed
 * four bands out. The reclaim figures move with the bytes, so they were
 * re-measured together rather than one at a time -- re-pinning them piecemeal
 * is how a real regression gets absorbed into a band nobody re-derived.
 *
 *   snapshot 7 (2026-08-25): 26,655 files  133.57 TiB  keep-1 49.69 TiB / 795
 *   snapshot 8 (2026-08-26): 26,685 files  133.77 TiB  keep-1 49.87 TiB / 797
 *
 * The structural invariants did NOT move, which is the reassuring part: 28
 * assets still carry two sub-letters under one version number, and protected
 * patch bytes are still 530.8 GiB at every keep-N.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { loadConfig, PROJECT_ROOT, type AppConfig } from '../src/config.ts';
import { openDb, loadReclaimInput } from '../src/db/index.ts';
import { runScan } from '../src/scan/run.ts';
import { computeReclaim, toTiB, toGiB } from '../src/scan/reclaim.ts';
import { compareVersions } from '../src/scan/derive.ts';
import { ExclusionMatcher } from '../src/scan/exclude.ts';
import type { ScanResult } from '../src/scan/run.ts';
import type { Database as Db } from 'better-sqlite3';

const DB_PATH = join(PROJECT_ROOT, 'data', 'integration-test.db');

let cfg: AppConfig;
let db: Db;
let result: ScanResult;
let reclaimInput: ReturnType<typeof loadReclaimInput>;

/**
 * This suite walks a REAL archive, so it can only run on a machine that has
 * one configured. The scan root is deliberately not committed -- it names a
 * client's storage layout -- so on a fresh clone there is nothing to scan and
 * these tests SKIP rather than fail. A missing archive is not a broken build.
 *
 * Configure one in config/local.json or ARCHIVE_ROOT to run them. See README.
 */
const haveArchive = await (async () => {
  try {
    await loadConfig('config/d3-delivery.json');
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!haveArchive)('integration: scan of the real archive', () => {
  beforeAll(async () => {
    cfg = await loadConfig('config/d3-delivery.json');
    db = openDb(DB_PATH);
    result = await runScan(db, cfg);
    reclaimInput = loadReclaimInput(db, result.snapshotId);
  }, 300_000);

  afterAll(() => {
    db?.close();
    // The throwaway DB is left in data/ (gitignored). Nothing to clean up in
    // the archive, because nothing was ever written there.
  });

  it('walks the ground-truth number of files', () => {
    // Ground truth at snapshot 8: 26,687 walked = 26,685 analysed + 2 excluded.
    const walked = result.walk.files.length + result.walk.excluded.count;
    expect(walked).toBeGreaterThanOrEqual(26_600);
    expect(walked).toBeLessThanOrEqual(26_800);
  });

  /**
   * The bookkeeping population is TRANSIENT. FreeFileSync creates these files
   * and clears them again: between snapshot 7 and snapshot 8 they went from 37
   * to 2. The old assertion here demanded at least 30, which was really
   * asserting that FFS had run recently -- it failed for a reason that had
   * nothing to do with this codebase.
   *
   * What must hold whatever FFS is doing: nothing matching an exclusion
   * pattern may reach the analysed set, and whatever was excluded must be
   * negligible in size. The matcher's own behaviour is covered exhaustively by
   * test/exclude.test.ts; this is the end-to-end half of it.
   */
  it('lets nothing excluded reach the analysed set', () => {
    const matcher = new ExclusionMatcher(cfg.exclusions.globs, cfg.exclusions.caseInsensitive);
    const leaked = result.walk.files.filter((f) => matcher.match(f.name) !== null);
    expect(leaked.map((f) => f.relPath)).toEqual([]);
    // A few hundred KB of bookkeeping, never megabytes of real media.
    expect(result.walk.excluded.bytes).toBeLessThan(10 * 1024 * 1024);
  });

  it('totals the ground-truth 133.77 TiB', () => {
    // 133.771 TiB at snapshot 8, up from 133.568 at snapshot 7 as deliveries
    // land. The band is 0.2% wide; a grammar or walk regression moves this by
    // whole TiB, not by hundredths.
    const tib = toTiB(result.walk.totalBytes);
    expect(tib).toBeGreaterThan(133.6);
    expect(tib).toBeLessThan(134.1);
  });

  it('is almost entirely .mov', () => {
    // Ground truth at snapshot 8: 26,681 of 26,685 are .mov. The four that are
    // not are two .tif QC stills and two zero-byte render logs.
    const mov = result.walk.files.filter((f) => f.ext === 'mov').length;
    expect(mov).toBeGreaterThanOrEqual(26_600);
    expect(mov).toBeLessThanOrEqual(26_800);
  });

  it('derives the ground-truth 1,532 assets', () => {
    // Measured at 1,532 and reproduced exactly on first run. Observed drifting
    // to 1,534 within the hour as FreeFileSync delivered new folders, so this
    // is banded upward rather than pinned. A grammar regression -- an
    // over-eager base normalisation, say -- would collapse this by hundreds.
    expect(result.derived.assets.length).toBeGreaterThanOrEqual(1532);
    expect(result.derived.assets.length).toBeLessThan(1600);
  });

  it('has exactly ONE .mov that fails the filename grammar', () => {
    // This single failure is expected and correct: a stray trailing underscore
    // in 520_THICKET_..._v0003b_region4_.mov. The other unparsed entries are .tif
    // and .txt files, which the .mov-only grammar was never meant to cover.
    const unparsedMov = result.derived.unparsedIndexes.filter(
      (i) => result.walk.files[i]?.ext === 'mov',
    );
    expect(unparsedMov).toHaveLength(1);
    expect(result.walk.files[unparsedMov[0] as number]?.name).toMatch(/_region4_\.mov$/);
  });

  it('totals 2.17 TiB of proxy3_region0', () => {
    const proxyBytes = result.walk.files.reduce(
      (n, f) => (/_proxy3_region0\./i.test(f.name) ? n + f.size : n),
      0,
    );
    expect(toTiB(proxyBytes)).toBeGreaterThan(2.1);
    expect(toTiB(proxyBytes)).toBeLessThan(2.25);
  });

  it('skips no directories and stalls nowhere', () => {
    expect(result.walk.skipped).toEqual([]);
  });

  it('completes the walk well inside the timeout budget', () => {
    // Measured ~12s cold, ~2s warm. Generous ceiling: this only catches a
    // pathological regression such as accidentally walking the mount root.
    expect(result.walk.elapsedMs).toBeLessThan(120_000);
  });

  describe('reclaim, keep latest N', () => {
    // CORRECTED figures. Two corrections are baked in, in order; neither may
    // be reverted to make a number look better.
    //
    // 1. Sub-revision letters are DISTINCT versions. The planning prototype's
    //    51.99 / 19.46 / 5.96 TiB (836 / 308 / 121) keyed versions by integer
    //    number alone and silently discarded the letter, collapsing `v002d`
    //    and `v002f` into one row. Known-wrong; never reinstate as targets.
    //
    // 2. THE PROXY-ONLY RULE. A version with no region files is a preview
    //    and cannot supersede a master. Before this rule the figures were
    //    52.87 / 19.83 / 5.97 TiB (864 / 316 / 127), which counted 3.86 TiB of
    //    region-bearing versions as reclaimable on the strength of a preview
    //    sitting above them -- 3.17 TiB of that being the LAST full-resolution
    //    copy of its asset. Also known-wrong; the drop to 49.69 TiB is the
    //    correction, not a regression.
    //
    // Superseded COUNTS rise at keep 2 and 3 while bytes fall: previews no
    // longer occupy kept slots, so more of them fall out of the window -- but
    // they are tiny, and the masters they were displacing are now retained.
    // Re-pinned against snapshot 8 (2026-08-26). Snapshot 7 read 49.69 / 18.19
    // / 5.63 TiB (795 / 400 / 304); the archive gained 30 files and 0.20 TiB,
    // and the figures moved with it. The SHAPE is what matters and it is
    // unchanged: bytes fall steeply as N rises, and protected patch bytes stay
    // flat at 530.8 GiB throughout.
    //   keep 1 -> 49.87 TiB / 797      keep 2 -> 18.26 TiB / 401
    //   keep 3 ->  5.71 TiB / 305
    const cases: [number, number, number][] = [
      [1, 49.87, 797],
      [2, 18.26, 401],
      [3, 5.71, 305],
    ];

    for (const [keepN, wantTiB, wantVersions] of cases) {
      it(`keep ${keepN} -> ${wantTiB} TiB, ${wantVersions} superseded versions`, () => {
        const r = computeReclaim(reclaimInput, keepN);
        expect(toTiB(r.reclaimableBytes)).toBeGreaterThan(wantTiB - 0.06);
        expect(toTiB(r.reclaimableBytes)).toBeLessThan(wantTiB + 0.06);
        expect(r.supersededVersions).toBeGreaterThanOrEqual(wantVersions - 3);
        expect(r.supersededVersions).toBeLessThanOrEqual(wantVersions + 3);
      });
    }

    it('counts one asset_version row per (number, letter, patch)', () => {
      // Measured 2,405 rows at snapshot 8: 2,399 full + 6 patch, of which 234
      // carry a letter. Folding the letters would collapse this to 2,377. The
      // lower bound stays at 2,403 -- it only has to sit above the folded
      // figure, and raising it on every scan would make the guard brittle as
      // the archive grows.
      const rows = db
        .prepare(
          `SELECT COUNT(*) c FROM asset_version av
           JOIN asset a ON a.id = av.asset_id WHERE a.snapshot_id = ?`,
        )
        .get(result.snapshotId) as { c: number };
      expect(rows.c).toBeGreaterThanOrEqual(2403);
      expect(rows.c).toBeLessThan(2500);
    });

    it('keeps sub-lettered versions as SEPARATE versions of the same asset', () => {
      // Asserted as a property rather than against a named asset: this suite
      // runs against whatever archive is configured, so a test that hard-codes
      // one company's asset name can never pass for anybody else.
      const variants = db
        .prepare(
          `SELECT a.base, av.ver_num, COUNT(*) AS n
             FROM asset_version av JOIN asset a ON a.id = av.asset_id
            WHERE a.snapshot_id = ? AND av.is_patch = 0 AND av.sub_letter IS NOT NULL
            GROUP BY av.asset_id, av.ver_num
            HAVING n > 1
            ORDER BY n DESC`,
        )
        .all(result.snapshotId) as { base: string; ver_num: number; n: number }[];

      // At least one asset must carry two different letters under one version
      // number, or this archive cannot exercise the rule at all.
      expect(variants.length).toBeGreaterThan(0);

      // ...and those really are distinct rows, not one row counted twice.
      const first = variants[0] as (typeof variants)[number];
      const letters = db
        .prepare(
          `SELECT av.sub_letter FROM asset_version av
             JOIN asset a ON a.id = av.asset_id
            WHERE a.snapshot_id = ? AND a.base = ? AND av.ver_num = ? AND av.is_patch = 0
            ORDER BY av.sub_letter`,
        )
        .all(result.snapshotId, first.base, first.ver_num) as { sub_letter: string | null }[];
      expect(new Set(letters.map((l) => l.sub_letter)).size).toBe(letters.length);
      expect(letters.length).toBeGreaterThan(1);

      const multi = db
        .prepare(
          `SELECT COUNT(*) c FROM (
             SELECT a.id FROM asset a JOIN asset_version av ON av.asset_id = a.id
             WHERE a.snapshot_id = ? AND av.is_patch = 0
             GROUP BY a.id, av.ver_num HAVING COUNT(*) > 1)`,
        )
        .get(result.snapshotId) as { c: number };
      expect(multi.c).toBeGreaterThanOrEqual(28);
    });

    it('sub_letter is a single letter, never a comma-joined list', () => {
      const bad = db
        .prepare(
          `SELECT av.sub_letter FROM asset_version av
           JOIN asset a ON a.id = av.asset_id
           WHERE a.snapshot_id = ? AND av.sub_letter IS NOT NULL
             AND LENGTH(av.sub_letter) != 1`,
        )
        .all(result.snapshotId);
      expect(bad).toEqual([]);
    });

    it('a patch below a newer full stays superseded at every keep-N', () => {
      // THE JUDGEMENT CALL, asserted against whatever archive is configured
      // rather than against a named asset. The shape being tested: an asset
      // with a patch that has at least two FULL versions above it, and at
      // least one full BELOW it. At keep-3 the kept fulls then include one
      // older than the patch -- yet the newer full re-renders already contain
      // its frames, so the patch is superseded regardless.
      const asset = reclaimInput.find((a) => {
        const p = a.versions.find((v) => v.isPatch);
        if (!p) return false;
        const fulls = a.versions.filter((v) => !v.isPatch && v.regionCount > 0);
        return (
          fulls.filter((f) => f.verNum > p.verNum).length >= 2 &&
          fulls.some((f) => f.verNum < p.verNum)
        );
      });
      if (!asset) {
        // Not every archive contains this shape. Skipping is honest; asserting
        // against an absent asset is not. The unit suite covers the rule with
        // a constructed fixture in every case.
        expect(reclaimInput.length).toBeGreaterThan(0);
        return;
      }
      const patchVersion = asset.versions.find((v) => v.isPatch);
      expect(patchVersion, 'expected a patch').toBeDefined();

      for (const keepN of [1, 2, 3]) {
        const r = computeReclaim([asset as (typeof reclaimInput)[number]], keepN);
        const verdict = r.verdicts.find((v) => v.versionId === patchVersion?.id);
        expect(verdict?.keep, `keepN=${keepN}`).toBe(false);
        expect(verdict?.reason, `keepN=${keepN}`).toBe('superseded-patch');
      }
    });

    it('protects 530.8 GiB of newer frame-patches at EVERY keep-N', () => {
      const protectedAt = cases.map(
        ([keepN]) => computeReclaim(reclaimInput, keepN).protectedPatchBytes,
      );
      // Constant across N by construction.
      expect(new Set(protectedAt).size).toBe(1);
      const gib = toGiB(protectedAt[0] as number);
      expect(gib).toBeGreaterThan(528);
      expect(gib).toBeLessThan(534);
    });

    it('never marks a full version superseded by a patch alone', () => {
      // For every superseded FULL version there must exist another FULL version
      // that sorts strictly AFTER it -- by (ver_num, sub_letter), so `v001` may
      // legitimately be superseded by `v001d`. If a patch had done the
      // superseding, this invariant would break.
      const r = computeReclaim(reclaimInput, 1);
      const byAsset = new Map(reclaimInput.map((a) => [a.id, a]));
      for (const v of r.verdicts) {
        if (v.keep) continue;
        const asset = byAsset.get(v.assetId);
        const version = asset?.versions.find((x) => x.id === v.versionId);
        if (!version || version.isPatch) continue;
        const newerFull = (asset as (typeof reclaimInput)[number]).versions.some(
          (x) => !x.isPatch && compareVersions(x, version) > 0,
        );
        expect(
          newerFull,
          `full version ${version.verNum}${version.subLetter ?? ''} of ` +
            `${asset?.songFolder}/${asset?.base} was superseded with no newer ` +
            `FULL version present`,
        ).toBe(true);
      }
    });

    it('never marks a master superseded by a preview alone', () => {
      // THE PROXY-ONLY RULE against the real archive. For every superseded
      // REGION-BEARING version there must exist another REGION-BEARING version
      // that sorts strictly after it. A version with no regions is a
      // preview and can never do the superseding.
      const r = computeReclaim(reclaimInput, 1);
      const byAsset = new Map(reclaimInput.map((a) => [a.id, a]));
      for (const v of r.verdicts) {
        if (v.keep) continue;
        const asset = byAsset.get(v.assetId);
        const version = asset?.versions.find((x) => x.id === v.versionId);
        if (!version || version.isPatch || version.regionCount === 0) continue;
        const newerMaster = (asset as (typeof reclaimInput)[number]).versions.some(
          (x) => !x.isPatch && x.regionCount > 0 && compareVersions(x, version) > 0,
        );
        expect(
          newerMaster,
          `region-bearing version ${version.verNum}${version.subLetter ?? ''} of ` +
            `${asset?.songFolder}/${asset?.base} was superseded with no newer ` +
            `REGION-BEARING version present -- a preview must never supersede a master`,
        ).toBe(true);
      }
    });

    it('keeps the newest master of every asset at every keep-N', () => {
      // The blunt statement of the same guarantee: whatever else happens, the
      // last full-resolution copy of an asset is never proposed for removal.
      for (const keepN of [1, 2, 3]) {
        const r = computeReclaim(reclaimInput, keepN);
        const verdictById = new Map(r.verdicts.map((v) => [v.versionId, v]));
        for (const asset of reclaimInput) {
          const masters = asset.versions
            .filter((v) => !v.isPatch && v.regionCount > 0)
            .sort(compareVersions);
          if (masters.length === 0) continue;
          const newest = masters[masters.length - 1] as (typeof masters)[number];
          expect(
            verdictById.get(newest.id)?.keep,
            `keepN=${keepN}: newest master ${newest.verNum}${newest.subLetter ?? ''} of ` +
              `${asset.songFolder}/${asset.base} was not kept`,
          ).toBe(true);
        }
      }
    });

    it('never keeps a patch whose base full version was dropped', () => {
      // Rule 3b, against the real archive at every keepN. A patch layers on the
      // newest full BELOW it; retaining one without its base would retain
      // something that cannot be played as delivered.
      for (const keepN of [1, 2, 3, 5, 10]) {
        const r = computeReclaim(reclaimInput, keepN);
        const byId = new Map(r.verdicts.map((v) => [v.versionId, v]));
        for (const asset of reclaimInput) {
          const fulls = asset.versions
            .filter((v) => !v.isPatch && v.regionCount > 0)
            .sort(compareVersions);
          for (const p of asset.versions) {
            if (!p.isPatch || !byId.get(p.id)?.keep) continue;
            const below = fulls.filter((f) => compareVersions(f, p) <= 0);
            const base = below[below.length - 1];
            if (!base) continue; // no full below it at all -- nothing to pin
            expect(
              byId.get(base.id)?.keep,
              `keepN=${keepN}: ${asset.songFolder}/${asset.base} keeps patch ` +
                `${p.verNum} but dropped its base full ${base.verNum}`,
            ).toBe(true);
          }
        }
      }
    });

    it('reclaim is monotonically non-increasing in keepN', () => {
      const totals = [1, 2, 3, 4, 5].map(
        (n) => computeReclaim(reclaimInput, n).reclaimableBytes,
      );
      for (let i = 1; i < totals.length; i++) {
        expect(totals[i] as number).toBeLessThanOrEqual(totals[i - 1] as number);
      }
    });
  });

  describe('the persisted index matches the in-memory derivation', () => {
    it('stores every analysed file', () => {
      const n = db.prepare(`SELECT COUNT(*) c FROM file WHERE snapshot_id = ?`).get(
        result.snapshotId,
      ) as { c: number };
      expect(n.c).toBe(result.walk.files.length);
    });

    it('stores every asset and links every parsed file to a version', () => {
      const assets = db.prepare(`SELECT COUNT(*) c FROM asset WHERE snapshot_id = ?`).get(
        result.snapshotId,
      ) as { c: number };
      expect(assets.c).toBe(result.derived.assets.length);

      const unlinked = db
        .prepare(
          `SELECT COUNT(*) c FROM file
           WHERE snapshot_id = ? AND parse_ok = 1 AND asset_version_id IS NULL`,
        )
        .get(result.snapshotId) as { c: number };
      expect(unlinked.c).toBe(0);
    });

    it('version byte totals reconcile with the files beneath them', () => {
      const bad = db
        .prepare(
          `SELECT av.id, av.bytes, SUM(f.size) actual
           FROM asset_version av
           JOIN asset a ON a.id = av.asset_id
           JOIN file f ON f.asset_version_id = av.id
           WHERE a.snapshot_id = ?
           GROUP BY av.id HAVING av.bytes != actual`,
        )
        .all(result.snapshotId);
      expect(bad).toEqual([]);
    });

    it('snapshot totals reconcile with the file rows', () => {
      const row = db
        .prepare(`SELECT SUM(size) total, COUNT(*) n FROM file WHERE snapshot_id = ?`)
        .get(result.snapshotId) as { total: number; n: number };
      expect(row.total).toBe(result.walk.totalBytes);
      expect(row.n).toBe(result.walk.files.length);
    });

    it('records the snapshot as complete and retains it', () => {
      const snap = db.prepare(`SELECT * FROM snapshot WHERE id = ?`).get(result.snapshotId) as {
        status: string;
        excluded_count: number;
        unparsed_count: number;
      };
      expect(snap.status).toBe('complete');
      expect(snap.excluded_count).toBe(result.walk.excluded.count);
      expect(snap.unparsed_count).toBe(result.derived.unparsedIndexes.length);
    });
  });
});

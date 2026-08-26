/**
 * THE PATCH RULE. Getting this wrong overstates reclaimable space and could
 * lead to deleting a master that a patch depends on. These tests are the
 * guardrail.
 */

import { describe, it, expect } from 'vitest';
import { computeReclaim, type ReclaimAssetInput, type ReclaimVersionInput } from '../src/scan/reclaim.ts';
import { compareVersions } from '../src/scan/derive.ts';

let nextId = 1;

function full(verNum: number, bytes: number, sub: string | null = null): ReclaimVersionInput {
  return {
    id: nextId++,
    verNum,
    subLetter: sub,
    isPatch: false,
    patchFrame: null,
    bytes,
    proxyBytes: 0,
    fileCount: 1,
    // A full delivery carries region files. Versions with none are
    // previews and are governed by THE PROXY-ONLY RULE -- see
    // test/proxy-only-rule.test.ts.
    regionCount: 14,
  };
}

function patch(
  verNum: number,
  frame: number,
  bytes: number,
  sub: string | null = null,
): ReclaimVersionInput {
  return {
    id: nextId++,
    verNum,
    subLetter: sub,
    isPatch: true,
    patchFrame: frame,
    bytes,
    proxyBytes: 0,
    fileCount: 1,
    regionCount: 14,
  };
}

function asset(...versions: ReclaimVersionInput[]): ReclaimAssetInput {
  return { id: nextId++, songFolder: '250_HARBOR', base: 'TEST_ASSET', versions };
}

function verdictFor(result: ReturnType<typeof computeReclaim>, v: ReclaimVersionInput) {
  const found = result.verdicts.find((x) => x.versionId === v.id);
  if (!found) throw new Error(`no verdict for version ${v.id}`);
  return found;
}

describe('the patch rule - the case from the brief', () => {
  it('v002 full + v003_frame05259 patch: v002 is NOT superseded and the patch is KEPT', () => {
    const v002 = full(2, 1000);
    const p003 = patch(3, 5259, 50);
    const a = asset(v002, p003);

    const r = computeReclaim([a], 1);

    // The full version is the latest FULL version, so it survives.
    expect(verdictFor(r, v002).keep).toBe(true);
    expect(verdictFor(r, v002).reason).toBe('kept-full-latest');

    // The patch sorts above the latest full version: always kept.
    expect(verdictFor(r, p003).keep).toBe(true);
    expect(verdictFor(r, p003).reason).toBe('kept-patch-newer-than-latest-full');

    // Nothing at all is reclaimable here.
    expect(r.reclaimableBytes).toBe(0);
    expect(r.supersededVersions).toBe(0);

    // And the patch bytes are reported as protected.
    expect(r.protectedPatchBytes).toBe(50);
    expect(r.protectedPatchVersions).toBe(1);
  });
});

describe('a full version is NEVER superseded by a patch alone', () => {
  it('many patches above the only full version do not supersede it', () => {
    const v001 = full(1, 1000);
    const patches = [patch(2, 10, 5), patch(3, 20, 5), patch(4, 30, 5), patch(9, 40, 5)];
    const a = asset(v001, ...patches);

    for (const keepN of [1, 2, 3, 10]) {
      const r = computeReclaim([a], keepN);
      expect(verdictFor(r, v001).keep, `keepN=${keepN}`).toBe(true);
      expect(r.reclaimableBytes, `keepN=${keepN}`).toBe(0);
      for (const p of patches) expect(verdictFor(r, p).keep, `keepN=${keepN}`).toBe(true);
    }
  });

  it('patches are excluded from the ranking entirely', () => {
    // Full v001, v002. Patches at v003..v009. keep=1 must keep v002 (the latest
    // FULL), not treat the patches as versions 3..9 that push v002 out.
    const v001 = full(1, 1000);
    const v002 = full(2, 2000);
    const a = asset(v001, v002, patch(3, 1, 5), patch(4, 1, 5), patch(5, 1, 5));

    const r = computeReclaim([a], 1);
    expect(verdictFor(r, v002).keep).toBe(true);
    expect(verdictFor(r, v001).keep).toBe(false);
    expect(verdictFor(r, v001).reason).toBe('superseded-full');
    expect(r.reclaimableBytes).toBe(1000);
  });
});

describe('a patch overtaken by a newer FULL version is superseded', () => {
  it('keep=1 drops the v001 patch along with v001', () => {
    const v001 = full(1, 1000);
    const p001 = patch(1, 100, 30);
    const v002 = full(2, 2000);
    const a = asset(v001, p001, v002);

    const r = computeReclaim([a], 1);
    expect(verdictFor(r, v001).keep).toBe(false);
    expect(verdictFor(r, p001).keep).toBe(false);
    expect(verdictFor(r, p001).reason).toBe('superseded-patch');
    expect(verdictFor(r, v002).keep).toBe(true);
    expect(r.reclaimableBytes).toBe(1030);
    expect(r.supersededVersions).toBe(2);
  });

  it('keep=2 keeps v001 but STILL drops its patch, because v002 is newer', () => {
    // The judgement call, asserted. Retaining an older full version does not
    // resurrect a patch that a newer full re-render has already absorbed.
    const v001 = full(1, 1000);
    const p001 = patch(1, 100, 30);
    const v002 = full(2, 2000);
    const a = asset(v001, p001, v002);

    const r = computeReclaim([a], 2);
    expect(verdictFor(r, v001).keep).toBe(true);
    expect(verdictFor(r, v002).keep).toBe(true);
    expect(verdictFor(r, p001).keep).toBe(false);
    expect(verdictFor(r, p001).reason).toBe('superseded-patch');
    expect(r.reclaimableBytes).toBe(30);
  });

  it('reproduces the 140_RIVER_INTRO_LL180 shape from the archive', () => {
    // Fulls v001, v002, v006, v007 and a patch at v004 with no full v004.
    // At keep-3 the kept fulls are v002, v006, v007 -- v002 is OLDER than the
    // patch and kept -- yet the patch is still superseded, because v006/v007
    // are newer full re-renders. This is what makes the measured keep-3 figure
    // 5.97 TiB rather than 5.75 TiB.
    const v001 = full(1, 5);
    const v002 = full(2, 383);
    const p004 = patch(4, 0, 225);
    const v006 = full(6, 312);
    const v007 = full(7, 312);
    const a = asset(v001, v002, p004, v006, v007);

    for (const keepN of [1, 2, 3]) {
      const r = computeReclaim([a], keepN);
      expect(verdictFor(r, p004).keep, `keepN=${keepN}`).toBe(false);
      expect(verdictFor(r, p004).reason, `keepN=${keepN}`).toBe('superseded-patch');
    }

    // At keep=3, v002/v006/v007 survive; v001 and the patch do not.
    const r3 = computeReclaim([a], 3);
    expect(verdictFor(r3, v002).keep).toBe(true);
    expect(verdictFor(r3, v001).keep).toBe(false);
    expect(r3.reclaimableBytes).toBe(5 + 225);
    expect(r3.protectedPatchBytes).toBe(0);
  });

  it('a patch at the latest full version is protected', () => {
    const v002 = full(2, 1000);
    const p002 = patch(2, 50, 40);
    const r = computeReclaim([asset(v002, p002)], 1);
    expect(verdictFor(r, p002).keep).toBe(true);
    expect(verdictFor(r, p002).reason).toBe('kept-patch-of-latest-full');
    expect(r.protectedPatchBytes).toBe(40);
  });

  it('a patch between two fulls is dropped at every N', () => {
    // Fulls at v001 and v004; a stray patch at v002 with no full v002.
    const v001 = full(1, 1000);
    const p002 = patch(2, 50, 40);
    const v004 = full(4, 4000);
    const a = asset(v001, p002, v004);

    for (const keepN of [1, 2, 3]) {
      const r = computeReclaim([a], keepN);
      expect(verdictFor(r, p002).keep, `keepN=${keepN}`).toBe(false);
    }
    expect(computeReclaim([a], 1).reclaimableBytes).toBe(1040);
    expect(computeReclaim([a], 2).reclaimableBytes).toBe(40);
  });
});

describe('protected patch bytes are constant across keep-N', () => {
  it('the same newer-than-latest-full patches are protected at every N', () => {
    const a = asset(full(1, 1000), full(2, 2000), full(3, 3000), patch(4, 10, 77));
    const totals = [1, 2, 3].map((n) => computeReclaim([a], n).protectedPatchBytes);
    expect(totals).toEqual([77, 77, 77]);
  });
});

describe('sub-revision letters create SEPARATE versions', () => {
  // A lettered revision is a later refinement of the numbered render, so
  // `v002`, `v002d` and `v002f` are three versions ordered
  // v002 < v002a < v002d < v002f < v003, with the bare form FIRST.
  it('two letters at the same number are two versions, newest letter wins', () => {
    const v002d = full(2, 1000, 'd');
    const v002f = full(2, 2000, 'f');
    const r = computeReclaim([asset(v002d, v002f)], 1);
    expect(verdictFor(r, v002f).keep).toBe(true);
    expect(verdictFor(r, v002d).keep).toBe(false);
    expect(verdictFor(r, v002d).reason).toBe('superseded-full');
    expect(r.reclaimableBytes).toBe(1000);
  });

  it('the bare version sorts FIRST, before any letter at the same number', () => {
    const v002 = full(2, 500);
    const v002a = full(2, 1000, 'a');
    const v002d = full(2, 2000, 'd');
    const r = computeReclaim([asset(v002, v002a, v002d)], 1);
    // v002d is newest; the bare v002 is the oldest of the three.
    expect(verdictFor(r, v002d).keep).toBe(true);
    expect(verdictFor(r, v002a).keep).toBe(false);
    expect(verdictFor(r, v002).keep).toBe(false);
    expect(r.reclaimableBytes).toBe(1500);
  });

  it('lettered versions occupy their own slots in the keep-N window', () => {
    const v002 = full(2, 500);
    const v002d = full(2, 1000, 'd');
    const v002f = full(2, 2000, 'f');
    // keep 2 retains v002d and v002f, dropping only the bare v002.
    const r = computeReclaim([asset(v002, v002d, v002f)], 2);
    expect(verdictFor(r, v002f).keep).toBe(true);
    expect(verdictFor(r, v002d).keep).toBe(true);
    expect(verdictFor(r, v002).keep).toBe(false);
    expect(r.reclaimableBytes).toBe(500);
    expect(r.supersededVersions).toBe(1);
  });

  it('a higher number still beats any letter below it', () => {
    const v002f = full(2, 1000, 'f');
    const v003 = full(3, 2000);
    const r = computeReclaim([asset(v002f, v003)], 1);
    expect(verdictFor(r, v002f).keep).toBe(false);
    expect(verdictFor(r, v003).keep).toBe(true);
  });

  it('compareVersions orders v002 < v002a < v002d < v002f < v003', () => {
    const v = (verNum: number, subLetter: string | null = null) => ({ verNum, subLetter });
    const shuffled = [v(3), v(2, 'f'), v(2), v(2, 'd'), v(2, 'a')];
    const sorted = [...shuffled].sort(compareVersions);
    expect(sorted).toEqual([v(2), v(2, 'a'), v(2, 'd'), v(2, 'f'), v(3)]);
  });

  it('a patch is superseded by a newer LETTER at the same number', () => {
    // The patch rule is unchanged: kept iff no kept full version is newer.
    const v002d = full(2, 1000, 'd');
    const p002 = patch(2, 50, 40, 'd');
    const v002f = full(2, 2000, 'f');
    const r = computeReclaim([asset(v002d, p002, v002f)], 1);
    expect(verdictFor(r, p002).keep).toBe(false);
    expect(verdictFor(r, p002).reason).toBe('superseded-patch');
  });
});

describe('derive keeps sub-letters as distinct version rows', () => {
  const deriveNames = async (songFolder: string, names: string[], size = 100) => {
    const { deriveAssets } = await import('../src/scan/derive.ts');
    const { makeParser } = await import('../src/scan/parse.ts');
    const parse = makeParser();
    const files = names.map((name) => ({
      relPath: `${songFolder}/${name}`,
      songFolder,
      name,
      ext: 'mov',
      size,
      mtime: 1,
    }));
    return deriveAssets(files, files.map((f) => parse(f.name)), {});
  };

  it('v002d and v002f become TWO version rows, not one summed row', async () => {
    const { assets } = await deriveNames('170_EMBER', [
      'X_LL180_v002d_region1.mov',
      'X_LL180_v002f_region1.mov',
    ]);

    expect(assets).toHaveLength(1);
    expect(assets[0]!.versions).toHaveLength(2);
    expect(assets[0]!.versions.map((v) => v.subLetter)).toEqual(['d', 'f']);
    for (const v of assets[0]!.versions) {
      expect(v).toMatchObject({ verNum: 2, bytes: 100, fileCount: 1 });
    }
  });

  it('a bare v001 alongside v001d is TWO versions, bare one first', async () => {
    const { assets } = await deriveNames(
      '110_TURBINE',
      ['X_LL180_v001_region1.mov', 'X_LL180_v001d.mov'],
      50,
    );

    expect(assets[0]!.versions).toHaveLength(2);
    expect(assets[0]!.versions.map((v) => v.subLetter)).toEqual([null, 'd']);
    // The region-less v001d contributes no region; the bare v001 has one.
    expect(assets[0]!.versions[0]).toMatchObject({ verNum: 1, bytes: 50, regionCount: 1 });
    expect(assets[0]!.versions[1]).toMatchObject({ verNum: 1, bytes: 50, regionCount: 0 });
  });

  it('regions of ONE lettered version still roll up into a single row', async () => {
    const { assets } = await deriveNames('170_EMBER', [
      'X_LL180_v002d_region1.mov',
      'X_LL180_v002d_region2.mov',
      'X_LL180_v002d_proxy3_region0.mov',
    ]);

    expect(assets[0]!.versions).toHaveLength(1);
    expect(assets[0]!.versions[0]).toMatchObject({
      verNum: 2,
      subLetter: 'd',
      bytes: 300,
      fileCount: 3,
      proxyBytes: 100,
      regionCount: 2,
    });
  });

  it('a patch stays a SEPARATE row from the full version of the same number', async () => {
    const { assets } = await deriveNames(
      '250_HARBOR',
      ['X_LL180_v003_region1.mov', 'X_LL180_v003_frame05259_region1.mov'],
      70,
    );

    expect(assets[0]!.versions).toHaveLength(2);
    expect(assets[0]!.versions.map((v) => v.isPatch)).toEqual([false, true]);
  });
});

describe('degenerate cases', () => {
  it('an asset with only patches keeps everything', () => {
    const p1 = patch(1, 10, 5);
    const p2 = patch(2, 20, 5);
    const r = computeReclaim([asset(p1, p2)], 1);
    expect(r.reclaimableBytes).toBe(0);
    expect(verdictFor(r, p1).reason).toBe('kept-no-full-versions');
    expect(verdictFor(r, p2).reason).toBe('kept-no-full-versions');
  });

  it('keepN larger than the number of full versions reclaims nothing', () => {
    const r = computeReclaim([asset(full(1, 10), full(2, 20))], 99);
    expect(r.reclaimableBytes).toBe(0);
  });

  it('rejects keepN below 1', () => {
    expect(() => computeReclaim([], 0)).toThrow(/keepN/);
    expect(() => computeReclaim([], -1)).toThrow(/keepN/);
    expect(() => computeReclaim([], 1.5)).toThrow(/keepN/);
  });

  describe('rule 3b: a kept patch always keeps its base full', () => {
    // CONFIRMED BY THE USER: "v004 and a v005 patch are both needed. A v006
    // replaces v004 and the v005 patch." A patch layers on the newest full
    // BELOW it; the two are only playable together.
    //
    // The guarantee is structural (see the proof in reclaim.ts) so these tests
    // add no behaviour -- they exist to fail loudly if rule 3 is ever changed
    // to key patches off their own version number instead of the kept fulls.

    /** The newest full at or below `p` -- the version a patch layers onto. */
    const baseOf = (a: ReclaimAssetInput, p: ReclaimVersionInput) =>
      a.versions
        .filter((v) => !v.isPatch && compareVersions(v, p) <= 0)
        .sort(compareVersions)
        .at(-1);

    it('keeps v004 when the v005 patch above it is kept', () => {
      const v004 = full(4, 1000);
      const p005 = patch(5, 12, 40);
      const a = asset(v004, p005);
      const r = computeReclaim([a], 1);

      expect(verdictFor(r, p005).keep).toBe(true);
      expect(baseOf(a, p005)).toBe(v004);
      expect(verdictFor(r, v004).keep).toBe(true);
      expect(r.reclaimableBytes).toBe(0);
    });

    it('v006 replaces both v004 and the v005 patch', () => {
      const v004 = full(4, 1000);
      const p005 = patch(5, 12, 40);
      const v006 = full(6, 2000);
      const r = computeReclaim([asset(v004, p005, v006)], 1);

      expect(verdictFor(r, v006).keep).toBe(true);
      expect(verdictFor(r, v004).keep).toBe(false);
      expect(verdictFor(r, p005).keep).toBe(false);
      expect(verdictFor(r, p005).reason).toBe('superseded-patch');
      expect(r.reclaimableBytes).toBe(1040);
    });

    it('holds for every keepN across a ladder of fulls and stacked patches', () => {
      // The 440_PRISM_LL180 shape: fulls v015/v018, patches v019/v020/v021.
      const a = asset(
        full(15, 500),
        full(18, 800),
        patch(19, 0, 10),
        patch(20, 5923, 197),
        patch(21, 6131, 5),
      );
      for (const keepN of [1, 2, 3, 4]) {
        const r = computeReclaim([a], keepN);
        const byId = new Map(r.verdicts.map((v) => [v.versionId, v]));
        for (const p of a.versions.filter((v) => v.isPatch)) {
          if (!byId.get(p.id)?.keep) continue;
          const base = baseOf(a, p);
          expect(base, `keepN=${keepN}: patch has no base full`).toBeDefined();
          expect(
            byId.get((base as ReclaimVersionInput).id)?.keep,
            `keepN=${keepN}: patch kept but its base full was dropped`,
          ).toBe(true);
        }
      }
    });

    it('a patch below the latest full is dropped, so no base is pinned', () => {
      // 140_RIVER_INTRO_LL180: fulls v002/v006/v007, patch v004 layering on v002.
      // v006 and v007 are newer full re-renders, so the patch goes -- and with
      // it any obligation to retain v002.
      const v002 = full(2, 100);
      const p004 = patch(4, 1, 225);
      const v006 = full(6, 300);
      const v007 = full(7, 400);
      const r = computeReclaim([asset(v002, p004, v006, v007)], 1);
      expect(verdictFor(r, p004).keep).toBe(false);
      expect(verdictFor(r, v002).keep).toBe(false);
    });
  });

  it('proxy bytes ride along with their version and are reported separately', () => {
    const v001: ReclaimVersionInput = {
      id: nextId++,
      verNum: 1,
      subLetter: null,
      isPatch: false,
      patchFrame: null,
      bytes: 1000,
      proxyBytes: 100,
      fileCount: 2,
      regionCount: 14,
    };
    const v002 = full(2, 2000);
    const r = computeReclaim([asset(v001, v002)], 1);
    expect(r.reclaimableBytes).toBe(1000);
    expect(r.reclaimableProxyBytes).toBe(100);
  });

  it('monotonicity: a larger keepN never reclaims more', () => {
    const a = asset(full(1, 100), full(2, 200), full(3, 300), full(4, 400), patch(5, 1, 9));
    const values = [1, 2, 3, 4, 5].map((n) => computeReclaim([a], n).reclaimableBytes);
    for (let i = 1; i < values.length; i++) {
      expect(values[i] as number).toBeLessThanOrEqual(values[i - 1] as number);
    }
  });
});

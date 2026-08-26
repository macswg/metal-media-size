/**
 * THE PROXY-ONLY RULE.
 *
 * A version with no region files is a low-res whole-canvas preview and
 * nothing else. It is not a delivery of the asset and must never be treated as
 * a replacement for one.
 *
 * This file is the sibling of `patch-rule.test.ts`. It exists because the
 * policy once ranked previews alongside masters, and on the real archive that
 * marked 85 region-bearing versions -- 3.86 TiB, 3.17 TiB of it the LAST
 * full-resolution copy of its asset -- as superseded by a preview. The
 * archive has no backup. Do not relax these.
 */

import { describe, it, expect } from 'vitest';
import { computeReclaim, type ReclaimAssetInput, type ReclaimVersionInput } from '../src/scan/reclaim.ts';

let nextId = 1;

/** A real delivery: 14 regions plus a proxy. */
function master(verNum: number, bytes: number, sub: string | null = null): ReclaimVersionInput {
  return {
    id: nextId++,
    verNum,
    subLetter: sub,
    isPatch: false,
    patchFrame: null,
    bytes,
    proxyBytes: Math.floor(bytes / 100),
    fileCount: 15,
    regionCount: 14,
  };
}

/** A preview and nothing else: one `proxy3_region0` file, no regions. */
function preview(verNum: number, bytes: number, sub: string | null = null): ReclaimVersionInput {
  return {
    id: nextId++,
    verNum,
    subLetter: sub,
    isPatch: false,
    patchFrame: null,
    bytes,
    proxyBytes: bytes,
    fileCount: 1,
    regionCount: 0,
  };
}

function patch(verNum: number, frame: number, bytes: number): ReclaimVersionInput {
  return {
    id: nextId++,
    verNum,
    subLetter: null,
    isPatch: true,
    patchFrame: frame,
    bytes,
    proxyBytes: 0,
    fileCount: 15,
    regionCount: 14,
  };
}

function asset(...versions: ReclaimVersionInput[]): ReclaimAssetInput {
  return { id: nextId++, songFolder: '580_CAUSEWAY', base: 'TEST_ASSET', versions };
}

function verdictFor(result: ReturnType<typeof computeReclaim>, v: ReclaimVersionInput) {
  const found = result.verdicts.find((x) => x.versionId === v.id);
  if (!found) throw new Error(`no verdict for version ${v.id}`);
  return found;
}

describe('a preview never supersedes a master', () => {
  it('the 580_CAUSEWAY_0000A_LL180 case: a preview above the only master keeps the master', () => {
    // v002: 15 files, 475 GiB of masters. v003: a single 1.5 GiB proxy.
    // The policy once proposed deleting v002 and retaining v003.
    const v002 = master(2, 510_447_402_940);
    const v003 = preview(3, 1_527_861_757);
    const r = computeReclaim([asset(v002, v003)], 1);

    expect(verdictFor(r, v002).keep).toBe(true);
    expect(verdictFor(r, v002).reason).toBe('kept-full-latest');
    expect(verdictFor(r, v003).keep).toBe(true);
    expect(verdictFor(r, v003).reason).toBe('kept-proxy-only-newer-than-latest-full');
    expect(r.reclaimableBytes).toBe(0);
  });

  it('a preview does not consume a slot in the keep-N window', () => {
    // Three masters and a preview on top. At keep-1 the newest MASTER is kept,
    // not the preview -- the preview must not push v003 out.
    const v001 = master(1, 100);
    const v002 = master(2, 200);
    const v003 = master(3, 300);
    const v004 = preview(4, 5);
    const r = computeReclaim([asset(v001, v002, v003, v004)], 1);

    expect(verdictFor(r, v003).keep).toBe(true);
    expect(verdictFor(r, v004).keep).toBe(true);
    expect(verdictFor(r, v001).keep).toBe(false);
    expect(verdictFor(r, v002).keep).toBe(false);
    expect(r.reclaimableBytes).toBe(300);
  });

  it('several previews stacked above a master still cannot supersede it', () => {
    const v002 = master(2, 1000);
    const p3 = preview(3, 5);
    const p4 = preview(4, 6);
    const p5 = preview(5, 7);
    const r = computeReclaim([asset(v002, p3, p4, p5)], 1);

    expect(verdictFor(r, v002).keep).toBe(true);
    for (const p of [p3, p4, p5]) expect(verdictFor(r, p).keep).toBe(true);
    expect(r.reclaimableBytes).toBe(0);
  });

  it('a sub-lettered preview cannot supersede a master either', () => {
    const v002 = master(2, 1000);
    const v002f = preview(2, 5, 'f');
    const r = computeReclaim([asset(v002, v002f)], 1);

    expect(verdictFor(r, v002).keep).toBe(true);
    expect(verdictFor(r, v002f).keep).toBe(true);
    expect(r.reclaimableBytes).toBe(0);
  });
});

describe('a stale preview below a kept master is still reclaimable', () => {
  it('the 140_RIVER_MARCHERS_LL180 shape: previews interleaved with masters', () => {
    // Previews at v001 and v006, masters at v003, v007, v008, v009.
    const p001 = preview(1, 288_926_890);
    const v003 = master(3, 19_006_476_511);
    const p006 = preview(6, 400_803_020);
    const v007 = master(7, 18_058_498_206);
    const v009 = master(9, 16_925_286_258);
    const r = computeReclaim([asset(p001, v003, p006, v007, v009)], 1);

    // v009 is the kept master; everything below it goes, previews included.
    expect(verdictFor(r, v009).keep).toBe(true);
    expect(verdictFor(r, p001).keep).toBe(false);
    expect(verdictFor(r, p001).reason).toBe('superseded-proxy-only');
    expect(verdictFor(r, p006).keep).toBe(false);
    expect(verdictFor(r, p006).reason).toBe('superseded-proxy-only');
    expect(verdictFor(r, v003).keep).toBe(false);
    expect(verdictFor(r, v007).keep).toBe(false);
  });

  it('a preview is kept once the master that overtook it leaves the keep window', () => {
    const p003 = preview(3, 50);
    const v004 = master(4, 1000);
    // keep-1 keeps v004, which is newer than the preview: preview goes.
    expect(verdictFor(computeReclaim([asset(p003, v004)], 1), p003).keep).toBe(false);

    // With only older masters kept, nothing newer than the preview survives...
    const p009 = preview(9, 50);
    const v004b = master(4, 1000);
    expect(verdictFor(computeReclaim([asset(v004b, p009)], 1), p009).keep).toBe(true);
  });
});

describe('an asset that is nothing but previews ranks them normally', () => {
  it('previews supersede each other when there is no master to protect', () => {
    // No region-bearing version exists, so the previews ARE the deliverable.
    // Leaving them out of the line-up would forfeit real reclaim to protect
    // nothing.
    const p1 = preview(1, 100);
    const p2 = preview(2, 200);
    const p3 = preview(3, 300);
    const r = computeReclaim([asset(p1, p2, p3)], 1);

    expect(verdictFor(r, p3).keep).toBe(true);
    expect(verdictFor(r, p3).reason).toBe('kept-full-latest');
    expect(verdictFor(r, p1).keep).toBe(false);
    expect(verdictFor(r, p2).keep).toBe(false);
    expect(r.reclaimableBytes).toBe(300);
  });

  it('keep-2 on a preview-only asset keeps the two newest previews', () => {
    const p1 = preview(1, 100);
    const p2 = preview(2, 200);
    const p3 = preview(3, 300);
    const r = computeReclaim([asset(p1, p2, p3)], 2);
    expect(verdictFor(r, p1).keep).toBe(false);
    expect(verdictFor(r, p2).keep).toBe(true);
    expect(verdictFor(r, p3).keep).toBe(true);
  });

  it('one master appearing later takes the previews back out of the ranking', () => {
    const p1 = preview(1, 100);
    const p2 = preview(2, 200);
    const v3 = master(3, 5000);
    const r = computeReclaim([asset(p1, p2, v3)], 1);
    // Now a master exists, so previews leave the line-up and are settled
    // against it instead.
    expect(verdictFor(r, v3).keep).toBe(true);
    expect(verdictFor(r, p1).reason).toBe('superseded-proxy-only');
    expect(verdictFor(r, p2).reason).toBe('superseded-proxy-only');
  });
});

describe('the rule composes with the patch rule', () => {
  it('a preview does not protect a patch, and a patch does not protect a preview', () => {
    const v002 = master(2, 1000);
    const p004 = patch(4, 100, 40);
    const prev005 = preview(5, 9);
    const r = computeReclaim([asset(v002, p004, prev005)], 1);

    // Latest master is v002; both the patch and the preview sit above it.
    expect(verdictFor(r, v002).keep).toBe(true);
    expect(verdictFor(r, p004).keep).toBe(true);
    expect(verdictFor(r, prev005).keep).toBe(true);
    expect(r.reclaimableBytes).toBe(0);
  });

  it('preview protection, like patch protection, does not depend on keepN', () => {
    const a = asset(master(1, 100), master(2, 200), master(3, 300), preview(4, 7));
    const kept = [1, 2, 3, 4].map((n) => {
      const r = computeReclaim([a], n);
      return r.verdicts.filter((v) => v.reason === 'kept-proxy-only-newer-than-latest-full').length;
    });
    expect(kept).toEqual([1, 1, 1, 1]);
  });

  it('monotonicity still holds with previews in the mix', () => {
    const a = asset(master(1, 100), preview(2, 5), master(3, 300), preview(4, 6), master(5, 500));
    const values = [1, 2, 3, 4, 5].map((n) => computeReclaim([a], n).reclaimableBytes);
    for (let i = 1; i < values.length; i++) {
      expect(values[i] as number).toBeLessThanOrEqual(values[i - 1] as number);
    }
  });
});

describe('the input contract fails safe', () => {
  it('a missing regionCount is read as proxy-only, never as a master', () => {
    // An unplumbed caller must LOSE reclaim, not regain the power to delete
    // masters. Here every version looks like a preview, so the asset falls
    // through to preview-only ranking rather than protecting nothing.
    const bare = (verNum: number, bytes: number) =>
      ({
        id: nextId++,
        verNum,
        subLetter: null,
        isPatch: false,
        patchFrame: null,
        bytes,
        proxyBytes: 0,
        fileCount: 15,
      }) as unknown as ReclaimVersionInput;

    const v1 = bare(1, 100);
    const v2 = master(2, 200);
    const r = computeReclaim([asset(v1, v2)], 1);

    // v2 declares regions, so it goes into the line-up; v1 does not and is
    // left out of it. The
    // unplumbed version is protected, not deleted.
    expect(verdictFor(r, v2).keep).toBe(true);
    expect(verdictFor(r, v1).reason).toBe('superseded-proxy-only');

    // And with the master OLDER than the unplumbed row, nothing is reclaimed.
    const v3 = master(1, 100);
    const v4 = bare(2, 200);
    const r2 = computeReclaim([asset(v3, v4)], 1);
    expect(r2.reclaimableBytes).toBe(0);
  });

  it('a region-bearing version is still ranked when regionCount is 1', () => {
    // The 520_THICKET v003b case has 13 regions, not 14. Any region at all counts.
    const v1 = master(1, 100);
    const v2 = { ...master(2, 200), regionCount: 1 };
    const r = computeReclaim([asset(v1, v2)], 1);
    expect(verdictFor(r, v2).keep).toBe(true);
    expect(verdictFor(r, v1).keep).toBe(false);
    expect(verdictFor(r, v1).reason).toBe('superseded-full');
  });
});

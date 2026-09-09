/**
 * THE PROGRAMMED-MEDIA RULE.
 *
 * A version the show is CUED TO PLAY is not superseded by anything, however
 * many newer renders sit above it. The archive's rules know which version is
 * newest; only the show file knows which one is programmed.
 *
 * This file exists because the gap was real and measured. On snapshot 14, with
 * the capture of 2026-09-08, a keep-1 export named FIVE versions the show was
 * still playing -- 1.25 TiB, including 974.9 GiB of `160_puppets_intro_ll180
 * v002`. Every one of them would have gone into a removal manifest looking
 * exactly like ordinary superseded media.
 *
 * The two properties that make this safe, and that these tests pin:
 *
 *   1. It can ONLY add protection. There is no input that makes a protected
 *      run remove something an unprotected run kept.
 *   2. It does NOT touch ranking. Protecting an old version must not demote a
 *      newer one -- the same class of mistake as filtering computeReclaim's
 *      input, and with the same consequence.
 */

import { describe, it, expect } from 'vitest';
import {
  computeReclaim,
  type ReclaimAssetInput,
  type ReclaimVersionInput,
} from '../src/scan/reclaim.ts';
import {
  normaliseProgrammedName,
  parseProgrammedVersion,
  parseProgrammedCapture,
} from '../src/programmed/parse.ts';
import { resolveProgrammed } from '../src/programmed/protect.ts';

let nextId = 1;

function master(verNum: number, bytes: number, sub: string | null = null): ReclaimVersionInput {
  return {
    id: nextId++,
    verNum,
    subLetter: sub,
    isPatch: false,
    patchFrame: null,
    bytes,
    proxyBytes: 0,
    fileCount: 15,
    regionCount: 14,
  };
}

function asset(base: string, versions: ReclaimVersionInput[], song = 'SONG'): ReclaimAssetInput {
  return { id: nextId++, songFolder: song, base, versions };
}

/** A capture document in the shape the d3 export writes. */
function capture(
  media: Array<{ name: string; version?: string | null }>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    capturedAt: '2026-09-08T20:52:05-07:00',
    project: 'test_project',
    schemaVersion: 7,
    tracks: [
      {
        name: 'a_track',
        layers: media.map((m) => ({
          type: 'VariableVideoModule',
          media: [{ name: m.name, version: m.version === undefined ? '001' : m.version }],
        })),
      },
    ],
    ...extra,
  });
}

describe('normaliseProgrammedName', () => {
  it('lower-cases and strips the container extension', () => {
    expect(normaliseProgrammedName('110_ENGINE_Red_Loop_LL180.mov')).toBe('110_engine_red_loop_ll180');
  });

  it('strips a trailing frame marker written with either separator', () => {
    // Both spellings occur in the real capture.
    expect(normaliseProgrammedName('120_liquid_cue_a_ll180_f755')).toBe('120_liquid_cue_a_ll180');
    expect(normaliseProgrammedName('310_neon_intro_ll180 f726')).toBe('310_neon_intro_ll180');
  });

  it('strips a hand-named trim marker', () => {
    expect(normaliseProgrammedName('640_slot_outro_0000b_ll180 start')).toBe('640_slot_outro_0000b_ll180');
    expect(normaliseProgrammedName('250_seek_venue_a_imag_matte_alpha_ll180 trim')).toBe(
      '250_seek_venue_a_imag_matte_alpha_ll180',
    );
  });

  it('handles an extension in the MIDDLE, which a single fixed-order pass gets wrong', () => {
    // `540_amps_..._ll180.mov hold` is real. Strip the marker first and the
    // extension is exposed; strip the extension first and nothing matches. The
    // normaliser loops to a fixed point precisely so the order cannot matter.
    expect(normaliseProgrammedName('540_amps_chase_front_fill_white_a_1080_loop_ll180.mov hold')).toBe(
      '540_amps_chase_front_fill_white_a_1080_loop_ll180',
    );
  });

  it('leaves an ordinary base untouched', () => {
    expect(normaliseProgrammedName('140_one_soldiers_ll180')).toBe('140_one_soldiers_ll180');
  });
});

describe('parseProgrammedVersion', () => {
  it('ignores leading zeros, which vary WITHIN one real capture', () => {
    expect(parseProgrammedVersion('003')).toEqual({ verNum: 3, subLetter: null });
    expect(parseProgrammedVersion('0003')).toEqual({ verNum: 3, subLetter: null });
  });

  it('keeps the sub-letter, because v002 and v002d are different versions', () => {
    expect(parseProgrammedVersion('005b')).toEqual({ verNum: 5, subLetter: 'b' });
    expect(parseProgrammedVersion('005')).toEqual({ verNum: 5, subLetter: null });
  });

  it('returns null for anything unreadable, so the caller protects the whole asset', () => {
    expect(parseProgrammedVersion(null)).toBeNull();
    expect(parseProgrammedVersion('')).toBeNull();
    expect(parseProgrammedVersion('latest')).toBeNull();
  });
});

describe('parseProgrammedCapture', () => {
  it('reads media off every track and layer', () => {
    const c = parseProgrammedCapture(capture([{ name: 'a_ll180.mov', version: '002' }]), 'f.json');
    expect(c.refs).toHaveLength(1);
    expect(c.refs[0]).toMatchObject({ base: 'a_ll180', verNum: 2, subLetter: null });
    expect(c.capturedAt).toBe('2026-09-08T20:52:05-07:00');
  });

  it('recurses into nested layer groups', () => {
    const doc = JSON.stringify({
      tracks: [
        {
          name: 't',
          layers: [{ layers: [{ media: [{ name: 'deep_ll180.mov', version: '004' }] }] }],
        },
      ],
    });
    expect(parseProgrammedCapture(doc, 'f.json').refs[0]).toMatchObject({ base: 'deep_ll180', verNum: 4 });
  });

  it('THROWS on unreadable JSON rather than reading as an empty list', () => {
    // An empty list and a broken file produce the same protection set. Only one
    // of them means "the show plays nothing".
    expect(() => parseProgrammedCapture('{not json', 'f.json')).toThrow(/not readable JSON/);
  });

  it('THROWS on a document with no tracks array', () => {
    expect(() => parseProgrammedCapture('{"hello":1}', 'f.json')).toThrow(/no "tracks" array/);
  });
});

describe('resolveProgrammed', () => {
  it('protects the exact version named, and only that one', () => {
    const v1 = master(1, 100);
    const v2 = master(2, 200);
    const a = asset('SHOW_CLIP_LL180', [v1, v2]);
    const p = resolveProgrammed([parseProgrammedCapture(capture([{ name: 'show_clip_ll180.mov', version: '001' }]), 'f')], [a]);
    expect([...p.protectedVersionIds]).toEqual([v1.id]);
  });

  it('distinguishes v002 from v002d', () => {
    const plain = master(2, 100);
    const letter = master(2, 100, 'd');
    const a = asset('CLIP_LL180', [plain, letter]);
    const p = resolveProgrammed([parseProgrammedCapture(capture([{ name: 'clip_ll180.mov', version: '002d' }]), 'f')], [a]);
    expect([...p.protectedVersionIds]).toEqual([letter.id]);
  });

  it('protects EVERY version when the capture names no readable version', () => {
    const v1 = master(1, 100);
    const v2 = master(2, 200);
    const a = asset('CLIP_LL180', [v1, v2]);
    const p = resolveProgrammed([parseProgrammedCapture(capture([{ name: 'clip_ll180.mov', version: null }]), 'f')], [a]);
    expect(new Set(p.protectedVersionIds)).toEqual(new Set([v1.id, v2.id]));
    expect(p.wholeAssetIds.has(a.id)).toBe(true);
  });

  it('protects a base in EVERY song folder that carries it', () => {
    // `asset` is unique on (song_folder, base); a capture names only the base.
    // Four bases in the real archive live in two folders each.
    const inTech = master(2, 100);
    const inDome = master(2, 100);
    const p = resolveProgrammed(
      [parseProgrammedCapture(capture([{ name: '999_tech_reticule_ll180.mov', version: '002' }]), 'f')],
      [
        asset('999_TECH_RETICULE_LL180', [inTech], '999_TECH'),
        asset('999_TECH_RETICULE_LL180', [inDome], 'BIGDOME'),
      ],
    );
    expect(new Set(p.protectedVersionIds)).toEqual(new Set([inTech.id, inDome.id]));
  });

  it('REPORTS a name the archive has no asset for, never swallows it', () => {
    const p = resolveProgrammed(
      [parseProgrammedCapture(capture([{ name: 'nothing_here.mov', version: '001' }]), 'f')],
      [asset('OTHER_LL180', [master(1, 10)])],
    );
    expect(p.unmatchedNames.map((u) => u.base)).toEqual(['nothing_here']);
    expect(p.matchedNames).toBe(0);
  });

  it('REPORTS a version the archive has not got, and says what it does have', () => {
    const p = resolveProgrammed(
      [parseProgrammedCapture(capture([{ name: 'clip_ll180.mov', version: '009' }]), 'f')],
      [asset('CLIP_LL180', [master(1, 10), master(2, 10, 'd')])],
    );
    expect(p.unmatchedVersions).toHaveLength(1);
    expect(p.unmatchedVersions[0]).toMatchObject({ rawVersion: '009', archiveHas: ['v001', 'v002d'] });
    expect(p.protectedVersionIds.size).toBe(0);
  });

  it('is NOT usable when nothing resolved, so an export can refuse', () => {
    // An empty protection set is what a capture of a different show produces,
    // and it is byte-for-byte what a correct capture of a show that plays
    // nothing produces. The caller must be able to tell.
    const p = resolveProgrammed(
      [parseProgrammedCapture(capture([{ name: 'nothing_here.mov' }]), 'f')],
      [asset('OTHER_LL180', [master(1, 10)])],
    );
    expect(p.usable).toBe(false);
  });

  it('unions across captures rather than letting the newest win', () => {
    const v1 = master(1, 100);
    const v2 = master(2, 100);
    const a = asset('CLIP_LL180', [v1, v2]);
    const p = resolveProgrammed(
      [
        parseProgrammedCapture(capture([{ name: 'clip_ll180.mov', version: '001' }]), 'old'),
        parseProgrammedCapture(capture([{ name: 'clip_ll180.mov', version: '002' }]), 'new'),
      ],
      [a],
    );
    expect(new Set(p.protectedVersionIds)).toEqual(new Set([v1.id, v2.id]));
  });
});

describe('computeReclaim with protectedVersionIds', () => {
  it('keeps a programmed version that keep-1 would otherwise supersede', () => {
    const v2 = master(2, 1_000);
    const v6 = master(6, 500);
    const a = asset('CLIP_LL180', [v2, v6]);

    const before = computeReclaim([a], 1);
    expect(before.verdicts.find((v) => v.versionId === v2.id)?.keep).toBe(false);

    const after = computeReclaim([a], 1, { protectedVersionIds: new Set([v2.id]) });
    const row = after.verdicts.find((v) => v.versionId === v2.id);
    expect(row?.keep).toBe(true);
    expect(row?.reason).toBe('kept-programmed');
    expect(after.programmedProtectedBytes).toBe(1_000);
    expect(after.programmedProtectedVersions).toBe(1);
  });

  it('DOES NOT push the newest version out: protection takes no keep-N slot', () => {
    // The failure this guards against: protect v002 under keep-1 and have v006
    // -- the current master -- fall out of the window to make room for it.
    const v2 = master(2, 1_000);
    const v6 = master(6, 500);
    const after = computeReclaim([asset('CLIP_LL180', [v2, v6])], 1, {
      protectedVersionIds: new Set([v2.id]),
    });
    expect(after.verdicts.find((v) => v.versionId === v6.id)?.keep).toBe(true);
    expect(after.verdicts.every((v) => v.keep)).toBe(true);
  });

  it('leaves a version that was ALREADY kept with its own, more informative reason', () => {
    const v6 = master(6, 500);
    const after = computeReclaim([asset('CLIP_LL180', [v6])], 1, {
      protectedVersionIds: new Set([v6.id]),
    });
    expect(after.verdicts[0]?.reason).toBe('kept-full-latest');
    // It was never at risk, so it rescued nothing.
    expect(after.programmedProtectedBytes).toBe(0);
  });

  it('can only ADD keeps -- no input makes it remove something', () => {
    // The one-directional property, stated as a property rather than a case.
    const versions = [master(1, 10), master(2, 20), master(3, 30), master(4, 40)];
    const a = asset('CLIP_LL180', versions);
    for (const keepN of [1, 2, 3]) {
      const bare = computeReclaim([a], keepN);
      for (const subset of versions) {
        const guarded = computeReclaim([a], keepN, { protectedVersionIds: new Set([subset.id]) });
        for (const b of bare.verdicts) {
          const g = guarded.verdicts.find((x) => x.versionId === b.versionId);
          if (b.keep) expect(g?.keep).toBe(true);
        }
        expect(guarded.reclaimableBytes).toBeLessThanOrEqual(bare.reclaimableBytes);
      }
    }
  });

  it('protects a patch the patch rule had superseded', () => {
    // A programmed patch is still programmed. Nothing about rule 3 exempts it.
    const patch = { ...master(3, 100), isPatch: true, patchFrame: 5259 };
    const v6 = master(6, 500);
    const a = asset('CLIP_LL180', [patch, v6]);
    expect(computeReclaim([a], 1).verdicts.find((v) => v.versionId === patch.id)?.keep).toBe(false);
    const after = computeReclaim([a], 1, { protectedVersionIds: new Set([patch.id]) });
    expect(after.verdicts.find((v) => v.versionId === patch.id)?.reason).toBe('kept-programmed');
  });

  it('reports zero protection when no ids are supplied at all', () => {
    const after = computeReclaim([asset('CLIP_LL180', [master(1, 10), master(2, 10)])], 1);
    expect(after.programmedProtectedBytes).toBe(0);
    expect(after.programmedProtectedVersions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Through the API, because the guarantee is "no route can forget this" and
// that is a statement about the server, not about computeReclaim.
// ---------------------------------------------------------------------------

describe('/api/reclaim reports the cross-check status', () => {
  it('returns programmed: null when NO capture is loaded', async () => {
    const { makeFixture } = await import('./server/fixture.ts');
    const { buildServer } = await import('../src/server/app.ts');
    const fx = makeFixture();
    const { app } = buildServer({ db: fx.db, cfg: fx.cfg });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/reclaim?keepN=1' });
    const body = res.json();
    // Null is a REPORTABLE STATE. It is what the UI keys its "not
    // cross-checked" warning on, and it must never be confused with a capture
    // that protected nothing -- the reclaim figures are identical either way.
    expect(body.programmed).toBeNull();
    expect(body.programmedBytes).toBe(0);
    await app.close();
    fx.db.close();
  });

  it('holds back a programmed version and says so in the same response', async () => {
    const { makeFixture } = await import('./server/fixture.ts');
    const { buildServer } = await import('../src/server/app.ts');
    const fx = makeFixture();

    const bare = buildServer({ db: fx.db, cfg: fx.cfg });
    await bare.app.ready();
    const before = (await bare.app.inject({ method: 'GET', url: '/api/reclaim?keepN=1' })).json();
    await bare.app.close();

    // `100_ALPHA_MAIN_LL180 v001` is superseded at keep-1 in the fixture.
    const cap = parseProgrammedCapture(
      capture([{ name: '100_alpha_main_ll180.mov', version: '001' }]),
      'susan.json',
    );
    const guarded = buildServer({ db: fx.db, cfg: fx.cfg, captures: [cap] });
    await guarded.app.ready();
    const after = (await guarded.app.inject({ method: 'GET', url: '/api/reclaim?keepN=1' })).json();

    expect(after.programmed).not.toBeNull();
    expect(after.programmed.usable).toBe(true);
    expect(after.programmed.captures[0].sourceFile).toBe('susan.json');
    expect(after.programmed.captures[0].capturedAt).toBe('2026-09-08T20:52:05-07:00');
    expect(after.programmedCount).toBeGreaterThan(0);
    expect(after.reclaimBytes).toBeLessThan(before.reclaimBytes);
    // Held back, not lost: what leaves the reclaim total arrives in kept.
    expect(after.keptBytes).toBe(before.keptBytes + after.programmedBytes);
    expect(after.reclaimBytes).toBe(before.reclaimBytes - after.programmedBytes);

    await guarded.app.close();
    fx.db.close();
  });

  it('reports usable: false for a capture that matched nothing here', async () => {
    const { makeFixture } = await import('./server/fixture.ts');
    const { buildServer } = await import('../src/server/app.ts');
    const fx = makeFixture();
    const cap = parseProgrammedCapture(
      capture([{ name: 'a_completely_different_show.mov', version: '001' }]),
      'wrong-show.json',
    );
    const { app } = buildServer({ db: fx.db, cfg: fx.cfg, captures: [cap] });
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: '/api/reclaim?keepN=1' })).json();
    // Not null -- a capture IS loaded -- but it protected nothing, which is a
    // third state and gets its own warning rather than reading as healthy.
    expect(body.programmed).not.toBeNull();
    expect(body.programmed.usable).toBe(false);
    expect(body.programmed.matchedNames).toBe(0);
    await app.close();
    fx.db.close();
  });

  it('marks the held-back version kept-programmed on /api/versions', async () => {
    const { makeFixture } = await import('./server/fixture.ts');
    const { buildServer } = await import('../src/server/app.ts');
    const fx = makeFixture();
    const cap = parseProgrammedCapture(
      capture([{ name: '100_alpha_main_ll180.mov', version: '001' }]),
      'susan.json',
    );
    const { app } = buildServer({ db: fx.db, cfg: fx.cfg, captures: [cap] });
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: '/api/versions?keepN=1&limit=200' })).json();
    const row = body.rows.find(
      (r: { base: string; verLabel: string }) =>
        r.base === '100_ALPHA_MAIN_LL180' && r.verLabel === 'v001',
    );
    // Every route reads its verdict from the same cache, so the table agrees
    // with the board without either being told about the other.
    expect(row.status).toBe('kept');
    expect(row.keepReason).toBe('kept-programmed');
    await app.close();
    fx.db.close();
  });
});

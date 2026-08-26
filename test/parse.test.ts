import { describe, it, expect } from 'vitest';
import { parseName, makeParser, familyOf, extensionOf, DEFAULT_PATTERN } from '../src/scan/parse.ts';

function ok(name: string) {
  const r = parseName(name);
  if (!r.ok) throw new Error(`expected ${name} to parse, got: ${r.reason}`);
  return r;
}

describe('parseName - real examples from the archive', () => {
  it('plain region file', () => {
    expect(ok('140_RIVER_ANIMATIC_LL180_v008_region1.mov')).toMatchObject({
      base: '140_RIVER_ANIMATIC_LL180',
      ver: 8,
      verRaw: '008',
      sub: null,
      isPatch: false,
      patchFrame: null,
      isProxy: false,
      region: 1,
      ext: 'mov',
    });
  });

  it('proxy file on region0', () => {
    expect(ok('140_RIVER_ANIMATIC_IMAG_LL180_v007_proxy3_region0.mov')).toMatchObject({
      base: '140_RIVER_ANIMATIC_IMAG_LL180',
      ver: 7,
      isProxy: true,
      proxyLevel: 3,
      region: 0,
      isPatch: false,
    });
  });

  it('frame patch', () => {
    expect(ok('250_HARBOR_ANIMATIC_A_LL180_v003_frame05259_region11.mov')).toMatchObject({
      base: '250_HARBOR_ANIMATIC_A_LL180',
      ver: 3,
      sub: null,
      isPatch: true,
      patchFrame: 5259,
      isProxy: false,
      region: 11,
    });
  });

  it('region-less file', () => {
    expect(ok('880_IMAG_CAM_A_EDIT_RECT_v001.mov')).toMatchObject({
      base: '880_IMAG_CAM_A_EDIT_RECT',
      ver: 1,
      sub: null,
      isPatch: false,
      isProxy: false,
      region: null,
    });
  });

  it('letter sub-revision, region-less', () => {
    expect(ok('170_EMBER_FRAME_04_LL180_v001d.mov')).toMatchObject({
      base: '170_EMBER_FRAME_04_LL180',
      ver: 1,
      sub: 'd',
      isPatch: false,
      region: null,
    });
  });
});

describe('parseName - edge cases', () => {
  it('keeps base VERBATIM: prefix-sharing bases stay distinct', () => {
    const a = ok('140_RIVER_ANIMATIC_LL180_v008_region1.mov');
    const b = ok('140_RIVER_ANIMATIC_IMAG_LL180_v007_region1.mov');
    expect(a.base).toBe('140_RIVER_ANIMATIC_LL180');
    expect(b.base).toBe('140_RIVER_ANIMATIC_IMAG_LL180');
    expect(a.base).not.toBe(b.base);
  });

  it('does not lowercase or normalise the base', () => {
    expect(ok('AbC_MiXeD_Case_v002_region3.mov').base).toBe('AbC_MiXeD_Case');
  });

  it('the lazy base does not swallow a FRAME token inside the base name', () => {
    // `FRAME` appears in the base; the real patch marker is `_frameNNNNN`
    // AFTER the version. This name has no patch.
    const r = ok('170_EMBER_FRAME_04_LL180_v001d.mov');
    expect(r.isPatch).toBe(false);
    expect(r.base).toContain('FRAME');
  });

  it('handles both _frame05259 and _frame_05259 spellings', () => {
    expect(ok('X_v001_frame05259_region1.mov').patchFrame).toBe(5259);
    expect(ok('X_v001_frame_05259_region1.mov').patchFrame).toBe(5259);
  });

  it('handles patch + proxy together', () => {
    const r = ok('X_v004_frame00120_proxy3_region0.mov');
    expect(r).toMatchObject({ ver: 4, isPatch: true, patchFrame: 120, isProxy: true, region: 0 });
  });

  it('handles letter sub-revision with a region', () => {
    expect(ok('X_LL180_v012a_region14.mov')).toMatchObject({ ver: 12, sub: 'a', region: 14 });
  });

  it('is case-insensitive on the V and region tokens', () => {
    expect(ok('X_V008_REGION2.mov')).toMatchObject({ ver: 8, region: 2 });
  });

  it('preserves zero padding in verRaw while ver is numeric', () => {
    const r = ok('X_v008_region1.mov');
    expect(r.verRaw).toBe('008');
    expect(r.ver).toBe(8);
  });

  it('parses all region numbers 0..14', () => {
    for (let n = 0; n <= 14; n++) {
      expect(ok(`X_LL180_v001_region${n}.mov`).region).toBe(n);
    }
  });

  it('lowercases the sub letter for stable grouping', () => {
    expect(ok('X_v001D.mov').sub).toBe('d');
  });
});

describe('parseName - unparsed results, never throws', () => {
  const bad = [
    'README.txt',
    'no_version_here_region1.mov',
    '.DS_Store',
    'X_vABC_region1.mov',
    'X_v001_region1.mp4',
    '_v001_region1.mov', // empty base
    '',
  ];

  for (const name of bad) {
    it(`returns ok:false for ${JSON.stringify(name)} without throwing`, () => {
      const r = parseName(name);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.name).toBe(name);
        expect(typeof r.reason).toBe('string');
      }
    });
  }

  it('a bare version with no base is rejected rather than producing an empty asset', () => {
    const r = parseName('_v001_region1.mov');
    expect(r.ok).toBe(false);
  });
});

describe('extensionOf', () => {
  it('lowercases and strips the dot', () => {
    expect(extensionOf('A.MOV')).toBe('mov');
    expect(extensionOf('a.b.mov')).toBe('mov');
  });
  it('returns empty for dotfiles and extension-less names', () => {
    expect(extensionOf('.DS_Store')).toBe('');
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });
});

describe('makeParser honours a configured pattern', () => {
  it('the default pattern string round-trips through makeParser', () => {
    const p = makeParser(DEFAULT_PATTERN, 'i');
    expect(p('140_RIVER_ANIMATIC_LL180_v008_region1.mov').ok).toBe(true);
  });
});

describe('familyOf - display label only', () => {
  const families = {
    ANIMATIC: ['ANIMATIC'],
    FULL: ['FULL', 'FINAL'],
    VENUE: ['VENUE', 'IMAG', 'LL180'],
    CHOR: ['CHOR'],
  };

  it('labels by token, not substring', () => {
    expect(familyOf('140_RIVER_ANIMATIC_LL180', families)).toBe('ANIMATIC');
    expect(familyOf('880_IMAG_CAM_A_EDIT_RECT', families)).toBe('VENUE');
  });

  it('falls back to OTHER', () => {
    expect(familyOf('999_MYSTERY_THING', families)).toBe('OTHER');
  });

  it('the SHIPPED config labels the screen token LL180, not VENUE', async () => {
    // The families above are a synthetic fixture for the matching mechanism.
    // This case pins the real config, which is the thing that decides what
    // 1,483 assets are labelled in the UI.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const cfg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../config/d3-delivery.json', import.meta.url)), 'utf8'),
    ) as { families: Record<string, string[]>; defaultFamily: string };
    const label = (base: string) => familyOf(base, cfg.families, cfg.defaultFamily);

    // VENUE was a near-constant: it matched on LL180, the screen token nearly
    // every deliverable carries, so it named the format rather than the venue.
    expect(Object.keys(cfg.families)).not.toContain('VENUE');
    expect(label('160_TOWER_C4D_SCENE_CB_LL180')).toBe('LL180');

    // ANIMATIC and FULL are listed first and still win when both tokens are
    // present -- reordering the config would silently move assets between
    // families, so the precedence is asserted, not assumed.
    expect(label('140_RIVER_ANIMATIC_LL180')).toBe('ANIMATIC');
    expect(label('280_MERIDIAN_FULL_MAIN_LL180')).toBe('FULL');

    // IMAG is its own family, and sits ABOVE LL180 so an IMAG deliverable is
    // labelled by its CONTENT rather than by the screen token it also carries.
    expect(label('880_IMAG_CAM_A_EDIT_RECT')).toBe('IMAG');
    expect(label('510_QUARRY_EXPOSITION_0000A_IMAG_MATTE_LL180')).toBe('IMAG');

    // ...but ANIMATIC still outranks IMAG, so the pair CLAUDE.md warns about
    // stays split by base, not merged by family.
    expect(label('140_RIVER_ANIMATIC_IMAG_LL180')).toBe('ANIMATIC');
  });

  it('does not match a token that is merely a substring of another token', () => {
    // ANIMATICS (plural) is a different token and must not match ANIMATIC.
    expect(familyOf('140_RIVER_ANIMATICS', { ANIMATIC: ['ANIMATIC'] })).toBe('OTHER');
  });
});

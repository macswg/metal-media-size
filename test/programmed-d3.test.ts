/**
 * Reading a d3 project archive (`.d3`) as a show capture, and the filters and
 * drill-down built on where each version is programmed.
 *
 * The real-archive cases run against whatever is in
 * `programmed_media_crosscheck/` -- a local folder in this project, never the
 * archive mount -- and print that they did not run when it holds nothing to
 * compare. Silent passes measuring nothing are how a check gets disarmed.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseD3Project } from '../src/programmed/d3.ts';
import { loadProgrammedCaptures } from '../src/programmed/load.ts';
import { parseProgrammedCapture, type ProgrammedCapture } from '../src/programmed/parse.ts';
import { resolveProgrammed } from '../src/programmed/protect.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = join(ROOT, 'src/programmed/vendor/d3extract.cjs');
const UPSTREAM = join(ROOT, '../d3_snapshot_diff/vendor/d3extract.js');
const CAPTURE_DIR = join(ROOT, 'programmed_media_crosscheck');

describe('the vendored extractor', () => {
  const text = readFileSync(VENDORED, 'utf8');

  it('does no I/O of its own -- it is handed bytes that ReadOnlyFs read', () => {
    // The read-only fence walks .ts files; this file is .cjs, so it is held to
    // the stronger rule here: it may not reach for a module at all.
    expect(text).not.toMatch(/\brequire\s*\(/);
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\s*\(/);
    expect(text).not.toMatch(/\bprocess\./);
  });

  it('is a byte-for-byte copy of d3_snapshot_diff/vendor/d3extract.js', () => {
    if (!existsSync(UPSTREAM)) {
      console.log('NOTE: ../d3_snapshot_diff not checked out; drift check did not run');
      return;
    }
    expect(text).toBe(readFileSync(UPSTREAM, 'utf8'));
  });
});

describe('parseD3Project', () => {
  it('refuses a file that is not a d3 archive, rather than reading it as an empty show', () => {
    const junk = new TextEncoder().encode('not a project at all, just some bytes');
    expect(() => parseD3Project(junk, 'junk.d3', 0)).toThrow(/could not be read.*Refusing/s);
  });

  it('takes its date from the file and says so', () => {
    const files = existsSync(CAPTURE_DIR) ? readdirSync(CAPTURE_DIR).filter((f) => f.endsWith('.d3')) : [];
    if (files.length === 0) {
      console.log('NOTE: no .d3 in programmed_media_crosscheck/; real-project cases did not run');
      return;
    }
    const name = files[0] as string;
    const full = join(CAPTURE_DIR, name);
    const cap = parseD3Project(readFileSync(full), name, statSync(full).mtimeMs);
    expect(cap.kind).toBe('project');
    expect(cap.capturedAtSource).toBe('file-mtime');
    expect(cap.refs.length).toBeGreaterThan(0);
    expect(cap.setlists.length).toBeGreaterThan(0);
    // Every reference knows its track, and every track in a capture is on a
    // setlist -- the tracks array is the union of what the setlists reference.
    for (const r of cap.refs) {
      expect(r.trackId).not.toBeNull();
      expect(r.setlists.length).toBeGreaterThan(0);
    }
  });

  it('yields exactly the references of the summary exported from the same save', () => {
    if (!existsSync(CAPTURE_DIR)) return;
    const names = readdirSync(CAPTURE_DIR);
    const pair = names
      .filter((f) => f.endsWith('.d3'))
      .map((d3) => ({ d3, json: names.find((j) => j.endsWith(`${d3.slice(0, -3)}.json`)) }))
      .find((p) => p.json !== undefined);
    if (!pair || !pair.json) {
      console.log('NOTE: no .d3 with a matching summary .json; equivalence case did not run');
      return;
    }
    const key = (c: ProgrammedCapture): string[] =>
      c.refs.map((r) => `${r.trackId}|${r.rawName}|${r.rawVersion}|${r.setlists.join(',')}`).sort();
    const d3Full = join(CAPTURE_DIR, pair.d3);
    const fromProject = parseD3Project(readFileSync(d3Full), pair.d3, statSync(d3Full).mtimeMs);
    const fromSummary = parseProgrammedCapture(
      readFileSync(join(CAPTURE_DIR, pair.json), 'utf8'),
      pair.json,
    );
    expect(key(fromProject)).toEqual(key(fromSummary));
  });
});

describe('loadProgrammedCaptures with .d3 files', () => {
  it('stops on an unreadable .d3 and ignores files that are not captures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mms-d3-'));
    writeFileSync(join(dir, '.DS_Store'), 'finder junk');
    writeFileSync(join(dir, 'notes.txt'), 'not a capture');
    const empty = await loadProgrammedCaptures(dir, dir);
    expect(empty.captures).toHaveLength(0);

    writeFileSync(join(dir, 'broken.d3'), 'truncated in the copy');
    await expect(loadProgrammedCaptures(dir, dir)).rejects.toThrow(/broken\.d3/);
  });
});

// ---------------------------------------------------------------------------
// Tracks and setlists
// ---------------------------------------------------------------------------

/** A summary with two tracks on two setlists, in the plugin's schema-7 shape. */
function twoSetlistCapture(): string {
  const layer = (name: string, version: string) => ({ media: [{ name, version }] });
  return JSON.stringify({
    capturedAt: '2026-10-01T06:48:43-07:00',
    project: 'test_project',
    schemaVersion: 7,
    transports: [
      { name: 'show_a', setlist: 'night1', trackRefs: ['alpha_song'] },
      { name: 'editor', setlist: 'band review', trackRefs: ['alpha_song', 'beta_song'] },
    ],
    tracks: [
      { id: 'alpha_song', name: 'alpha_song', layers: [layer('100_alpha_main_ll180.mov', '001')] },
      { id: 'beta_song', name: 'beta_song', layers: [layer('200_beta_edit_ll180.mov', '001a')] },
    ],
  });
}

describe('track and setlist use', () => {
  it('records which setlists carry each reference\'s track', () => {
    const cap = parseProgrammedCapture(twoSetlistCapture(), 's.json');
    const alpha = cap.refs.find((r) => r.trackId === 'alpha_song');
    expect(alpha?.setlists.sort()).toEqual(['band review', 'night1']);
    expect(cap.refs.find((r) => r.trackId === 'beta_song')?.setlists).toEqual(['band review']);
  });

  it('maps every protected version to the tracks that play it', () => {
    const cap = parseProgrammedCapture(twoSetlistCapture(), 's.json');
    const prot = resolveProgrammed(
      [cap],
      [
        {
          id: 1,
          songFolder: 'S',
          base: '100_ALPHA_MAIN_LL180',
          versions: [
            { id: 10, verNum: 1, subLetter: null, isPatch: false, patchFrame: null, bytes: 1, proxyBytes: 0, fileCount: 1, regionCount: 1 },
            { id: 11, verNum: 2, subLetter: null, isPatch: false, patchFrame: null, bytes: 1, proxyBytes: 0, fileCount: 1, regionCount: 1 },
          ],
        },
      ],
    );
    expect(prot.programmedOn.get(10)).toEqual([{ track: 'alpha_song', setlists: ['band review', 'night1'] }]);
    // Not programmed is absent, never an empty entry.
    expect(prot.programmedOn.has(11)).toBe(false);
    expect(prot.tracks.find((t) => t.track === 'alpha_song')?.versions).toBe(1);
    expect(prot.tracks.find((t) => t.track === 'beta_song')?.versions).toBe(0);
    expect(prot.setlists.map((s) => s.setlist)).toEqual(['band review', 'night1']);
  });
});

// ---------------------------------------------------------------------------
// Through the API
// ---------------------------------------------------------------------------

async function server(withCapture: boolean) {
  const { makeFixture } = await import('./server/fixture.ts');
  const { buildServer } = await import('../src/server/app.ts');
  const fx = makeFixture();
  const captures = withCapture ? [parseProgrammedCapture(twoSetlistCapture(), 's.json')] : [];
  const { app } = buildServer({ db: fx.db, cfg: fx.cfg, captures });
  await app.ready();
  const get = async (url: string) => app.inject({ method: 'GET', url });
  const close = async () => {
    await app.close();
    fx.db.close();
  };
  return { get, close };
}

type FileRowLike = { relPath?: string; rel_path?: string; name?: string; assetVersionId: number | null };
const nameOf = (r: FileRowLike): string => String(r.relPath ?? r.rel_path ?? r.name ?? '');

describe('the programmed filters', () => {
  it('splits the file list into programmed and not, with nothing lost or doubled', async () => {
    const s = await server(true);
    const all = (await s.get('/api/files?limit=2000')).json();
    const yes = (await s.get('/api/files?limit=2000&programmed=1')).json();
    const no = (await s.get('/api/files?limit=2000&programmed=0')).json();
    expect(yes.total).toBeGreaterThan(0);
    expect(no.total).toBeGreaterThan(0);
    expect(yes.total + no.total).toBe(all.total);
    expect(yes.matchedBytes + no.matchedBytes).toBe(all.matchedBytes);
    for (const r of yes.rows) expect(nameOf(r)).toMatch(/100_ALPHA_MAIN_LL180_v001_|200_BETA_EDIT_LL180_v001a_/);
    await s.close();
  });

  it('hides everything on an excluded setlist, including a version also on another one', async () => {
    const s = await server(true);
    const programmed = (await s.get('/api/versions?limit=2000&programmed=1')).json();
    expect(programmed.total).toBe(2);
    // alpha is on night1 AND band review; excluding band review hides it too.
    const hidden = (await s.get(`/api/versions?limit=2000&programmed=1&excludeSetlist=${encodeURIComponent('band review')}`)).json();
    expect(hidden.total).toBe(0);
    const nightOnly = (await s.get('/api/versions?limit=2000&programmed=1&excludeSetlist=night1')).json();
    expect(nightOnly.rows.map((r: { base: string }) => r.base)).toEqual(['200_BETA_EDIT_LL180']);
    await s.close();
  });

  it('hides a track\'s versions and leaves unprogrammed rows alone', async () => {
    const s = await server(true);
    const all = (await s.get('/api/versions?limit=2000')).json();
    const res = (await s.get('/api/versions?limit=2000&excludeTrack=beta_song')).json();
    expect(res.total).toBe(all.total - 1);
    expect(res.rows.some((r: { base: string; verLabel: string }) => r.base === '200_BETA_EDIT_LL180' && r.verLabel === 'v001a')).toBe(false);
    await s.close();
  });

  it('hides rows and never unprotects them', async () => {
    const s = await server(true);
    const before = (await s.get('/api/reclaim?keepN=1')).json();
    const after = (await s.get('/api/reclaim?keepN=1&excludeTrack=alpha_song&excludeTrack=beta_song')).json();
    // The whole-snapshot protection count is the same either way; only the
    // rows in view moved.
    expect(after.programmed.protectedVersions).toBe(before.programmed.protectedVersions);
    const versions = (await s.get('/api/versions?keepN=1&limit=2000')).json();
    const alpha = versions.rows.find((r: { base: string; verLabel: string }) => r.base === '100_ALPHA_MAIN_LL180' && r.verLabel === 'v001');
    expect(alpha.keepReason).toBe('kept-programmed');
    await s.close();
  });

  it('refuses without a capture rather than calling everything unprogrammed', async () => {
    const s = await server(false);
    const res = await s.get('/api/files?programmed=0');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('no_capture');
    await s.close();
  });

  it('refuses a track or setlist the capture does not have', async () => {
    const s = await server(true);
    expect((await s.get('/api/files?excludeTrack=no_such_track')).statusCode).toBe(400);
    expect((await s.get('/api/versions?excludeSetlist=no_such_setlist')).statusCode).toBe(400);
    await s.close();
  });
});

describe('the drill-down', () => {
  it('lists the tracks and setlists on each ladder version', async () => {
    const s = await server(true);
    const versions = (await s.get('/api/versions?limit=2000')).json();
    const alpha = versions.rows.find((r: { base: string }) => r.base === '100_ALPHA_MAIN_LL180');
    const ladder = (await s.get(`/api/assets/${alpha.assetId}/versions`)).json();
    expect(ladder.programmed.usable).toBe(true);
    const v1 = ladder.versions.find((v: { verLabel: string }) => v.verLabel === 'v001');
    expect(v1.programmedOn).toEqual([{ track: 'alpha_song', setlists: ['band review', 'night1'] }]);
    const v2 = ladder.versions.find((v: { verLabel: string }) => v.verLabel === 'v002');
    expect(v2.programmedOn).toEqual([]);
    await s.close();
  });

  it('says null, not empty, when no capture is loaded', async () => {
    const s = await server(false);
    const versions = (await s.get('/api/versions?limit=2000')).json();
    const ladder = (await s.get(`/api/assets/${versions.rows[0].assetId}/versions`)).json();
    expect(ladder.programmed).toBeNull();
    for (const v of ladder.versions) expect(v.programmedOn).toBeNull();
    await s.close();
  });

  it('hands the filter panel its tracks and setlists on /api/summary', async () => {
    const s = await server(true);
    const sum = (await s.get('/api/summary')).json();
    expect(sum.programmed.setlists.map((x: { setlist: string }) => x.setlist)).toEqual(['band review', 'night1']);
    expect(sum.programmed.tracks.map((x: { track: string }) => x.track)).toEqual(['alpha_song', 'beta_song']);
    await s.close();
    const bare = await server(false);
    expect((await bare.get('/api/summary')).json().programmed).toBeNull();
    await bare.close();
  });
});

describe('the Programmed column', () => {
  it('carries where each file is programmed, and null when nothing was checked', async () => {
    const s = await server(true);
    const res = (await s.get('/api/files?limit=2000')).json();
    const hit = res.rows.find((r: FileRowLike) => /100_ALPHA_MAIN_LL180_v001_region1/.test(nameOf(r)));
    expect(hit.programmedOn).toEqual([{ track: 'alpha_song', setlists: ['band review', 'night1'] }]);
    const other = res.rows.find((r: FileRowLike) => /100_ALPHA_MAIN_LL180_v002/.test(nameOf(r)));
    expect(other.programmedOn).toEqual([]);
    // The JS-pass route builds rows separately; it must say the same.
    const slow = (await s.get('/api/files?limit=2000&programmed=1')).json();
    expect(slow.rows.find((r: { id: number }) => r.id === hit.id).programmedOn).toEqual(hit.programmedOn);
    await s.close();

    const bare = await server(false);
    for (const r of (await bare.get('/api/files?limit=50')).json().rows) expect(r.programmedOn).toBeNull();
    await bare.close();
  });
});

describe('POST /api/programmed/reload', () => {
  async function reloadable(dir: string) {
    const { makeFixture } = await import('./server/fixture.ts');
    const { buildServer } = await import('../src/server/app.ts');
    const fx = makeFixture();
    const { app } = buildServer({
      db: fx.db,
      cfg: fx.cfg,
      captures: [],
      captureSource: { projectRoot: dir, directory: dir },
    });
    await app.ready();
    return {
      reload: () => app.inject({ method: 'POST', url: '/api/programmed/reload', payload: {} }),
      programmed: async () => (await app.inject({ method: 'GET', url: '/api/reclaim?keepN=1' })).json().programmed,
      close: async () => {
        await app.close();
        fx.db.close();
      },
    };
  }

  it('picks up a capture dropped in after startup, and drops one removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mms-reload-'));
    const s = await reloadable(dir);
    expect(await s.programmed()).toBeNull();

    writeFileSync(join(dir, 'show.json'), twoSetlistCapture());
    const res = await s.reload();
    expect(res.statusCode).toBe(200);
    expect(res.json().captures.map((c: { sourceFile: string }) => c.sourceFile)).toEqual(['show.json']);
    expect((await s.programmed()).protectedVersions).toBe(2);

    const { rmSync } = await import('node:fs');
    rmSync(join(dir, 'show.json'));
    expect((await s.reload()).json().captures).toEqual([]);
    // Back to "not cross-checked" -- stated, not an empty protection list.
    expect(await s.programmed()).toBeNull();
    await s.close();
  });

  it('refuses on an unreadable file and leaves the old captures in force', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mms-reload-'));
    writeFileSync(join(dir, 'show.json'), twoSetlistCapture());
    const s = await reloadable(dir);
    expect((await s.reload()).statusCode).toBe(200);
    const before = await s.programmed();

    writeFileSync(join(dir, 'broken.d3'), 'cut short in the copy');
    const res = await s.reload();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('capture_unreadable');
    expect(res.json().error.message).toMatch(/still in force/);
    // Not a partial set, not an empty one: exactly what was there before.
    expect(await s.programmed()).toEqual(before);
    await s.close();
  });

  it('answers 409 when the server was given no directory to reload from', async () => {
    const { buildServer } = await import('../src/server/app.ts');
    const { makeFixture } = await import('./server/fixture.ts');
    const fx = makeFixture();
    const { app } = buildServer({ db: fx.db, cfg: fx.cfg });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/programmed/reload', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('reload_unavailable');
    await app.close();
    fx.db.close();
  });
});

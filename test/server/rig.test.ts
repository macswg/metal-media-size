/**
 * ============================================================================
 *  THE RIG SURVEY
 * ============================================================================
 *
 * Three things here could go badly wrong, and most of these tests are about
 * them rather than about the happy path:
 *
 *   1. A HOST NAME REACHES A COMMAND. The address becomes part of a
 *      `mount_smbfs` URL and part of a local directory name, so `assertHost` is
 *      an allowlist of the two shapes an address can take, and it is tested
 *      with the things an attacker (or a mis-paste) would actually produce.
 *
 *   1b. THE MOUNT IS NOT ACTUALLY READ-ONLY. The whole protection for the
 *      playback machines rests on two flags in one argument vector, so the
 *      argv is asserted literally.
 *
 *   2. THE CREDENTIAL LEAKS. It may not appear in `argv` (where `ps` would
 *      show it), and it may not come back out of the session. Both are
 *      asserted behaviourally, against a real session object, rather than by
 *      grepping for a variable name.
 *
 *   3. THE SURVEY LIES. Comparing a machine to the archive is the whole point,
 *      and a comparison that quietly mis-buckets a file is worse than no
 *      comparison. `compareMachine` is pure, so it is tested exhaustively with
 *      no network anywhere near it.
 *
 * Nothing in this file mounts anything or touches a network. The mount is one
 * function, its two commands are asserted by
 * `test/readonly-enforcement.test.ts`, and its inputs are validated here.
 * ============================================================================
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server/app.ts';
import type { AppContext } from '../../src/server/context.ts';
import { makeFixture, type Fixture } from './fixture.ts';
import {
  assertHost,
  assertInMountRoot,
  assertShare,
  findMount,
  InvalidTargetError,
  isOurMountPoint,
  mountArgs,
  MOUNT_ROOT,
  mountPointFor,
  mountUrl,
  parseMountTable,
} from '../../src/rig/mounts.ts';
import { formatTargetsYaml, parseTargetList, MAX_TARGETS } from '../../src/rig/targets.ts';
import {
  compareMachine,
  rollUpMissing,
  totalsOf,
  type ExpectedFile,
  type RemoteFile,
} from '../../src/rig/survey.ts';
import { RigSession } from '../../src/server/rig-session.ts';
import { assertRelativeDirectory } from '../../src/server/routes/rig.ts';

let fx: Fixture;
let app: FastifyInstance;
let ctx: AppContext;

beforeAll(() => {
  fx = makeFixture();
  const built = buildServer({ db: fx.db, cfg: fx.cfg });
  app = built.app;
  ctx = built.ctx;
});

afterAll(async () => {
  await app.close();
  fx.db.close();
});

async function req(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: any; raw: string }> {
  const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  let body: any = null;
  try {
    body = res.json();
  } catch {
    /* not JSON -- the YAML route */
  }
  return { status: res.statusCode, body, raw: res.body };
}

// ===========================================================================
describe('a machine address may never reach a command unchecked', () => {
  it('accepts the two shapes an address really takes', () => {
    expect(assertHost('10.10.1.53')).toBe('10.10.1.53');
    expect(assertHost(' 10.10.1.53 ')).toBe('10.10.1.53');
    expect(assertHost('d3-server-101.local')).toBe('d3-server-101.local');
    expect(assertHost('MOOSE-103')).toBe('MOOSE-103');
  });

  it('refuses anything that could break out of the URL or the directory name', () => {
    for (const bad of [
      '10.10.1.53" & (do shell script "id") & "',
      '10.10.1.53; rm -rf /',
      'host name with spaces',
      '10.10.1.53/../../etc',
      '"',
      "'; osascript -e 'beep",
      '',
      '   ',
    ]) {
      expect(() => assertHost(bad), bad).toThrow(InvalidTargetError);
    }
  });

  it('refuses an address with a control character in it', () => {
    expect(() => assertHost('10.10.1.53\nmount volume "smb://evil/x"')).toThrow(InvalidTargetError);
  });

  it('refuses out-of-range octets rather than passing them along', () => {
    expect(() => assertHost('10.10.1.999')).toThrow(InvalidTargetError);
  });

  it('allows a share name with a space, and refuses one with a slash or quote', () => {
    expect(assertShare('d3 Projects')).toBe('d3 Projects');
    for (const bad of ['d3/Projects', 'd3"Projects', 'd3\\Projects', '']) {
      expect(() => assertShare(bad), bad).toThrow(InvalidTargetError);
    }
  });

  it('percent-encodes the share into the URL', () => {
    expect(mountUrl({ host: '10.10.1.53', share: 'd3 Projects', username: 'd3', password: 'secret' }))
      .toBe('//d3:secret@10.10.1.53/d3%20Projects');
  });

  it('percent-encodes a password containing URL punctuation', () => {
    // A password with `@` or `/` would otherwise be read as a host or a share,
    // and the mount would fail confusingly -- or succeed against the wrong
    // thing, which is far worse.
    expect(mountUrl({ host: '10.10.1.53', share: 'd3', username: 'a@b', password: 'p@ss/w:rd' }))
      .toBe('//a%40b:p%40ss%2Fw%3Ard@10.10.1.53/d3');
  });

  it('omits the credential entirely when there is none', () => {
    expect(mountUrl({ host: '10.10.1.53', share: 'd3' })).toBe('//10.10.1.53/d3');
  });
});

// ===========================================================================
describe('the mount is read-only, and that is the whole protection', () => {
  it('always passes rdonly, so the kernel refuses every write through it', () => {
    // Verified against the real rig before this was written: `touch` and
    // `mkdir` on such a mount both fail with `Read-only file system`, locally,
    // before anything reaches the machine. If this flag were ever dropped the
    // failure would be completely silent -- reads would keep working.
    const args = mountArgs({ host: '10.10.1.53', share: 'd3 Projects' }, '/tmp/x');
    expect(args).toContain('rdonly,nobrowse');
    expect(args.join(' ')).toMatch(/-o rdonly/);
  });

  it('always passes -N, so a bad password can never hang the server', () => {
    // Without it `mount_smbfs` prompts on a terminal a server process does not
    // have, and the request blocks until the timeout.
    expect(mountArgs({ host: '10.10.1.53', share: 'd3' }, '/tmp/x')[0]).toBe('-N');
  });

  it('puts the URL and the mountpoint last, in that order', () => {
    const args = mountArgs({ host: '10.10.1.53', share: 'd3' }, '/tmp/x');
    expect(args.slice(-2)).toEqual(['//10.10.1.53/d3', '/tmp/x']);
  });

  it('reads read-only back out of the mount table instead of assuming it', () => {
    // A share the operator connected in Finder is read-WRITE. Describing it as
    // protected would be the one lie this module must not tell.
    const [ours, theirs] = parseMountTable(
      `//d3@10.10.1.53/d3 on ${MOUNT_ROOT}/10.10.1.53 (smbfs, nodev, nosuid, read-only, nobrowse)\n` +
        '//d3@10.10.1.54/d3 on /Volumes/d3 (smbfs, nodev, nosuid)\n',
    );
    expect(ours).toMatchObject({ readOnly: true, ours: true });
    expect(theirs).toMatchObject({ readOnly: false, ours: false });
  });
});

// ===========================================================================
describe('the mountpoint jail', () => {
  it('puts each machine under the application\'s own root', () => {
    expect(mountPointFor('10.10.1.53')).toBe(`${MOUNT_ROOT}/10.10.1.53`);
    expect(isOurMountPoint(mountPointFor('10.10.1.53'))).toBe(true);
  });

  it('refuses to touch anything outside that root', () => {
    // What stands between a bug and unmounting the archive mid-show.
    for (const bad of [
      '/Volumes/d3 Projects',
      '/Users/Shared/ObjectMount.noindex/show-archive',
      '/',
      `${MOUNT_ROOT}/../../../Volumes/d3`,
    ]) {
      expect(() => assertInMountRoot(bad), bad).toThrow(InvalidTargetError);
      expect(isOurMountPoint(bad), bad).toBe(false);
    }
  });

  it('accepts the /private spelling macOS reports mounts under', () => {
    // `/var` is a symlink to `/private/var`, so the mount table says one and
    // `os.tmpdir()` says the other. Both are the same directory.
    const viaPrivate = MOUNT_ROOT.startsWith('/private')
      ? MOUNT_ROOT.slice('/private'.length)
      : `/private${MOUNT_ROOT}`;
    expect(isOurMountPoint(`${viaPrivate}/10.10.1.53`)).toBe(true);
  });

  it('cannot be escaped by a host name, because a host name cannot contain a slash', () => {
    expect(() => mountPointFor('../../../Volumes/d3')).toThrow(InvalidTargetError);
  });
});

// ===========================================================================
describe('reading the mount table', () => {
  // Verbatim from `/sbin/mount` on the development machine.
  const REAL =
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n' +
    'objectMount on /Users/Shared/ObjectMount.noindex/x (macfuse, nodev, nosuid, read-only)\n' +
    '//d3@10.10.1.53/d3%20Projects on /Volumes/d3 Projects (smbfs, nodev, nosuid, mounted by seangreen)\n';

  it('reads host, share and mountpoint out of a real line', () => {
    const mounts = parseMountTable(REAL);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toEqual({
      host: '10.10.1.53',
      share: 'd3 Projects',
      user: 'd3',
      mountPoint: '/Volumes/d3 Projects',
      // A Finder mount: writable, and not one of ours.
      readOnly: false,
      ours: false,
    });
  });

  it('keeps a mountpoint that contains spaces intact', () => {
    // Splitting the line on whitespace would give `/Volumes/d3`, and the survey
    // would then walk a path that does not exist.
    expect(parseMountTable(REAL)[0]?.mountPoint).toBe('/Volumes/d3 Projects');
  });

  it('tells two machines apart when they offer the same share name', () => {
    // THE FAILURE THIS PREVENTS: every machine on the rig offers `d3 Projects`,
    // so macOS suffixes the second one. Predicting the mountpoint instead of
    // reading it back would survey the wrong machine and report its contents
    // under another machine's name.
    const mounts = parseMountTable(
      '//d3@10.10.1.53/d3%20Projects on /Volumes/d3 Projects (smbfs, nodev)\n' +
        '//d3@10.10.1.54/d3%20Projects on /Volumes/d3 Projects-1 (smbfs, nodev)\n',
    );
    expect(mounts).toHaveLength(2);
    expect(findMount(mounts, '10.10.1.53', 'd3 Projects')?.mountPoint).toBe('/Volumes/d3 Projects');
    expect(findMount(mounts, '10.10.1.54', 'd3 Projects')?.mountPoint).toBe('/Volumes/d3 Projects-1');
  });

  it('ignores every non-SMB mount, including the archive itself', () => {
    expect(parseMountTable(REAL).some((m) => m.mountPoint.includes('ObjectMount'))).toBe(false);
  });

  it('survives a share mounted with no user name', () => {
    const m = parseMountTable('//10.10.1.7/media on /Volumes/media (smbfs)\n');
    expect(m[0]).toMatchObject({ host: '10.10.1.7', share: 'media', user: null });
  });
});

// ===========================================================================
describe('the target list', () => {
  it('reads the plain form, with or without a machine id', () => {
    const r = parseTargetList('101 10.10.1.53\n102=10.10.1.54\n10.10.1.99\n');
    expect(r.targets).toEqual([
      { machineId: '101', host: '10.10.1.53' },
      { machineId: '102', host: '10.10.1.54' },
      { machineId: null, host: '10.10.1.99' },
    ]);
    expect(r.errors).toEqual([]);
  });

  it('does not care which way round the pair is written', () => {
    // A machine id is never a valid IPv4 literal, so this is unambiguous.
    expect(parseTargetList('10.10.1.53 101').targets).toEqual([
      { machineId: '101', host: '10.10.1.53' },
    ]);
  });

  it('ignores comments and blank lines', () => {
    const r = parseTargetList('# the actors\n\n101 10.10.1.53   # spare\n');
    expect(r.targets).toEqual([{ machineId: '101', host: '10.10.1.53' }]);
  });

  it('reports a bad line with its number, and keeps the good ones', () => {
    // Never silently dropped: a machine missing from a survey because its line
    // was quietly discarded is the worst outcome this feature has.
    const r = parseTargetList('101 10.10.1.53\nnot an address at all here\n102 10.10.1.54\n');
    expect(r.targets).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.line).toBe(2);
    expect(r.errors[0]?.text).toBe('not an address at all here');
  });

  it('collapses a list pasted twice', () => {
    const r = parseTargetList('101 10.10.1.53\n101 10.10.1.53\n');
    expect(r.targets).toHaveLength(1);
  });

  it('refuses a list longer than the ceiling, and says so', () => {
    // Distinct addresses, or the dedup would collapse them below the ceiling
    // and the test would pass without ever reaching it.
    const many = Array.from(
      { length: MAX_TARGETS + 10 },
      (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250}`,
    ).join('\n');
    const r = parseTargetList(many);
    expect(r.targets.length).toBeLessThanOrEqual(MAX_TARGETS);
    expect(r.errors.some((e) => /more than the/.test(e.message))).toBe(true);
  });
});

// ===========================================================================
describe('the YAML file the operator saves', () => {
  const targets = [
    { machineId: '101', host: '10.10.1.53' },
    { machineId: '306', host: '10.10.1.70' },
    { machineId: null, host: 'spare.local' },
  ];

  it('round-trips exactly, so a saved list means the same on the way back in', () => {
    const yaml = formatTargetsYaml({ targets, share: 'd3 Projects', directory: 'media/SHOW_2026' });
    const back = parseTargetList(yaml);
    expect(back.targets).toEqual(targets);
    expect(back.share).toBe('d3 Projects');
    expect(back.directory).toBe('media/SHOW_2026');
    expect(back.errors).toEqual([]);
  });

  it('NEVER contains a credential', () => {
    // The file is the one artefact of this feature that outlives the session,
    // so it must carry no credential FIELD at all -- checked as a key, since
    // the header comment says the words on purpose and should keep saying them.
    const yaml = formatTargetsYaml({ targets, share: 'd3 Projects', directory: '' });
    expect(yaml).not.toMatch(/^\s*-?\s*(password|username|user|secret)\s*:/im);
    expect(yaml).toMatch(/No password and no user name is ever written/);
    // Structurally impossible, not merely absent: the renderer takes no
    // credential, so there is nothing for it to write even by mistake.
    expect(formatTargetsYaml.length).toBe(1);
  });

  it('is recognised as YAML rather than being read as a paste', () => {
    const yaml = formatTargetsYaml({ targets, share: 'd3 Projects', directory: '' });
    // The plain parser would choke on `machines:` and `- id: "101"`.
    expect(parseTargetList(yaml).errors).toEqual([]);
  });

  it('ignores a key a later version added, rather than rejecting the file', () => {
    const r = parseTargetList(
      'share: d3 Projects\nsomethingNew: 42\nmachines:\n  - id: "101"\n    host: 10.10.1.53\n',
    );
    expect(r.targets).toEqual([{ machineId: '101', host: '10.10.1.53' }]);
    expect(r.errors).toEqual([]);
  });

  it('reports an entry with no host instead of skipping it', () => {
    const r = parseTargetList('machines:\n  - id: "101"\n');
    expect(r.targets).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });

  it('rejects a host inside the YAML just as strictly as a pasted one', () => {
    const r = parseTargetList('machines:\n  - host: "evil" & do shell script "id"\n');
    expect(r.targets).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });
});

// ===========================================================================
describe('the directory cannot escape the share', () => {
  it('accepts an ordinary relative path', () => {
    expect(assertRelativeDirectory('media/SHOW_2026')).toBe('media/SHOW_2026');
    expect(assertRelativeDirectory('')).toBe('');
    expect(assertRelativeDirectory('/')).toBe('');
  });

  it('normalises Windows separators, since these are Windows machines', () => {
    expect(assertRelativeDirectory('media\\SHOW_2026')).toBe('media/SHOW_2026');
  });

  it('refuses `..`, an absolute path, or a drive letter', () => {
    for (const bad of ['../../etc', 'media/../../etc', '/etc', 'C:\\Windows']) {
      expect(() => assertRelativeDirectory(bad), bad).toThrow();
    }
  });
});

// ===========================================================================
describe('comparing a machine with the archive', () => {
  const expected = (over: Partial<ExpectedFile> & { name: string; size: number }): ExpectedFile => ({
    region: 1,
    songFolder: '100_ALPHA',
    base: '100_ALPHA_MAIN_LL180',
    verLabel: 'v004',
    versionId: 1,
    status: 'kept',
    ...over,
  });
  const onDisk = (name: string, size: number): RemoteFile => ({
    relPath: name,
    name,
    size,
    mtime: 1,
  });
  // Region 1 and 2 are this machine's; anything else belongs elsewhere.
  const opts = {
    regions: [1, 2],
    regionOfName: (n: string) => {
      const m = /_region(\d+)\./.exec(n);
      return m?.[1] ? Number(m[1]) : null;
    },
  };

  it('finds current media that is absent — the alarm', () => {
    const c = compareMachine(
      [],
      [expected({ name: 'a_v004_region1.mov', size: 100 })],
      opts,
    );
    expect(c.missingKept.map((x) => x.name)).toEqual(['a_v004_region1.mov']);
    expect(totalsOf(c).inSync).toBe(false);
    expect(totalsOf(c).missingKeptBytes).toBe(100);
  });

  it('does not raise the alarm for superseded media that is already gone', () => {
    const c = compareMachine(
      [],
      [expected({ name: 'a_v001_region1.mov', size: 100, status: 'superseded' })],
      opts,
    );
    expect(c.missingKept).toEqual([]);
    expect(c.missingSuperseded).toHaveLength(1);
    // A tidy machine is in sync, not "missing" the media someone cleaned off.
    expect(totalsOf(c).inSync).toBe(true);
  });

  it('reports superseded media still taking up space on the drive', () => {
    const c = compareMachine(
      [onDisk('a_v001_region1.mov', 100)],
      [expected({ name: 'a_v001_region1.mov', size: 100, status: 'superseded' })],
      opts,
    );
    expect(c.presentSuperseded).toHaveLength(1);
    expect(totalsOf(c).presentSupersededBytes).toBe(100);
    // Old media is a space problem, not a playback one, so it is still in sync.
    expect(totalsOf(c).inSync).toBe(true);
  });

  it('treats a size difference as its own finding, not as a match', () => {
    // Both readings are bad: a copy that did not finish, or a re-render the
    // archive has never seen. Either way it is not the file we recorded.
    const c = compareMachine(
      [onDisk('a_v004_region1.mov', 90)],
      [expected({ name: 'a_v004_region1.mov', size: 100 })],
      opts,
    );
    expect(c.sizeMismatch).toHaveLength(1);
    expect(c.sizeMismatch[0]).toMatchObject({ archiveSize: 100, machineSize: 90 });
    expect(c.presentKept.count).toBe(0);
    expect(c.missingKept).toEqual([]);
    expect(totalsOf(c).inSync).toBe(false);
  });

  it("separates another machine's media from media the archive never saw", () => {
    const c = compareMachine(
      [onDisk('a_v004_region7.mov', 10), onDisk('holiday-photo.jpg', 20)],
      [],
      opts,
    );
    expect(c.extraForeign.map((x) => x.name)).toEqual(['a_v004_region7.mov']);
    expect(c.extraUnknown.map((x) => x.name)).toEqual(['holiday-photo.jpg']);
  });

  it('counts a correct machine as correct and says nothing else about it', () => {
    const c = compareMachine(
      [onDisk('a_v004_region1.mov', 100), onDisk('b_v004_region2.mov', 200)],
      [
        expected({ name: 'a_v004_region1.mov', size: 100 }),
        expected({ name: 'b_v004_region2.mov', size: 200, region: 2 }),
      ],
      opts,
    );
    expect(totalsOf(c).inSync).toBe(true);
    expect(c.presentKept).toEqual({ count: 2, bytes: 300 });
    expect(c.missingKept).toEqual([]);
    expect(c.extraForeign).toEqual([]);
    expect(c.extraUnknown).toEqual([]);
  });

  it('surfaces a duplicate archive name instead of matching one arbitrarily', () => {
    // Basename matching rests on names being unique across the delivery. If
    // that stopped being true the comparison would be untrustworthy, so it is
    // reported rather than resolved by picking whichever came first.
    const c = compareMachine(
      [onDisk('dupe.mov', 100)],
      [expected({ name: 'dupe.mov', size: 100 }), expected({ name: 'dupe.mov', size: 999 })],
      opts,
    );
    expect(c.nameCollisions).toBe(1);
    expect(totalsOf(c).nameCollisions).toBe(1);
  });

  it('orders every list biggest-first, so the costliest thing is at the top', () => {
    const c = compareMachine(
      [],
      [
        expected({ name: 'small.mov', size: 1 }),
        expected({ name: 'huge.mov', size: 1000 }),
        expected({ name: 'mid.mov', size: 50 }),
      ],
      opts,
    );
    expect(c.missingKept.map((x) => x.name)).toEqual(['huge.mov', 'mid.mov', 'small.mov']);
  });

  it('accounts for every file on the machine exactly once', () => {
    const actual = [
      onDisk('kept.mov', 10),
      onDisk('old.mov', 20),
      onDisk('wrong-size.mov', 30),
      onDisk('a_v001_region7.mov', 40),
      onDisk('stranger.txt', 50),
    ];
    const c = compareMachine(
      actual,
      [
        expected({ name: 'kept.mov', size: 10 }),
        expected({ name: 'old.mov', size: 20, status: 'superseded' }),
        expected({ name: 'wrong-size.mov', size: 999 }),
      ],
      opts,
    );
    const bucketed =
      c.presentKept.count +
      c.presentSuperseded.length +
      c.sizeMismatch.length +
      c.extraForeign.length +
      c.extraUnknown.length;
    expect(bucketed).toBe(actual.length);
    expect(c.actual).toEqual({ count: 5, bytes: 150 });
  });
});

// ===========================================================================
describe('the session holds the credential and never gives it back', () => {
  it('does not put the password in status, at any depth', () => {
    const session = new RigSession();
    session.setTargets([{ machineId: '101', host: '10.10.1.53' }], 'd3 Projects', '');
    session.setCredentials('d3', 'hunter2-do-not-leak');
    const status = session.status();
    expect(status.hasCredentials).toBe(true);
    expect(status.username).toBe('d3');
    // Serialised, so a nested field cannot hide from the assertion.
    expect(JSON.stringify(status)).not.toContain('hunter2-do-not-leak');
  });

  it('forgets the password when the session is cleared', () => {
    const session = new RigSession();
    session.setCredentials('d3', 'secret');
    expect(session.hasCredentials()).toBe(true);
    session.clear();
    expect(session.hasCredentials()).toBe(false);
    expect(session.status().username).toBeNull();
    expect(session.getTargets()).toEqual([]);
  });

  it('drops stale results when the target list changes', () => {
    // Results describe a list of machines. Keeping them beside a different list
    // is how a reading of the old rig gets read as the new one.
    const session = new RigSession();
    session.setTargets([{ machineId: '101', host: '10.10.1.53' }], 'd3', '');
    session.setTargets([{ machineId: '102', host: '10.10.1.54' }], 'd3', '');
    expect(session.status().survey.results).toEqual([]);
    expect(session.status().targets.map((t) => t.host)).toEqual(['10.10.1.54']);
  });
});

// ===========================================================================
describe('the routes', () => {
  it('starts with an empty session that has no addresses and no credential', async () => {
    const { status, body } = await req('GET', '/api/rig/status');
    expect(status).toBe(200);
    expect(body.targets).toEqual([]);
    expect(body.hasCredentials).toBe(false);
    expect(body).not.toHaveProperty('password');
  });

  it('accepts a pasted list and reports the lines it could not read', async () => {
    const { body } = await req('POST', '/api/rig/targets', {
      text: '101 10.10.1.53\nrubbish rubbish rubbish\n',
      share: 'd3 Projects',
      directory: 'media',
    });
    expect(body.targets).toHaveLength(1);
    expect(body.errors).toHaveLength(1);
    expect(body.share).toBe('d3 Projects');
    expect(body.directory).toBe('media');
  });

  it('names the machine ids the rig does not recognise', async () => {
    const { body } = await req('POST', '/api/rig/targets', { text: '999 10.10.1.60\n' });
    expect(body.unknownMachineIds).toEqual(['999']);
  });

  it('serves the list as a YAML attachment without writing a file', async () => {
    await req('POST', '/api/rig/targets', { text: '101 10.10.1.53\n306 10.10.1.70\n' });
    // A credential is held at the time the file is generated: the point is
    // that it still cannot reach the file.
    await req('POST', '/api/rig/credentials', { username: 'd3', password: 'yaml-must-not-hold-me' });
    const res = await app.inject({ method: 'GET', url: '/api/rig/targets.yaml' });
    expect(res.headers['content-type']).toContain('text/yaml');
    expect(res.headers['content-disposition']).toContain('rig-targets.yaml');
    expect(res.body).toContain('host: 10.10.1.53');
    expect(res.body).not.toContain('yaml-must-not-hold-me');
    expect(res.body).not.toMatch(/^\s*-?\s*(password|username)\s*:/im);
    // And it round-trips through the same parser the paste box uses.
    expect(parseTargetList(res.body).targets).toHaveLength(2);
  });

  it('takes a credential and echoes back only what is safe to see', async () => {
    const { body } = await req('POST', '/api/rig/credentials', {
      username: 'd3',
      password: 'never-echo-me',
    });
    expect(body).toEqual({ hasCredentials: true, username: 'd3' });
    const status = await req('GET', '/api/rig/status');
    expect(JSON.stringify(status.body)).not.toContain('never-echo-me');
  });

  it('refuses to survey when nothing is mounted', async () => {
    await req('POST', '/api/rig/targets', { text: '101 10.10.1.53\n' });
    const { status, body } = await req('POST', '/api/rig/survey', {});
    expect(status).toBe(400);
    expect(body.error.code).toBe('not_connected');
  });

  it('refuses a directory that tries to leave the share', async () => {
    const { status, body } = await req('POST', '/api/rig/targets', {
      text: '101 10.10.1.53\n',
      directory: '../../../etc',
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_directory');
  });

  it('refuses to connect with no addresses', async () => {
    await req('DELETE', '/api/rig/session');
    const { status, body } = await req('POST', '/api/rig/connect', {});
    expect(status).toBe(400);
    expect(body.error.code).toBe('no_targets');
  });

  it('forgets everything on request', async () => {
    await req('POST', '/api/rig/targets', { text: '101 10.10.1.53\n' });
    await req('POST', '/api/rig/credentials', { username: 'd3', password: 'x' });
    await req('DELETE', '/api/rig/session');
    const { body } = await req('GET', '/api/rig/status');
    expect(body.targets).toEqual([]);
    expect(body.hasCredentials).toBe(false);
    expect(body.share).toBeNull();
  });

  it('never touches the index: a survey session leaves the snapshot alone', async () => {
    const before = (
      ctx.db.prepare('SELECT COUNT(*) AS n FROM file').get() as { n: number }
    ).n;
    await req('POST', '/api/rig/targets', { text: '101 10.10.1.53\n' });
    await req('POST', '/api/rig/credentials', { username: 'd3', password: 'x' });
    await req('DELETE', '/api/rig/session');
    const after = (ctx.db.prepare('SELECT COUNT(*) AS n FROM file').get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

// ===========================================================================
describe('the master list of what is missing across the rig', () => {
  const file = (name: string, region: number, size = 100): ExpectedFile => ({
    name,
    size,
    region,
    songFolder: '100_ALPHA',
    base: '100_ALPHA_MAIN_LL180',
    verLabel: 'v004',
    versionId: 1,
    status: 'kept',
  });

  /** A machine result carrying just the two lists the roll-up reads. */
  const machine = (
    machineId: string,
    missingKept: ExpectedFile[],
    sizeMismatch: { name: string }[] = [],
  ) => ({
    machineId,
    error: null,
    comparison: {
      missingKept,
      sizeMismatch,
      missingSuperseded: [],
      presentKept: { count: 0, bytes: 0 },
      presentSuperseded: [],
      extraForeign: [],
      extraUnknown: [],
      actual: { count: 0, bytes: 0 },
      expected: { count: 0, bytes: 0 },
      nameCollisions: 0,
    },
  }) as unknown as Parameters<typeof rollUpMissing>[0][number];

  // Region 4 is carried by 103 (actor) and 208 (understudy), as the real rig
  // mirrors every region on exactly two machines.
  const holders = new Map<number, string[]>([
    [4, ['103', '208']],
    [5, ['104', '208']],
  ]);

  it('is GONE when no surveyed holder has it and both were looked at', () => {
    // The finding that matters most: nothing on the rig can put this on screen.
    const r = rollUpMissing(
      [machine('103', [file('a_region4.mov', 4)]), machine('208', [file('a_region4.mov', 4)])],
      holders,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      state: 'gone',
      missingFrom: ['103', '208'],
      presentOn: [],
      unknownOn: [],
    });
    expect(r.counts.gone).toBe(1);
  });

  it('is REDUCED when the other holder still has it — the show still plays', () => {
    const r = rollUpMissing(
      [machine('103', [file('a_region4.mov', 4)]), machine('208', [])],
      holders,
    );
    expect(r.rows[0]).toMatchObject({
      state: 'reduced',
      missingFrom: ['103'],
      presentOn: ['208'],
    });
    expect(r.counts.gone).toBe(0);
  });

  it('is UNCONFIRMED, never gone, when a holder was not surveyed', () => {
    // THE HONESTY RULE. 208 was offline; we did not look. Calling this `gone`
    // would be reporting a finding we did not make, and it is the difference
    // between "copy this file tonight" and "the rig is fine".
    const r = rollUpMissing([machine('103', [file('a_region4.mov', 4)])], holders);
    expect(r.rows[0]).toMatchObject({
      state: 'unconfirmed',
      missingFrom: ['103'],
      unknownOn: ['208'],
      presentOn: [],
    });
    expect(r.counts.gone).toBe(0);
    expect(r.unsurveyedHolders).toEqual(['208']);
  });

  it('does not treat a wrong-sized copy as a copy', () => {
    // Whatever that file is, it is not the one the archive recorded. Counting
    // it as a spare would turn a `gone` into a `reduced` and hide the worst
    // finding the survey can make.
    const r = rollUpMissing(
      [
        machine('103', [file('a_region4.mov', 4)]),
        machine('208', [], [{ name: 'a_region4.mov' }]),
      ],
      holders,
    );
    expect(r.rows[0]).toMatchObject({
      state: 'gone',
      wrongSizeOn: ['208'],
      presentOn: [],
    });
  });

  it('collapses one file reported by several machines into one row', () => {
    const r = rollUpMissing(
      [machine('103', [file('a_region4.mov', 4)]), machine('208', [file('a_region4.mov', 4)])],
      holders,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.missingFrom).toEqual(['103', '208']);
  });

  it('ignores a machine that failed, rather than reading it as complete', () => {
    const failed = { machineId: '208', error: 'not reachable', comparison: null };
    const r = rollUpMissing([machine('103', [file('a_region4.mov', 4)]), failed], holders);
    // 208 errored, so it is unknown -- not a holder that "has" the file.
    expect(r.rows[0]?.state).toBe('unconfirmed');
    expect(r.rows[0]?.unknownOn).toEqual(['208']);
  });

  it('orders gone first, then unconfirmed, then reduced, biggest first', () => {
    const r = rollUpMissing(
      [
        machine('103', [file('gone.mov', 4, 10), file('small-gone.mov', 4, 1), file('reduced.mov', 5, 999)]),
        machine('208', [file('gone.mov', 4, 10), file('small-gone.mov', 4, 1)]),
        machine('104', []),
      ],
      holders,
    );
    expect(r.rows.map((x) => x.name)).toEqual(['gone.mov', 'small-gone.mov', 'reduced.mov']);
    expect(r.rows.map((x) => x.state)).toEqual(['gone', 'gone', 'reduced']);
  });

  it('rolls up per region, worst region first, naming who carries it', () => {
    const r = rollUpMissing(
      [
        machine('103', [file('a_region4.mov', 4, 10)]),
        machine('208', [file('a_region4.mov', 4, 10), file('b_region5.mov', 5, 500)]),
        machine('104', []),
      ],
      holders,
    );
    expect(r.byRegion[0]).toMatchObject({ region: 4, holders: ['103', '208'], files: 1, gone: 1 });
    expect(r.byRegion[1]).toMatchObject({ region: 5, gone: 0 });
  });

  it('is clean when nothing is missing anywhere', () => {
    const r = rollUpMissing([machine('103', []), machine('208', [])], holders);
    expect(r.clean).toBe(true);
    expect(r.rows).toEqual([]);
    expect(r.unsurveyedHolders).toEqual([]);
  });

  it('is served by the status route even before a survey has run', async () => {
    const { body } = await req('GET', '/api/rig/status');
    expect(body.survey.missing).toMatchObject({ rows: [], clean: true });
  });
});

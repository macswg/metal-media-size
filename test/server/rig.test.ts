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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server/app.ts';
import type { AppContext } from '../../src/server/context.ts';
import { makeFixture, type Fixture } from './fixture.ts';
import {
  assertHost,
  assertInMountRoot,
  connectShare,
  disconnectShare,
  netCommand,
  netDeleteArgs,
  netUseArgs,
  rigPlatformOf,
  uncPath,
  assertShare,
  findMount,
  InvalidTargetError,
  isOurMountPoint,
  listSmbMounts,
  mountArgs,
  MOUNT_ROOT,
  mountPointFor,
  mountUrl,
  parseMountTable,
} from '../../src/rig/mounts.ts';
import { formatTargetsYaml, parseTargetList, MAX_TARGETS } from '../../src/rig/targets.ts';
import {
  compareMachine,
  rollUpMisplaced,
  rollUpMissing,
  totalsOf,
  type ExpectedFile,
  type RemoteFile,
} from '../../src/rig/survey.ts';
import { browseDirectory, MAX_BROWSE_ENTRIES } from '../../src/rig/browse.ts';
import { csvField, formatMissingCsv, MISSING_CSV_COLUMNS } from '../../src/rig/missing-csv.ts';
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
/**
 * ============================================================================
 *  WINDOWS  --  THE SAME SURVEY, A DIFFERENT PROMISE
 * ============================================================================
 *
 * The port was resisted for one reason, recorded in CLAUDE.md: Windows has no
 * `-o rdonly`, so the kernel-enforced read-only guarantee cannot be had there.
 * The instruction was never "do not port it" -- it was "do not port it by
 * QUIETLY dropping that guarantee". So these assert the two things that keep it
 * loud: which promise each platform reports, and that a password never reaches
 * a prompt on a machine with no terminal to prompt on.
 *
 * None of this runs a command. The argv is built by pure functions and asserted
 * literally, exactly as the macOS side is.
 */
describe('the rig survey on Windows', () => {
  it('reads a UNC share, with the host and share through the same allowlists', () => {
    expect(uncPath('10.10.1.53', 'd3 Projects')).toBe('\\\\10.10.1.53\\d3 Projects');
    // The allowlists are not bypassed just because the path shape changed.
    expect(() => uncPath('10.10.1.999', 'd3 Projects')).toThrow(InvalidTargetError);
    expect(() => uncPath('10.10.1.53', 'a/b')).toThrow(InvalidTargetError);
    expect(() => uncPath('10.10.1.53', 'a"b')).toThrow(InvalidTargetError);
  });

  it('runs net.exe from the system root, never off PATH', () => {
    // A `net.exe` earlier in PATH than System32 is exactly the substitution an
    // absolute path exists to prevent.
    expect(netCommand({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows/System32/net.exe'.replace(/\//g, sepOf()));
    expect(netCommand({ windir: 'D:\\Win' })).toContain('System32');
    expect(netCommand({})).toContain('System32');
  });

  it('ALWAYS passes a password, because net use prompts without one', () => {
    // The Windows analogue of `mount_smbfs -N`. A server has no terminal to
    // prompt on, so a prompt is a hang, not a question.
    expect(netUseArgs({ username: 'd3' }, '\\\\h\\s')).toEqual([
      'use',
      '\\\\h\\s',
      '',
      '/user:d3',
      '/persistent:no',
    ]);
    expect(netUseArgs({ username: 'd3', password: 'pw' }, '\\\\h\\s')).toEqual([
      'use',
      '\\\\h\\s',
      'pw',
      '/user:d3',
      '/persistent:no',
    ]);
  });

  it('never leaves the connection behind for the next reboot', () => {
    expect(netUseArgs({}, '\\\\h\\s')).toContain('/persistent:no');
  });

  it('disconnects with /delete, and only ever one share', () => {
    expect(netDeleteArgs('\\\\h\\s')).toEqual(['use', '\\\\h\\s', '/delete', '/y']);
  });

  it('does not disconnect a session it did not make', async () => {
    // We only ran `net use` when a credential was supplied. Anything else is
    // the operator's own connection, and dropping it would reach outside what
    // this application connected -- the same rule that stops the Mac side
    // unmounting a volume it did not mount.
    await expect(
      disconnectShare({ mountPoint: null, session: null }, 'win32'),
    ).resolves.toBeUndefined();
  });

  it('refuses a platform that has neither implementation, in words', async () => {
    expect(rigPlatformOf('linux')).toBeNull();
    expect(rigPlatformOf('darwin')).toBe('darwin');
    expect(rigPlatformOf('win32')).toBe('win32');
    await expect(
      connectShare({ host: '10.10.1.53', share: 'd3 Projects' }, 'linux'),
    ).rejects.toThrow(/macOS or Windows/);
  });

  /**
   * THE ASSUMPTION THE WINDOWS FENCE RESTS ON.
   *
   * `ReadOnlyFs` refuses any path that does not resolve inside an allowed root,
   * and on Windows that root is a UNC share. This asserts the platform
   * behaviour that makes that work -- run against `path.win32` explicitly, so
   * it is checked on the Mac where the tests actually run. If Node ever changed
   * how it resolves a UNC path, the fence would move and this fires first.
   */
  it('fences a UNC share the way it fences a directory — per SHARE, not per host', () => {
    const root = String.raw`\\10.10.1.53\d3 Projects`;
    // The same normalise/compare `ReadOnlyFs` performs.
    const norm = (r: string): string => {
      const x = win32.resolve(r);
      return x.endsWith(win32.sep) ? x.slice(0, -1) : x;
    };
    const isUnder = (c: string, r: string): boolean => c === r || c.startsWith(r + win32.sep);

    expect(win32.isAbsolute(root)).toBe(true);
    expect(norm(root)).toBe(root);
    expect(win32.join(root, 'SHOW/objects/VideoFile')).toBe(
      String.raw`\\10.10.1.53\d3 Projects\SHOW\objects\VideoFile`,
    );

    expect(isUnder(norm(win32.join(root, 'SHOW')), norm(root))).toBe(true);
    // A DIFFERENT share on the same machine is outside. The fence is the share,
    // not the host -- otherwise surveying one share could read another.
    expect(isUnder(norm(String.raw`\\10.10.1.53\other`), norm(root))).toBe(false);
    expect(isUnder(norm(String.raw`C:\Windows`), norm(root))).toBe(false);
  });

  it('has no mount table to read off macOS, and does not go looking for one', async () => {
    // `/sbin/mount` does not exist on Windows; running it would fail with an
    // ENOENT that reads like a broken install rather than "there are no mounts".
    await expect(listSmbMounts('win32')).resolves.toEqual([]);
    await expect(listSmbMounts('linux')).resolves.toEqual([]);
  });
});

/** `path.join` uses the platform separator; the test states the expectation. */
function sepOf(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

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
  // Region 1 and 2 are this machine's; anything else belongs elsewhere. The
  // real one is the scan's parser; this reads the same two tokens off a name.
  const opts = {
    regions: [1, 2],
    describeName: (n: string) => {
      const m = /_(v\d+[a-z]?)_region(\d+)\./.exec(n);
      if (!m) return null;
      return { region: Number(m[2]), verLabel: m[1] as string, base: n.split('_v')[0] as string };
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
      [
        onDisk('a_v004_region7.mov', 10),
        onDisk('b_v004_region1.mov', 15),
        onDisk('holiday-photo.jpg', 20),
      ],
      [],
      opts,
    );
    // Region 7 is somebody else's; region 1 is this machine's, so a file the
    // archive has no row for is unexpected media HERE; the photo is a name
    // nothing in this grammar can read.
    expect(c.extraForeign.map((x) => x.name)).toEqual(['a_v004_region7.mov']);
    expect(c.extraUnknown.map((x) => x.name)).toEqual(['b_v004_region1.mov']);
    expect(c.extraUnparsed.map((x) => x.name)).toEqual(['holiday-photo.jpg']);
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
      c.extraUnknown.length +
      c.extraUnparsed.length +
      c.regionless.length;
    expect(bucketed).toBe(actual.length);
    expect(c.actual).toEqual({ count: 5, bytes: 150 });
  });

  /**
   * A file with no region belongs to no machine, because the allocation is BY
   * region. Reporting one as extra on a machine is a finding that is not there,
   * and on the real rig it was 388 of them on one machine -- 0.63 TiB of
   * whole-canvas deliverables read as strangers. Confirmed with the user:
   * *"if not in the archive at all just means content without a region ignore
   * these files"*.
   */
  it('does not treat a file with no region as extra: it belongs to no machine', () => {
    const c = compareMachine(
      [onDisk('888_IMAG_LARS_EDIT_RECT_v001.mov', 10)],
      [],
      {
        regions: [1, 2],
        // A valid name the grammar reads -- it simply carries no region.
        describeName: () => ({ region: null, verLabel: 'v001', base: '888_IMAG_LARS_EDIT_RECT' }),
      },
    );
    expect(c.regionless.map((x) => x.name)).toEqual(['888_IMAG_LARS_EDIT_RECT_v001.mov']);
    expect(c.extraUnknown).toEqual([]);
    expect(c.extraForeign).toEqual([]);
    // Still counted, or the arithmetic would stop closing.
    expect(totalsOf(c).regionlessFiles).toBe(1);
    expect(c.actual.count).toBe(1);
  });

  /**
   * A name nothing here can read is NOT the same as a name with no region.
   * `120_LIQUID_CUE_H_LL180_v006_region0_proxy3.mov` writes its tokens in the
   * wrong order and is real, on the real rig; so is a stray with no version at
   * all. Merging them into the regionless pile would hide both.
   */
  it('keeps an unreadable name apart from a name with no region', () => {
    const c = compareMachine([onDisk('RORSCHACH_Processed_260723.mov', 10)], [], {
      regions: [1, 2],
      describeName: () => null,
    });
    expect(c.extraUnparsed.map((x) => x.name)).toEqual(['RORSCHACH_Processed_260723.mov']);
    expect(c.regionless).toEqual([]);
  });

  it('reads the region, version and base off a name the archive does not have', () => {
    const c = compareMachine([onDisk('b_v009_region7.mov', 10)], [], opts);
    // Region 7 is another machine's, so this is a copy in the wrong place --
    // and the row can say which version and which slice without the index.
    expect(c.extraForeign[0]).toMatchObject({ region: 7, verLabel: 'v009', base: 'b' });
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
  /**
   * The actors. THE UNDERSTUDY IS A BACKUP, and that is what decides every
   * state below. Confirmed by the user: *"the understudy machines are backups,
   * so if files are not found on the main (actor) machine they are missing."*
   */
  const primaries = new Set(['103', '104']);

  it('is MISSING when the machine that plays it has not got it, and nothing else has either', () => {
    // The finding that matters most: the show cannot play it and the rig cannot
    // supply it, so it has to come back from the archive.
    const r = rollUpMissing(
      [machine('103', [file('a_region4.mov', 4)]), machine('208', [file('a_region4.mov', 4)])],
      holders,
      primaries,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      state: 'missing',
      missingFrom: ['103', '208'],
      presentOn: [],
      unknownOn: [],
      primaryOn: ['103'],
    });
    expect(r.counts.missing).toBe(1);
    expect(r.unplayable.files).toBe(1);
  });

  /**
   * THE RULE THAT REPLACED `reduced`. A copy on the understudy does not put the
   * file on screen: the actor is what plays. The old reading called this "the
   * show still plays", which was wrong, and it was wrong quietly.
   */
  it('is RECOVERABLE, not fine, when only the backup has it — the actor is what plays', () => {
    const r = rollUpMissing(
      [machine('103', [file('a_region4.mov', 4)]), machine('208', [])],
      holders,
      primaries,
    );
    expect(r.rows[0]).toMatchObject({
      state: 'recoverable',
      missingFrom: ['103'],
      presentOn: ['208'],
    });
    // Still an alarm, and still not `missing`: it can be restored from the rig
    // rather than from the archive, which is the only difference.
    expect(r.counts.missing).toBe(0);
    expect(r.unplayable.files).toBe(1);
  });

  it('is SPARE LOST when the actor has it and the backup does not — the one state that is not an alarm', () => {
    const r = rollUpMissing(
      [machine('103', []), machine('208', [file('a_region4.mov', 4)])],
      holders,
      primaries,
    );
    expect(r.rows[0]).toMatchObject({
      state: 'spareLost',
      missingFrom: ['208'],
      presentOn: ['103'],
    });
    expect(r.unplayable.files).toBe(0);
  });

  it('is UNCONFIRMED when the machine that PLAYS it was not surveyed', () => {
    // THE HONESTY RULE, now correctly scoped. 103 is the actor and was not
    // read; 208 is a backup and its answer cannot settle the question.
    const r = rollUpMissing([machine('208', [file('a_region4.mov', 4)])], holders, primaries);
    expect(r.rows[0]).toMatchObject({
      state: 'unconfirmed',
      missingFrom: ['208'],
      unknownOn: ['103'],
      presentOn: [],
    });
    expect(r.counts.missing).toBe(0);
    expect(r.unsurveyedHolders).toEqual(['103']);
    // And it says the omission is one that matters: an unread ACTOR is a
    // finding this list cannot make at all.
    expect(r.unsurveyedPrimaries).toEqual(['103']);
  });

  /**
   * The real rig, first run: one actor surveyed, its understudy not. Under the
   * old reading all 1,292 files came back `unconfirmed` — "we did not look at
   * 207". Under the user's rule they are missing from the machine that plays
   * them, and 207 could only have made them recoverable, never fine.
   */
  it('is an alarm when the actor is missing it and only the BACKUP was unsurveyed', () => {
    const r = rollUpMissing([machine('103', [file('a_region4.mov', 4)])], holders, primaries);
    expect(r.rows[0]).toMatchObject({ state: 'missing', missingFrom: ['103'], unknownOn: ['208'] });
    expect(r.unsurveyedPrimaries).toEqual([]);
    // The list still says a machine was not read: `missing` here means "no machine
    // we looked at has it", and the UI must not upgrade that to "it exists
    // nowhere". 208 stays visible as an unanswered question.
    expect(r.unsurveyedHolders).toEqual(['208']);
  });

  it('does not treat a wrong-sized copy as a copy', () => {
    // Whatever that file is, it is not the one the archive recorded. Counting
    // it as a copy would turn a `missing` into a `recoverable` and hide the fact
    // that the archive is the only place left to get it from.
    const r = rollUpMissing(
      [
        machine('103', [file('a_region4.mov', 4)]),
        machine('208', [], [{ name: 'a_region4.mov' }]),
      ],
      holders,
      primaries,
    );
    expect(r.rows[0]).toMatchObject({
      state: 'missing',
      wrongSizeOn: ['208'],
      presentOn: [],
    });
  });

  it('collapses one file reported by several machines into one row', () => {
    const r = rollUpMissing(
      [machine('103', [file('a_region4.mov', 4)]), machine('208', [file('a_region4.mov', 4)])],
      holders,
      primaries,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.missingFrom).toEqual(['103', '208']);
  });

  it('ignores a machine that failed, rather than reading it as complete', () => {
    const failed = { machineId: '103', error: 'not reachable', comparison: null };
    const r = rollUpMissing([machine('208', [file('a_region4.mov', 4)]), failed], holders, primaries);
    // The actor errored, so it is unknown -- and unknown on the machine that
    // decides is the whole of what `unconfirmed` now means.
    expect(r.rows[0]?.state).toBe('unconfirmed');
    expect(r.rows[0]?.unknownOn).toEqual(['103']);
  });

  it('orders missing first, then recoverable, then unconfirmed, then spare lost, biggest first', () => {
    const r = rollUpMissing(
      [
        machine('103', [file('missing.mov', 4, 10), file('small-missing.mov', 4, 1), file('recoverable.mov', 4, 999)]),
        machine('208', [file('missing.mov', 4, 10), file('small-missing.mov', 4, 1), file('spare-lost.mov', 5, 5000)]),
        machine('104', []),
      ],
      holders,
      primaries,
    );
    expect(r.rows.map((x) => x.name)).toEqual([
      'missing.mov',
      'small-missing.mov',
      'recoverable.mov',
      'spare-lost.mov',
    ]);
    expect(r.rows.map((x) => x.state)).toEqual(['missing', 'missing', 'recoverable', 'spareLost']);
  });

  it('rolls up per region in canvas order, naming who carries it and who plays it', () => {
    const r = rollUpMissing(
      [
        machine('103', [file('a_region4.mov', 4, 10)]),
        machine('208', [file('a_region4.mov', 4, 10), file('b_region5.mov', 5, 500)]),
        machine('104', []),
      ],
      holders,
      primaries,
    );
    expect(r.byRegion[0]).toMatchObject({
      region: 4,
      holders: ['103', '208'],
      primaries: ['103'],
      files: 1,
      missing: 1,
      unplayable: 1,
      state: 'short',
    });
    // Region 5's actor has it; only the spare is gone, so the region is not an
    // alarm however many bytes it is.
    expect(r.byRegion[1]).toMatchObject({ region: 5, missing: 0, unplayable: 0, state: 'spare' });
  });

  /**
   * THE STATE THIS STRIP EXISTS FOR. A region nobody looked at used to be
   * absent from the tab entirely, which reads exactly like a region that is
   * fine. Confirmed by the user in the region 0 case: *"if region 0 is missing
   * from 306 mark it as such"* -- and the honest first answer, before 306 is
   * surveyed, is that nobody has looked.
   */
  it('covers EVERY region, not only the ones with findings', () => {
    const r = rollUpMissing([machine('103', [])], holders, primaries);
    expect(r.byRegion.map((x) => x.region)).toEqual([4, 5]);
    // 103 plays region 4 and was read: nothing wrong with it.
    expect(r.byRegion[0]).toMatchObject({ region: 4, state: 'ok', surveyedPrimaries: ['103'] });
    // 104 plays region 5 and was NOT read. Not `ok`, and never silently absent.
    expect(r.byRegion[1]).toMatchObject({ region: 5, state: 'unsurveyed', surveyedPrimaries: [] });
  });

  it('marks a region short when its own machine is missing files, and says how much', () => {
    const r = rollUpMissing(
      [machine('103', [file('a_region4.mov', 4, 700)]), machine('208', [])],
      holders,
      primaries,
    );
    expect(r.byRegion[0]).toMatchObject({
      region: 4,
      state: 'short',
      unplayable: 1,
      unplayableBytes: 700,
    });
  });

  /**
   * With no roles to go on -- an allocation that names none, or machine ids
   * this rig does not know -- every holder decides. That is the old
   * any-copy-will-do behaviour, and it is the only safe reading without them.
   */
  it('falls back to treating every holder as equal when none is a primary', () => {
    const r = rollUpMissing(
      [machine('103', [file('a_region4.mov', 4)]), machine('208', [])],
      holders,
      new Set(),
    );
    expect(r.rows[0]?.state).toBe('spareLost');
  });

  it('is clean when nothing is missing anywhere', () => {
    const r = rollUpMissing([machine('103', []), machine('208', [])], holders, primaries);
    expect(r.clean).toBe(true);
    expect(r.rows).toEqual([]);
    expect(r.unsurveyedHolders).toEqual([]);
    expect(r.unplayable).toEqual({ files: 0, bytes: 0 });
  });

  it('is served by the status route even before a survey has run', async () => {
    const { body } = await req('GET', '/api/rig/status');
    expect(body.survey.missing).toMatchObject({ rows: [], clean: true });
  });
});

/**
 * ============================================================================
 *  REGION 0 BELONGS TO THE DIRECTOR MACHINES
 * ============================================================================
 *
 * **Confirmed by the user:** *"306 should have region 0s include that in the
 * analysis, 307 is an understudy for 306 so should have region 0 content as
 * well."*
 *
 * The allocation has said so since it was written, and `machines.test.ts` pins
 * that. What was only ever INCIDENTAL is what the rig survey does with it, and
 * that is what these assert: region 0 is a legitimate holding on 306 and 307,
 * an anomaly anywhere else, and 306 -- not 307 -- is the machine whose absence
 * is the finding.
 *
 * The archive's own rules point the other way and stay that way: region 0 is
 * never a slice, never a required region, never counted in `region_count`.
 * Those are statements about what a VERSION must contain. This is a statement
 * about which machine holds a delivered file, and the two do not meet.
 */
describe('region 0 on the rig', () => {
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
  const result = (machineId: string, missingKept: ExpectedFile[] = []) => ({
    machineId,
    error: null,
    comparison: {
      missingKept,
      missingSuperseded: [],
      sizeMismatch: [],
      presentSuperseded: [],
      presentKept: { count: 0, bytes: 0 },
      extraForeign: [],
      extraUnknown: [],
      extraUnparsed: [],
      regionless: [],
      actual: { count: 0, bytes: 0 },
      expected: { count: 0, bytes: 0 },
      nameCollisions: 0,
    },
  }) as unknown as Parameters<typeof rollUpMissing>[0][number];

  const holders = new Map<number, string[]>([[0, ['306', '307']]]);
  /** 306 is the director and plays region 0; 307 backs it up. */
  const primaries = new Set(['306']);
  const proxy = 'a_v004_proxy3_region0.mov';

  it('is a legitimate holding on the director, not something extra', () => {
    const c = compareMachine(
      [{ relPath: proxy, name: proxy, size: 100, mtime: 1 }],
      [file(proxy, 0)],
      {
        regions: [0],
        describeName: () => ({ region: 0, verLabel: 'v004', base: 'a' }),
      },
    );
    expect(c.presentKept).toEqual({ count: 1, bytes: 100 });
    expect(c.extraForeign).toEqual([]);
    expect(totalsOf(c).inSync).toBe(true);
  });

  it('is expected there: absent from the director, it is the alarm', () => {
    const c = compareMachine([], [file(proxy, 0)], {
      regions: [0],
      describeName: () => ({ region: 0, verLabel: 'v004', base: 'a' }),
    });
    expect(c.missingKept.map((f) => f.name)).toEqual([proxy]);
  });

  it('belongs to another machine when it turns up on an actor', () => {
    // What the real rig shows: 2,584 region 0 proxies sitting on 101, which
    // carries region 1. Not "unknown", not ignored -- somebody else's media.
    const c = compareMachine(
      [{ relPath: proxy, name: proxy, size: 100, mtime: 1 }],
      [],
      { regions: [1], describeName: () => ({ region: 0, verLabel: 'v004', base: 'a' }) },
    );
    expect(c.extraForeign.map((f) => f.name)).toEqual([proxy]);
    expect(c.extraUnknown).toEqual([]);
    expect(c.regionless).toEqual([]);
  });

  it('is RECOVERABLE when only 307 has it — the understudy is a backup here too', () => {
    const r = rollUpMissing([result('306', [file(proxy, 0)]), result('307')], holders, primaries);
    expect(r.rows[0]).toMatchObject({
      state: 'recoverable',
      missingFrom: ['306'],
      presentOn: ['307'],
      primaryOn: ['306'],
    });
  });

  it('is MISSING when neither director machine has it', () => {
    const r = rollUpMissing(
      [result('306', [file(proxy, 0)]), result('307', [file(proxy, 0)])],
      holders,
      primaries,
    );
    expect(r.rows[0]?.state).toBe('missing');
    expect(r.unplayable.files).toBe(1);
  });

  /**
   * *"if region 0 is missing from 306 mark it as such in the region gaps
   * (cluster) section."* -- the user. The strip carries region 0 like any other
   * region, and says which of the three things is true of it.
   */
  it('marks region 0 SHORT when 306 has not got it', () => {
    const r = rollUpMissing([result('306', [file(proxy, 0)]), result('307')], holders, primaries);
    expect(r.byRegion).toHaveLength(1);
    expect(r.byRegion[0]).toMatchObject({
      region: 0,
      primaries: ['306'],
      holders: ['306', '307'],
      state: 'short',
      unplayable: 1,
      unplayableBytes: 100,
    });
  });

  it('marks region 0 NOT SURVEYED until 306 is actually read', () => {
    // The honest state of the real rig today: region 0 has never been looked
    // at, and that is not the same as region 0 being fine.
    const r = rollUpMissing([result('101')], holders, primaries);
    expect(r.byRegion[0]).toMatchObject({ region: 0, state: 'unsurveyed', surveyedPrimaries: [] });
  });

  it('marks region 0 OK once 306 is read and is short of nothing', () => {
    const r = rollUpMissing([result('306'), result('307')], holders, primaries);
    expect(r.byRegion[0]).toMatchObject({ region: 0, state: 'ok', surveyedPrimaries: ['306'] });
  });

  it('sends a stray region 0 file home to 306 and 307', () => {
    const found = {
      relPath: `100_ALPHA/${proxy}`,
      name: proxy,
      size: 100,
      mtime: 1,
      region: 0,
      verLabel: 'v004',
      base: 'a',
    };
    const onActor = {
      machineId: '101',
      error: null,
      comparison: {
        missingKept: [],
        missingSuperseded: [],
        sizeMismatch: [],
        presentSuperseded: [],
        presentKept: { count: 0, bytes: 0 },
        extraForeign: [found],
        extraUnknown: [],
        extraUnparsed: [],
        regionless: [],
        actual: { count: 0, bytes: 0 },
        expected: { count: 0, bytes: 0 },
        nameCollisions: 0,
      },
    } as unknown as Parameters<typeof rollUpMisplaced>[0][number];
    const archive = new Map([[proxy, 'kept' as const]]);

    // Neither director surveyed: it cannot be told whether this copy is needed.
    const unread = rollUpMisplaced([onActor], holders, archive);
    expect(unread.rows[0]).toMatchObject({
      state: 'unconfirmed',
      belongsOn: ['306', '307'],
      unknownOn: ['306', '307'],
    });

    // 306 surveyed and short of it: the nearest copy is on 101.
    const read = rollUpMisplaced([onActor, result('306', [file(proxy, 0)]), result('307')], holders, archive);
    expect(read.rows[0]).toMatchObject({ state: 'rescue', needIt: ['306'], haveIt: ['307'] });
  });
});

/**
 * ============================================================================
 *  MEDIA THAT IS HERE, AND IN THE WRONG PLACE
 * ============================================================================
 *
 * The counterpart to the missing list, and the failure to guard against is the
 * mirror image of that one: calling a stray copy USEFUL when the machine it
 * belongs on already has it (busywork), or calling it useless when that machine
 * is short of it (a file that could have been put back in a minute, restored
 * from the archive over a night instead).
 */
describe('the roll-up of media on the wrong machine', () => {
  const foreign = (name: string, region: number, size = 100) => ({
    relPath: `100_ALPHA/${name}`,
    name,
    size,
    mtime: 1,
    region,
    verLabel: 'v004',
    base: '100_ALPHA_MAIN_LL180',
  });

  const expected = (name: string, region: number, size = 100): ExpectedFile => ({
    name,
    size,
    region,
    songFolder: '100_ALPHA',
    base: '100_ALPHA_MAIN_LL180',
    verLabel: 'v004',
    versionId: 1,
    status: 'kept',
  });

  /** A machine result carrying only the lists this roll-up reads. */
  const machine = (
    machineId: string,
    over: {
      extraForeign?: ReturnType<typeof foreign>[];
      missingKept?: ExpectedFile[];
      missingSuperseded?: ExpectedFile[];
      sizeMismatch?: { name: string }[];
      presentSuperseded?: { name: string }[];
    } = {},
  ) => ({
    machineId,
    error: null,
    comparison: {
      missingKept: over.missingKept ?? [],
      missingSuperseded: over.missingSuperseded ?? [],
      sizeMismatch: over.sizeMismatch ?? [],
      presentSuperseded: over.presentSuperseded ?? [],
      extraForeign: over.extraForeign ?? [],
      extraUnknown: [],
      extraUnparsed: [],
      regionless: [],
      presentKept: { count: 0, bytes: 0 },
      actual: { count: 0, bytes: 0 },
      expected: { count: 0, bytes: 0 },
      nameCollisions: 0,
    },
  }) as unknown as Parameters<typeof rollUpMisplaced>[0][number];

  // Region 7 belongs on 106 (actor) and 301 (understudy). 101 carries region 1
  // and has no business holding a region 7 file.
  const holders = new Map<number, string[]>([[7, ['106', '301']]]);
  const archive = new Map<string, 'kept' | 'superseded' | 'unknown'>([
    ['a_v004_region7.mov', 'kept'],
  ]);

  it('is a RESCUE when a machine that should have it is short of it', () => {
    const r = rollUpMisplaced(
      [
        machine('101', { extraForeign: [foreign('a_v004_region7.mov', 7)] }),
        machine('106', { missingKept: [expected('a_v004_region7.mov', 7)] }),
        machine('301', {}),
      ],
      holders,
      archive,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      state: 'rescue',
      foundOn: ['101'],
      belongsOn: ['106', '301'],
      needIt: ['106'],
      haveIt: ['301'],
    });
    expect(r.counts.rescue).toBe(1);
  });

  it('is a DUPLICATE when every machine that should have it already does', () => {
    const r = rollUpMisplaced(
      [machine('101', { extraForeign: [foreign('a_v004_region7.mov', 7)] }), machine('106', {}), machine('301', {})],
      holders,
      archive,
    );
    // Space on the wrong drive. A cleanup, not a job for tonight.
    expect(r.rows[0]).toMatchObject({ state: 'duplicate', needIt: [], haveIt: ['106', '301'] });
    expect(r.counts.rescue).toBe(0);
  });

  it('is UNCONFIRMED when a machine that should have it was not surveyed', () => {
    const r = rollUpMisplaced(
      [machine('101', { extraForeign: [foreign('a_v004_region7.mov', 7)] }), machine('106', {})],
      holders,
      archive,
    );
    expect(r.rows[0]).toMatchObject({ state: 'unconfirmed', unknownOn: ['301'] });
    expect(r.unsurveyedHolders).toEqual(['301']);
  });

  /**
   * The guard the archive map exists for. Nobody reports a file the archive has
   * never seen as missing -- so without that map, silence would read as "the
   * right machines already have it", which is not evidence of anything.
   */
  it('does not call a file the archive has never seen a duplicate', () => {
    const r = rollUpMisplaced(
      [machine('101', { extraForeign: [foreign('stranger_v001_region7.mov', 7)] }), machine('106', {}), machine('301', {})],
      holders,
      archive,
    );
    expect(r.rows[0]).toMatchObject({ state: 'unknown', archiveStatus: null });
  });

  it('never calls a superseded file a rescue, however few copies exist', () => {
    // The archive has replaced it, so no machine is short of it and moving it
    // would be moving old media around the rig.
    const r = rollUpMisplaced(
      [
        machine('101', { extraForeign: [foreign('a_v004_region7.mov', 7)] }),
        machine('106', { missingSuperseded: [expected('a_v004_region7.mov', 7)] }),
        machine('301', {}),
      ],
      holders,
      new Map([['a_v004_region7.mov', 'superseded' as const]]),
    );
    expect(r.rows[0]).toMatchObject({ state: 'duplicate', archiveStatus: 'superseded' });
  });

  it('treats a wrong-sized copy on the rightful machine as needing it', () => {
    // Same rule as the missing roll-up, pointing the same way: whatever that
    // file is, it is not the one the archive recorded.
    const r = rollUpMisplaced(
      [
        machine('101', { extraForeign: [foreign('a_v004_region7.mov', 7)] }),
        machine('106', { sizeMismatch: [{ name: 'a_v004_region7.mov' }] }),
        machine('301', {}),
      ],
      holders,
      archive,
    );
    expect(r.rows[0]).toMatchObject({ state: 'rescue', needIt: ['106'] });
  });

  it('collapses one file found on several machines into one row', () => {
    const r = rollUpMisplaced(
      [
        machine('101', { extraForeign: [foreign('a_v004_region7.mov', 7)] }),
        machine('102', { extraForeign: [foreign('a_v004_region7.mov', 7)] }),
        machine('106', { missingKept: [expected('a_v004_region7.mov', 7)] }),
        machine('301', {}),
      ],
      holders,
      archive,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.foundOn).toEqual(['101', '102']);
  });

  it('orders rescues first and counts the space either way', () => {
    const r = rollUpMisplaced(
      [
        machine('101', {
          extraForeign: [foreign('a_v004_region7.mov', 7, 10), foreign('b_v004_region7.mov', 7, 900)],
        }),
        machine('106', { missingKept: [expected('a_v004_region7.mov', 7, 10)] }),
        machine('301', {}),
      ],
      holders,
      new Map([
        ['a_v004_region7.mov', 'kept' as const],
        ['b_v004_region7.mov', 'kept' as const],
      ]),
    );
    expect(r.rows.map((x) => x.state)).toEqual(['rescue', 'duplicate']);
    // The header counts every misplaced byte, not just the actionable ones:
    // all of it is space sitting on the wrong drive.
    expect(r.total).toEqual({ files: 2, bytes: 910 });
  });

  it('is clean when nothing is out of place', () => {
    const r = rollUpMisplaced([machine('101', {}), machine('106', {})], holders, archive);
    expect(r.clean).toBe(true);
    expect(r.rows).toEqual([]);
  });

  it('is served by the status route even before a survey has run', async () => {
    const { body } = await req('GET', '/api/rig/status');
    expect(body.survey.misplaced).toMatchObject({ rows: [], clean: true });
  });
});

/**
 * ============================================================================
 *  THE MASTER LIST AS A CSV
 * ============================================================================
 *
 * Two things could go wrong here and neither would be loud. The export could
 * carry something the rig session promises never to write down -- an address,
 * a password -- or it could quietly stop where the TABLE stops and hand over a
 * list of findings with findings missing from it.
 */
describe('exporting the master list', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    name: 'a_v004_region4.mov',
    size: 100,
    region: 4,
    songFolder: '100_ALPHA',
    base: '100_ALPHA_MAIN_LL180',
    verLabel: 'v004',
    missingFrom: ['103'],
    wrongSizeOn: [],
    presentOn: ['208'],
    unknownOn: [],
    primaryOn: ['103'],
    state: 'recoverable',
    ...over,
  }) as unknown as Parameters<typeof formatMissingCsv>[0]['rows'][number];

  it('writes a header and one line per row, CRLF, ending on a row boundary', () => {
    const csv = formatMissingCsv({ rows: [row(), row({ name: 'b_v004_region4.mov' })] });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(MISSING_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(4); // header, two rows, and the trailing break
    expect(lines[3]).toBe('');
    expect(lines[1]).toBe('recoverable,100_ALPHA,a_v004_region4.mov,v004,4,100,103,208,,');
  });

  it('carries BYTES, not a formatted size — a sheet can add up a number', () => {
    const csv = formatMissingCsv({ rows: [row({ size: 51114466479 })] });
    expect(csv).toContain(',51114466479,');
    expect(csv).not.toMatch(/TiB|GiB/);
  });

  it('puts several machines in one cell without breaking the row', () => {
    const csv = formatMissingCsv({ rows: [row({ missingFrom: ['103', '208'], presentOn: [] })] });
    // Space-separated: a machine id cannot contain a space, so no quoting is
    // needed and no comma is introduced into a comma-separated file.
    expect(csv).toContain(',103 208,');
    expect(csv.trimEnd().split('\r\n')).toHaveLength(2);
  });

  it('escapes a quote, a comma and a line break rather than corrupting the file', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    const csv = formatMissingCsv({ rows: [row({ name: 'weird,name "quoted".mov' })] });
    expect(csv).toContain('"weird,name ""quoted"".mov"');
  });

  it('exports EVERY row, never the visible ones — the tab caps at 500, this does not', () => {
    const rows = Array.from({ length: 900 }, (_, i) => row({ name: `f${i}_v004_region4.mov` }));
    const csv = formatMissingCsv({ rows });
    expect(csv.trimEnd().split('\r\n')).toHaveLength(901);
  });

  it('keeps the roll-up\'s order, which is the order the findings matter in', () => {
    const csv = formatMissingCsv({
      rows: [row({ state: 'missing', name: 'first.mov' }), row({ state: 'spareLost', name: 'last.mov' })],
    });
    const lines = csv.split('\r\n');
    expect(lines[1]).toContain('first.mov');
    expect(lines[2]).toContain('last.mov');
  });

  describe('the route', () => {
    it('serves it as an attachment, without writing a file', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/rig/missing.csv' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      // An empty session still answers with a well-formed file: a header and
      // nothing else, rather than a 404 or an empty body.
      expect(res.body).toBe(`${MISSING_CSV_COLUMNS.join(',')}\r\n`);
    });

    /**
     * THE ONE THAT MATTERS. Addresses and the credential live in `RigSession`
     * and are promised never to be written anywhere; this is the only file the
     * rig tab can produce besides the target YAML, so it is asserted the same
     * way that one is -- behaviourally, against a session that actually holds
     * both.
     */
    it('NEVER contains an address or a credential', async () => {
      await req('POST', '/api/rig/targets', { text: '103 10.10.1.53\n208 10.10.1.54' });
      await req('POST', '/api/rig/credentials', { username: 'd3', password: 'hunter2' });
      const res = await app.inject({ method: 'GET', url: '/api/rig/missing.csv' });
      expect(res.body).not.toContain('10.10.1.53');
      expect(res.body).not.toContain('10.10.1.54');
      expect(res.body).not.toContain('hunter2');
      await req('DELETE', '/api/rig/session');
    });
  });
});

/**
 * ============================================================================
 *  BROWSING FOR THE DIRECTORY
 * ============================================================================
 *
 * The survey takes one directory and applies it to every machine, and until
 * this existed the only way to supply one was to type it from memory. That is
 * the one input on this tab whose mistake is SILENT: a directory that is not
 * there surveys as an empty machine, and an empty machine compares as a rig
 * with nothing on it -- or, if the archive expects nothing of it, as a clean
 * one. So the picker matters, and so does the fence around it.
 *
 * Nothing here mounts anything. The mountpoint is a local sandbox directory,
 * which is exactly what `browseDirectory` is handed in production: a path this
 * Mac can read, fenced to itself by `ReadOnlyFs`.
 */
describe('choosing the directory off the machine instead of typing it', () => {
  let sandbox: string;

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'metal-media-size-browse-'));
    mkdirSync(join(sandbox, 'share', 'SHOW_2026', '01_Media'), { recursive: true });
    mkdirSync(join(sandbox, 'share', 'SHOW_2026', '02_Backup'), { recursive: true });
    mkdirSync(join(sandbox, 'share', 'SHOW_2026', '10_Late'), { recursive: true });
    mkdirSync(join(sandbox, 'share', 'SHOW_2026', '2_Middle'), { recursive: true });
    mkdirSync(join(sandbox, 'outside-the-share'), { recursive: true });
    writeFileSync(join(sandbox, 'share', 'SHOW_2026', '01_Media', 'a_v001_region1.mov'), 'x');
    writeFileSync(join(sandbox, 'share', 'SHOW_2026', '01_Media', 'a_v001_region2.mov'), 'xx');
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  const share = (): string => join(sandbox, 'share');

  it('lists the folders one level down, with the path the survey takes', async () => {
    const listing = await browseDirectory({ readRoot: share(), directory: 'SHOW_2026' });
    expect(listing.directories.map((d) => d.name)).toEqual([
      '01_Media',
      '02_Backup',
      '2_Middle',
      '10_Late',
    ]);
    // Relative to the SHARE ROOT, not to the directory listed: it goes straight
    // into the survey field, which is defined that way.
    expect(listing.directories[0]?.path).toBe('SHOW_2026/01_Media');
  });

  it('orders 10 after 2, because a show numbers its folders', async () => {
    const listing = await browseDirectory({ readRoot: share(), directory: 'SHOW_2026' });
    const names = listing.directories.map((d) => d.name);
    expect(names.indexOf('2_Middle')).toBeLessThan(names.indexOf('10_Late'));
  });

  it('counts the files sitting here without opening one', async () => {
    const listing = await browseDirectory({
      readRoot: share(),
      directory: 'SHOW_2026/01_Media',
    });
    expect(listing.fileCount).toBe(2);
    expect(listing.directories).toEqual([]);
    // No size anywhere in the payload: sizes would cost a round trip per file
    // on an SMB share, and comparing them is the survey's job.
    expect(JSON.stringify(listing)).not.toMatch(/size/i);
  });

  it('knows where the way back up is, and that the share root has none', async () => {
    expect((await browseDirectory({ readRoot: share(), directory: '' })).parent).toBeNull();
    expect((await browseDirectory({ readRoot: share(), directory: 'SHOW_2026' })).parent).toBe('');
    expect(
      (await browseDirectory({ readRoot: share(), directory: 'SHOW_2026/01_Media' })).parent,
    ).toBe('SHOW_2026');
  });

  it('cannot be walked out of the share, even given a path that tries', async () => {
    // The route refuses `..` with a readable message; this is the structural
    // refusal underneath it, which holds whatever the route does.
    await expect(
      browseDirectory({ readRoot: share(), directory: '../outside-the-share' }),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
  });

  it('does not follow a symlink out, and does not offer one as a folder', async () => {
    symlinkSync(join(sandbox, 'outside-the-share'), join(share(), 'escape-hatch'), 'dir');
    const listing = await browseDirectory({ readRoot: share(), directory: '' });
    expect(listing.directories.map((d) => d.name)).toEqual(['SHOW_2026']);
    // Nor is it quietly counted as a file, which would misdescribe the place.
    expect(listing.fileCount).toBe(0);
  });

  it('says when the list is cut short, rather than reading as complete', async () => {
    const many = join(sandbox, 'many');
    for (let i = 0; i < MAX_BROWSE_ENTRIES + 5; i += 1) {
      mkdirSync(join(many, `d${String(i).padStart(4, '0')}`), { recursive: true });
    }
    const listing = await browseDirectory({ readRoot: sandbox, directory: 'many' });
    expect(listing.directories).toHaveLength(MAX_BROWSE_ENTRIES);
    expect(listing.truncated).toBe(true);
  });

  describe('the route', () => {
    afterAll(async () => {
      // Leave the shared session exactly as it was found: the other route
      // tests read a rig with nothing mounted.
      await req('DELETE', '/api/rig/session');
    });

    it('refuses to browse when no machine is mounted', async () => {
      await req('DELETE', '/api/rig/session');
      const { status, body } = await req('GET', '/api/rig/browse');
      expect(status).toBe(400);
      expect(body.error.code).toBe('not_connected');
    });

    it('refuses a directory that tries to leave the share', async () => {
      const { status, body } = await req('GET', '/api/rig/browse?directory=../..');
      expect(status).toBe(400);
      expect(body.error.code).toBe('bad_directory');
    });

    it('lists one machine, and says which one it read', async () => {
      await req('POST', '/api/rig/targets', { text: '301 10.10.1.53\n302 10.10.1.54' });
      connectAt(ctx, '10.10.1.53', share());
      connectAt(ctx, '10.10.1.54', join(sandbox, 'outside-the-share'));

      const { status, body } = await req('GET', '/api/rig/browse?directory=SHOW_2026');
      expect(status).toBe(200);
      // Named, never inferred by the UI: the survey applies this path to every
      // machine, and a path present on 301 and absent on 302 is a finding the
      // SURVEY makes. Browsing must not stand in for it.
      expect(body.host).toBe('10.10.1.53');
      expect(body.machineId).toBe('301');
      expect(body.mountedHosts).toHaveLength(2);
      expect(body.directories.map((d: { name: string }) => d.name)).toContain('01_Media');
    });

    it('reads the machine that was asked for', async () => {
      const { body } = await req('GET', '/api/rig/browse?host=10.10.1.54');
      expect(body.machineId).toBe('302');
      expect(body.directories).toEqual([]);
    });

    it('refuses a machine that is not mounted, rather than picking another', async () => {
      const { status, body } = await req('GET', '/api/rig/browse?host=10.10.1.99');
      expect(status).toBe(400);
      expect(body.error.code).toBe('unknown_host');
    });

    it('says a directory is not there, instead of reporting it empty', async () => {
      const { status, body } = await req('GET', '/api/rig/browse?directory=SHOW_2027');
      expect(status).toBe(400);
      expect(body.error.code).toBe('no_such_directory');
    });

    it('never touches a file: the sandbox is unchanged afterwards', () => {
      // Names and directory entries only -- the same promise the survey makes.
      expect(readdirSync(join(share(), 'SHOW_2026', '01_Media')).sort()).toEqual([
        'a_v001_region1.mov',
        'a_v001_region2.mov',
      ]);
    });
  });
});

/**
 * Put a read root on a target without connecting to anything.
 *
 * `connect()` runs `mount_smbfs` or `net use`, which need a rig on the other
 * end of a network. Everything downstream only ever reads `readRoot`, so a
 * local directory stands in for one exactly -- which is also the point: the
 * survey does not care whether that path is a mountpoint or a UNC share.
 */
function connectAt(context: AppContext, host: string, readRoot: string): void {
  const target = context.rig.getTargets().find((t) => t.host === host);
  if (!target) throw new Error(`No target ${host} in the session`);
  (target as { readRoot: string | null }).readRoot = readRoot;
}

/**
 * =============================================================================
 *  MOUNT CHOKEPOINT  --  THE ONLY MODULE THAT RUNS AN EXTERNAL COMMAND
 * =============================================================================
 *
 * The rig survey reads directories on other machines. macOS ships no SMB client
 * library, so a share has to be MOUNTED before it can be read, and mounting
 * means asking the operating system. That is the one thing in this codebase
 * that reaches outside the process, and this is the one file that does it.
 *
 * ---------------------------------------------------------------------------
 * THE MOUNT IS READ-ONLY, AND THAT IS ENFORCED BY THE KERNEL
 *
 * Every mount this module makes carries `-o rdonly`. From `mount(8)`: *"Mount
 * the file system read-only (even the super-user may not write it)."* That is a
 * stronger guarantee than anything this application can make about itself:
 *
 *   - the app cannot write, because no write primitive exists in `src/` outside
 *     the export writer, and the survey never even OPENS a file -- it reads
 *     directory entries and stats and nothing else;
 *   - but ALSO nothing else on this Mac can write through these mountpoints --
 *     not Finder, not another application, not a shell, not root.
 *
 * Verified against the real rig before this was written: `touch` and `mkdir`
 * on such a mount both fail with `Read-only file system`, locally, before
 * anything is sent over the wire. Nothing is created on the machine.
 *
 * A mount the OPERATOR made in Finder is a different thing and is reported as
 * such -- `readOnly` on `SmbMount` is read back out of the mount table rather
 * than assumed, so a share someone else connected read-write is never described
 * as protected.
 * ---------------------------------------------------------------------------
 *
 * CONTRACT
 *
 *   1. This is the ONLY file in `src/` permitted to import `node:child_process`,
 *      and the only one permitted to name `mkdir`.
 *      `test/readonly-enforcement.test.ts` fails the build otherwise.
 *
 *   2. Exactly FOUR commands may be run, all by absolute path, all on the
 *      allowlist below, none built from user input:
 *        /sbin/mount        read the mount table. Takes no arguments.
 *        /bin/mkdir         create a LOCAL, EMPTY mountpoint directory.
 *        /sbin/mount_smbfs  mount a share there, read-only.
 *        /sbin/umount       take one of OUR mountpoints away again.
 *      They run through `execFile`, never `exec`, so THERE IS NO SHELL and
 *      nothing can be word-split, globbed or chained out of an argument.
 *
 *   3. THE MKDIR IS LOCAL AND IT IS EMPTY. A mountpoint is a directory on THIS
 *      Mac that a remote share is grafted onto; the remote machine never hears
 *      about it, and nothing is created there. It is jailed to `MOUNT_ROOT`
 *      under the system temp directory by `assertInMountRoot`, which is the
 *      same shape of guard as the export jail. `/Volumes` is `root:wheel` and
 *      is deliberately not used.
 *
 *   4. UNMOUNT IS JAILED THE SAME WAY. Only a path under `MOUNT_ROOT` can be
 *      unmounted -- never `/Volumes`, never the object mount holding the
 *      archive, never a volume the operator connected themselves. Taking the
 *      archive away during a show is exactly the class of accident this
 *      codebase is shaped to prevent.
 *
 *   5. NOTHING HERE REMOVES A DIRECTORY OR WRITES A FILE. An emptied mountpoint
 *      is left behind; it is an empty directory in the system temp area, the OS
 *      clears it in its own time, and the next mount reuses it.
 *
 * ---------------------------------------------------------------------------
 * THE PASSWORD IS IN THE COMMAND LINE, AND THAT IS A DELIBERATE TRADE
 *
 * `mount_smbfs` accepts a credential in exactly one place: the URL. There is no
 * stdin form and no environment form -- `-N` means "do not prompt, read
 * ~/Library/Preferences/nsmb.conf or the keychain", which is the only
 * alternative and does not accept a typed password. So a supplied password is
 * visible in `ps` for the fraction of a second the mount takes.
 *
 * THE USER WAS TOLD THIS AND CHOSE IT: *"if we do the rdonly mount i can deal
 * with typing passwords. the passwords for the smb share are just guest
 * accounts so they're not meant to be secure"*. The trade is a guest-account
 * credential with no security value, exchanged for a kernel-enforced read-only
 * mount on machines that run the show. Recorded here so nobody quietly reverses
 * it later on the grounds that a password in argv looks wrong in isolation.
 *
 * `-N` is passed ALWAYS regardless, because without it a failed authentication
 * makes `mount_smbfs` prompt on a terminal that a server process does not have,
 * and the request would hang until it timed out.
 *
 * The password is never logged, never returned, and never stored: it lives in
 * one private field of `RigSession` and is cleared with the session.
 * ---------------------------------------------------------------------------
 *
 *   6. EVERY HOST AND SHARE IS VALIDATED BEFORE IT REACHES A COMMAND, by
 *      `assertHost` and `assertShare` -- allowlists of shape, not denylists of
 *      character. The host also becomes a directory name under `MOUNT_ROOT`,
 *      which is safe for the same reason: it cannot contain a slash or a dot
 *      segment that would climb out.
 *
 * WHAT IS READ AFTERWARDS goes through `ReadOnlyFs` like everything else here:
 * the survey builds one fenced to a single mountpoint, so a mounted machine is
 * reachable exactly as far as the directory the operator named and no further.
 * =============================================================================
 */

import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ReadOnlyFs } from '../fs/readonly.ts';

/** The complete set of commands this application may ever run on macOS. */
export const ALLOWED_COMMANDS = Object.freeze({
  mount: '/sbin/mount',
  makeDir: '/bin/mkdir',
  mountSmbfs: '/sbin/mount_smbfs',
  umount: '/sbin/umount',
});

/**
 * The one command this application may run on Windows, resolved from the
 * system root rather than found on PATH -- a `net.exe` earlier in PATH than
 * System32 is exactly the substitution an absolute path exists to prevent.
 *
 * `net use` is Windows' whole SMB session API from a command line. There is no
 * mount and no mountpoint: a UNC path is read directly once the session exists.
 */
export function netCommand(env: NodeJS.ProcessEnv = process.env): string {
  const root = env['SystemRoot'] || env['windir'] || 'C:\\Windows';
  return join(root, 'System32', 'net.exe');
}

/** Which implementation a platform gets. Injected so both can be tested anywhere. */
export type RigPlatform = 'darwin' | 'win32';

export function rigPlatformOf(platform: string = process.platform): RigPlatform | null {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'win32';
  return null;
}

/**
 * Where this application puts its own mountpoints.
 *
 * The system temp directory, not `/Volumes`: that is `root:wheel` and would
 * need privileges we should not want. `nobrowse` keeps these off the Desktop,
 * which matters when there are twenty-three of them.
 */
export const MOUNT_ROOT = join(tmpdir(), 'media-allocation-analyzer-rig');

/** Default budget for one mount attempt. An unreachable host must not hang. */
export const DEFAULT_MOUNT_TIMEOUT_MS = 25_000;

export class RigCommandError extends Error {
  readonly code = 'RIG_COMMAND_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'RigCommandError';
  }
}

export class InvalidTargetError extends Error {
  readonly code = 'INVALID_TARGET';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTargetError';
  }
}

/** One SMB share currently mounted on this Mac. */
export interface SmbMount {
  /** Host as the mount table records it -- an IPv4 literal or a name. */
  host: string;
  /** Share name, percent-DEcoded, e.g. `d3 Projects`. */
  share: string;
  /** The user the share was mounted as, or null when it was not recorded. */
  user: string | null;
  /** Absolute local path the share is mounted at. */
  mountPoint: string;
  /**
   * Read back out of the mount options, never assumed. A share the operator
   * connected in Finder is read-WRITE, and must not be described otherwise.
   */
  readOnly: boolean;
  /** True when this mountpoint is one of ours, under `MOUNT_ROOT`. */
  ours: boolean;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Control characters, which may not appear in anything that reaches a command. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function isIpv4(value: string): boolean {
  return IPV4.test(String(value ?? '').trim());
}

/** Digits and dots only -- something that is TRYING to be an IPv4 address. */
function looksNumeric(value: string): boolean {
  return /^[\d.]+$/.test(value);
}

/**
 * An IPv4 literal or a DNS name, and nothing else.
 *
 * This is the security boundary for the command below, so it is an ALLOWLIST of
 * shapes rather than a denylist of dangerous characters: a denylist has to be
 * right about every character, an allowlist only has to be right about the two
 * forms a machine address can take. It is also what makes the host safe to use
 * as a directory name -- neither shape can contain a slash or a `..`.
 */
export function assertHost(host: string): string {
  const h = String(host ?? '').trim();
  if (h === '') throw new InvalidTargetError('A machine address is required.');
  // `10.10.1.999` is a valid DNS name and an invalid address, and it is always
  // the second of those: accepting it would send a typo'd octet to a name
  // lookup and report the failure as an unreachable machine ten seconds later.
  if (looksNumeric(h)) {
    if (IPV4.test(h)) return h;
    throw new InvalidTargetError(
      `${JSON.stringify(host)} looks like an address but is not a valid one. ` +
        'Each of the four parts must be 0-255.',
    );
  }
  if (HOSTNAME.test(h)) return h;
  throw new InvalidTargetError(
    `${JSON.stringify(host)} is not an IPv4 address or a host name. ` +
      'Addresses look like 10.10.1.53, names look like d3-server-101.local.',
  );
}

/**
 * A share name. Spaces are legal and common (`d3 Projects`); anything that
 * could break out of a URL path segment is not.
 */
export function assertShare(share: string): string {
  const s = String(share ?? '').trim();
  if (s === '') throw new InvalidTargetError('A share name is required.');
  if (s.length > 255) throw new InvalidTargetError('Share name is too long.');
  if (CONTROL_CHARS.test(s) || /["\\/]/.test(s)) {
    throw new InvalidTargetError(
      `Share name ${JSON.stringify(share)} contains a character that is not allowed ` +
        '(slashes, backslashes, quotes and control characters).',
    );
  }
  return s;
}

/**
 * macOS reports `/var/...` paths as `/private/var/...` in the mount table,
 * because `/var` is a symlink. Both spellings mean the same directory, so the
 * jail and the "is this ours" test accept either. Measured, not guessed: the
 * mountpoint handed to `mount_smbfs` comes back with the `/private` prefix.
 */
function candidateRoots(): string[] {
  const root = resolve(MOUNT_ROOT);
  return root.startsWith('/private/')
    ? [root, root.slice('/private'.length)]
    : [root, `/private${root}`];
}

function isUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/** True when `p` is one of this application's own mountpoints. */
export function isOurMountPoint(p: string): boolean {
  const abs = resolve(String(p ?? ''));
  return candidateRoots().some((root) => isUnder(abs, root));
}

/**
 * Throws unless `p` is inside `MOUNT_ROOT`. The guard on both the directory
 * this module creates and the mountpoint it takes away.
 */
export function assertInMountRoot(p: string): string {
  const abs = resolve(String(p ?? ''));
  if (!isOurMountPoint(abs)) {
    throw new InvalidTargetError(
      `Refusing to touch ${JSON.stringify(abs)}: it is not one of this application's own ` +
        `mountpoints under ${MOUNT_ROOT}.`,
    );
  }
  return abs;
}

/** Where this application mounts a given host's share. */
export function mountPointFor(host: string): string {
  return join(MOUNT_ROOT, assertHost(host));
}

/**
 * Parse the output of `/sbin/mount`, keeping only SMB lines.
 *
 * A real line looks like:
 *   //d3@10.10.1.53/d3%20Projects on /Volumes/d3 Projects (smbfs, nodev, ...)
 *
 * A MOUNTPOINT MAY CONTAIN SPACES, which is why the options block is matched
 * from the END of the line rather than the mountpoint from the start: `d3
 * Projects` is a perfectly ordinary share name and splitting on whitespace
 * would cut it short. Pure and exported so it is tested against real output
 * rather than against what the format was assumed to be.
 */
export function parseMountTable(text: string): SmbMount[] {
  const out: SmbMount[] = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('//')) continue;
    const m = /^\/\/(.+?) on (.+) \(([^()]*)\)$/.exec(trimmed);
    if (!m) continue;
    const [, source = '', mountPoint = '', opts = ''] = m;
    if (!/(^|,)\s*smbfs(\s|,|$)/.test(opts)) continue;

    // `[user@]host/share`
    const slash = source.indexOf('/');
    if (slash === -1) continue;
    const authority = source.slice(0, slash);
    const rawShare = source.slice(slash + 1);
    const at = authority.lastIndexOf('@');
    const user = at === -1 ? null : authority.slice(0, at);
    const host = at === -1 ? authority : authority.slice(at + 1);
    if (host === '') continue;

    let share = rawShare;
    try {
      share = decodeURIComponent(rawShare);
    } catch {
      /* a share name that is not valid percent-encoding: keep it verbatim */
    }
    out.push({
      host,
      share,
      user,
      mountPoint,
      // Read out of the options, never assumed.
      readOnly: /(^|,)\s*read-only(\s|,|$)/.test(opts),
      ours: isOurMountPoint(mountPoint),
    });
  }
  return out;
}

function run(command: string, args: readonly string[], opts: { timeoutMs: number }): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      [...args],
      { timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || '').trim();
          reject(new RigCommandError(detail || `${command} failed`));
          return;
        }
        resolvePromise(String(stdout));
      },
    );
  });
}

export interface MountRequest {
  host: string;
  share: string;
  /** Omitted mounts as a guest. */
  username?: string | undefined;
  /** See the header: this reaches `mount_smbfs` in its URL, by its only route. */
  password?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface MountOutcome {
  host: string;
  share: string;
  mountPoint: string;
  /** True when our read-only mountpoint was already live and was reused. */
  alreadyMounted: boolean;
  /** Always true for a mount this module made. Reported, not assumed. */
  readOnly: boolean;
  /**
   * A DIFFERENT, read-write mount of the same share that somebody else made --
   * typically the operator, in Finder. Surfaced so the UI can be honest: our
   * mountpoint is read-only, but that other one is not, and the machine is
   * still writable through it.
   */
  otherWritableMount: string | null;
}

/**
 * Every SMB share mounted on this Mac right now.
 *
 * Empty off macOS: Windows has no mount table to read, because it has no
 * mounts -- a UNC path is read where it stands. Returning `[]` rather than
 * running a command that is not there keeps the caller from having to know.
 */
export async function listSmbMounts(platform: string = process.platform): Promise<SmbMount[]> {
  if (rigPlatformOf(platform) !== 'darwin') return [];
  const text = await run(ALLOWED_COMMANDS.mount, [], { timeoutMs: 10_000 });
  return parseMountTable(text);
}

/** Find an existing mount of this exact host+share, case-insensitively. */
export function findMount(
  mounts: readonly SmbMount[],
  host: string,
  share: string,
  opts: { oursOnly?: boolean } = {},
): SmbMount | undefined {
  const h = host.toLowerCase();
  const s = share.toLowerCase();
  return mounts.find(
    (m) =>
      m.host.toLowerCase() === h &&
      m.share.toLowerCase() === s &&
      (opts.oursOnly !== true || m.ours),
  );
}

/**
 * Build the `mount_smbfs` URL.
 *
 * Every component is percent-encoded as one authority or path segment, which is
 * not cosmetic: a password containing `@`, `:` or `/` would otherwise be read
 * as a host, a port or a share, and the mount would fail confusingly or -- far
 * worse -- succeed against something unintended. Exported so its exact shape is
 * asserted rather than assumed.
 */
export function mountUrl(req: {
  host: string;
  share: string;
  username?: string | undefined;
  password?: string | undefined;
}): string {
  const host = assertHost(req.host);
  const share = assertShare(req.share);
  let authority = '';
  if (req.username) {
    authority = encodeURIComponent(req.username);
    if (req.password) authority += `:${encodeURIComponent(req.password)}`;
    authority += '@';
  }
  return `//${authority}${host}/${encodeURIComponent(share)}`;
}

/**
 * The arguments for one read-only mount, as one array.
 *
 * Split out so a test can assert the exact argv without a network: `-N` and
 * `rdonly` are the two flags this feature's guarantees rest on, and an
 * accidental edit to either would be silent at runtime.
 */
export function mountArgs(req: MountRequest, mountPoint: string): string[] {
  return [
    // Never prompt. A server process has no terminal, and a wrong password
    // would otherwise hang until the timeout.
    '-N',
    '-o',
    // rdonly: the kernel refuses every write through this mountpoint.
    // nobrowse: keep twenty-three of these off the Desktop.
    'rdonly,nobrowse',
    mountUrl(req),
    mountPoint,
  ];
}

/**
 * Mount one share READ-ONLY at this application's own mountpoint.
 *
 * Deliberately does NOT reuse a mount somebody else made: a share the operator
 * connected in Finder is read-write, and quietly surveying through it would
 * throw away the guarantee this whole path exists to provide. macOS is happy to
 * hold both at once -- verified against the real rig -- so we make our own and
 * report theirs alongside it.
 */
export async function mountShare(req: MountRequest): Promise<MountOutcome> {
  const host = assertHost(req.host);
  const share = assertShare(req.share);
  const timeoutMs = req.timeoutMs ?? DEFAULT_MOUNT_TIMEOUT_MS;
  const mountPoint = assertInMountRoot(mountPointFor(host));

  const before = await listSmbMounts();
  const otherWritable =
    before.find(
      (m) =>
        m.host.toLowerCase() === host.toLowerCase() &&
        m.share.toLowerCase() === share.toLowerCase() &&
        !m.ours &&
        !m.readOnly,
    )?.mountPoint ?? null;

  const existing = findMount(before, host, share, { oursOnly: true });
  if (existing) {
    return {
      host,
      share,
      mountPoint: existing.mountPoint,
      alreadyMounted: true,
      readOnly: existing.readOnly,
      otherWritableMount: otherWritable,
    };
  }

  // A LOCAL, EMPTY directory for the share to be grafted onto. The remote
  // machine never hears about this and nothing is created there.
  await run(ALLOWED_COMMANDS.makeDir, ['-p', mountPoint], { timeoutMs: 10_000 });

  await run(ALLOWED_COMMANDS.mountSmbfs, mountArgs({ ...req, host, share }, mountPoint), {
    timeoutMs,
  });

  const after = await listSmbMounts();
  const landed = findMount(after, host, share, { oursOnly: true });
  if (!landed) {
    throw new RigCommandError(
      `mount_smbfs reported no error, but ${share} on ${host} is not in the mount table.`,
    );
  }
  if (!landed.readOnly) {
    // Never reachable with the options above, and checked anyway: reporting a
    // writable mount as protected is the one lie this module must not tell.
    throw new RigCommandError(
      `${share} on ${host} mounted, but NOT read-only. Refusing to report it as protected.`,
    );
  }
  return {
    host,
    share,
    mountPoint: landed.mountPoint,
    alreadyMounted: false,
    readOnly: true,
    otherWritableMount: otherWritable,
  };
}

/**
 * Take one of OUR mountpoints away again.
 *
 * Jailed to `MOUNT_ROOT`, so this can never reach `/Volumes`, the object mount
 * holding the archive, or anything the operator connected themselves. The empty
 * directory is left behind on purpose -- nothing in this module removes a
 * directory, and the next mount reuses it.
 */
export async function unmountShare(mountPoint: string): Promise<void> {
  const abs = assertInMountRoot(mountPoint);
  await run(ALLOWED_COMMANDS.umount, [abs], { timeoutMs: 20_000 });
}

/* ===========================================================================
 *  WINDOWS  --  NO MOUNT, NO MOUNTPOINT, AND A WEAKER PROMISE SAID OUT LOUD
 * ===========================================================================
 *
 * Windows reads `\\host\share` where it stands. There is nothing to mount, so
 * there is no mountpoint to make and none to take away -- and, crucially,
 * **no `-o rdonly`**. Windows has no per-connection read-only flag at all.
 *
 * That difference is the whole reason this port was resisted, and it is not
 * papered over anywhere:
 *
 *   macOS    the KERNEL refuses every write through our mountpoint, from any
 *            process on the Mac including root. `guarantee: 'kernel'`.
 *   Windows  THIS APPLICATION cannot write -- `ReadOnlyFs` exposes readdir,
 *            lstat and a read-only open, no write primitive exists in `src/`
 *            outside the export writer, and the survey never opens a file at
 *            all -- but nothing stops another program on the PC from writing
 *            to that share if the share's own permissions allow it.
 *            `guarantee: 'application'`.
 *
 * Both are true statements; they are different statements, and the UI prints
 * whichever one is actually in force rather than the flattering one. If you are
 * tempted to collapse them into a single "read-only" badge: don't. The badge is
 * the only place an operator learns which promise they have.
 *
 * THE CREDENTIAL reaches `net use` as an argument, exactly as it reaches
 * `mount_smbfs` in a URL, and for the same reason -- there is no other route
 * into either. See the header above; the user was told and chose it.
 *
 * A PASSWORD IS ALWAYS PASSED, even when empty, because `net use \\h\s /user:x`
 * with no password PROMPTS, and a server has no terminal to prompt on. `''` is
 * the guest case and the Windows analogue of `mount_smbfs -N`.
 * =========================================================================== */

/** `\\host\share`, from parts that have each been through the allowlists. */
export function uncPath(host: string, share: string): string {
  return `\\\\${assertHost(host)}\\${assertShare(share)}`;
}

/**
 * `net use \\host\share <password> /user:<name> /persistent:no`
 *
 * `/persistent:no` so nothing is left behind in the operator's profile for the
 * next reboot to restore: this session lasts as long as the survey does, like
 * everything else the rig tab holds.
 */
export function netUseArgs(req: Pick<MountRequest, 'username' | 'password'>, unc: string): string[] {
  const args = ['use', unc];
  // Positional, and it must be present. See the header: an absent password
  // makes `net use` prompt, and there is no `-N` to turn that off.
  args.push(req.password ?? '');
  if (req.username) args.push(`/user:${req.username}`);
  args.push('/persistent:no');
  return args;
}

/** `net use \\host\share /delete /y` -- only ever for a session we made. */
export function netDeleteArgs(unc: string): string[] {
  return ['use', unc, '/delete', '/y'];
}

/**
 * What reaching a machine produced, whichever platform did it.
 *
 * `readRoot` is the one field the survey needs: the absolute path this machine
 * is read through. A mountpoint on macOS, a UNC share on Windows.
 */
export interface AccessOutcome {
  host: string;
  share: string;
  readRoot: string;
  /** macOS: the mountpoint we made or reused. Null on Windows -- there is none. */
  mountPoint: string | null;
  /** Windows: the UNC we authenticated and must disconnect. Null otherwise. */
  session: string | null;
  /** True when the OS already had this connection and we did not make it. */
  preexisting: boolean;
  /** WHO enforces the read-only promise. Never assumed; see the header. */
  guarantee: ReadGuarantee;
  /** macOS: a separate read-WRITE mount of the same share somebody else made. */
  otherWritableMount: string | null;
}

export type ReadGuarantee = 'kernel' | 'application';

/**
 * Reach one machine, by whatever means the platform has.
 *
 * "Connected" means the same thing on both: a path this application has
 * successfully READ through once. On macOS that is the mount table reporting
 * our read-only mount; on Windows it is a directory listing of the share root.
 * Either way, a target that comes back has been proven, not assumed.
 */
export async function connectShare(
  req: MountRequest,
  platform: string = process.platform,
): Promise<AccessOutcome> {
  const kind = rigPlatformOf(platform);
  if (kind === 'darwin') {
    const m = await mountShare(req);
    return {
      host: m.host,
      share: m.share,
      readRoot: m.mountPoint,
      mountPoint: m.mountPoint,
      session: null,
      preexisting: m.alreadyMounted,
      guarantee: 'kernel',
      otherWritableMount: m.otherWritableMount,
    };
  }
  if (kind === 'win32') return connectWindowsShare(req);
  throw new RigCommandError(
    `The rig survey needs macOS or Windows; this is ${platform}. Everything else in the analyser works here.`,
  );
}

async function connectWindowsShare(req: MountRequest): Promise<AccessOutcome> {
  const host = assertHost(req.host);
  const share = assertShare(req.share);
  const unc = uncPath(host, share);
  const timeoutMs = req.timeoutMs ?? DEFAULT_MOUNT_TIMEOUT_MS;

  // Only when a credential was supplied. Without one, Windows uses whatever
  // access the operator's own session already has -- and we must not disconnect
  // a session we did not make, which is why `session` stays null here.
  let session: string | null = null;
  if (req.username) {
    await run(netCommand(), netUseArgs(req, unc), { timeoutMs });
    session = unc;
  }

  // Prove it. A share that authenticates but cannot be listed is not a machine
  // this survey can read, and finding that out now beats finding it out per
  // machine in the middle of a walk.
  const rofs = new ReadOnlyFs({ allowedRoots: [unc], dirTimeoutMs: timeoutMs });
  await rofs.readdir(unc);

  return {
    host,
    share,
    readRoot: unc,
    mountPoint: null,
    session,
    preexisting: session === null,
    // NOT 'kernel'. Windows has no per-connection read-only flag; this promise
    // is made by the application, and the UI says so in those words.
    guarantee: 'application',
    otherWritableMount: null,
  };
}

/**
 * Let go of one machine.
 *
 * macOS unmounts OUR mountpoint, jailed to `MOUNT_ROOT`. Windows drops the
 * session we authenticated -- and only that one: a connection the operator
 * made themselves is left exactly where it is, the same rule that stops the
 * Mac side unmounting a volume it did not mount.
 */
export async function disconnectShare(
  target: Pick<AccessOutcome, 'mountPoint' | 'session'>,
  platform: string = process.platform,
): Promise<void> {
  if (rigPlatformOf(platform) === 'win32') {
    if (!target.session) return;
    await run(netCommand(), netDeleteArgs(target.session), { timeoutMs: 20_000 });
    return;
  }
  if (!target.mountPoint) return;
  await unmountShare(target.mountPoint);
}

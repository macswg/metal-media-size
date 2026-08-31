/**
 * ============================================================================
 *  READ-ONLY ENFORCEMENT  --  THE PROOF
 * ============================================================================
 *
 * The archive is 133 TB of irreplaceable master renders on a read-only mount
 * with no backup. These two tests are the mechanical guarantee that no code in
 * `src/` can write to it, and they are a hard requirement, not a nice-to-have.
 *
 *   1. DENYLIST      -- no fs write primitive appears anywhere in `src/`.
 *   2. IMPORT FENCE  -- `node:fs` / `fs` is imported only by the chokepoint.
 *   3. COMMAND FENCE -- `node:child_process` is imported only by the MOUNT
 *      chokepoint, `src/rig/mounts.ts`, which exists because macOS ships no
 *      SMB client and a share has to be mounted before it can be read. That
 *      module may run exactly four commands, all by absolute path. The rest of
 *      `src/` may not run a command at all.
 *
 *      It is also the ONLY file outside the export writer allowed to name
 *      `mkdir`, and only to create a LOCAL, EMPTY mountpoint directory jailed
 *      to its own root under the system temp area. That directory is on this
 *      Mac; the remote machine never hears about it. Its `umount` is jailed to
 *      the same root, which is what stands between a bug and the archive's own
 *      volume being taken away mid-show.
 *
 * The single sanctioned exception is `src/export/writer.ts`, which a later
 * agent will add to write export artefacts into the project's `exports/`
 * directory. It does not exist yet; its absence is tolerated.
 *
 * These tests read files with `node:fs`, which is correct: test code is not
 * shipped and is outside the fence it enforces. The fence covers `src/`.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PROJECT_ROOT, 'src');

/** Files allowed to write, and therefore exempt from both checks. */
const WRITE_EXEMPT = new Set(['src/export/writer.ts']);

/** Files allowed to import node:fs. The chokepoint, plus the export writer. */
const FS_IMPORT_EXEMPT = new Set(['src/fs/readonly.ts', 'src/export/writer.ts']);

/**
 * Files allowed to import `node:child_process`. Exactly one: the mount
 * chokepoint. Reading a machine on the network means mounting its share first,
 * and mounting means asking macOS -- so the capability exists, and it is fenced
 * the same way touching the archive is.
 */
const EXEC_IMPORT_EXEMPT = new Set(['src/rig/mounts.ts']);

/**
 * Files allowed to name `mkdir`. The mount chokepoint, for one purpose: a
 * mountpoint is a local, empty directory on THIS Mac that a remote share is
 * grafted onto. Nothing is created on the remote machine, and the path is
 * jailed to the application's own root under the system temp directory.
 */
const MKDIR_EXEMPT = new Set(['src/rig/mounts.ts']);

/**
 * Filesystem mutation primitives. Any occurrence in `src/` outside the exempt
 * list fails the build. Matched as whole identifiers so `writeFileSync` in a
 * comment still trips (deliberate: comments describing writes are a smell) but
 * unrelated words like `mkdirp_note` do not.
 */
const DENIED = [
  'writeFile',
  'writeFileSync',
  'unlink',
  'unlinkSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'chmod',
  'chmodSync',
  'chown',
  'chownSync',
  'utimes',
  'utimesSync',
  'truncate',
  'truncateSync',
  'mkdir',
  'mkdirSync',
  'copyFile',
  'copyFileSync',
  'appendFile',
  'appendFileSync',
  'createWriteStream',
];

interface Violation {
  file: string;
  line: number;
  column: number;
  text: string;
  token: string;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Project-relative, forward-slashed, for stable comparison and messages. */
function rel(file: string): string {
  return relative(PROJECT_ROOT, file).split(sep).join('/');
}

function formatViolations(violations: Violation[], what: string): string {
  const lines = violations.map(
    (v) => `  ${v.file}:${v.line}:${v.column}  ${v.token}\n      ${v.text.trim()}`,
  );
  return (
    `Found ${violations.length} ${what}:\n${lines.join('\n')}\n\n` +
    `The archive is a READ-ONLY mount holding 133 TB of irreplaceable masters. ` +
    `Nothing under src/ may write to the filesystem outside src/export/writer.ts, ` +
    `and only src/fs/readonly.ts may import node:fs.`
  );
}

describe('read-only enforcement', () => {
  const files = listTsFiles(SRC);

  it('finds source files to check (guards against a vacuously passing test)', () => {
    expect(files.length).toBeGreaterThan(5);
    // The chokepoint must exist, or the fence protects nothing.
    expect(files.map(rel)).toContain('src/fs/readonly.ts');
  });

  it('DENYLIST: no filesystem write primitive appears in src/', () => {
    const denyRe = new RegExp(`\\b(${DENIED.join('|')})\\b`, 'g');
    const violations: Violation[] = [];

    for (const file of files) {
      const relPath = rel(file);
      if (WRITE_EXEMPT.has(relPath)) continue;

      // The mount chokepoint may name `mkdir`, and only `mkdir`: a mountpoint
      // is a local empty directory, and creating one is the single write this
      // application makes outside `exports/`. Every other primitive still
      // fails the build there, which the next test asserts positively.
      const allowMkdir = MKDIR_EXEMPT.has(relPath);

      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        denyRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = denyRe.exec(text)) !== null) {
          if (allowMkdir && (m[1] === 'mkdir' || m[1] === 'mkdirSync')) continue;
          violations.push({
            file: relPath,
            line: i + 1,
            column: m.index + 1,
            text,
            token: m[1] as string,
          });
        }
      });
    }

    expect(violations, formatViolations(violations, 'filesystem write primitive(s)')).toEqual([]);
  });

  it('IMPORT BOUNDARY: node:fs is imported only by the chokepoint', () => {
    // static import, export-from, dynamic import(), and require()
    const importRe =
      /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s*['"](node:fs(?:\/promises)?|fs(?:\/promises)?)['"]|(?:import|require)\s*\(\s*['"](node:fs(?:\/promises)?|fs(?:\/promises)?)['"]\s*\)|import\s+['"](node:fs(?:\/promises)?|fs(?:\/promises)?)['"]/g;

    const violations: Violation[] = [];

    for (const file of files) {
      const relPath = rel(file);
      if (FS_IMPORT_EXEMPT.has(relPath)) continue;

      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');

      // Line-oriented pass so the message can name a line number.
      lines.forEach((text, i) => {
        const perLine =
          /(?:from|import|require)\s*\(?\s*['"](node:fs(?:\/promises)?|fs(?:\/promises)?)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = perLine.exec(text)) !== null) {
          violations.push({
            file: relPath,
            line: i + 1,
            column: m.index + 1,
            text,
            token: m[1] as string,
          });
        }
      });

      // Whole-file pass catches multi-line import blocks the line pass misses.
      importRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(source)) !== null) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (!spec) continue;
        const line = source.slice(0, m.index).split('\n').length;
        const already = violations.some((v) => v.file === relPath && Math.abs(v.line - line) <= 6);
        if (!already) {
          violations.push({
            file: relPath,
            line,
            column: 1,
            text: m[0].replace(/\n/g, ' '),
            token: spec,
          });
        }
      }
    }

    expect(
      violations,
      formatViolations(violations, 'illegal node:fs import(s)'),
    ).toEqual([]);
  });

  it('COMMAND BOUNDARY: node:child_process is imported only by the mount chokepoint', () => {
    // Running a command is the one capability that can reach outside this
    // process entirely. It exists for exactly one reason -- macOS has no SMB
    // client library, so a share must be mounted before it can be read -- and
    // it is confined to the one module that does that.
    const violations: Violation[] = [];
    const perLine =
      /(?:from|import|require)\s*\(?\s*['"](node:child_process|child_process)['"]/g;

    for (const file of files) {
      const relPath = rel(file);
      if (EXEC_IMPORT_EXEMPT.has(relPath)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((text, i) => {
          perLine.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = perLine.exec(text)) !== null) {
            violations.push({
              file: relPath,
              line: i + 1,
              column: m.index + 1,
              text,
              token: m[1] as string,
            });
          }
        });
    }

    expect(violations, formatViolations(violations, 'illegal child_process import(s)')).toEqual([]);
  });

  it('the mount chokepoint runs only the four allowed commands', () => {
    const source = readFileSync(join(SRC, 'rig/mounts.ts'), 'utf8');

    // execFile only. `exec` would take a shell, and a shell would take a
    // command line built from a host name.
    expect(source).toMatch(/import \{ execFile \} from 'node:child_process'/);
    // `exec(` only when it is a call to the shell-taking exec, not the `.exec(`
    // of a regular expression -- which this module uses to read the mount table.
    expect(source).not.toMatch(/\bexecSync\b|\bspawnSync\b|\bspawn\s*\(/);
    expect(source).not.toMatch(/(?<![.\w])exec\s*\(/);
    expect(source).not.toMatch(/shell\s*:/);

    // All four are absolute literals, so none can be resolved through a PATH
    // an attacker controls.
    expect(source).toMatch(/mount: '\/sbin\/mount'/);
    expect(source).toMatch(/makeDir: '\/bin\/mkdir'/);
    expect(source).toMatch(/mountSmbfs: '\/sbin\/mount_smbfs'/);
    expect(source).toMatch(/umount: '\/sbin\/umount'/);
    // And there are no others.
    expect(source.match(/^  \w+: '\/[^']+',$/gm)).toHaveLength(4);

    // WINDOWS adds exactly one command, and it is built from the system root
    // rather than found on PATH -- a `net.exe` earlier in PATH than System32 is
    // exactly the substitution an absolute path exists to prevent.
    expect(source).toMatch(/join\(root, 'System32', 'net\.exe'\)/);
    expect(source).not.toMatch(/'net\.exe'\s*[,)]\s*$/m);
    // No second way to reach a share: no drive letters, no PowerShell, no
    // registry, and nothing that could mount one somewhere writable.
    expect(source).not.toMatch(/powershell|cmd\.exe|reg\.exe|wmic|robocopy|xcopy/i);

    // A password must never reach a prompt. macOS has `-N`; Windows has no
    // such flag, so an empty password is passed positionally instead, and a
    // server with no terminal can never be left waiting on one.
    expect(source).toMatch(/args\.push\(req\.password \?\? ''\)/);

    // EVERY mount is read-only. This is the whole protection for the playback
    // machines and it rests on one option string.
    expect(source).toMatch(/'rdonly,nobrowse'/);
    // Never prompt: a server process has no terminal to prompt on.
    expect(source).toMatch(/'-N'/);

    // Both the mkdir and the umount are jailed to our own mount root. Without
    // this, a bug could unmount the volume holding the archive.
    expect(source).toMatch(/assertInMountRoot\(mountPointFor\(host\)\)/);
    expect(source).toMatch(/const abs = assertInMountRoot\(mountPoint\);/);

    // Nothing here may remove a directory or eject a disk.
    expect(source).not.toMatch(/\bdiskutil\b|\beject\b|\brmdir\b/);

    // THE TWO PROMISES STAY TOLD APART. macOS gets the kernel's; Windows gets
    // the application's own, because it has no per-connection read-only flag.
    // A single flat 'read-only' anywhere in here would be the quiet loss the
    // port was resisted over -- see CLAUDE.md.
    expect(source).toMatch(/guarantee: 'kernel'/);
    expect(source).toMatch(/guarantee: 'application'/);
  });

  it('the rig session never persists what it holds', () => {
    // The operator asked for addresses to live nowhere. The session is the one
    // place they exist, so it may not reach the database or the exporter.
    // (That the CREDENTIAL never comes back out is asserted behaviourally, by
    // reading a real session's status -- see test/server/rig.test.ts.)
    const source = readFileSync(join(SRC, 'server/rig-session.ts'), 'utf8');
    expect(source).not.toMatch(/better-sqlite3|INSERT |prepare\(/);
    expect(source).not.toMatch(/from '\.\.\/export\//);
  });

  it('the rig survey never even OPENS a file on a remote machine', () => {
    // The application cannot write anywhere -- the two fences above prove that
    // for every path, remote ones included. This is the stronger claim, and it
    // is worth pinning separately: surveying a playback machine reads its
    // DIRECTORY ENTRIES and nothing else. No file on a machine is opened at
    // all, so there is no descriptor to write through even by accident, and a
    // survey costs the machine no file reads while a show is loaded.
    for (const f of ['rig/mounts.ts', 'rig/survey.ts', 'rig/targets.ts', 'server/rig-session.ts', 'server/routes/rig.ts']) {
      expect(readFileSync(join(SRC, f), 'utf8'), f).not.toMatch(/\bopenRead\b/);
    }
    // And the walker the survey drives uses only the two listing calls.
    const walker = readFileSync(join(SRC, 'scan/walk.ts'), 'utf8');
    expect(walker).not.toMatch(/\bopenRead\b/);
    expect(walker).toMatch(/rofs\.readdir\(/);
    expect(walker).toMatch(/rofs\.lstat\(/);
  });

  it('the export jail still refuses /Volumes, where every SMB share mounts', () => {
    // The rig survey mounts machines under /Volumes. The one module that may
    // write is already forbidden from writing there, so the sanctioned writer
    // cannot reach a playback machine either. Asserted here because the rig
    // feature now depends on a rule written for a different reason.
    const source = readFileSync(join(SRC, 'export/writer.ts'), 'utf8');
    expect(source).toMatch(/'\/Volumes'/);
  });

  it('the chokepoint exposes no write operation', () => {
    const source = readFileSync(join(SRC, 'fs/readonly.ts'), 'utf8');
    // Only these three operations may be exported as capabilities.
    expect(source).toMatch(/async readdir\(/);
    expect(source).toMatch(/async lstat\(/);
    expect(source).toMatch(/async openRead\(/);
    // openRead must hard-code the read-only flag.
    expect(source).toMatch(/return open\(abs, 'r'\)/);
    // And it must not import a write-capable helper.
    expect(source).not.toMatch(/\bwriteFile\b|\bcreateWriteStream\b|\bmkdir\b/);
  });
});

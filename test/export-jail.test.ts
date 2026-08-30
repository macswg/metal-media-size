/**
 * ============================================================================
 *  EXPORT JAIL  --  THE PROOF THAT NOTHING CAN BE WRITTEN OUTSIDE exports/
 * ============================================================================
 *
 * `src/export/writer.ts` is the only module in the codebase permitted to write.
 * `test/readonly-enforcement.test.ts` proves nothing ELSE can write. These
 * tests prove that the one module that can, cannot be aimed at the archive.
 *
 * Test code is outside the fence it enforces, so it uses `node:fs` freely to
 * build and tear down scratch directories.
 * ============================================================================
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  assertDirectoryEmpty,
  DEFAULT_EXPORTS_DIR,
  freeFileSyncConfigDirs,
  isUncPath,
  DEFAULT_FORBIDDEN_ROOTS,
  ExportJailError,
  PROJECT_ROOT,
  assertExportPath,
  assertResolvedPathAllowed,
  ensureExportDir,
  forbiddenRootsFor,
  writeExportText,
} from '../src/export/writer.ts';

/** The real archive, from config/d3-delivery.json. Nothing may ever land here. */
const ARCHIVE_ROOT =
  '/Users/Shared/ObjectMount.noindex/show-archive/SHOW_2026/00_D3_Delivery';
const OBJECT_MOUNT = '/Users/Shared/ObjectMount.noindex';
const FFS_APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'FreeFileSync');

let sandbox: string;
let exportsDir: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'metal-media-size-jail-'));
  exportsDir = join(sandbox, 'exports');
  mkdirSync(exportsDir, { recursive: true });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('export jail: the forbidden set', () => {
  it('always includes the object mount, /Volumes and FreeFileSync app support', () => {
    const roots = forbiddenRootsFor();
    expect(roots).toContain(OBJECT_MOUNT);
    expect(roots).toContain('/Volumes');
    expect(roots).toContain(resolve(FFS_APP_SUPPORT));
  });

  it('the caller can only ADD forbidden roots, never remove the defaults', () => {
    const roots = forbiddenRootsFor({ forbiddenRoots: ['/some/scan/root'] });
    for (const d of DEFAULT_FORBIDDEN_ROOTS) expect(roots).toContain(resolve(d));
    expect(roots).toContain('/some/scan/root');
  });

  it('the default export directory is inside the project', () => {
    expect(DEFAULT_EXPORTS_DIR).toBe(join(PROJECT_ROOT, 'exports'));
  });
});

describe('export jail: paths that must be refused', () => {
  const cases: [string, string][] = [
    ['a file directly on the object mount', join(OBJECT_MOUNT, 'evil.ffs_gui')],
    ['a file inside the scan root', join(ARCHIVE_ROOT, 'evil.ffs_gui')],
    ['a file deep inside the scan root', join(ARCHIVE_ROOT, '140_RIVER', 'x', 'y.json')],
    ['the scan root itself', ARCHIVE_ROOT],
    ['anything under /Volumes', '/Volumes/d3 Projects/showproject/objects/VideoFile/x.ffs_gui'],
    ['FreeFileSync application support', join(FFS_APP_SUPPORT, 'MyJob.ffs_gui')],
    ['the home directory', join(homedir(), 'export.json')],
    ['the project root itself', join(PROJECT_ROOT, 'package.json')],
    ['the project src directory', join(PROJECT_ROOT, 'src', 'evil.ts')],
    ['a sibling of exports/', join(PROJECT_ROOT, 'data', 'index.db')],
    ['the filesystem root', '/evil.txt'],
  ];

  for (const [what, path] of cases) {
    it(`refuses ${what}`, () => {
      expect(() => assertResolvedPathAllowed(path)).toThrow(ExportJailError);
    });
  }

  it('refuses LastRun.ffs_gui by name, even inside exports/', () => {
    expect(() =>
      assertResolvedPathAllowed(join(DEFAULT_EXPORTS_DIR, 'LastRun.ffs_gui')),
    ).toThrow(/live FreeFileSync job/);
  });

  it('refuses the export directory itself (a file must be INSIDE it)', () => {
    expect(() => assertResolvedPathAllowed(DEFAULT_EXPORTS_DIR)).toThrow(ExportJailError);
  });

  it('names the protected location in the error, so the failure is diagnosable', () => {
    try {
      assertResolvedPathAllowed(join(ARCHIVE_ROOT, 'x.json'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(String(err)).toContain(OBJECT_MOUNT);
    }
  });
});

describe('export jail: a caller cannot unlock the archive via exportsDir', () => {
  it('refuses when exportsDir is pointed at the scan root', () => {
    expect(() =>
      assertResolvedPathAllowed(join(ARCHIVE_ROOT, 'out.json'), { exportsDir: ARCHIVE_ROOT }),
    ).toThrow(ExportJailError);
  });

  it('refuses when exportsDir is pointed at the object mount', () => {
    expect(() =>
      assertResolvedPathAllowed(join(OBJECT_MOUNT, 'sub', 'out.json'), {
        exportsDir: join(OBJECT_MOUNT, 'sub'),
      }),
    ).toThrow(ExportJailError);
  });

  it('refuses a scan root the caller declared, even outside the default set', () => {
    const scanRoot = join(sandbox, 'pretend-archive');
    expect(() =>
      assertResolvedPathAllowed(join(scanRoot, 'out.json'), {
        exportsDir: scanRoot,
        forbiddenRoots: [scanRoot],
      }),
    ).toThrow(ExportJailError);
  });
});

describe('export jail: path traversal', () => {
  it('catches ../../ escaping the export directory', async () => {
    await expect(
      assertExportPath(join(exportsDir, '..', '..', 'evil.txt'), { exportsDir }),
    ).rejects.toThrow(ExportJailError);
  });

  it('catches a traversal aimed straight at the archive', async () => {
    const rel = join(exportsDir, '..', '..', '..', '..', '..', '..', 'Users', 'Shared');
    await expect(assertExportPath(join(rel, 'evil.txt'), { exportsDir })).rejects.toThrow(
      ExportJailError,
    );
  });

  it('catches a traversal buried in the middle of a path', async () => {
    await expect(
      assertExportPath(join(exportsDir, 'run-1', '..', '..', 'evil.txt'), { exportsDir }),
    ).rejects.toThrow(ExportJailError);
  });

  it('a traversal that lands back inside exports/ is fine', async () => {
    const p = await assertExportPath(join(exportsDir, 'a', '..', 'b.json'), { exportsDir });
    expect(p.endsWith('/b.json')).toBe(true);
  });

  it('catches a symlink planted inside exports/ that points outside it', async () => {
    const outside = join(sandbox, 'outside');
    mkdirSync(outside, { recursive: true });
    const link = join(exportsDir, 'escape-hatch');
    if (!existsSync(link)) symlinkSync(outside, link);
    await expect(assertExportPath(join(link, 'evil.txt'), { exportsDir })).rejects.toThrow(
      ExportJailError,
    );
  });

  it('catches a symlink inside exports/ that points at a forbidden root', async () => {
    // The forbidden root is created inside the sandbox and injected, rather
    // than being a real archive path on this machine. It used to point at the
    // configured scan root, which meant the test only proved anything on a
    // machine where that path happened to exist -- it resolved to the link
    // itself anywhere else, and quietly passed for the wrong reason.
    const archive = join(sandbox, 'pretend-archive');
    mkdirSync(archive, { recursive: true });
    const link = join(exportsDir, 'archive-link');
    if (!existsSync(link)) symlinkSync(archive, link);

    await expect(
      assertExportPath(join(link, 'evil.ffs_gui'), { exportsDir, forbiddenRoots: [archive] }),
    ).rejects.toThrow(ExportJailError);
  });

  it('catches a symlink pointing at a DEFAULT forbidden root', async () => {
    // /Volumes is in DEFAULT_FORBIDDEN_ROOTS and exists on every macOS box, so
    // this covers the defaults without depending on any particular archive.
    const link = join(exportsDir, 'volumes-link');
    if (!existsSync(link)) symlinkSync('/Volumes', link);
    await expect(assertExportPath(join(link, 'evil.ffs_gui'), { exportsDir })).rejects.toThrow(
      ExportJailError,
    );
  });
});

/**
 * Each case gets its own run directory. The jail is a safety mechanism, so its
 * tests must never share mutable state with each other or with another worker.
 */
let runCounter = 0;
function freshRun(): string {
  return join(exportsDir, `run-${++runCounter}-${process.pid}`);
}

describe('export jail: the happy path still works', () => {
  it('writes a file inside the export directory', async () => {
    const target = join(freshRun(), 'review.md');
    const res = await writeExportText(target, '# hello\n', { exportsDir });
    expect(res.bytes).toBe(8);
    expect(readFileSync(res.path, 'utf8')).toBe('# hello\n');
  });

  it('creates directories inside the jail', async () => {
    const dir = await ensureExportDir(join(freshRun(), 'nested', 'deep'), { exportsDir });
    expect(existsSync(dir)).toBe(true);
  });

  it('will not silently replace an existing artefact', async () => {
    const target = join(freshRun(), 'once.txt');
    await writeExportText(target, 'first', { exportsDir });
    await expect(writeExportText(target, 'second', { exportsDir })).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('first');
  });

  it('refuses to create a directory outside the jail', async () => {
    const outside = join(sandbox, `nope-${++runCounter}`);
    await expect(ensureExportDir(outside, { exportsDir })).rejects.toThrow(ExportJailError);
    expect(existsSync(outside)).toBe(false);
  });
});

describe('the empty-left folder is proved empty, not assumed empty', () => {
  it('accepts a directory that really is empty', async () => {
    const dir = await ensureExportDir(join(freshRun(), '_empty_left'), { exportsDir });
    await expect(assertDirectoryEmpty(dir, { exportsDir })).resolves.toBeUndefined();
  });

  it('refuses a directory that has acquired content', async () => {
    const dir = await ensureExportDir(join(freshRun(), '_empty_left'), { exportsDir });
    writeFileSync(join(dir, 'stray.mov'), 'x');
    await expect(assertDirectoryEmpty(dir, { exportsDir })).rejects.toThrow(/is not empty/);
  });

  it('refuses a directory that does not exist', async () => {
    await expect(
      assertDirectoryEmpty(join(freshRun(), 'missing'), { exportsDir }),
    ).rejects.toThrow(/could not be read/);
  });

  it('is itself jailed: it will not even look outside exports/', async () => {
    await expect(assertDirectoryEmpty('/tmp', { exportsDir })).rejects.toThrow(ExportJailError);
  });
});

// ===========================================================================
describe('the jail is not macOS-only', () => {
  /**
   * THE BUG THIS PINS. Every forbidden root was a POSIX path written for a Mac.
   * On Windows none of them can match: FreeFileSync keeps `LastRun.ffs_gui` in
   * `%APPDATA%\FreeFileSync`, so the guard that stops the exporter writing over
   * a live job simply did not apply. Nothing failed -- the export succeeded,
   * which is exactly what makes it worth a test rather than a comment.
   */
  it('protects the FreeFileSync config directory on every platform', () => {
    const dirs = freeFileSyncConfigDirs();
    const joined = dirs.join('|');
    expect(joined, 'macOS').toMatch(/Library[\\/]Application Support[\\/]FreeFileSync/);
    expect(joined, 'Windows').toMatch(/AppData[\\/]Roaming[\\/]FreeFileSync|APPDATA/i);
    expect(joined, 'Linux').toMatch(/\.config[\\/]FreeFileSync/);
    // And every one of them is in force, not merely listed.
    for (const d of dirs) expect(DEFAULT_FORBIDDEN_ROOTS).toContain(d);
  });

  it('honours %APPDATA% when the environment sets it somewhere unusual', () => {
    const before = process.env['APPDATA'];
    process.env['APPDATA'] = join('D:', 'Roaming');
    try {
      expect(freeFileSyncConfigDirs()).toContain(join('D:', 'Roaming', 'FreeFileSync'));
    } finally {
      if (before === undefined) delete process.env['APPDATA'];
      else process.env['APPDATA'] = before;
    }
  });

  it('keeps the POSIX roots even where they cannot match', () => {
    // A list that changes shape per platform is a list somebody reads wrong.
    expect(DEFAULT_FORBIDDEN_ROOTS).toContain('/Volumes');
    expect(DEFAULT_FORBIDDEN_ROOTS).toContain('/Users/Shared/ObjectMount.noindex');
  });

  it('recognises a UNC path by its shape, whatever platform is asking', () => {
    expect(isUncPath('\\\\10.10.1.53\\d3 Projects\\x.ffs_gui')).toBe(true);
    expect(isUncPath('//10.10.1.53/d3 Projects')).toBe(true);
    expect(isUncPath('C:\\Users\\seangreen\\exports')).toBe(false);
    expect(isUncPath('/Users/seangreen/exports')).toBe(false);
    // A single leading slash is an ordinary absolute path, not a share.
    expect(isUncPath('/Volumes/d3')).toBe(false);
  });

  it('refuses to write onto a network share', () => {
    // The Windows analogue of the /Volumes rule: it is where the `d3 Projects`
    // share on a playback machine appears, and it has no parent directory that
    // could be added to the forbidden roots.
    expect(() =>
      assertResolvedPathAllowed('\\\\10.10.1.53\\d3 Projects\\report.html'),
    ).toThrow(ExportJailError);
    expect(() => assertResolvedPathAllowed('//10.10.1.53/d3 Projects/report.html')).toThrow(
      /network share/,
    );
  });

  it('refuses even when the export directory itself is the share', () => {
    expect(() =>
      assertResolvedPathAllowed('//srv/share/exports/report.html', {
        exportsDir: '//srv/share/exports',
      }),
    ).toThrow(/network share/);
  });
});

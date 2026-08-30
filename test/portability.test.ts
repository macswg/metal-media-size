/**
 * ============================================================================
 *  PORTABILITY  --  THE THINGS THAT BREAK ON A PC AND SAY NOTHING
 * ============================================================================
 *
 * This project was written on a Mac and ships `start-analyser.bat`, so Windows
 * is a supported target rather than a hypothetical one. Three things had gone
 * wrong there, and all three were silent in the sense that matters: nothing
 * threw on macOS, and nobody would notice until a PC was in front of them.
 *
 *   1. `npm run serve` and `npm run probe` began with `UV_THREADPOOL_SIZE=64`,
 *      which is POSIX shell syntax. npm runs scripts through `cmd.exe` on
 *      Windows, where a leading `NAME=value` is the name of a program. Neither
 *      script started -- and `start-analyser.bat` calls `npm run serve` as its
 *      last line.
 *
 *   2. The value therefore was not set at all, which is the documented
 *      slow-probe-and-starved-UI failure in CLAUDE.md.
 *
 *   3. The export jail's forbidden roots were all POSIX paths. On Windows none
 *      could match, so the guard protecting a live `LastRun.ffs_gui` did not
 *      apply -- and the export SUCCEEDED, which is why it needed a test rather
 *      than a comment. That one is pinned in `export-jail.test.ts`.
 *
 * A test can only assert the shape of these from here; what it cannot do is run
 * cmd.exe. So it asserts the property that made them wrong -- shell syntax in a
 * script, and a POSIX-only assumption -- rather than the symptom.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_THREADPOOL_SIZE,
  resolveThreadpoolSize,
  threadpoolSize,
} from '../src/cli/threadpool.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('npm scripts run on cmd.exe as well as on a shell', () => {
  it('sets no environment variable with shell syntax', () => {
    // `FOO=bar node x.js` is a POSIX shell assignment and a Windows program
    // name. The env var this project needs is set inside Node instead.
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script, `${name}: ${script}`).not.toMatch(/(^|&&\s*)[A-Z_][A-Z0-9_]*=/);
    }
  });

  it('quotes globs with double quotes, which cmd.exe strips', () => {
    // cmd.exe leaves single quotes in place, so `--exclude '**/x'` reaches
    // vitest with the quotes attached and matches nothing.
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script, `${name}: ${script}`).not.toMatch(/'/);
    }
  });

  it('still launches the server and the probe', () => {
    // Guards against fixing the quoting by deleting the script.
    expect(pkg.scripts['serve']).toMatch(/src\/cli\/serve\.ts/);
    expect(pkg.scripts['probe']).toMatch(/src\/cli\/probe\.ts/);
  });
});

describe('the thread pool is sized in Node, where every platform sees it', () => {
  it('has already set the variable by the time the module is imported', () => {
    expect(process.env['UV_THREADPOOL_SIZE']).toBe(threadpoolSize);
    expect(threadpoolSize).toBe(DEFAULT_THREADPOOL_SIZE);
  });

  it('keeps 64, the size measured on the real mount', () => {
    // At the default of 4 the probe runs at ~4.7 files/s instead of ~10 and the
    // web UI starves behind archive reads. See CLAUDE.md.
    expect(DEFAULT_THREADPOOL_SIZE).toBe('64');
  });

  it('is the FIRST import of both entry points', () => {
    // ES modules evaluate imports in source order, before the importing
    // module's body. Anywhere but first and the pool may already exist.
    for (const entry of ['serve.ts', 'probe.ts']) {
      const source = readFileSync(join(PROJECT_ROOT, 'src', 'cli', entry), 'utf8');
      const firstImport = /^import .*$/m.exec(source);
      expect(firstImport?.[0], entry).toContain('threadpool.ts');
    }
  });

  it('lets an explicit value from the environment win', () => {
    // An operator tuning it from outside must not be overridden -- including
    // tuning it DOWN, which is the case a `Math.max` would quietly break.
    expect(resolveThreadpoolSize('8')).toBe('8');
    expect(resolveThreadpoolSize('128')).toBe('128');
  });

  it('supplies the default when the environment says nothing usable', () => {
    expect(resolveThreadpoolSize(undefined)).toBe(DEFAULT_THREADPOOL_SIZE);
    expect(resolveThreadpoolSize('')).toBe(DEFAULT_THREADPOOL_SIZE);
    expect(resolveThreadpoolSize('   ')).toBe(DEFAULT_THREADPOOL_SIZE);
  });
});

describe('paths do not assume a platform', () => {
  it('reports scanned paths with forward slashes whatever the OS uses', () => {
    // `rel_path` is stored in the index, shown in the UI and written into the
    // FreeFileSync manifest. A backslash there would change what every one of
    // those means, so the walker normalises at the point of capture.
    const walker = readFileSync(join(PROJECT_ROOT, 'src', 'scan', 'walk.ts'), 'utf8');
    expect(walker).toMatch(/relative\(root, full\)\.split\(sep\)\.join\('\/'\)/);
  });

  it('compares path boundaries with the platform separator, not a slash', () => {
    // `isUnder(a, b)` deciding on `'/'` would let `C:\archive-other` look like
    // it was inside `C:\archive`.
    for (const f of [['fs', 'readonly.ts'], ['export', 'writer.ts'], ['rig', 'mounts.ts']]) {
      const source = readFileSync(join(PROJECT_ROOT, 'src', ...f), 'utf8');
      expect(source, f.join('/')).toMatch(/root \+ sep/);
    }
  });
});

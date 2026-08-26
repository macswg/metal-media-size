/**
 * Behavioural tests for the read-only chokepoint: the allowlist fence and the
 * per-directory timeout. These run against the PROJECT directory, never the
 * archive, so they are fast and safe.
 */

import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  ReadOnlyFs,
  PathNotAllowedError,
  DirTimeoutError,
  raceWithTimeout,
} from '../src/fs/readonly.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The mount root that stalls indefinitely. Must always be refused. */
const STALLING_MOUNT_ROOT = '/Users/Shared/ObjectMount.noindex/show-archive';
const CONFIGURED_ROOT = `${STALLING_MOUNT_ROOT}/SHOW_2026/00_D3_Delivery`;

describe('root allowlist', () => {
  const rofs = new ReadOnlyFs({ allowedRoots: [PROJECT_ROOT] });

  it('permits paths inside an allowed root', () => {
    expect(rofs.isAllowed(join(PROJECT_ROOT, 'src/fs/readonly.ts'))).toBe(true);
    expect(rofs.isAllowed(PROJECT_ROOT)).toBe(true);
  });

  it('refuses paths outside every allowed root', () => {
    expect(rofs.isAllowed('/etc/passwd')).toBe(false);
    expect(rofs.isAllowed('/')).toBe(false);
    expect(() => rofs.assertAllowed('/etc/passwd')).toThrow(PathNotAllowedError);
  });

  it('refuses a sibling directory that merely shares a name prefix', () => {
    // `${PROJECT_ROOT}-evil` must NOT count as inside `${PROJECT_ROOT}`.
    expect(rofs.isAllowed(`${PROJECT_ROOT}-evil/x.ts`)).toBe(false);
  });

  it('refuses traversal back out of the root', () => {
    expect(rofs.isAllowed(join(PROJECT_ROOT, '../../../etc/passwd'))).toBe(false);
  });

  it('CRITICAL: refuses the stalling object-mount root when scoped to the delivery folder', () => {
    const scoped = new ReadOnlyFs({ allowedRoots: [CONFIGURED_ROOT] });
    expect(scoped.isAllowed(STALLING_MOUNT_ROOT)).toBe(false);
    expect(scoped.isAllowed(`${STALLING_MOUNT_ROOT}/25_EAGLES`)).toBe(false);
    // ...while still permitting the configured root itself.
    expect(scoped.isAllowed(CONFIGURED_ROOT)).toBe(true);
    expect(scoped.isAllowed(`${CONFIGURED_ROOT}/140_RIVER`)).toBe(true);
  });

  it('rejects a relative allowed root at construction time', () => {
    expect(() => new ReadOnlyFs({ allowedRoots: ['relative/path'] })).toThrow(/absolute/);
  });

  it('requires at least one allowed root', () => {
    expect(() => new ReadOnlyFs({ allowedRoots: [] })).toThrow(/at least one/);
  });

  it('the async operations enforce the fence too, not just the sync check', async () => {
    await expect(rofs.readdir('/etc')).rejects.toThrow(PathNotAllowedError);
    await expect(rofs.lstat('/etc/passwd')).rejects.toThrow(PathNotAllowedError);
    await expect(rofs.openRead('/etc/passwd')).rejects.toThrow(PathNotAllowedError);
  });
});

describe('read operations', () => {
  const rofs = new ReadOnlyFs({ allowedRoots: [PROJECT_ROOT] });

  it('readdir returns dirent type information', async () => {
    const entries = await rofs.readdir(join(PROJECT_ROOT, 'src'));
    const names = entries.map((e) => e.name);
    expect(names).toContain('fs');
    expect(entries.find((e) => e.name === 'fs')?.isDirectory).toBe(true);
    expect(entries.find((e) => e.name === 'config.ts')?.isFile).toBe(true);
  });

  it('lstat reports size and mtime', async () => {
    const st = await rofs.lstat(join(PROJECT_ROOT, 'package.json'));
    expect(st.isFile).toBe(true);
    expect(st.size).toBeGreaterThan(0);
    expect(st.mtimeMs).toBeGreaterThan(0);
  });

  it('openRead yields a readable handle', async () => {
    const h = await rofs.openRead(join(PROJECT_ROOT, 'package.json'));
    try {
      const text = await h.readFile('utf8');
      expect(text).toContain('metal-media-size');
    } finally {
      await h.close();
    }
  });

  it('openRead opens O_RDONLY: writing through the handle fails at the OS level', async () => {
    const h = await rofs.openRead(join(PROJECT_ROOT, 'package.json'));
    try {
      // EBADF: the descriptor genuinely has no write capability, so the
      // read-only guarantee does not rest on convention alone.
      await expect(h.write('x')).rejects.toThrow();
    } finally {
      await h.close();
    }
  });
});

describe('per-directory timeout', () => {
  // The timeout mechanism is tested through `raceWithTimeout` against a promise
  // that never settles. Racing a REAL directory listing against a short budget
  // is inherently non-deterministic (measured: a 0ms budget loses the race
  // roughly half the time on a warm local directory), and a flaky test of a
  // safety mechanism is worse than no test at all.
  it('rejects with the supplied error when the budget expires', async () => {
    const never = new Promise<string>(() => {});
    await expect(
      raceWithTimeout(never, 5, () => new DirTimeoutError('/stalling/dir', 5)),
    ).rejects.toThrow(DirTimeoutError);
  });

  it('names the stalling directory and the budget in the error', async () => {
    const never = new Promise<string>(() => {});
    await expect(
      raceWithTimeout(never, 5, () => new DirTimeoutError('/stalling/dir', 5)),
    ).rejects.toThrow(/\/stalling\/dir/);
  });

  it('returns the value when the work finishes inside the budget', async () => {
    await expect(
      raceWithTimeout(Promise.resolve('done'), 60_000, () => new Error('nope')),
    ).resolves.toBe('done');
  });

  it('propagates a genuine failure rather than reporting a timeout', async () => {
    await expect(
      raceWithTimeout(Promise.reject(new Error('EACCES')), 60_000, () => new Error('nope')),
    ).rejects.toThrow('EACCES');
  });

  it('does not raise an unhandled rejection when the slow work later fails', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const slowFailure = new Promise<string>((_, rej) =>
        setTimeout(() => rej(new Error('late failure')), 10),
      );
      await expect(
        raceWithTimeout(slowFailure, 1, () => new DirTimeoutError('/d', 1)),
      ).rejects.toThrow(DirTimeoutError);
      await new Promise((r) => setTimeout(r, 60));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('records a timed-out directory as skipped so the scan can continue', async () => {
    // Drives the real readdir path with a budget it cannot meet. A 0ms budget
    // is racy, so retry until the timeout branch is exercised; each attempt
    // that resolves simply proves the listing was fast.
    const rofs = new ReadOnlyFs({ allowedRoots: [PROJECT_ROOT], dirTimeoutMs: 0 });
    for (let attempt = 0; attempt < 200 && rofs.getSkipped().length === 0; attempt++) {
      await rofs.readdir(join(PROJECT_ROOT, 'node_modules')).catch(() => {});
    }
    const skipped = rofs.getSkipped();
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]?.path).toBe(join(PROJECT_ROOT, 'node_modules'));
    expect(skipped[0]?.reason).toMatch(/timeout/);
  });

  it('a generous budget does not trip', async () => {
    const rofs = new ReadOnlyFs({ allowedRoots: [PROJECT_ROOT], dirTimeoutMs: 60_000 });
    await expect(rofs.readdir(join(PROJECT_ROOT, 'src'))).resolves.toBeInstanceOf(Array);
    expect(rofs.getSkipped()).toHaveLength(0);
  });

  it('exposes manually recorded skips alongside timeouts', () => {
    const rofs = new ReadOnlyFs({ allowedRoots: [PROJECT_ROOT] });
    rofs.recordSkip('/x', 'EACCES');
    expect(rofs.getSkipped()).toEqual([{ path: '/x', reason: 'EACCES' }]);
  });
});

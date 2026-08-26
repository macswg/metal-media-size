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

      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        denyRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = denyRe.exec(text)) !== null) {
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

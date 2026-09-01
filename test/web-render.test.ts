/**
 * =============================================================================
 *  THE WORD "null" MUST NOT APPEAR ON THE PAGE
 * =============================================================================
 *
 * The frontend has two functions called `append` and they behave differently:
 *
 *   `append(el, children)` from `dom.js`   drops null, undefined and false.
 *   `el.append(...)`, the DOM's own        STRINGIFIES them. A null child is
 *                                          rendered as the literal text "null".
 *
 * Every conditional child in this UI is written `cond ? h(...) : null`, and
 * `h()` routes its children through the helper -- so a null nested inside an
 * `h(...)` is safe, and only a null passed at the TOP LEVEL of a native
 * `.append(...)` reaches the page.
 *
 * That is not a hypothetical. On the first real rig survey the machine cards
 * rendered a stray "null" above them and "nullnull" at the foot of each one:
 * `misplacedCard` returns null when nothing is misplaced, and two of the three
 * trailing lines in a machine card are absent on a machine with nothing to
 * report. Three nulls, three words on screen, in a tool whose entire value is
 * that an operator can trust what it says about a playback rig.
 *
 * It is a silent failure -- no error, no console message, just a word -- which
 * is what makes it worth a test rather than a comment.
 * =============================================================================
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(import.meta.dirname, '..', 'src', 'web', 'js');

const files = readdirSync(WEB)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ name: `src/web/js/${f}`, source: readFileSync(join(WEB, f), 'utf8') }));

/**
 * Replace every comment with spaces, preserving offsets and line numbers.
 *
 * String and template literals are respected, so a `//` inside a URL or a
 * regex-looking string is not mistaken for the start of a comment.
 */
function blankComments(source: string): string {
  const out = source.split('');
  let quote = '';
  let comment: '' | 'line' | 'block' = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (comment === 'line') {
      if (ch === '\n') comment = '';
      else out[i] = ' ';
      continue;
    }
    if (comment === 'block') {
      if (ch === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
        comment = '';
        continue;
      }
      if (ch !== '\n') out[i] = ' ';
      continue;
    }
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '/' && next === '/') {
      comment = 'line';
      out[i] = ' ';
    } else if (ch === '/' && next === '*') {
      comment = 'block';
      out[i] = ' ';
    }
  }
  return out.join('');
}

/**
 * The arguments of every native `.append(` call, split on TOP-LEVEL commas.
 *
 * Depth-aware, and aware of strings and template literals, because this UI is
 * full of both and a comma inside one is not an argument boundary. Nested
 * `h(...)` calls come back as a single argument, which is the point: their
 * children are filtered by `h` and are not the hazard.
 */
function topLevelAppendArgs(raw: string): { line: number; args: string[] }[] {
  const out: { line: number; args: string[] }[] = [];
  // Comments are blanked first, keeping the line count, so prose describing
  // `.append(` -- of which this codebase now has a fair amount -- is not read
  // as code.
  const source = blankComments(raw);
  const call = /(?<![\w$])append\(/g;
  for (let m = call.exec(source); m !== null; m = call.exec(source)) {
    // `append(el, [...])`, the helper, is called bare; `x.append(` is the DOM's.
    // The dot must be the character immediately before -- nothing between.
    if (source[m.index - 1] !== '.') continue;

    let depth = 0;
    let quote = '';
    const args: string[] = [];
    let current = '';
    // The call's own `(`. `m` is a regex match: it has `index`, not an end.
    let i = m.index + m[0].length - 1;
    for (; i < source.length; i++) {
      const ch = source[i] as string;
      if (quote) {
        if (ch === '\\') {
          current += ch + (source[i + 1] ?? '');
          i += 1;
          continue;
        }
        if (ch === quote) quote = '';
        current += ch;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
        if (depth === 1) continue; // the call's own opening paren
        current += ch;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) break; // the call's own closing paren
        current += ch;
        continue;
      }
      if (ch === ',' && depth === 1) {
        args.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    args.push(current);
    out.push({ line: source.slice(0, m.index).split('\n').length, args: args.map((a) => a.trim()) });
  }
  return out;
}

describe('a null child never reaches the page as the word "null"', () => {
  it('passes no nullable value to the DOM’s own append', () => {
    const violations: string[] = [];
    for (const { name, source } of files) {
      for (const { line, args } of topLevelAppendArgs(source)) {
        for (const arg of args) {
          // `cond ? h(...) : null` as a WHOLE argument. Nested inside an
          // `h(...)` it is fine, and this only ever sees top-level arguments.
          if (/[:?]\s*(null|undefined|false)$/.test(arg)) {
            violations.push(`${name}:${line} — a native .append() argument can be null:\n    ${arg.replace(/\s+/g, ' ').slice(0, 120)}`);
          }
        }
      }
    }
    expect(
      violations,
      `Use \`append(el, [...])\` from dom.js, which drops null. The DOM's own append writes it out as text.\n\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * The rig tab renders several whole CARDS that are null when they have
   * nothing to say -- `missingCard` and `misplacedCard` both do. No static
   * check can see what a method returns, so this file gets the blunt rule
   * instead: it does not call the DOM's append at all.
   */
  it('keeps the rig tab off the DOM’s own append entirely', () => {
    const rig = files.find((f) => f.name.endsWith('rig.js'));
    expect(rig, 'src/web/js/rig.js is missing').toBeDefined();
    expect(topLevelAppendArgs(rig!.source)).toEqual([]);
  });
});

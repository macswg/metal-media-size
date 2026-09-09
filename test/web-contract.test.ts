/**
 * =============================================================================
 *  A FIELD THE ROUTE RETURNS MUST REACH THE THING THAT DRAWS IT
 * =============================================================================
 *
 * `api.js` does not hand the server's reclaim response to the UI. It rebuilds
 * it, field by field, in `normaliseReclaim` -- a whitelist that exists for a
 * good reason (the contract and `src/scan/reclaim.ts` disagree on two field
 * names, and accepting either keeps a mismatch cosmetic instead of blanking the
 * headline). The cost is that ADDING a field to the route is not enough. A
 * field nobody names in that function is silently dropped on the way to the
 * strip, with no error and no console message.
 *
 * That is not hypothetical. The show-file cross-check shipped with the route
 * returning `programmed`, the strip reading `r.programmed`, and the whitelist
 * naming neither -- so the board drew its "NOT cross-checked against the show
 * file" warning over an archive that was, in fact, fully cross-checked. Every
 * number on the screen was right. The one sentence saying whether they had been
 * checked against the show was wrong, and it was wrong in the direction that
 * makes an operator distrust a correct answer.
 *
 * So this test reads what the strip actually consumes and asserts the
 * normaliser passes it through. It is deliberately derived from the source
 * rather than from a hand-written list, because a hand-written list is one more
 * place to forget the same thing.
 * =============================================================================
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(import.meta.dirname, '..', 'src', 'web', 'js');
const read = (f: string): string => readFileSync(join(WEB, f), 'utf8');

/** Strip line and block comments so prose cannot satisfy or break the check. */
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
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      comment = 'line';
      out[i] = ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      comment = 'block';
      out[i] = ' ';
      continue;
    }
  }
  return out.join('');
}

/** The body of `function normaliseReclaim(...) { ... }`, comments removed. */
function normaliserBody(): string {
  const src = blankComments(read('api.js'));
  const start = src.indexOf('function normaliseReclaim');
  expect(start, 'normaliseReclaim not found in api.js').toBeGreaterThan(-1);
  // Up to the next top-level `function`, which is enough to bound it here.
  const rest = src.slice(start + 1);
  const end = rest.indexOf('\nfunction ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('the reclaim response survives api.js normalisation', () => {
  /**
   * Every `r.<field>` the strip reads out of a reclaim response. `paint()` and
   * `paintCrosscheck()` both take the normalised object and call it `r`, which
   * is what makes this scan reliable rather than a guess.
   */
  function fieldsReadByStrip(): Set<string> {
    const src = blankComments(read('reclaim.js'));
    const names = new Set<string>();
    for (const m of src.matchAll(/\br\.([A-Za-z_$][\w$]*)/g)) names.add(m[1] as string);
    return names;
  }

  it('reads at least the fields this feature depends on', () => {
    // A sanity check on the scan itself: if the regex ever stops finding
    // anything, every assertion below would pass vacuously.
    const fields = fieldsReadByStrip();
    expect(fields.has('reclaimBytes')).toBe(true);
    expect(fields.has('programmed')).toBe(true);
    expect(fields.size).toBeGreaterThan(8);
  });

  it('names every field the strip reads', () => {
    const body = normaliserBody();
    const missing = [...fieldsReadByStrip()].filter((f) => !new RegExp(`\\b${f}\\b`).test(body));
    expect(
      missing,
      `reclaim.js reads these off the reclaim response, but api.js's normaliseReclaim ` +
        `does not carry them through, so they arrive undefined: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('carries the cross-check fields specifically', () => {
    // Named as well as derived, because these three are the ones whose absence
    // is INVISIBLE: the strip's null branch is a plausible-looking warning, not
    // a blank or an error.
    const body = normaliserBody();
    // Matched as a KEY, not as a substring: `programmedBytes` contains the
    // string "programmed", so a substring check would pass with the field that
    // actually matters missing.
    for (const f of ['programmed', 'programmedBytes', 'programmedCount']) {
      expect(body, `normaliseReclaim drops ${f}`).toMatch(new RegExp(`\\b${f}:`));
    }
  });

  it('defaults the cross-check to null, not to a healthy-looking value', () => {
    // An unknown state must read as "unchecked", because the alternative is a
    // green line on an archive nobody checked.
    expect(normaliserBody()).toMatch(/programmed:\s*r\.programmed\s*\?\?\s*null/);
  });
});

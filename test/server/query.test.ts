/**
 * Unit tests for the query layer: parameter parsing, the sort allowlist and
 * the glob/regex path predicates that must never reach SQL.
 */

import { describe, it, expect } from 'vitest';
import { HttpError } from '../../src/server/errors.ts';
import {
  DEFAULT_LIMIT,
  FILE_SORT_COLUMNS,
  globToRegExp,
  makePathPredicate,
  MAX_LIMIT,
  orderByClause,
  parseFilters,
  parseKeepN,
  parsePaging,
  parseSort,
  VERSION_SORT_COLUMNS,
} from '../../src/server/query.ts';

function expectHttp(fn: () => unknown, status: number, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(status);
    expect((err as HttpError).code).toBe(code);
    return;
  }
  throw new Error('expected the call to throw an HttpError');
}

describe('parseFilters', () => {
  it('returns an empty spec for an empty query', () => {
    expect(parseFilters({})).toEqual({});
  });

  it('splits and normalises ext', () => {
    expect(parseFilters({ ext: 'MOV, .tif ,mov' }).ext).toEqual(['mov', 'tif']);
  });

  it('parses the numeric bounds', () => {
    const f = parseFilters({ minSize: '100', maxSize: '200', mtimeFrom: '1', mtimeTo: '2' });
    expect(f).toMatchObject({ minSize: 100, maxSize: 200, mtimeFrom: 1, mtimeTo: 2 });
  });

  it('rejects an inverted size range', () => {
    expectHttp(() => parseFilters({ minSize: '200', maxSize: '100' }), 400, 'bad_param');
  });

  it('rejects an inverted mtime range', () => {
    expectHttp(() => parseFilters({ mtimeFrom: '9', mtimeTo: '1' }), 400, 'bad_param');
  });

  it('rejects a non-integer size', () => {
    expectHttp(() => parseFilters({ minSize: '1.5' }), 400, 'bad_param');
  });

  it('accepts 0/1/true/false for the boolean filters', () => {
    expect(parseFilters({ isPatch: '1', hasProxy: 'false' })).toMatchObject({
      isPatch: 1,
      hasProxy: 0,
    });
  });

  it('rejects a nonsense boolean', () => {
    expectHttp(() => parseFilters({ isPatch: 'maybe' }), 400, 'bad_param');
  });

  it('rejects an unknown status', () => {
    expectHttp(() => parseFilters({ status: 'deleted' }), 400, 'bad_param');
  });

  it('rejects a malformed pathRe rather than passing it on', () => {
    expectHttp(() => parseFilters({ pathRe: '([' }), 400, 'bad_regex');
  });

  it('rejects an over-long pathRe', () => {
    expectHttp(() => parseFilters({ pathRe: 'a'.repeat(301) }), 400, 'bad_param');
  });
});

describe('parsePaging', () => {
  it('defaults to the documented page size', () => {
    expect(parsePaging({})).toEqual({ limit: DEFAULT_LIMIT, offset: 0 });
  });

  it('rejects a limit above the ceiling', () => {
    expectHttp(() => parsePaging({ limit: String(MAX_LIMIT + 1) }), 400, 'bad_param');
  });

  it('rejects a negative offset', () => {
    expectHttp(() => parsePaging({ offset: '-1' }), 400, 'bad_param');
  });
});

describe('parseKeepN', () => {
  it('rejects zero and negatives', () => {
    expectHttp(() => parseKeepN({ keepN: '0' }), 400, 'bad_param');
    expectHttp(() => parseKeepN({ keepN: '-3' }), 400, 'bad_param');
  });

  it('accepts a positive integer', () => {
    expect(parseKeepN({ keepN: '7' })).toBe(7);
  });
});

describe('parseSort -- the allowlist', () => {
  const allowed = Object.keys(FILE_SORT_COLUMNS);

  it('accepts an allowlisted column', () => {
    expect(parseSort({ sort: 'size', dir: 'asc' }, allowed, { key: 'id', dir: 'desc' })).toEqual({
      key: 'size',
      dir: 'asc',
    });
  });

  it('REJECTS an unknown column instead of interpolating it', () => {
    expectHttp(() => parseSort({ sort: 'nope' }, allowed, { key: 'id', dir: 'desc' }), 400, 'bad_sort_column');
  });

  it('REJECTS a SQL fragment dressed up as a column', () => {
    const attacks = [
      'size); DROP TABLE file;--',
      'size, (SELECT 1)',
      "size' OR '1'='1",
      'f.size',
      '1',
    ];
    for (const sort of attacks) {
      expectHttp(() => parseSort({ sort }, allowed, { key: 'id', dir: 'desc' }), 400, 'bad_sort_column');
    }
  });

  it('rejects a direction that is not asc or desc', () => {
    expectHttp(() => parseSort({ dir: 'sideways' }, allowed, { key: 'id', dir: 'desc' }), 400, 'bad_sort_dir');
  });

  it('names the allowed columns in the error, so the client can recover', () => {
    try {
      parseSort({ sort: 'nope' }, allowed, { key: 'id', dir: 'desc' });
    } catch (err) {
      expect((err as HttpError).message).toContain('relPath');
      expect((err as HttpError).details).toEqual({ allowed });
    }
  });
});

describe('orderByClause', () => {
  it('only ever emits the mapped, hand-authored SQL expression', () => {
    expect(orderByClause(FILE_SORT_COLUMNS, { key: 'size', dir: 'desc' }, 'f.id ASC')).toBe(
      'ORDER BY f.size DESC, f.id ASC',
    );
  });

  it('falls back to the tie-break for a JS-only key', () => {
    expect(orderByClause(VERSION_SORT_COLUMNS, { key: 'status', dir: 'asc' }, 'av.version_id ASC')).toBe(
      'ORDER BY av.version_id ASC',
    );
  });

  it('emits no user text even if a key somehow slipped past the allowlist', () => {
    const clause = orderByClause(FILE_SORT_COLUMNS, { key: 'DROP TABLE file', dir: 'asc' }, 'f.id ASC');
    expect(clause).toBe('ORDER BY f.id ASC');
    expect(clause).not.toContain('DROP');
  });
});

describe('globToRegExp', () => {
  it('anchors and keeps * inside a path segment', () => {
    const re = globToRegExp('100_ALPHA/*_region1.mov');
    expect(re.test('100_ALPHA/x_region1.mov')).toBe(true);
    expect(re.test('100_ALPHA/sub/x_region1.mov')).toBe(false);
    expect(re.test('200_BETA/x_region1.mov')).toBe(false);
  });

  it('lets ** cross separators', () => {
    const re = globToRegExp('**/*_region1.mov');
    expect(re.test('100_ALPHA/a/b/x_region1.mov')).toBe(true);
  });

  it('escapes regex metacharacters in the literal parts', () => {
    const re = globToRegExp('a.b/*.mov');
    expect(re.test('a.b/x.mov')).toBe(true);
    expect(re.test('axb/x.mov')).toBe(false);
  });
});

describe('makePathPredicate', () => {
  it('is null when neither path nor pathRe is set', () => {
    expect(makePathPredicate({})).toBeNull();
  });

  it('ANDs a glob and a regex together', () => {
    const p = makePathPredicate({ path: '100_ALPHA/**', pathRe: 'region2' });
    expect(p).not.toBeNull();
    expect(p?.('100_ALPHA/a_region2.mov')).toBe(true);
    expect(p?.('100_ALPHA/a_region1.mov')).toBe(false);
    expect(p?.('200_BETA/a_region2.mov')).toBe(false);
  });
});

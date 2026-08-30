/**
 * ============================================================================
 *  QUERY LAYER  --  filters, sorting, paging
 * ============================================================================
 *
 * Everything the HTTP routes need to turn a query string into SQL that is
 * SAFE BY CONSTRUCTION:
 *
 *   - Every user value goes in as a bound parameter. Nothing is interpolated.
 *   - Sort columns are looked up in a fixed allowlist. An unknown column is a
 *     400, never a string spliced into `ORDER BY`.
 *   - `path` (glob) and `pathRe` (regex) are NEVER handed to SQLite. They are
 *     compiled to a JS predicate and applied over a bounded candidate set that
 *     SQL has already narrowed.
 *
 * ---------------------------------------------------------------------------
 * TWO FILTER DOMAINS
 *
 * The same query params serve `/files` (rows are files) and `/versions`,
 * `/reclaim`, `/songs` (rows are asset-versions). A filter therefore has to
 * mean something in both domains. The mapping, decided once here:
 *
 *   param        file domain                 version domain
 *   ---------    -------------------------   ----------------------------------
 *   songFolder   file.song_folder            asset.song_folder
 *   ext          file.ext                    version has >=1 file of that ext
 *   minSize      file.size                   asset_version.bytes
 *   maxSize      file.size                   asset_version.bytes
 *   mtimeFrom    file.mtime                  asset_version.latest_mtime
 *   mtimeTo      file.mtime                  asset_version.latest_mtime
 *   path         file.rel_path (JS glob)     version has >=1 matching file
 *   pathRe       file.rel_path (JS regex)    version has >=1 matching file
 *   family       family of the file's version (display label only)
 *   isPatch      the file's version          asset_version.is_patch
 *   hasProxy     the file's version          proxy_bytes > 0 OR
 *                (0|1|only)                  region0_bytes > 0
 *                                            only = that, AND region_count = 0
 *                                            -- a whole-canvas copy with no
 *                                            slices behind it
 *   status       verdict of the file's       verdict of the version at keepN
 *                version at keepN
 *   q            substring of rel_path       substring of
 *                                            "song_folder/base ver_label"
 *
 * `family` is a DISPLAY LABEL. It filters the view; it never classifies
 * anything as removable. Only `computeReclaim` decides that.
 * ---------------------------------------------------------------------------
 */

import type { Database as Db } from 'better-sqlite3';
import { badRequest } from './errors.ts';

/** Hard ceiling on rows pulled into JS when a JS-side predicate is active. */
export const MAX_CANDIDATES = 250_000;

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 2000;

/**
 * Default "keep latest N" when the caller does not say. The contract does not
 * fix a default; 3 is chosen because it is the conservative end of the range
 * the CLI reports, so a caller who forgets the param under-states rather than
 * over-states what is safe to delete.
 */
export const DEFAULT_KEEP_N = 3;

/** Longest accepted `pathRe`. A cheap guard against pathological patterns. */
const MAX_REGEX_LENGTH = 300;

export type StatusValue = 'kept' | 'superseded';

export interface FilterSpec {
  songFolder?: string;
  ext?: string[];
  minSize?: number;
  maxSize?: number;
  mtimeFrom?: number;
  mtimeTo?: number;
  path?: string;
  pathRe?: string;
  family?: string;
  status?: StatusValue;
  isPatch?: 0 | 1;
  hasProxy?: 0 | 1 | 'only';
  q?: string;
  /**
   * Restrict to these version ids. Exists so the UI can show "only what I have
   * ticked" -- a selection lives in the browser, so the server has to be told
   * which rows it is. Version domain only; ignored for files and songs.
   */
  versionIds?: number[];
  /** Exclude these version ids. The un-ticked rows of a select-all-matched. */
  excludeIds?: number[];
}

export interface Paging {
  limit: number;
  offset: number;
}

export interface SortSpec {
  /** The API-facing column name, already validated against an allowlist. */
  key: string;
  dir: 'asc' | 'desc';
}

/** Anything Fastify hands us as a parsed query string. */
export type Query = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Scalar parsing
// ---------------------------------------------------------------------------

function str(q: Query, key: string): string | undefined {
  const v = q[key];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const last = v[v.length - 1];
    return last === undefined ? undefined : String(last);
  }
  const s = String(v);
  return s === '' ? undefined : s;
}

export function intParam(q: Query, key: string): number | undefined {
  const s = str(q, key);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw badRequest('bad_param', `${key} must be an integer, got ${JSON.stringify(s)}`);
  }
  return n;
}

export function boolIntParam(q: Query, key: string): 0 | 1 | undefined {
  const s = str(q, key);
  if (s === undefined) return undefined;
  if (s === '1' || s === 'true') return 1;
  if (s === '0' || s === 'false') return 0;
  throw badRequest('bad_param', `${key} must be 0 or 1, got ${JSON.stringify(s)}`);
}

/**
 * `hasProxy` is not quite a boolean. Beyond "has one" / "has none" there is a
 * third state worth filtering on: a version that is NOTHING BUT its
 * whole-canvas copy -- no `region1`..`regionN` slices behind it. Those are
 * offline-edit material, not deliveries of the asset, and the reclaim policy
 * treats them specially, so being able to see exactly which versions they are
 * matters.
 *
 * The predicate spans BOTH `proxy_bytes` and `region0_bytes`. In this archive
 * every region0 file is also a `_proxy3`, so the two are the same set; the
 * grammar does not require that, and a region0 rendered at full resolution is
 * still the offline-edit copy. The param keeps its name so existing links and
 * saved views keep working -- the UI calls the control "Proxy/region0".
 */
function proxyParam(q: Query): 0 | 1 | 'only' | undefined {
  const s = str(q, 'hasProxy');
  if (s === undefined) return undefined;
  if (s === 'only') return 'only';
  if (s === '1' || s === 'true') return 1;
  if (s === '0' || s === 'false') return 0;
  throw badRequest('bad_param', `hasProxy must be 0, 1 or 'only', got ${JSON.stringify(s)}`);
}

export function parseKeepN(q: Query): number {
  const n = intParam(q, 'keepN');
  if (n === undefined) return DEFAULT_KEEP_N;
  if (n < 1) throw badRequest('bad_param', `keepN must be an integer >= 1, got ${n}`);
  if (n > 1000) throw badRequest('bad_param', `keepN must be <= 1000, got ${n}`);
  return n;
}

export function parsePaging(q: Query): Paging {
  const limit = intParam(q, 'limit') ?? DEFAULT_LIMIT;
  const offset = intParam(q, 'offset') ?? 0;
  if (limit < 0) throw badRequest('bad_param', `limit must be >= 0, got ${limit}`);
  if (limit > MAX_LIMIT) {
    throw badRequest('bad_param', `limit must be <= ${MAX_LIMIT}, got ${limit}`);
  }
  if (offset < 0) throw badRequest('bad_param', `offset must be >= 0, got ${offset}`);
  return { limit, offset };
}

/**
 * Validate `?sort=` against an allowlist. THIS IS THE ONLY WAY A SORT COLUMN
 * MAY REACH SQL. The caller passes the allowlist; an unknown key is rejected
 * with a 400 that names the accepted columns.
 */
export function parseSort(
  q: Query,
  allowed: readonly string[],
  fallback: SortSpec,
): SortSpec {
  const key = str(q, 'sort');
  const dirRaw = str(q, 'dir');
  let dir: 'asc' | 'desc' = fallback.dir;
  if (dirRaw !== undefined) {
    const d = dirRaw.toLowerCase();
    if (d !== 'asc' && d !== 'desc') {
      throw badRequest('bad_sort_dir', `dir must be 'asc' or 'desc', got ${JSON.stringify(dirRaw)}`);
    }
    dir = d;
  }
  if (key === undefined) return { key: fallback.key, dir };
  if (!allowed.includes(key)) {
    throw badRequest(
      'bad_sort_column',
      `Unknown sort column ${JSON.stringify(key)}. Allowed: ${allowed.join(', ')}`,
      { allowed },
    );
  }
  return { key, dir };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Ceiling on an id list. A selection is built by a human ticking rows, so this
 * is far above any real use; it exists so a malformed request cannot ask SQLite
 * to bind a hundred thousand parameters.
 */
export const MAX_ID_LIST = 5000;

/** Comma-separated positive integers, deduplicated. */
function idListParam(q: Query, key: string): number[] | undefined {
  const raw = q[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parts = String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');
  const out: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1) {
      throw badRequest('bad_param', `${key} must be a comma-separated list of positive integers`);
    }
    out.push(n);
  }
  const unique = [...new Set(out)];
  if (unique.length > MAX_ID_LIST) {
    throw badRequest('bad_param', `${key} may hold at most ${MAX_ID_LIST} ids, got ${unique.length}`);
  }
  return unique;
}

export function parseFilters(q: Query): FilterSpec {
  const f: FilterSpec = {};

  const songFolder = str(q, 'songFolder');
  if (songFolder !== undefined) f.songFolder = songFolder;

  const ext = str(q, 'ext');
  if (ext !== undefined) {
    const list = ext
      .split(',')
      .map((s) => s.trim().replace(/^\./, '').toLowerCase())
      .filter((s) => s !== '');
    if (list.length === 0) throw badRequest('bad_param', 'ext must list at least one extension');
    f.ext = [...new Set(list)];
  }

  const versionIds = idListParam(q, 'versionIds');
  if (versionIds !== undefined) f.versionIds = versionIds;
  const excludeIds = idListParam(q, 'excludeIds');
  if (excludeIds !== undefined) f.excludeIds = excludeIds;

  const minSize = intParam(q, 'minSize');
  if (minSize !== undefined) f.minSize = minSize;
  const maxSize = intParam(q, 'maxSize');
  if (maxSize !== undefined) f.maxSize = maxSize;
  if (f.minSize !== undefined && f.maxSize !== undefined && f.minSize > f.maxSize) {
    throw badRequest('bad_param', `minSize (${f.minSize}) is greater than maxSize (${f.maxSize})`);
  }

  const mtimeFrom = intParam(q, 'mtimeFrom');
  if (mtimeFrom !== undefined) f.mtimeFrom = mtimeFrom;
  const mtimeTo = intParam(q, 'mtimeTo');
  if (mtimeTo !== undefined) f.mtimeTo = mtimeTo;
  if (f.mtimeFrom !== undefined && f.mtimeTo !== undefined && f.mtimeFrom > f.mtimeTo) {
    throw badRequest('bad_param', 'mtimeFrom is later than mtimeTo');
  }

  const path = str(q, 'path');
  if (path !== undefined) f.path = path;

  const pathRe = str(q, 'pathRe');
  if (pathRe !== undefined) {
    if (pathRe.length > MAX_REGEX_LENGTH) {
      throw badRequest('bad_param', `pathRe must be at most ${MAX_REGEX_LENGTH} characters`);
    }
    try {
      // Compiled here purely to reject a malformed pattern early with a 400.
      new RegExp(pathRe, 'i');
    } catch (err) {
      throw badRequest('bad_regex', `pathRe is not a valid regular expression: ${(err as Error).message}`);
    }
    f.pathRe = pathRe;
  }

  const family = str(q, 'family');
  if (family !== undefined) f.family = family;

  const status = str(q, 'status');
  if (status !== undefined) {
    if (status !== 'kept' && status !== 'superseded') {
      throw badRequest('bad_param', `status must be 'kept' or 'superseded', got ${JSON.stringify(status)}`);
    }
    f.status = status;
  }

  const isPatch = boolIntParam(q, 'isPatch');
  if (isPatch !== undefined) f.isPatch = isPatch;
  const hasProxy = proxyParam(q);
  if (hasProxy !== undefined) f.hasProxy = hasProxy;

  const qq = str(q, 'q');
  if (qq !== undefined) f.q = qq;

  return f;
}

/** True when nothing at all was requested. */
export function isEmptyFilter(f: FilterSpec): boolean {
  return Object.keys(f).length === 0;
}

// ---------------------------------------------------------------------------
// Path matching (JS only -- never SQL)
// ---------------------------------------------------------------------------

/**
 * Translate a shell-style glob into an anchored regex.
 *
 * `*` matches within a path segment, `**` crosses separators, `?` matches one
 * character. Everything else is escaped. Matching is case-insensitive to suit
 * a macOS archive.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/**
 * Build the JS predicate for `path` / `pathRe`, or null when neither is set.
 * A glob is anchored to the whole relative path; a bare `foo` therefore needs
 * to be written `**\/foo*` to match mid-path, which is the least surprising
 * reading of an anchored glob.
 */
export function makePathPredicate(f: FilterSpec): ((relPath: string) => boolean) | null {
  const parts: ((p: string) => boolean)[] = [];
  if (f.path !== undefined) {
    const re = globToRegExp(f.path);
    parts.push((p) => re.test(p));
  }
  if (f.pathRe !== undefined) {
    const re = new RegExp(f.pathRe, 'i');
    parts.push((p) => re.test(p));
  }
  if (parts.length === 0) return null;
  return (p: string) => parts.every((fn) => fn(p));
}

/**
 * Version ids owning at least one file whose relative path satisfies the
 * `path` / `pathRe` predicate.
 *
 * The candidate set is bounded by the snapshot's file count and narrowed first
 * by whatever else SQL can express, so this stays a scan over tens of
 * thousands of short strings, not a table scan per row.
 */
export function versionIdsMatchingPath(
  db: Db,
  snapshotId: number,
  predicate: (relPath: string) => boolean,
): Set<number> {
  const rows = db
    .prepare(
      `SELECT rel_path, asset_version_id
         FROM file
        WHERE snapshot_id = ? AND asset_version_id IS NOT NULL`,
    )
    .all(snapshotId) as { rel_path: string; asset_version_id: number }[];
  const ids = new Set<number>();
  for (const r of rows) {
    if (predicate(r.rel_path)) ids.add(r.asset_version_id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// SQL fragment builders
// ---------------------------------------------------------------------------

export interface SqlWhere {
  /** Conjunction of parameterised predicates, already joined with AND. */
  sql: string;
  params: unknown[];
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/**
 * WHERE fragment for the FILE domain.
 *
 * Callers must select from `file f LEFT JOIN v_asset_version av
 * ON av.version_id = f.asset_version_id`.
 */
export function fileWhere(snapshotId: number, f: FilterSpec): SqlWhere {
  const parts = ['f.snapshot_id = ?'];
  const params: unknown[] = [snapshotId];

  if (f.songFolder !== undefined) {
    parts.push('f.song_folder = ?');
    params.push(f.songFolder);
  }
  if (f.ext !== undefined) {
    parts.push(`f.ext IN (${placeholders(f.ext.length)})`);
    params.push(...f.ext);
  }
  if (f.minSize !== undefined) {
    parts.push('f.size >= ?');
    params.push(f.minSize);
  }
  if (f.maxSize !== undefined) {
    parts.push('f.size <= ?');
    params.push(f.maxSize);
  }
  if (f.mtimeFrom !== undefined) {
    parts.push('f.mtime >= ?');
    params.push(f.mtimeFrom);
  }
  if (f.mtimeTo !== undefined) {
    parts.push('f.mtime <= ?');
    params.push(f.mtimeTo);
  }
  if (f.family !== undefined) {
    parts.push('av.family = ?');
    params.push(f.family);
  }
  if (f.isPatch !== undefined) {
    parts.push('av.is_patch = ?');
    params.push(f.isPatch);
  }
  if (f.hasProxy !== undefined) {
    const has = '(COALESCE(av.proxy_bytes, 0) > 0 OR COALESCE(av.region0_bytes, 0) > 0)';
    parts.push(
      f.hasProxy === 'only'
        ? `${has} AND COALESCE(av.region_count, 0) = 0`
        : f.hasProxy === 1
          ? has
          : `NOT ${has}`,
    );
  }
  if (f.q !== undefined) {
    parts.push('instr(lower(f.rel_path), lower(?)) > 0');
    params.push(f.q);
  }

  return { sql: parts.join(' AND '), params };
}

/** WHERE fragment for the VERSION domain. Callers select from `v_asset_version av`. */
export function versionWhere(snapshotId: number, f: FilterSpec): SqlWhere {
  const parts = ['av.snapshot_id = ?'];
  const params: unknown[] = [snapshotId];

  if (f.songFolder !== undefined) {
    parts.push('av.song_folder = ?');
    params.push(f.songFolder);
  }
  if (f.ext !== undefined) {
    parts.push(
      `EXISTS (SELECT 1 FROM file f2 WHERE f2.asset_version_id = av.version_id
                 AND f2.ext IN (${placeholders(f.ext.length)}))`,
    );
    params.push(...f.ext);
  }
  if (f.versionIds !== undefined) {
    // An empty list means "nothing is selected", which must match no rows --
    // NOT every row, which is what an omitted clause would do.
    if (f.versionIds.length === 0) parts.push('1 = 0');
    else {
      parts.push(`av.version_id IN (${placeholders(f.versionIds.length)})`);
      params.push(...f.versionIds);
    }
  }
  if (f.excludeIds !== undefined && f.excludeIds.length > 0) {
    parts.push(`av.version_id NOT IN (${placeholders(f.excludeIds.length)})`);
    params.push(...f.excludeIds);
  }
  if (f.minSize !== undefined) {
    parts.push('av.bytes >= ?');
    params.push(f.minSize);
  }
  if (f.maxSize !== undefined) {
    parts.push('av.bytes <= ?');
    params.push(f.maxSize);
  }
  if (f.mtimeFrom !== undefined) {
    parts.push('av.latest_mtime >= ?');
    params.push(f.mtimeFrom);
  }
  if (f.mtimeTo !== undefined) {
    parts.push('av.latest_mtime <= ?');
    params.push(f.mtimeTo);
  }
  if (f.family !== undefined) {
    parts.push('av.family = ?');
    params.push(f.family);
  }
  if (f.isPatch !== undefined) {
    parts.push('av.is_patch = ?');
    params.push(f.isPatch);
  }
  if (f.hasProxy !== undefined) {
    const has = '(av.proxy_bytes > 0 OR av.region0_bytes > 0)';
    parts.push(
      f.hasProxy === 'only'
        ? `${has} AND av.region_count = 0`
        : f.hasProxy === 1
          ? has
          : `NOT ${has}`,
    );
  }
  if (f.q !== undefined) {
    parts.push("instr(lower(av.song_folder || '/' || av.base || ' ' || av.ver_label), lower(?)) > 0");
    params.push(f.q);
  }

  return { sql: parts.join(' AND '), params };
}

// ---------------------------------------------------------------------------
// Sort allowlists. Values are FIXED SQL expressions authored here; the caller
// only ever supplies the KEY, which must already be in the map.
// ---------------------------------------------------------------------------

export const FILE_SORT_COLUMNS: Record<string, string> = {
  id: 'f.id',
  relPath: 'f.rel_path',
  songFolder: 'f.song_folder',
  name: 'f.name',
  ext: 'f.ext',
  size: 'f.size',
  mtime: 'f.mtime',
  parseOk: 'f.parse_ok',
  assetVersionId: 'f.asset_version_id',
  // Sorting by resolution means sorting by pixel count: 8996x2584 and
  // 3976x3248 cannot be ordered by either axis alone. Unprobed rows sort as 0,
  // which puts them at one end rather than scattering them through the list.
  resolution: 'COALESCE(fm.width, 0) * COALESCE(fm.height, 0)',
  width: 'COALESCE(fm.width, 0)',
  height: 'COALESCE(fm.height, 0)',
};

export const VERSION_SORT_COLUMNS: Record<string, string> = {
  versionId: 'av.version_id',
  assetId: 'av.asset_id',
  songFolder: 'av.song_folder',
  base: 'av.base',
  family: 'av.family',
  verNum: 'av.ver_num',
  // `v002`, `v002d` and `v002f` are three DIFFERENT versions, so ver_num alone
  // is not a unique key within an asset. Sorting by version means ordering by
  // (ver_num, sub_letter) with an absent letter first -- which is SQLite's
  // default ASC behaviour for NULL.
  subLetter: 'av.sub_letter',
  verLabel: 'av.ver_label',
  isPatch: 'av.is_patch',
  patchFrame: 'av.patch_frame',
  bytes: 'av.bytes',
  fileCount: 'av.file_count',
  proxyBytes: 'av.proxy_bytes',
  region0Bytes: 'av.region0_bytes',
  regionCount: 'av.region_count',
  latestMtime: 'av.latest_mtime',
  // Resolved from the reclaim verdicts in JS, not from SQL.
  status: '',
};

export const SONG_SORT_COLUMNS: Record<string, string> = {
  songFolder: '',
  fileCount: '',
  totalBytes: '',
  assetCount: '',
  versionCount: '',
  supersededBytes: '',
  supersededCount: '',
  latestMtime: '',
};

/** Sort keys that cannot be expressed in SQL and must be applied in JS. */
export const JS_ONLY_SORT_KEYS = new Set(['status']);

export function orderByClause(map: Record<string, string>, sort: SortSpec, tieBreak: string): string {
  const col = map[sort.key];
  if (col === undefined || col === '') return `ORDER BY ${tieBreak}`;
  return `ORDER BY ${col} ${sort.dir === 'asc' ? 'ASC' : 'DESC'}, ${tieBreak}`;
}

// ---------------------------------------------------------------------------
// Generic in-JS listing: sort, total, matchedBytes, page
// ---------------------------------------------------------------------------

export interface Listing<T> {
  rows: T[];
  total: number;
  matchedBytes: number;
}

export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** Sort (stable), total, sum of bytes, then slice one page out of `rows`. */
export function listInJs<T>(
  rows: T[],
  opts: {
    sort?: { key: string; dir: 'asc' | 'desc' } | undefined;
    accessor?: ((row: T, key: string) => unknown) | undefined;
    bytesOf: (row: T) => number;
    paging: Paging;
  },
): Listing<T> {
  let out = rows;
  if (opts.sort && opts.accessor) {
    const { key, dir } = opts.sort;
    const sign = dir === 'asc' ? 1 : -1;
    const acc = opts.accessor;
    out = [...rows].sort((x, y) => sign * compareValues(acc(x, key), acc(y, key)));
  }
  let matchedBytes = 0;
  for (const r of out) matchedBytes += opts.bytesOf(r);
  const { limit, offset } = opts.paging;
  return { rows: out.slice(offset, offset + limit), total: out.length, matchedBytes };
}

export function guardCandidateCount(n: number, what: string): void {
  if (n > MAX_CANDIDATES) {
    throw badRequest(
      'candidate_set_too_large',
      `${what}: ${n} candidate rows exceeds the ${MAX_CANDIDATES} row ceiling for ` +
        `in-process path matching. Narrow the query (songFolder, ext, minSize) first.`,
    );
  }
}

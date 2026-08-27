/**
 * ============================================================================
 *  SQLITE SCHEMA  --  THE CONTRACT FOR THE API, FRONTEND AND EXPORTER AGENTS
 * ============================================================================
 *
 * Assets and asset-versions are DERIVED AT SCAN TIME and stored, so the UI
 * queries a prepared index instead of re-deriving the grammar on every request.
 *
 * SNAPSHOTS ARE RETAINED AND DIFFABLE. A scan always INSERTs a new `snapshot`
 * row; it never updates or deletes a prior one. Every other table carries a
 * `snapshot_id` (directly, or via `asset`), so two snapshots can be compared
 * with ordinary SQL.
 *
 * Byte columns are INTEGER (SQLite's 64-bit). The largest value in play is
 * ~1.5e14, well inside JavaScript's safe-integer range, so the driver's default
 * number handling is correct here.
 *
 * ---------------------------------------------------------------------------
 * COLUMNS ADDED BEYOND THE AGREED CONTRACT (additive only, nothing renamed):
 *
 *   file.asset_version_id  -- nullable FK to asset_version. Without it the
 *     exporter would have to re-derive the grammar to turn a superseded
 *     version back into the list of files it covers. It is NULL exactly when
 *     parse_ok = 0.
 *   snapshot.name / elapsed_ms / dir_count / excluded_count / excluded_bytes /
 *     unparsed_count / skipped_json -- scan provenance. `excluded_*` is where
 *     the FreeFileSync bookkeeping files are counted so they are never
 *     silently invisible.
 *   asset_version.ver_label -- the version as displayed, e.g. `v008d`.
 *   asset_version.region0_bytes -- subtotal of `bytes` held in `region0`
 *     files, the whole-canvas copy the offline edit is cut against. Kept apart
 *     from `proxy_bytes` because region0 says WHICH part of the canvas and
 *     `_proxyN` says AT WHAT RESOLUTION; they coincide in this delivery and
 *     need not in the next. Added in schema version 2, and backfilled for
 *     snapshots scanned before it -- see `migrate` in db/index.ts.
 *   file_media -- pixel dimensions, written only by `npm run probe`. Kept out
 *     of `file` so that the insert-only guarantee on a scan's rows holds
 *     literally: a probe adds rows to its own table and edits nothing.
 * ---------------------------------------------------------------------------
 */

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per scan. Never updated in place by a later scan; never deleted.
CREATE TABLE IF NOT EXISTS snapshot (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  root           TEXT    NOT NULL,
  started_at     INTEGER NOT NULL,          -- epoch ms
  finished_at    INTEGER,                   -- epoch ms, NULL while running
  file_count     INTEGER NOT NULL DEFAULT 0,
  total_bytes    INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'running',
                 -- 'running' | 'complete' | 'failed'
  -- provenance (additive)
  name           TEXT,
  elapsed_ms     INTEGER,
  dir_count      INTEGER,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  excluded_bytes INTEGER NOT NULL DEFAULT 0,
  unparsed_count INTEGER NOT NULL DEFAULT 0,
  skipped_json   TEXT                       -- JSON array of {path, reason}
);

-- One row per analysed file. Excluded bookkeeping files are NOT rows here;
-- they are counted in snapshot.excluded_count / excluded_bytes.
CREATE TABLE IF NOT EXISTS file (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id      INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  rel_path         TEXT    NOT NULL,        -- relative to snapshot.root, '/' separated
  song_folder      TEXT    NOT NULL,        -- first path segment, '' at root level
  name             TEXT    NOT NULL,
  ext              TEXT    NOT NULL,        -- lower-case, no dot
  size             INTEGER NOT NULL,
  mtime            INTEGER NOT NULL,        -- epoch ms
  parse_ok         INTEGER NOT NULL,        -- 0/1
  asset_version_id INTEGER REFERENCES asset_version(id) ON DELETE SET NULL
);

-- Pixel dimensions, filled in by 'npm run probe' and NEVER by a scan.
--
-- A separate table on purpose. Snapshots are insert-only: a scan's file rows
-- are a record of what the archive looked like at a moment, and the probe --
-- which runs later, on the operator's say-so -- must not reach back and edit
-- them. A row here means the file HAS been probed; NULL width/height means it
-- was probed and had no dimensions to give (unreadable, or not a movie), which
-- is what stops the next run retrying it forever.
CREATE TABLE IF NOT EXISTS file_media (
  file_id   INTEGER PRIMARY KEY REFERENCES file(id) ON DELETE CASCADE,
  width     INTEGER,
  height    INTEGER,
  probed_at INTEGER NOT NULL                -- epoch ms
);

-- Asset identity is (snapshot_id, song_folder, base). The base is VERBATIM.
CREATE TABLE IF NOT EXISTS asset (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  song_folder TEXT    NOT NULL,
  base        TEXT    NOT NULL,
  -- DISPLAY LABEL ONLY. Never use family to classify anything as removable.
  family      TEXT    NOT NULL
);

-- One row per (version number, sub-letter, patch) group within an asset. A
-- version's regions and its proxy roll up into one row. A '_frameNNNNN'
-- patch gets its OWN row, because a patch never replaces the full render of
-- the same number.
CREATE TABLE IF NOT EXISTS asset_version (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id     INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  ver_num      INTEGER NOT NULL,
  -- Single lower-case sub-revision letter, or NULL for the bare 'vNNN' form.
  -- Part of the version's IDENTITY: 'v002', 'v002d' and 'v002f' are THREE
  -- separate rows, ordered v002 < v002d < v002f < v003 (absent letter first).
  -- Ranking and keep-latest-N use (ver_num, sub_letter).
  sub_letter   TEXT,
  is_patch     INTEGER NOT NULL,            -- 0/1; 1 = partial re-render
  patch_frame  INTEGER,                     -- NULL unless is_patch = 1
  bytes        INTEGER NOT NULL,            -- includes proxy_bytes
  file_count   INTEGER NOT NULL,
  proxy_bytes  INTEGER NOT NULL,            -- subtotal of bytes
  -- Subtotal of bytes in region0 files: the whole-canvas copy kept for offline
  -- editing. NOT the same column as proxy_bytes even though this archive's
  -- region0 files are all proxies -- see the header note.
  region0_bytes INTEGER NOT NULL DEFAULT 0, -- subtotal of bytes
  region_count INTEGER NOT NULL,            -- distinct slices, excl. region0
  latest_mtime INTEGER NOT NULL,            -- epoch ms
  ver_label    TEXT    NOT NULL             -- e.g. 'v008d', 'v003 frame05259'
);

-- Indexes on the columns the UI filters and sorts on.
CREATE INDEX IF NOT EXISTS idx_file_snapshot      ON file(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_file_size          ON file(snapshot_id, size DESC);
CREATE INDEX IF NOT EXISTS idx_file_mtime         ON file(snapshot_id, mtime DESC);
CREATE INDEX IF NOT EXISTS idx_file_ext           ON file(snapshot_id, ext);
CREATE INDEX IF NOT EXISTS idx_file_song          ON file(snapshot_id, song_folder);
CREATE INDEX IF NOT EXISTS idx_file_version       ON file(asset_version_id);
CREATE INDEX IF NOT EXISTS idx_file_relpath       ON file(snapshot_id, rel_path);
CREATE INDEX IF NOT EXISTS idx_file_parse_ok      ON file(snapshot_id, parse_ok);
-- Carrying probe results across a rescan matches on identity, not on file id.
CREATE INDEX IF NOT EXISTS idx_file_identity      ON file(rel_path, size, mtime);

CREATE INDEX IF NOT EXISTS idx_asset_snapshot     ON asset(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_asset_song         ON asset(snapshot_id, song_folder);
CREATE INDEX IF NOT EXISTS idx_asset_family       ON asset(snapshot_id, family);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_ident ON asset(snapshot_id, song_folder, base);

CREATE INDEX IF NOT EXISTS idx_av_asset           ON asset_version(asset_id);
CREATE INDEX IF NOT EXISTS idx_av_patch           ON asset_version(is_patch);
CREATE INDEX IF NOT EXISTS idx_av_bytes           ON asset_version(bytes DESC);
CREATE INDEX IF NOT EXISTS idx_av_mtime           ON asset_version(latest_mtime DESC);
CREATE INDEX IF NOT EXISTS idx_av_ver             ON asset_version(asset_id, ver_num, sub_letter);
`;

/**
 * Convenience views for the API agent. Kept separate from SCHEMA_SQL so they
 * can be dropped and recreated without touching the tables.
 */
export const VIEWS_SQL = `
DROP VIEW IF EXISTS v_asset_version;
CREATE VIEW v_asset_version AS
SELECT
  av.id            AS version_id,
  av.asset_id      AS asset_id,
  a.snapshot_id    AS snapshot_id,
  a.song_folder    AS song_folder,
  a.base           AS base,
  a.family         AS family,
  av.ver_num, av.sub_letter, av.ver_label,
  av.is_patch, av.patch_frame,
  av.bytes, av.file_count, av.proxy_bytes, av.region0_bytes, av.region_count,
  av.latest_mtime
FROM asset_version av
JOIN asset a ON a.id = av.asset_id;

DROP VIEW IF EXISTS v_song_summary;
CREATE VIEW v_song_summary AS
SELECT
  snapshot_id,
  song_folder,
  COUNT(*)    AS file_count,
  SUM(size)   AS total_bytes,
  MAX(mtime)  AS latest_mtime
FROM file
GROUP BY snapshot_id, song_folder;
`;

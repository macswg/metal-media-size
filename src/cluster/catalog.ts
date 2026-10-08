/**
 * =============================================================================
 *  THE CLUSTER, AS THE MEDIA INDEX CATALOG LAST SAW IT
 * =============================================================================
 *
 * The rig scanner in `moose_2026/media_search_base` walks every playback
 * machine's share and records each file -- path, name, size -- in a Postgres
 * catalog, marking a file `missing_at` once a completed scan stops finding it.
 * That catalog already answers the question this module asks: which files are
 * on the cluster right now. So we READ it, and never walk the machines again
 * ourselves. A rig scan is disruptive and is armed by a person in that
 * project; nothing here starts one, asks for one, or touches a machine.
 *
 * THE ONLY FILE IN `src/` THAT MAY IMPORT `pg`. Pinned by
 * `test/readonly-enforcement.test.ts`, alongside the rule that every statement
 * here is a SELECT.
 *
 * READ-ONLY THREE TIMES OVER, so no one mistake can change the catalog:
 *
 *   1. the login is `metal_media_ro`, a role granted SELECT on six tables and
 *      nothing else, with `default_transaction_read_only = on` set on the role;
 *   2. every read runs inside `BEGIN READ ONLY`, so Postgres refuses a write
 *      even from a login that could make one;
 *   3. the SQL below is SELECT only, and a test says so.
 *
 * NOTHING IS STORED. The listing lives in memory (`ClusterSource`) and is
 * never put in `data/index.db`, `exports/` or a log. The URL carries a
 * credential, so no message built here quotes it.
 *
 * THE CLUSTER IS ONE LOCATION. Which machine holds a file is kept for the
 * per-machine counts, and decides nothing else: a file is "on the cluster"
 * when any seat in the configured roles holds it at the archive's size.
 * =============================================================================
 */

import pg from 'pg';
import type { MediaIndexConfig } from '../config.ts';

/** One seat on the cluster, as the catalog has it. */
export interface ClusterMachine {
  key: string;
  role: string;
  regions: number[];
  disabled: boolean;
  /** Catalog location the seat's files are scanned into. */
  location: string;
  /** Files present on it (not `missing_at`). Zero on a disabled seat: not read. */
  files: number;
  bytes: number;
  /**
   * The drive as the rig scanner measured it at the start of its last scan
   * (`root_space`), or null when the catalog has no reading -- or when this
   * login may not read that table, which is reported the same way rather
   * than failing the whole listing over a figure that only adds context.
   */
  space: { totalBytes: number; freeBytes: number; at: string | null } | null;
  /**
   * Whether its location's last complete scan READ it. Null when that location
   * has never completed a scan.
   */
  read: MachineRead | null;
}

/**
 * A scan that cannot read a path leaves the files under it exactly as an
 * earlier scan listed them, and still completes. So a machine the last scan
 * could not reach keeps its old file list beside a fresh scan time, and only
 * this says so.
 *
 *   - `read`: the last complete scan reached all of it.
 *   - `partly`: it reached the machine but not every folder on it; files under
 *     `unreadable` are as an earlier scan listed them.
 *   - `not-read`: it did not reach the machine at all. Its whole listing is as
 *     of `lastReadAt` -- the newest complete scan that did, if any of the
 *     recent ones did.
 */
export interface MachineRead {
  state: 'read' | 'partly' | 'not-read';
  /** Paths at or under this machine the last complete scan could not read. */
  unreadable: string[];
  /** Finish of the newest complete scan that reached the machine at all. */
  lastReadAt: string | null;
}

/** A location's complete scans, newest first, with what each could not read. */
export interface CompleteScan {
  finishedAt: string | null;
  unreadable: readonly string[];
}

/** How many complete scans per location are searched for a machine's last read. */
export const READ_HISTORY_SCANS = 50;

/**
 * What the recent complete scans of a machine's location say about whether
 * they read it. Pure. `scans` is newest first. A path is the machine's when
 * it is its key, or under it with either separator, since a Windows agent
 * sends backslashes; `.` is the location's whole root.
 */
export function machineReadState(key: string, scans: readonly CompleteScan[]): MachineRead | null {
  if (scans.length === 0) return null;
  const whole = (p: string) => p === '.' || p === key;
  const mine = (p: string) => whole(p) || p.startsWith(`${key}/`) || p.startsWith(`${key}\\`);
  const last = scans[0]!;
  const unreadable = last.unreadable.filter(mine);
  const missed = unreadable.some(whole);
  const reached = scans.find((s) => !s.unreadable.some(whole));
  return {
    state: missed ? 'not-read' : unreadable.length ? 'partly' : 'read',
    unreadable,
    lastReadAt: reached?.finishedAt ?? null,
  };
}

/** When the catalog last walked a location that holds part of the cluster. */
export interface ClusterScan {
  location: string;
  /** Finish of the newest COMPLETE scan -- what the listing is as of. */
  lastCompleteAt: string | null;
  /** The newest scan of any ending, which may be newer and may have failed. */
  newestStatus: string | null;
  newestStartedAt: string | null;
}

export interface ClusterFile {
  machine: string;
  name: string;
  size: number;
}

export interface ClusterListing {
  cluster: string;
  roles: string[];
  machines: ClusterMachine[];
  scans: ClusterScan[];
  files: ClusterFile[];
  /** When this process read the catalog. Not when the cluster was scanned. */
  readAt: string;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

/**
 * Read the cluster's file list.
 *
 * THROWS when the catalog cannot be reached, the cluster is not there, or no
 * seat matches the roles: an empty listing is what "nothing is on the
 * cluster" looks like, and that must never be produced by a failed read.
 */
export async function readClusterListing(cfg: MediaIndexConfig): Promise<ClusterListing> {
  const client = new pg.Client({
    connectionString: cfg.databaseUrl,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 60_000,
    application_name: 'metal-media-size',
  });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`Media Index catalog not reachable: ${(e as Error).message}`);
  }
  try {
    await client.query('BEGIN READ ONLY');

    const seats = await client.query<{
      key: string;
      role: string;
      regions: number[];
      disabled: boolean;
      location_id: string;
      location: string;
    }>(
      `SELECT cm.key, cm.role, cm.regions, cm.disabled, cm.location_id, l.slug AS location
         FROM cluster_machines cm
         JOIN clusters c ON c.id = cm.cluster_id
         JOIN locations l ON l.id = cm.location_id
        WHERE c.slug = $1 AND cm.role = ANY($2::text[])
        ORDER BY cm.key`,
      [cfg.cluster, cfg.roles],
    );
    if (seats.rows.length === 0) {
      throw new Error(
        `Media Index has no ${cfg.roles.join('/')} seats in a cluster named ${JSON.stringify(cfg.cluster)}.`,
      );
    }

    // A catalog path starts with the machine key the rig scanner labels each
    // root with, so the first segment says which seat a file is on.
    const files = await client.query<{ machine: string; name: string; size: string }>(
      `SELECT cm.key AS machine, f.name, f.size_bytes AS size
         FROM files f
         JOIN cluster_machines cm
           ON cm.location_id = f.location_id AND cm.key = split_part(f.path, '/', 1)
         JOIN clusters c ON c.id = cm.cluster_id
        WHERE c.slug = $1 AND cm.role = ANY($2::text[]) AND NOT cm.disabled
          AND f.missing_at IS NULL`,
      [cfg.cluster, cfg.roles],
    );

    const locationIds = [...new Set(seats.rows.map((r) => r.location_id))];
    const scans = await client.query<{
      location: string;
      last_complete_at: Date | null;
      newest_status: string | null;
      newest_started_at: Date | null;
    }>(
      `SELECT l.slug AS location,
              (SELECT max(s.finished_at) FROM scans s
                WHERE s.location_id = l.id AND s.status = 'complete') AS last_complete_at,
              n.status AS newest_status, n.started_at AS newest_started_at
         FROM locations l
         LEFT JOIN LATERAL (
           SELECT status, started_at FROM scans
            WHERE location_id = l.id ORDER BY started_at DESC LIMIT 1
         ) n ON true
        WHERE l.id = ANY($1::bigint[])
        ORDER BY l.slug`,
      [locationIds],
    );

    // Each location's recent complete scans and the paths each could not
    // read, for whether the last one reached every machine.
    const history = await client.query<{ location_id: string; finished_at: Date | null; unreadable: string[] | null }>(
      `SELECT l.id AS location_id, h.finished_at, h.unreadable
         FROM locations l
         CROSS JOIN LATERAL (
           SELECT finished_at, unreadable FROM scans
            WHERE location_id = l.id AND status = 'complete'
            ORDER BY finished_at DESC LIMIT $2
         ) h
        WHERE l.id = ANY($1::bigint[])
        ORDER BY l.id, h.finished_at DESC`,
      [locationIds, READ_HISTORY_SCANS],
    );
    const completeScans = new Map<string, CompleteScan[]>();
    for (const r of history.rows) {
      const list = completeScans.get(String(r.location_id)) ?? [];
      list.push({ finishedAt: iso(r.finished_at), unreadable: r.unreadable ?? [] });
      completeScans.set(String(r.location_id), list);
    }

    // Drive size and free space per seat. Optional: asked first, because a
    // failed statement would abort the transaction and with it the listing.
    const canSpace = await client.query<{ ok: boolean }>(
      `SELECT has_table_privilege('root_space', 'SELECT') AS ok`,
    );
    const space = new Map<string, { totalBytes: number; freeBytes: number; at: string | null }>();
    if (canSpace.rows[0]?.ok) {
      const rs = await client.query<{ location_id: string; label: string; total: string; free: string; at: Date | null }>(
        `SELECT location_id, label, total_bytes AS total, free_bytes AS free, at
           FROM root_space WHERE location_id = ANY($1::bigint[])`,
        [locationIds],
      );
      for (const r of rs.rows) {
        space.set(`${r.location_id}|${r.label}`, {
          totalBytes: Number(r.total),
          freeBytes: Number(r.free),
          at: iso(r.at),
        });
      }
    }

    await client.query('COMMIT');

    const tally = new Map<string, { files: number; bytes: number }>();
    const out: ClusterFile[] = files.rows.map((r) => {
      const size = Number(r.size);
      const t = tally.get(r.machine) ?? { files: 0, bytes: 0 };
      t.files += 1;
      t.bytes += size;
      tally.set(r.machine, t);
      return { machine: r.machine, name: r.name, size };
    });

    return {
      cluster: cfg.cluster,
      roles: [...cfg.roles],
      machines: seats.rows.map((r) => ({
        key: r.key,
        role: r.role,
        regions: [...r.regions].sort((a, b) => a - b),
        disabled: r.disabled,
        location: r.location,
        files: tally.get(r.key)?.files ?? 0,
        bytes: tally.get(r.key)?.bytes ?? 0,
        space: space.get(`${r.location_id}|${r.key}`) ?? null,
        read: machineReadState(r.key, completeScans.get(String(r.location_id)) ?? []),
      })),
      scans: scans.rows.map((r) => ({
        location: r.location,
        lastCompleteAt: iso(r.last_complete_at),
        newestStatus: r.newest_status,
        newestStartedAt: iso(r.newest_started_at),
      })),
      files: out,
      readAt: new Date().toISOString(),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The cluster listing a running server holds, and what it says about each
 * snapshot.
 *
 * THREE STATES, kept apart for the reason the show-file cross-check keeps
 * its own apart -- they look alike in every figure that depends on them:
 *
 *   - not configured: no `mediaIndex` in config. The cluster is not in use,
 *     and nothing on screen mentions it.
 *   - unavailable: configured, and the catalog could not be read. Never an
 *     empty listing -- "nothing on the cluster" read off a database that was
 *     down is the one wrong answer worth designing out. The filter refuses.
 *   - loaded: a listing, with the scan times it is as of.
 *
 * A FAILED RELOAD CHANGES NOTHING: the listing already in force stays in
 * force, and the error says so. Same rule as `POST /api/programmed/reload`.
 *
 * Startup does NOT stop on an unreadable catalog, unlike an unreadable
 * capture. A capture decides what is protected; the cluster only decides
 * which rows are shown, and a Docker stack that is not up yet is no reason to
 * refuse to serve the archive.
 */

import type { Database as Db } from 'better-sqlite3';
import type { ClusterListing } from '../cluster/catalog.ts';
import { resolveClusterPresence, type ArchiveFileRef, type ClusterPresence } from '../cluster/presence.ts';

export type ClusterReader = () => Promise<ClusterListing>;

export class ClusterSource {
  private readonly db: Db;
  private readonly reader: ClusterReader | null;
  private current: ClusterListing | null = null;
  private lastError: string | null = null;
  private memo = new Map<string, ClusterPresence>();
  private archive: { snapshotId: number; files: ArchiveFileRef[] } | null = null;
  private running = false;

  constructor(db: Db, reader: ClusterReader | null) {
    this.db = db;
    this.reader = reader;
  }

  get configured(): boolean {
    return this.reader !== null;
  }

  get listing(): ClusterListing | null {
    return this.current;
  }

  /** The last read's failure, or null when it succeeded. */
  get error(): string | null {
    return this.lastError;
  }

  /** Startup: read once, and on failure record why rather than throwing. */
  async load(): Promise<void> {
    if (!this.reader) return;
    try {
      await this.reload();
    } catch {
      // Recorded in `lastError` by reload().
    }
  }

  /**
   * Read the catalog again and swap the listing in. THROWS on failure, with
   * the previous listing still in force.
   */
  async reload(): Promise<ClusterListing> {
    if (!this.reader) throw new Error('No Media Index catalog is configured.');
    if (this.running) throw new Error('A cluster reload is already running.');
    this.running = true;
    try {
      const next = await this.reader();
      this.current = next;
      this.lastError = null;
      this.memo = new Map();
      return next;
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    } finally {
      this.running = false;
    }
  }

  /**
   * Which of a snapshot's files are on the cluster, or null with no listing.
   * `roles` narrows "the cluster" to the seats in those roles -- so a fresh
   * actor scan can be used without an old understudy one -- and is checked by
   * the caller against `listing.roles`. Absent = every seat in the listing.
   */
  presence(snapshotId: number, roles?: readonly string[]): ClusterPresence | null {
    const l = this.current;
    if (l === null) return null;
    const only = roles && roles.length < l.roles.length ? [...roles].sort() : null;
    const key = `${snapshotId}|${only ? only.join(',') : '*'}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    if (!this.archive || this.archive.snapshotId !== snapshotId) {
      this.archive = {
        snapshotId,
        files: this.db
          .prepare(`SELECT id, name, size, asset_version_id AS versionId FROM file WHERE snapshot_id = ?`)
          .all(snapshotId) as ArchiveFileRef[],
      };
    }
    let listing = l;
    if (only) {
      const counted = new Set(l.machines.filter((m) => only.includes(m.role)).map((m) => m.key));
      listing = { ...l, files: l.files.filter((f) => counted.has(f.machine)) };
    }
    const p = resolveClusterPresence(listing, this.archive.files);
    this.memo.set(key, p);
    return p;
  }
}

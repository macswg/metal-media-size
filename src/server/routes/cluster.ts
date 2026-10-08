/**
 * The cluster, as the Media Index catalog last saw it.
 *
 *   POST /api/cluster/reload   read the catalog again
 *
 * The listing is reported on `/api/reclaim` as `cluster` (see `clusterReport`)
 * so the board states it beside the figures it scopes. Reloading reads the
 * catalog and nothing else: no rig scan is started or requested -- that stays
 * a person's job in the Media Index, where a rig is only ever scanned by hand.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { conflict, messageOf } from '../errors.ts';
import type { MachineRead } from '../../cluster/catalog.ts';
import { DEFAULT_DRIVE_RESERVE_FRACTION, driveState, type DriveState } from '../../machines.ts';

/**
 * What `/api/reclaim` says about the cluster. Null when it is not configured.
 * `usable: false` with an `error` when it is and could not be read: the two
 * must never look alike.
 */
export function clusterReport(ctx: AppContext, snapshotId: number, countedRoles?: readonly string[]) {
  const c = ctx.cluster;
  if (!c.configured) return null;
  const l = c.listing;
  const p = c.presence(snapshotId, countedRoles);
  if (l === null || p === null) {
    return { usable: false as const, error: c.error ?? 'not read yet' };
  }
  const counted = new Set(l.machines.filter((m) => !countedRoles || countedRoles.includes(m.role)).map((m) => m.key));
  return {
    usable: true as const,
    /** The last reload's failure, when an older listing is still in force. */
    error: c.error,
    cluster: l.cluster,
    roles: l.roles,
    /**
     * The roles counted as "on the cluster" for the figures below, the
     * ON CLUSTER tile and the filter -- `clusterRoles`, or every role.
     */
    countedRoles: countedRoles ? [...countedRoles] : [...l.roles],
    readAt: l.readAt,
    machines: l.machines.map((m) => ({
      key: m.key,
      role: m.role,
      regions: m.regions,
      /** Catalog location, which says which of `scans` this machine is as of. */
      location: m.location,
      disabled: m.disabled,
      files: m.files,
      bytes: m.bytes,
      space: m.space,
      read: m.read,
    })),
    scans: l.scans,
    /** Files listed on the counted seats. */
    clusterFiles: countedRoles ? l.files.filter((f) => counted.has(f.machine)).length : l.files.length,
    /** Archive files on the cluster at the archive's size. */
    matchedFiles: p.matchedFiles,
    matchedBytes: p.matchedBytes,
    sizeMismatchFiles: p.sizeMismatchFiles,
    /** Files on the cluster the archive has no name for. */
    strangerFiles: p.strangerFiles,
    strangerBytes: p.strangerBytes,
  };
}

/** One machine on the board: what a cleanup frees on it, against its drive. */
export interface ClusterMachineRow {
  key: string;
  role: string;
  regions: number[];
  /** Catalog location: its entry in `cluster.scans` is when this was listed. */
  location: string;
  /** Superseded bytes in view that this machine holds. */
  freesBytes: number;
  freesFiles: number;
  freesVersions: number;
  /** Everything the catalog lists on it. */
  heldBytes: number;
  /** Whether the last complete scan of its location read it. See `MachineRead`. */
  read: MachineRead | null;
  /**
   * Whether its role is counted as "on the cluster" (`clusterRoles`). Its
   * own figures are drawn either way: they are about this machine's drive.
   */
  counted: boolean;
  /**
   * The drive, from the rig scanner's MEASURED size and free space -- not the
   * assumed capacity the Machines tab uses. Null when the catalog has no
   * reading. Percentages are of USABLE space, after the reserve, as on that
   * tab, so `over` means into the reserve rather than physically full.
   */
  drive: {
    capacityBytes: number;
    reserveBytes: number;
    usableBytes: number;
    /** Measured used space -- the whole drive, not only the media folder. */
    usedBytes: number;
    usedFraction: number;
    /** After removing `freesBytes`. */
    afterFraction: number;
    driveState: DriveState;
    afterState: DriveState;
    measuredAt: string | null;
  } | null;
}

/**
 * What removing the superseded versions in view frees on each machine: the
 * bytes of every file it holds that belongs to one of them. Per machine,
 * because the drives fill unevenly and the full ones are the point. These do
 * NOT sum to the board's ON CLUSTER figure -- a file on an actor and on its
 * understudy is freed twice on the rig and counted once on the cluster.
 */
export function clusterMachineFrees(
  ctx: AppContext,
  snapshotId: number,
  supersededInView: ReadonlySet<number>,
  countedRoles?: readonly string[],
): ClusterMachineRow[] | null {
  const l = ctx.cluster.listing;
  const p = ctx.cluster.presence(snapshotId);
  if (l === null || p === null) return null;
  return l.machines.map((m) => {
    let freesBytes = 0;
    let freesFiles = 0;
    const versions = new Set<number>();
    for (const f of p.byMachine.get(m.key) ?? []) {
      const hit = f.versionIds.filter((v) => supersededInView.has(v));
      if (hit.length === 0) continue;
      freesBytes += f.size;
      freesFiles += 1;
      for (const v of hit) versions.add(v);
    }
    let drive: ClusterMachineRow['drive'] = null;
    if (m.space && m.space.totalBytes > 0) {
      const capacityBytes = m.space.totalBytes;
      const reserveBytes = Math.round(capacityBytes * DEFAULT_DRIVE_RESERVE_FRACTION);
      const usableBytes = capacityBytes - reserveBytes;
      const usedBytes = capacityBytes - m.space.freeBytes;
      const after = Math.max(0, usedBytes - freesBytes);
      drive = {
        capacityBytes,
        reserveBytes,
        usableBytes,
        usedBytes,
        usedFraction: usedBytes / usableBytes,
        afterFraction: after / usableBytes,
        driveState: driveState(usedBytes, usableBytes),
        afterState: driveState(after, usableBytes),
        measuredAt: m.space.at,
      };
    }
    return {
      key: m.key,
      role: m.role,
      regions: m.regions,
      location: m.location,
      freesBytes,
      freesFiles,
      freesVersions: versions.size,
      heldBytes: m.bytes,
      read: m.read,
      counted: !countedRoles || countedRoles.includes(m.role),
      drive,
    };
  });
}

export function registerClusterRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/cluster/reload', async () => {
    if (!ctx.cluster.configured) {
      throw conflict(
        'no_cluster',
        'No Media Index catalog is configured, so there is nothing to reload. Add mediaIndex to config/local.json.',
      );
    }
    const had = ctx.cluster.listing !== null;
    try {
      const l = await ctx.cluster.reload();
      return { machines: l.machines.length, files: l.files.length, scans: l.scans, readAt: l.readAt };
    } catch (e) {
      throw conflict(
        'cluster_unreadable',
        `${messageOf(e)} ` +
          (had
            ? 'Nothing was changed: the listing read before is still in force.'
            : 'There is still no listing, so the cluster filter stays unavailable.'),
      );
    }
  });
}

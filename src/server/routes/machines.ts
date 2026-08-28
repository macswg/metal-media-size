/**
 * ============================================================================
 *  `GET /api/machines` -- per-machine media allocation
 * ============================================================================
 *
 * How much media each playback machine has to hold, and how much of that is
 * superseded and could come back.
 *
 * KEYED BY REGION, WHICH IS A PROPERTY OF THE FILE NAME AND NOT OF THE INDEX.
 * The `file` table stores the name, not the region -- the scanner parses the
 * region only to roll versions up. Rather than add a column and force a rescan
 * of every existing snapshot, the region is parsed here from `file.name` USING
 * THE SAME PARSER THE SCAN USED, built from the same config pattern. That
 * matters more than the saved migration: a second, hand-rolled way of reading a
 * region out of a filename would be a divergent source of truth for the one
 * thing this route keys on. Measured at ~26.7k names per request, which is
 * milliseconds.
 *
 * THE TOTALS DO NOT ADD UP, AND MUST NOT BE MADE TO.
 * A region may be assigned to several machines, so a file's bytes can appear in
 * several rows. `Σ machine bytes` is therefore >= the bytes on the archive, and
 * the difference is real duplicated material rather than an error. The response
 * carries `reconcile`, which states all four quantities plainly:
 *
 *   allocatedBytes    -- distinct bytes reaching at least one machine
 *   duplicatedBytes   -- Σ per-machine minus allocated; the cost of redundancy
 *   unallocatedBytes  -- bytes whose region no machine claims
 *   regionlessBytes   -- bytes in valid names carrying no region token
 *   unparsedBytes     -- bytes in names the grammar cannot read at all
 *
 * A caller that renders per-machine bytes as shares of a pie is wrong, and the
 * UI says so on the page instead of hoping.
 *
 * THE VERDICT IS NOT COMPUTED HERE. `status` arrives on each file row from
 * `selectFilesFiltered`, which annotates it from the whole-snapshot reclaim
 * exactly as every other route does. This route never ranks anything.
 * ============================================================================
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { resolveSnapshot } from '../context.ts';
import {
  guardCandidateCount,
  listInJs,
  parseFilters,
  parseKeepN,
  parsePaging,
  parseSort,
  type FilterSpec,
  type Query,
} from '../query.ts';
import { selectFilesFiltered } from '../select.ts';
import { makeParser } from '../../scan/parse.ts';
import {
  machinePeers,
  machinesByRegion,
  resolveMachines,
  type AllocationSource,
  type MachineRole,
  type MachineSpec,
} from '../../machines.ts';

export interface MachineRow {
  machineId: string;
  name: string;
  role: MachineRole;
  /** Slices this machine carries, ascending. */
  regions: number[];
  note: string | null;
  fileCount: number;
  totalBytes: number;
  supersededBytes: number;
  supersededFiles: number;
  /**
   * Bytes of this machine's media that at least one OTHER machine also holds.
   * Zero when the allocation happens to be a partition.
   */
  sharedBytes: number;
  /**
   * Other machines holding at least one of the same regions -- this machine's
   * understudy, or the actor it covers. Derived from the region lists, so it
   * cannot disagree with them.
   */
  peers: string[];
  latestMtime: number | null;
}

/** Bytes that reach no machine, split by why. */
export interface MachineReconcile {
  /** Distinct bytes held by at least one machine. */
  allocatedBytes: number;
  allocatedFiles: number;
  /** Σ per-machine bytes minus `allocatedBytes`. The cost of redundancy. */
  duplicatedBytes: number;
  /** Bytes whose region is real but claimed by no machine. */
  unallocatedBytes: number;
  unallocatedFiles: number;
  /** Regions seen in the media that no machine claims, ascending. */
  unallocatedRegions: number[];
  /**
   * Bytes in files the grammar CAN read but which carry no region token --
   * region-less deliverables, which are legal. See src/scan/parse.ts.
   */
  regionlessBytes: number;
  regionlessFiles: number;
  /**
   * Bytes in files whose name the grammar cannot read at all. Kept apart from
   * `regionless` on purpose: one is a deliverable that covers the whole canvas,
   * the other is a name nothing in this tool understands, and merging them
   * would hide the second inside the first.
   */
  unparsedBytes: number;
  unparsedFiles: number;
  /** Every byte in view, however it is classified above. */
  matchedBytes: number;
  matchedFiles: number;
}

const SORT_COLUMNS = [
  'machineId',
  'name',
  'role',
  'fileCount',
  'totalBytes',
  'supersededBytes',
  'supersededFiles',
  'sharedBytes',
  'latestMtime',
];

function emptyRow(m: MachineSpec, peers: string[]): MachineRow {
  return {
    machineId: m.id,
    name: m.name,
    role: m.role,
    regions: [...m.regions].sort((a, b) => a - b),
    note: m.note ?? null,
    peers,
    fileCount: 0,
    totalBytes: 0,
    supersededBytes: 0,
    supersededFiles: 0,
    sharedBytes: 0,
    latestMtime: null,
  };
}

export interface MachineBreakdown {
  rows: MachineRow[];
  reconcile: MachineReconcile;
}

/**
 * Roll the files in view up by machine.
 *
 * Exported so a test can drive it without a server, and so the shape of the
 * overlap arithmetic is inspectable rather than buried in a handler.
 */
export function buildMachineRows(
  ctx: AppContext,
  snapshotId: number,
  filters: FilterSpec,
  keepN: number,
  machines: readonly MachineSpec[],
): MachineBreakdown {
  const byRegion = machinesByRegion(machines);
  const peers = machinePeers(machines);
  const rows = new Map<string, MachineRow>();
  for (const m of machines) rows.set(m.id, emptyRow(m, peers.get(m.id) ?? []));

  const parse = makeParser(ctx.cfg.parse.pattern, ctx.cfg.parse.flags);

  const reconcile: MachineReconcile = {
    allocatedBytes: 0,
    allocatedFiles: 0,
    duplicatedBytes: 0,
    unallocatedBytes: 0,
    unallocatedFiles: 0,
    unallocatedRegions: [],
    regionlessBytes: 0,
    regionlessFiles: 0,
    unparsedBytes: 0,
    unparsedFiles: 0,
    matchedBytes: 0,
    matchedFiles: 0,
  };
  const orphanRegions = new Set<number>();
  let perMachineBytes = 0;

  for (const f of selectFilesFiltered(ctx, snapshotId, filters, keepN, 'ORDER BY f.id ASC')) {
    reconcile.matchedFiles += 1;
    reconcile.matchedBytes += f.size;

    const parsed = parse(f.name);
    if (!parsed.ok) {
      // The grammar cannot read this name. Its own category, never folded into
      // the one below: nothing here knows what it is.
      reconcile.unparsedFiles += 1;
      reconcile.unparsedBytes += f.size;
      continue;
    }
    const region = parsed.region;
    if (region === null) {
      // Matched the grammar, carries no region token. Region-less deliverables
      // are legal -- see src/scan/parse.ts -- so this is a category, not a
      // failure, and it is not the same category as the one above.
      reconcile.regionlessFiles += 1;
      reconcile.regionlessBytes += f.size;
      continue;
    }

    const holders = byRegion.get(region);
    if (!holders || holders.length === 0) {
      orphanRegions.add(region);
      reconcile.unallocatedFiles += 1;
      reconcile.unallocatedBytes += f.size;
      continue;
    }

    reconcile.allocatedFiles += 1;
    reconcile.allocatedBytes += f.size;
    const shared = holders.length > 1;

    for (const m of holders) {
      const row = rows.get(m.id) as MachineRow;
      row.fileCount += 1;
      row.totalBytes += f.size;
      perMachineBytes += f.size;
      if (shared) row.sharedBytes += f.size;
      if (f.status === 'superseded') {
        row.supersededBytes += f.size;
        row.supersededFiles += 1;
      }
      if (row.latestMtime === null || f.mtime > row.latestMtime) row.latestMtime = f.mtime;
    }
  }

  // Not Σ-minus-anything-guessed: `allocatedBytes` counted each file once and
  // `perMachineBytes` counted it once per holder, so the difference IS the
  // material held more than once.
  reconcile.duplicatedBytes = perMachineBytes - reconcile.allocatedBytes;
  reconcile.unallocatedRegions = [...orphanRegions].sort((a, b) => a - b);

  return { rows: [...rows.values()], reconcile };
}

export function registerMachineRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/machines', (req) => {
    const q = req.query as Query;
    const snapshot = resolveSnapshot(ctx, q);
    const filters = parseFilters(q);
    const keepN = parseKeepN(q);
    const paging = parsePaging(q);
    const sort = parseSort(q, SORT_COLUMNS, { key: 'totalBytes', dir: 'desc' });

    const { machines, source } = resolveMachines();
    const { rows, reconcile } = buildMachineRows(ctx, snapshot.id, filters, keepN, machines);
    // Bounded by the machine count, but guarded on the same principle as the
    // song rollup: a config could name thousands.
    guardCandidateCount(rows.length, 'machine rollup');

    const listed = listInJs(rows, {
      sort,
      accessor: (row, key) => (row as unknown as Record<string, unknown>)[key],
      bytesOf: (r) => r.totalBytes,
      paging,
    });

    return {
      snapshotId: snapshot.id,
      keepN,
      limit: paging.limit,
      offset: paging.offset,
      sort: sort.key,
      dir: sort.dir,
      /**
       * 'placeholder' means the allocation is INVENTED and the numbers describe
       * a rig that does not exist. The UI must say so; silently plausible
       * machine names are the failure mode this field exists to prevent.
       */
      allocationSource: source satisfies AllocationSource,
      machineCount: machines.length,
      reconcile,
      ...listed,
    };
  });
}

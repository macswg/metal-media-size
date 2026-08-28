/**
 * ============================================================================
 *  PER-MACHINE ALLOCATION
 * ============================================================================
 *
 * The thing this view can get wrong, and the reason most of these tests exist,
 * is presenting overlapping allocations as if they were shares of a total. A
 * region may be held by several machines; per-machine bytes then sum to MORE
 * than the archive holds, and the difference is real redundant media rather
 * than an arithmetic slip. So the assertions below are mostly about the
 * reconciliation: every byte in view lands in exactly one of four categories,
 * and the overlap is a stated number rather than a discrepancy.
 *
 * The fixture's region distribution in the latest snapshot, which the expected
 * values are derived from rather than guessed at:
 *
 *   region 0    5 files      560 bytes
 *   region 1   13 files   37,992 bytes
 *   region 2    8 files   31,100 bytes
 *   region 9    1 file        90 bytes
 *   unparsed    6 files    6,098 bytes   (names the grammar cannot read)
 *   ---------------------------------
 *   total      33 files   75,840 bytes
 * ============================================================================
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server/app.ts';
import type { AppContext } from '../../src/server/context.ts';
import { makeFixture, type Fixture } from './fixture.ts';
import { buildMachineRows, type MachineRow } from '../../src/server/routes/machines.ts';
import {
  DEFAULT_DRIVE_CAPACITY_BYTES,
  DEFAULT_DRIVE_RESERVE_FRACTION,
  DEFAULT_MACHINES,
  driveState,
  usableBytesOf,
  MachineConfigError,
  machinePeers,
  machinesByRegion,
  resolveMachines,
  validateMachines,
  type MachineSpec,
} from '../../src/machines.ts';

let fx: Fixture;
let app: FastifyInstance;
let ctx: AppContext;

const R0 = 560;
const R1 = 37_992;
const R2 = 31_100;
const R9 = 90;
const UNPARSED = 6_098;
const TOTAL = 75_840;

beforeAll(() => {
  fx = makeFixture();
  const built = buildServer({ db: fx.db, cfg: fx.cfg });
  app = built.app;
  ctx = built.ctx;
});

afterAll(async () => {
  await app.close();
  fx.db.close();
});

async function get(url: string): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
}

function rowsOf(machines: MachineSpec[], keepN = 3): Map<string, MachineRow> {
  const { rows } = buildMachineRows(ctx, fx.snapshotId, {}, keepN, machines);
  return new Map(rows.map((r) => [r.machineId, r]));
}

function reconcileOf(machines: MachineSpec[], keepN = 3) {
  return buildMachineRows(ctx, fx.snapshotId, {}, keepN, machines).reconcile;
}

// ===========================================================================
describe('the allocation config', () => {
  it('accepts the built-in rig and reports where it came from', () => {
    const { machines, source } = resolveMachines();
    expect(source).toBe('built-in');
    expect(machines).toHaveLength(DEFAULT_MACHINES.length);
    expect(() => validateMachines(machines)).not.toThrow();
  });

  it('hands out a copy, so a caller cannot mutate the built-in list', () => {
    const first = resolveMachines().machines;
    (first[0] as MachineSpec).regions.push(99);
    expect(resolveMachines().machines[0]?.regions).not.toContain(99);
  });

  it('refuses two machines with the same id', () => {
    // The id is what a row and a click-through resolve by; a duplicate would
    // silently resolve to whichever the map happened to keep.
    expect(() =>
      validateMachines([
        { id: 'm1', name: 'One', role: 'actor', regions: [1] },
        { id: 'm1', name: 'Also one', role: 'actor', regions: [2] },
      ]),
    ).toThrow(MachineConfigError);
  });

  it('refuses a region listed twice on one machine', () => {
    // Within ONE machine a repeat is never an overlap, it is double-counting.
    expect(() => validateMachines([{ id: 'm1', name: 'One', role: 'actor', regions: [1, 1] }])).toThrow(
      /lists a region twice/,
    );
  });

  it('refuses a region that is not a non-negative integer', () => {
    expect(() => validateMachines([{ id: 'm1', name: 'One', role: 'actor', regions: [-1] }])).toThrow(
      MachineConfigError,
    );
    expect(() => validateMachines([{ id: 'm1', name: 'One', role: 'actor', regions: [1.5] }])).toThrow(
      MachineConfigError,
    );
  });

  it('allows a machine that carries nothing yet', () => {
    // A spare in the rig. Reporting it at zero is more use than dropping it.
    expect(() => validateMachines([{ id: 'spare', name: 'Spare', role: 'actor', regions: [] }])).not.toThrow();
  });

  it('maps a region to every machine holding it', () => {
    const byRegion = machinesByRegion([
      { id: 'a', name: 'A', role: 'actor', regions: [1, 2] },
      { id: 'b', name: 'B', role: 'actor', regions: [2] },
    ]);
    expect(byRegion.get(1)?.map((m) => m.id)).toEqual(['a']);
    expect(byRegion.get(2)?.map((m) => m.id)).toEqual(['a', 'b']);
    expect(byRegion.get(3)).toBeUndefined();
  });
});

// ===========================================================================
describe('the rig as configured', () => {
  /**
   * These are assertions about the SHAPE of the real allocation, not about the
   * code that reads it. They are here because the rig has a property worth
   * protecting: every canvas slice is held by exactly one actor and exactly one
   * understudy, so nothing is unprotected and nothing is triple-stored. An edit
   * that broke that would otherwise show up only as a byte total nobody
   * questioned.
   */
  const { machines } = resolveMachines();
  const byId = new Map(machines.map((m) => [m.id, m]));
  const of = (role: string) => machines.filter((m) => m.role === role);
  const SLICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

  it('has fourteen actors carrying one slice each', () => {
    const actors = of('actor');
    expect(actors).toHaveLength(14);
    for (const a of actors) expect(a.regions).toHaveLength(1);
    expect(actors.flatMap((a) => a.regions).sort((x, y) => x - y)).toEqual(SLICES);
  });

  it('has seven understudies covering the same fourteen slices, two each', () => {
    const understudies = of('understudy');
    expect(understudies).toHaveLength(7);
    for (const u of understudies) expect(u.regions).toHaveLength(2);
    expect(understudies.flatMap((u) => u.regions).sort((x, y) => x - y)).toEqual(SLICES);
  });

  it('puts region 0 on the director and its understudy, and nowhere else', () => {
    const byRegion = machinesByRegion(machines);
    expect(byRegion.get(0)?.map((m) => m.id).sort()).toEqual(['306', '307']);
    expect(byId.get('306')?.role).toBe('director');
    expect(byId.get('307')?.role).toBe('director-understudy');
  });

  it('holds every region on exactly two machines — nothing bare, nothing tripled', () => {
    const byRegion = machinesByRegion(machines);
    for (const r of [0, ...SLICES]) {
      expect(byRegion.get(r)?.length, `region ${r}`).toBe(2);
    }
    // ...and no machine carries a region outside that set.
    const known = new Set([0, ...SLICES]);
    for (const m of machines) for (const r of m.regions) expect(known.has(r)).toBe(true);
  });

  it('covers every slice a machine holds with a distinct peer, mutually', () => {
    const peers = machinePeers(machines);
    for (const m of machines) {
      const mine = peers.get(m.id) as string[];
      // Every region sits on exactly two machines and no machine shares two of
      // its regions with the same partner, so a machine has one peer PER SLICE
      // it carries: an actor has one, an understudy carrying two has two.
      expect(mine, m.id).toHaveLength(m.regions.length);
      for (const other of mine) {
        // If 207 covers 101, then 101 is covered by 207. An asymmetric pairing
        // would mean a machine believed it was covered by one that did not
        // cover it.
        expect(peers.get(other), `${m.id} <-> ${other}`).toContain(m.id);
      }
    }
    expect(peers.get('101')).toEqual(['207']);
    expect(peers.get('206')).toEqual(['305']);
    expect(peers.get('207')).toEqual(['101', '102']);
    expect(peers.get('306')).toEqual(['307']);
  });

  it('pairs each actor with an understudy rather than with another actor', () => {
    const peers = machinePeers(machines);
    for (const a of of('actor')) {
      expect(byId.get((peers.get(a.id) as string[])[0] as string)?.role).toBe('understudy');
    }
  });
});

// ===========================================================================
describe('rolling the media up by machine', () => {
  const PARTITION: MachineSpec[] = [
    { id: 'm1', name: 'One', role: 'actor', regions: [1] },
    { id: 'm2', name: 'Two', role: 'actor', regions: [2] },
    { id: 'edit', name: 'Editorial', role: 'actor', regions: [0] },
  ];

  it('gives each machine the bytes of the regions it holds', () => {
    const rows = rowsOf(PARTITION);
    expect(rows.get('m1')?.totalBytes).toBe(R1);
    expect(rows.get('m2')?.totalBytes).toBe(R2);
    expect(rows.get('edit')?.totalBytes).toBe(R0);
  });

  it('puts every byte in view into exactly one category', () => {
    // The load-bearing one: nothing may fall between the four buckets, or the
    // table would quietly account for less media than the archive holds.
    const r = reconcileOf(PARTITION);
    expect(r.matchedBytes).toBe(TOTAL);
    expect(
      r.allocatedBytes + r.unallocatedBytes + r.regionlessBytes + r.unparsedBytes,
    ).toBe(r.matchedBytes);
    expect(
      r.allocatedFiles + r.unallocatedFiles + r.regionlessFiles + r.unparsedFiles,
    ).toBe(r.matchedFiles);
  });

  it('reports media whose region reaches no machine, and which region it is', () => {
    // Region 9 exists in the fixture and no machine here claims it. Media that
    // nothing plays must not read as media that is safely allocated.
    const r = reconcileOf(PARTITION);
    expect(r.unallocatedBytes).toBe(R9);
    expect(r.unallocatedFiles).toBe(1);
    expect(r.unallocatedRegions).toEqual([9]);
    expect(r.allocatedBytes).toBe(R0 + R1 + R2);
  });

  it('keeps names the grammar cannot read in their own category', () => {
    const r = reconcileOf(PARTITION);
    expect(r.unparsedBytes).toBe(UNPARSED);
    expect(r.unparsedFiles).toBe(6);
  });

  it('reports no duplication when no region has two holders', () => {
    const r = reconcileOf(PARTITION);
    expect(r.duplicatedBytes).toBe(0);
    for (const row of rowsOf(PARTITION).values()) expect(row.sharedBytes).toBe(0);
  });

  it('includes a machine that holds nothing, at zero', () => {
    const rows = rowsOf([...PARTITION, { id: 'spare', name: 'Spare', role: 'actor', regions: [] }]);
    const spare = rows.get('spare');
    expect(spare).toBeDefined();
    expect(spare?.totalBytes).toBe(0);
    expect(spare?.fileCount).toBe(0);
    expect(spare?.latestMtime).toBeNull();
  });
});

// ===========================================================================
describe('when a region is held by more than one machine', () => {
  // region1 -> a + edit, region2 -> a + b, region0 -> edit alone.
  const OVERLAP: MachineSpec[] = [
    { id: 'a', name: 'A', role: 'actor', regions: [1, 2] },
    { id: 'b', name: 'B', role: 'actor', regions: [2] },
    { id: 'edit', name: 'Editorial', role: 'actor', regions: [0, 1] },
  ];

  it('counts the bytes on every machine that holds them', () => {
    const rows = rowsOf(OVERLAP);
    expect(rows.get('a')?.totalBytes).toBe(R1 + R2);
    expect(rows.get('b')?.totalBytes).toBe(R2);
    expect(rows.get('edit')?.totalBytes).toBe(R0 + R1);
  });

  it('states the duplication rather than letting the totals silently exceed the archive', () => {
    const { rows, reconcile } = buildMachineRows(ctx, fx.snapshotId, {}, 3, OVERLAP);
    const perMachine = rows.reduce((a, r) => a + r.totalBytes, 0);
    // Σ per-machine overshoots the distinct bytes by exactly the duplication.
    expect(perMachine).toBeGreaterThan(reconcile.allocatedBytes);
    expect(perMachine - reconcile.allocatedBytes).toBe(reconcile.duplicatedBytes);
    expect(reconcile.duplicatedBytes).toBe(R1 + R2);
  });

  it('counts each distinct file once in allocated, however many machines hold it', () => {
    const r = reconcileOf(OVERLAP);
    expect(r.allocatedBytes).toBe(R0 + R1 + R2);
    expect(r.allocatedFiles).toBe(5 + 13 + 8);
  });

  it("tells each machine how much of its load is somebody else's too", () => {
    const rows = rowsOf(OVERLAP);
    // Both of A's regions are shared; only region1 of Editorial's two is.
    expect(rows.get('a')?.sharedBytes).toBe(R1 + R2);
    expect(rows.get('b')?.sharedBytes).toBe(R2);
    expect(rows.get('edit')?.sharedBytes).toBe(R1);
  });
});

// ===========================================================================
describe('how full the drive is', () => {
  const ALL: MachineSpec[] = [{ id: 'all', name: 'All', role: 'actor', regions: [0, 1, 2, 9] }];

  it('reads 32 TB as the label it is: decimal, not 32 TiB', () => {
    // The single most consequential constant in this view. 32 TiB would make
    // every machine read ~9 points emptier than it is, and the fullest one look
    // comfortable when it is not.
    expect(DEFAULT_DRIVE_CAPACITY_BYTES).toBe(32_000_000_000_000);
    expect(DEFAULT_DRIVE_CAPACITY_BYTES).not.toBe(32 * 1024 ** 4);
    expect(DEFAULT_DRIVE_CAPACITY_BYTES / 1024 ** 4).toBeCloseTo(29.1, 1);
  });

  it('holds back the reserve before calling anything full', () => {
    expect(DEFAULT_DRIVE_RESERVE_FRACTION).toBe(0.05);
    expect(usableBytesOf()).toBe(30_400_000_000_000);
    expect(usableBytesOf(1000, 0.1)).toBe(900);
  });

  it('grades fullness against usable space, not against the raw drive', () => {
    // 'over' therefore means "into the reserve", which is reachable while the
    // drive still has bytes left -- and is the line worth flagging.
    expect(driveState(0, 1000)).toBe('ok');
    expect(driveState(749, 1000)).toBe('ok');
    expect(driveState(750, 1000)).toBe('watch');
    expect(driveState(899, 1000)).toBe('watch');
    expect(driveState(900, 1000)).toBe('critical');
    expect(driveState(999, 1000)).toBe('critical');
    expect(driveState(1000, 1000)).toBe('over');
    expect(driveState(1200, 1000)).toBe('over');
  });

  it('splits what is on the drive into what stays and what a cleanup frees', () => {
    const row = rowsOf(ALL).get('all') as MachineRow;
    expect(row.keptBytes + row.supersededBytes).toBe(row.totalBytes);
    expect(row.keptBytes).toBeGreaterThan(0);
  });

  it('reports free space and fullness against the usable figure', () => {
    const row = rowsOf(ALL).get('all') as MachineRow;
    expect(row.capacityBytes).toBe(DEFAULT_DRIVE_CAPACITY_BYTES);
    expect(row.reserveBytes).toBe(row.capacityBytes - row.usableBytes);
    expect(row.usableBytes).toBe(usableBytesOf());
    expect(row.freeBytes).toBe(row.usableBytes - row.totalBytes);
    expect(row.usedFraction).toBeCloseTo(row.totalBytes / row.usableBytes, 12);
    expect(row.driveState).toBe('ok');
  });

  it('honours a per-machine drive size', () => {
    const rows = rowsOf([{ ...(ALL[0] as MachineSpec), capacityBytes: 200_000 }]);
    const row = rows.get('all') as MachineRow;
    expect(row.capacityBytes).toBe(200_000);
    expect(row.usableBytes).toBe(190_000);
  });

  it('reports how far PAST the headroom a full machine is, rather than clamping', () => {
    // A drive exactly at its reserve and one 1.2 TiB beyond it are not the same
    // situation, and a clamped zero would say they were.
    const rows = rowsOf([
      { id: 'tiny', name: 'Tiny', role: 'actor', regions: [1], capacityBytes: 1_000 },
    ]);
    const row = rows.get('tiny') as MachineRow;
    expect(row.driveState).toBe('over');
    expect(row.freeBytes).toBeLessThan(0);
    expect(row.freeBytes).toBe(row.usableBytes - row.totalBytes);
    expect(row.usedFraction).toBeGreaterThan(1);
  });

  it('refuses a drive size that is not a positive number of bytes', () => {
    expect(() =>
      validateMachines([{ id: 'm1', name: 'One', role: 'actor', regions: [1], capacityBytes: 0 }]),
    ).toThrow(MachineConfigError);
    expect(() =>
      validateMachines([{ id: 'm1', name: 'One', role: 'actor', regions: [1], capacityBytes: -5 }]),
    ).toThrow(MachineConfigError);
  });

  it('states its assumptions in the response', async () => {
    const { body } = await get('/api/machines?keepN=3');
    expect(body.drive.defaultCapacityBytes).toBe(DEFAULT_DRIVE_CAPACITY_BYTES);
    expect(body.drive.reserveFraction).toBe(DEFAULT_DRIVE_RESERVE_FRACTION);
  });
});

// ===========================================================================
describe('the verdict on a machine row', () => {
  const ALL: MachineSpec[] = [{ id: 'all', name: 'All', role: 'actor', regions: [0, 1, 2, 9] }];

  it('never claims more is superseded than the machine holds', () => {
    for (const keepN of [1, 2, 3, 4]) {
      for (const row of rowsOf(ALL, keepN).values()) {
        expect(row.supersededBytes).toBeLessThanOrEqual(row.totalBytes);
        expect(row.supersededFiles).toBeLessThanOrEqual(row.fileCount);
      }
    }
  });

  it('moves with keep-N, because it is the same verdict the rest of the tool uses', () => {
    const at1 = rowsOf(ALL, 1).get('all') as MachineRow;
    const at4 = rowsOf(ALL, 4).get('all') as MachineRow;
    expect(at1.supersededBytes).toBeGreaterThan(at4.supersededBytes);
    // ...while what the machine has to HOLD is a fact about the rig and does
    // not move at all.
    expect(at1.totalBytes).toBe(at4.totalBytes);
  });
});

// ===========================================================================
describe('a valid name that carries no region', () => {
  /**
   * The fixture has no such file -- all six of its non-region names are ones
   * the grammar cannot read at all -- so this builds a snapshot that does.
   *
   * The distinction is the point. `880_IMAG_CAM_A_EDIT_RECT_v001.mov` is a real
   * shape in the grammar: a deliverable covering the whole canvas with no slice
   * token. It cannot be allocated to a machine by region, but it is a perfectly
   * good file, and folding it in with names nothing understands would hide the
   * second category inside the first.
   *
   * Inserted as a `running` snapshot so it can never become the one the routes
   * pick when none is named, and read here by id only.
   */
  let snapshotId: number;

  beforeAll(() => {
    snapshotId = Number(
      fx.db
        .prepare(
          `INSERT INTO snapshot (root, started_at, finished_at, file_count, total_bytes, status, name)
           VALUES (?, ?, ?, ?, ?, 'running', 'regionless-probe')`,
        )
        .run('/fixture/root', 9_000, 9_001, 3, 305).lastInsertRowid,
    );
    const ins = fx.db.prepare(
      `INSERT INTO file (snapshot_id, rel_path, song_folder, name, ext, size, mtime, parse_ok, asset_version_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    ins.run(snapshotId, 'S/A_v001_region1.mov', 'S', 'A_v001_region1.mov', 'mov', 100, 9_000, 1);
    ins.run(snapshotId, 'S/A_v001.mov', 'S', 'A_v001.mov', 'mov', 200, 9_000, 1);
    ins.run(snapshotId, 'S/notes.txt', 'S', 'notes.txt', 'txt', 5, 9_000, 0);
  });

  it('counts it apart from both the allocated media and the unreadable names', () => {
    const { rows, reconcile } = buildMachineRows(ctx, snapshotId, {}, 3, [
      { id: 'm1', name: 'One', role: 'actor', regions: [1] },
    ]);
    expect(rows[0]?.totalBytes).toBe(100);
    expect(reconcile.allocatedBytes).toBe(100);
    expect(reconcile.regionlessBytes).toBe(200);
    expect(reconcile.regionlessFiles).toBe(1);
    expect(reconcile.unparsedBytes).toBe(5);
    expect(reconcile.unparsedFiles).toBe(1);
    expect(reconcile.unallocatedBytes).toBe(0);
    expect(reconcile.matchedBytes).toBe(305);
    // And still exactly one category each.
    expect(
      reconcile.allocatedBytes +
        reconcile.unallocatedBytes +
        reconcile.regionlessBytes +
        reconcile.unparsedBytes,
    ).toBe(reconcile.matchedBytes);
  });
});

// ===========================================================================
describe('GET /api/machines', () => {
  it('answers with a row per machine and says the allocation is a placeholder', async () => {
    const { status, body } = await get('/api/machines?keepN=3');
    expect(status).toBe(200);
    // 'built-in' means compiled into the source rather than read from a
    // config file. It is real, and the UI must not disclaim it as a guess.
    expect(body.allocationSource).toBe('built-in');
    expect(body.machineCount).toBe(DEFAULT_MACHINES.length);
    expect(body.rows).toHaveLength(DEFAULT_MACHINES.length);
    expect(body.total).toBe(DEFAULT_MACHINES.length);
  });

  it('carries the reconciliation, and it adds up', async () => {
    const { body } = await get('/api/machines?keepN=3');
    const r = body.reconcile;
    expect(r.matchedBytes).toBe(TOTAL);
    expect(r.allocatedBytes + r.unallocatedBytes + r.regionlessBytes + r.unparsedBytes).toBe(TOTAL);
  });

  it('comes back in rig order by default, 101 first', async () => {
    const { body } = await get('/api/machines?keepN=3');
    expect(body.sort).toBe('name');
    expect(body.dir).toBe('asc');
    expect(body.rows.map((r: MachineRow) => r.machineId).slice(0, 4)).toEqual([
      '101',
      '102',
      '103',
      '104',
    ]);
    // The ids are fixed-width, so a plain string compare is numeric order --
    // 108 before 201, and 206 before 301.
    expect(body.rows.map((r: MachineRow) => r.machineId)).toEqual(
      [...body.rows.map((r: MachineRow) => r.machineId)].sort(),
    );
  });

  it('sorts and pages like the other rollups', async () => {
    const { body } = await get('/api/machines?sort=totalBytes&dir=desc&limit=2');
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].totalBytes).toBeGreaterThanOrEqual(body.rows[1].totalBytes);
    const asc = await get('/api/machines?sort=totalBytes&dir=asc&limit=2');
    expect(asc.body.rows[0].totalBytes).toBeLessThanOrEqual(asc.body.rows[1].totalBytes);
  });

  it('respects the shared filters', async () => {
    const all = await get('/api/machines?keepN=3');
    const one = await get('/api/machines?keepN=3&songFolder=100_ALPHA');
    expect(one.body.reconcile.matchedBytes).toBeLessThan(all.body.reconcile.matchedBytes);
    expect(one.body.reconcile.matchedBytes).toBeGreaterThan(0);
  });

  it('rejects a sort key it does not have', async () => {
    const { status } = await get('/api/machines?sort=nonsense');
    expect(status).toBe(400);
  });
});

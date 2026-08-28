/**
 * =============================================================================
 *  MACHINE ALLOCATION  --  WHICH PLAYBACK MACHINE CARRIES WHICH SLICES
 * =============================================================================
 *
 * A version is cut into region files, one per slice of the canvas, and the
 * playback rig divides those slices between machines. So "how much media does
 * machine 3 have to hold" is a question about REGIONS, not about songs or
 * assets, and it is answered here.
 *
 * THREE PROPERTIES OF THIS MAPPING, EACH OF WHICH THE UI DEPENDS ON
 *
 * 1. **It is not a partition.** The same region may be assigned to several
 *    machines -- a spare, a redundant pair, an editorial box that carries the
 *    whole-canvas preview. Per-machine bytes therefore SUM TO MORE than the
 *    archive holds, and every consumer must present them as overlapping
 *    allocations rather than as shares of a total. `reconcile()` exists to make
 *    the overlap a number on the screen instead of a discrepancy someone
 *    notices later.
 *
 * 2. **It can be incomplete.** A region named by no machine is not an error --
 *    the rig may genuinely not carry it -- but it must be VISIBLE, or media
 *    that nothing plays would silently read as media that is safely allocated.
 *    Same for a file whose name carries no region token at all.
 *
 * 3. **It is a statement about the RIG, not about the archive.** Nothing here
 *    decides what is superseded, and nothing here may. The keep/supersede
 *    verdict comes from `computeReclaim` over the whole snapshot exactly as it
 *    does everywhere else; this module only says which machine's column a
 *    file's bytes land in.
 *
 * WHERE THE MAP LIVES
 *
 * `DEFAULT_MACHINES` below is the REAL rig, compiled in. It is shaped exactly
 * like the `config/machines.json` this will read one day, so switching to that
 * file is a loader in `resolveMachines` and no change anywhere else -- and
 * `allocationSource` already distinguishes the two for anything downstream that
 * wants to say which is in force.
 * =============================================================================
 */

/** One playback machine and the canvas slices it carries. */
export interface MachineSpec {
  /** Stable key. Used in query strings, so it may not change casually. */
  id: string;
  /** What the operator calls it. */
  name: string;
  /** What it is for. Display and grouping only -- nothing keys off it. */
  role: MachineRole;
  /**
   * Region numbers this machine holds. `0` is the whole-canvas copy, which is
   * a legitimate allocation for an editorial machine and is why this is a plain
   * list rather than a range.
   */
  regions: number[];
  /** Free text, shown beside the row. */
  note?: string;
  /**
   * Drive size in bytes, when this machine differs from the rig default.
   * Omitted means `DEFAULT_DRIVE_CAPACITY_BYTES`.
   */
  capacityBytes?: number;
}

/**
 * Where the allocation currently in force came from.
 *
 * `built-in` means the list below: the real rig, compiled into the source. It
 * is not a guess and the UI must not disclaim it as one -- but it is also not
 * something an operator can change without an edit, which is what `config`
 * will mean once `config/machines.json` is read.
 */
export type AllocationSource = 'built-in' | 'config';

/** What a machine is for. Display and grouping only; nothing keys off it. */
export type MachineRole = 'actor' | 'understudy' | 'director' | 'director-understudy';

export const ROLE_LABELS: Record<MachineRole, string> = {
  actor: 'Actor',
  understudy: 'Understudy',
  director: 'Director',
  'director-understudy': 'Director understudy',
};

/**
 * THE RIG.
 *
 * Fourteen actors carry the fourteen canvas slices, one each. Seven
 * understudies carry the same fourteen slices, two each. Two director machines
 * carry region 0, the whole canvas. So EVERY region sits on exactly two
 * machines, and every byte of playable media is held twice -- which is the
 * whole reason the per-machine totals are not a partition and must never be
 * rendered as shares of one.
 *
 * The pairing is the operationally useful fact: 101's slice is covered by 207,
 * 206's by 305, and so on. `peers` in the API is derived from this rather than
 * stated, so it cannot drift from the region lists.
 *
 * THE BOUNDARY. The rig was first given as "101-206 are actors" and "206-305
 * are understudies", which put 206 in both. The region map already settled it
 * -- 206 holds one slice, r2, exactly as every other actor holds one, and
 * reading it as an understudy would leave r2 as the single region with no actor
 * -- and the user then CONFIRMED it directly: *"101-206 are actors, 207-305 are
 * understudies"*. Recorded because the off-by-one is the kind of thing that
 * gets re-introduced by someone reading the original message.
 */
export const DEFAULT_MACHINES: readonly MachineSpec[] = Object.freeze([
  // Actors -- the main output machines, one canvas slice each.
  { id: '101', name: '101', role: 'actor', regions: [1] },
  { id: '102', name: '102', role: 'actor', regions: [3] },
  { id: '103', name: '103', role: 'actor', regions: [4] },
  { id: '104', name: '104', role: 'actor', regions: [5] },
  { id: '105', name: '105', role: 'actor', regions: [6] },
  { id: '106', name: '106', role: 'actor', regions: [7] },
  { id: '107', name: '107', role: 'actor', regions: [8] },
  { id: '108', name: '108', role: 'actor', regions: [9] },
  { id: '201', name: '201', role: 'actor', regions: [10] },
  { id: '202', name: '202', role: 'actor', regions: [11] },
  { id: '203', name: '203', role: 'actor', regions: [12] },
  { id: '204', name: '204', role: 'actor', regions: [13] },
  { id: '205', name: '205', role: 'actor', regions: [14] },
  { id: '206', name: '206', role: 'actor', regions: [2] },

  // Understudies -- the same fourteen slices again, two per machine.
  { id: '207', name: '207', role: 'understudy', regions: [1, 3] },
  { id: '208', name: '208', role: 'understudy', regions: [4, 5] },
  { id: '301', name: '301', role: 'understudy', regions: [6, 7] },
  { id: '302', name: '302', role: 'understudy', regions: [8, 9] },
  { id: '303', name: '303', role: 'understudy', regions: [10, 11] },
  { id: '304', name: '304', role: 'understudy', regions: [12, 13] },
  { id: '305', name: '305', role: 'understudy', regions: [2, 14] },

  // Directors -- region 0, the whole canvas.
  { id: '306', name: '306', role: 'director', regions: [0] },
  { id: '307', name: '307', role: 'director-understudy', regions: [0] },
] as MachineSpec[]);

/**
 * -----------------------------------------------------------------------------
 *  DRIVE CAPACITY
 * -----------------------------------------------------------------------------
 *
 * A drive sold as "32 TB" holds 32,000,000,000,000 bytes, which is 29.10 TiB --
 * NOT 32 TiB. That is a 10% difference and it lands squarely on the answer this
 * view exists to give: at 32 TiB the fullest machine reads 85.8% and looks
 * comfortable; at the real 29.10 TiB it reads 94.4% and does not. **Confirmed
 * with the user: 32 TB is the label**, so the decimal figure is what is stored.
 *
 * Not all of it is available for content -- filesystem overhead, and the working
 * headroom a volume needs to stay healthy. `DEFAULT_DRIVE_RESERVE_FRACTION` is
 * held back before anything is called full, also at the user's word.
 *
 * Both are stated as constants rather than folded into one "usable" number, so
 * the UI can draw the reserve as a distinct part of the drive rather than
 * silently shrinking it.
 */

/** 32 TB as a manufacturer labels it: decimal, not 32 TiB. */
export const DEFAULT_DRIVE_CAPACITY_BYTES = 32_000_000_000_000;

/** Held back for filesystem overhead and working headroom. */
export const DEFAULT_DRIVE_RESERVE_FRACTION = 0.05;

/**
 * How full a drive has to be before the view stops being neutral about it.
 *
 * These are fractions of USABLE space, not of the raw drive, so `over` means
 * "into the reserve" rather than "physically full" -- which is the line worth
 * warning about, and it is reachable while the drive still has bytes left.
 */
export const DRIVE_WATCH_FRACTION = 0.75;
export const DRIVE_CRITICAL_FRACTION = 0.9;

export type DriveState = 'ok' | 'watch' | 'critical' | 'over';

export function driveState(usedBytes: number, usable: number): DriveState {
  if (usable <= 0) return 'over';
  const f = usedBytes / usable;
  if (f >= 1) return 'over';
  if (f >= DRIVE_CRITICAL_FRACTION) return 'critical';
  if (f >= DRIVE_WATCH_FRACTION) return 'watch';
  return 'ok';
}

/** Bytes actually available for content on a drive of `capacity`. */
export function usableBytesOf(
  capacity: number = DEFAULT_DRIVE_CAPACITY_BYTES,
  reserveFraction: number = DEFAULT_DRIVE_RESERVE_FRACTION,
): number {
  return Math.floor(capacity * (1 - reserveFraction));
}

export class MachineConfigError extends Error {}

/**
 * Reject an allocation that cannot mean what it says, before anything renders.
 *
 * Duplicate ids are the dangerous one: two rows would carry the same key, and a
 * click-through filter would resolve to whichever the map happened to keep. A
 * machine with no regions is allowed -- a rig can hold a spare that carries
 * nothing yet, and reporting it at 0 bytes is more use than dropping it.
 */
export function validateMachines(specs: readonly MachineSpec[]): void {
  const seen = new Set<string>();
  for (const m of specs) {
    if (!m.id || typeof m.id !== 'string') {
      throw new MachineConfigError(`Machine id must be a non-empty string, got ${JSON.stringify(m.id)}.`);
    }
    if (seen.has(m.id)) {
      throw new MachineConfigError(
        `Duplicate machine id ${JSON.stringify(m.id)}. Ids are the key a row and a ` +
          'click-through filter are resolved by, so they must be unique.',
      );
    }
    seen.add(m.id);
    if (!m.name || typeof m.name !== 'string') {
      throw new MachineConfigError(`Machine ${m.id} needs a display name.`);
    }
    if (!(m.role in ROLE_LABELS)) {
      throw new MachineConfigError(
        `Machine ${m.id}: unknown role ${JSON.stringify(m.role)}. Expected one of: ` +
          `${Object.keys(ROLE_LABELS).join(', ')}.`,
      );
    }
    if (!Array.isArray(m.regions)) {
      throw new MachineConfigError(`Machine ${m.id}: regions must be an array of integers.`);
    }
    for (const r of m.regions) {
      if (!Number.isInteger(r) || r < 0) {
        throw new MachineConfigError(
          `Machine ${m.id}: region ${JSON.stringify(r)} is not a non-negative integer.`,
        );
      }
    }
    if (m.capacityBytes !== undefined && (!Number.isFinite(m.capacityBytes) || m.capacityBytes <= 0)) {
      throw new MachineConfigError(
        `Machine ${m.id}: capacityBytes must be a positive number of bytes, got ` +
          `${JSON.stringify(m.capacityBytes)}.`,
      );
    }
    if (new Set(m.regions).size !== m.regions.length) {
      throw new MachineConfigError(
        `Machine ${m.id} lists a region twice. Its bytes would be counted twice within ` +
          'one machine, which is never what an overlap means.',
      );
    }
  }
}

/**
 * The allocation in force.
 *
 * Hard-coded for now, deliberately. The loader that reads `config/machines.json`
 * belongs exactly here, and its absence should fall back to this list rather
 * than to an empty one -- an empty allocation would report the entire archive as
 * unallocated, which reads as a finding rather than as missing configuration.
 */
export function resolveMachines(): { machines: MachineSpec[]; source: AllocationSource } {
  const machines = DEFAULT_MACHINES.map((m) => ({ ...m, regions: [...m.regions] }));
  validateMachines(machines);
  return { machines, source: 'built-in' };
}

/**
 * For each machine, the OTHER machines holding at least one of the same
 * regions. Derived rather than stated, so it cannot drift from `regions`.
 *
 * On this rig every machine has exactly one peer -- its understudy, or its
 * actor -- which is the fact an operator wants when a machine fails.
 */
export function machinePeers(specs: readonly MachineSpec[]): Map<string, string[]> {
  const byRegion = machinesByRegion(specs);
  const out = new Map<string, string[]>();
  for (const m of specs) {
    const peers = new Set<string>();
    for (const r of m.regions) {
      for (const other of byRegion.get(r) ?? []) {
        if (other.id !== m.id) peers.add(other.id);
      }
    }
    out.set(m.id, [...peers].sort());
  }
  return out;
}

/**
 * region -> the machines holding it. A region with several machines is the
 * overlap case and is expected, not exceptional.
 */
export function machinesByRegion(specs: readonly MachineSpec[]): Map<number, MachineSpec[]> {
  const out = new Map<number, MachineSpec[]>();
  for (const m of specs) {
    for (const r of m.regions) {
      const list = out.get(r);
      if (list) list.push(m);
      else out.set(r, [m]);
    }
  }
  return out;
}

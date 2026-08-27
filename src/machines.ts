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
 * WHERE THE REAL MAP GOES
 *
 * `DEFAULT_MACHINES` below is a PLACEHOLDER, and is reported as one all the way
 * out to the browser -- see `allocationSource`. It is shaped exactly like the
 * `config/machines.json` this will read one day, so switching to that file is a
 * loader in `resolveMachines` and no change anywhere else.
 * =============================================================================
 */

/** One playback machine and the canvas slices it carries. */
export interface MachineSpec {
  /** Stable key. Used in query strings, so it may not change casually. */
  id: string;
  /** What the operator calls it. */
  name: string;
  /**
   * Region numbers this machine holds. `0` is the whole-canvas copy, which is
   * a legitimate allocation for an editorial machine and is why this is a plain
   * list rather than a range.
   */
  regions: number[];
  /** Free text, shown beside the row. */
  note?: string;
}

/** Where the allocation currently in force came from. */
export type AllocationSource = 'placeholder' | 'config';

/**
 * PLACEHOLDER. Invented, not measured -- every consumer labels it as such.
 *
 * Two slices per machine across region1-region14, plus an editorial machine
 * carrying region0. Replace wholesale with the real rig.
 */
export const DEFAULT_MACHINES: readonly MachineSpec[] = Object.freeze([
  { id: 'm01', name: 'Machine 01', regions: [1, 2] },
  { id: 'm02', name: 'Machine 02', regions: [3, 4] },
  { id: 'm03', name: 'Machine 03', regions: [5, 6] },
  { id: 'm04', name: 'Machine 04', regions: [7, 8] },
  { id: 'm05', name: 'Machine 05', regions: [9, 10] },
  { id: 'm06', name: 'Machine 06', regions: [11, 12] },
  { id: 'm07', name: 'Machine 07', regions: [13, 14] },
  {
    id: 'edit',
    name: 'Editorial',
    regions: [0],
    note: 'Whole-canvas copies for offline editing.',
  },
] as MachineSpec[]);

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
  return { machines, source: 'placeholder' };
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

/**
 * =============================================================================
 *  PER-MACHINE DRIVE FILL, FOR THE REPORT. PURE APART FROM READING THE INDEX.
 * =============================================================================
 *
 * The Browse view answers "how full is each drive right now". A report that
 * puts four cleanup options on its first page has to answer a harder question:
 * **which option gets a full machine back under control.** So every machine is
 * costed at every option, not just at the one this export happens to use.
 *
 * WHAT IS ON A DRIVE DOES NOT DEPEND ON THE OPTION. `totalBytes` is everything
 * allocated to that machine, superseded or not -- the media is on the disk
 * until somebody removes it. Only `recoverable` moves with the option, and
 * `remainingBytes` is the subtraction.
 *
 * THE REGION IS PARSED, NOT STORED, and with THE SAME PARSER THE SCAN USED --
 * the caller passes the pattern from the same config. See the header of
 * `src/server/routes/machines.ts`; the reasoning is identical and the risk of
 * a second hand-rolled reading of a filename is the reason it is spelled out
 * in both places.
 *
 * OVERLAP IS NOT COLLAPSED. A region held by two machines puts its bytes on
 * both drives, because it genuinely is on both drives. Anything summing these
 * rows is summing storage, not archive, and the report says so where it draws
 * them.
 * =============================================================================
 */

import type { Database as Db } from 'better-sqlite3';

import { computeReclaim, type ReclaimAssetInput } from '../scan/reclaim.ts';
import { makeParser } from '../scan/parse.ts';
import {
  driveState,
  machinesByRegion,
  usableBytesOf,
  DEFAULT_DRIVE_CAPACITY_BYTES,
  DEFAULT_DRIVE_RESERVE_FRACTION,
  type MachineSpec,
} from '../machines.ts';
import type { ExportMachineFill, ExportMachineOption } from './types.ts';

interface FileQueryRow {
  name: string;
  size: number;
  asset_version_id: number | null;
}

export interface MachineFillOptions {
  /** Filename grammar. Pass the scan's own pattern; defaults to the built-in. */
  parsePattern?: string | undefined;
  parseFlags?: string | undefined;
  capacityBytes?: number;
  reserveFraction?: number;
}

/**
 * Cost every machine at every one of `keepNs`.
 *
 * @param assets   The whole snapshot, unfiltered -- `computeReclaim` may never
 *                 be given a subset. See CLAUDE.md.
 * @param keepNs   The options being reported, ascending.
 */
export function buildMachineFill(
  db: Db,
  snapshotId: number,
  machines: readonly MachineSpec[],
  assets: readonly ReclaimAssetInput[],
  keepNs: readonly number[],
  opts: MachineFillOptions = {},
): ExportMachineFill[] {
  const reserveFraction = opts.reserveFraction ?? DEFAULT_DRIVE_RESERVE_FRACTION;
  const byRegion = machinesByRegion(machines);
  const parse = makeParser(opts.parsePattern, opts.parseFlags);

  // versionId -> superseded, once per option. Computed over the WHOLE snapshot.
  const supersededByOption = keepNs.map((n) => {
    const set = new Set<number>();
    for (const v of computeReclaim(assets, n).verdicts) if (!v.keep) set.add(v.versionId);
    return set;
  });

  const totals = new Map<string, number>();
  const recoverable = new Map<string, number[]>();
  for (const m of machines) {
    totals.set(m.id, 0);
    recoverable.set(m.id, keepNs.map(() => 0));
  }

  const rows = db
    .prepare(`SELECT name, size, asset_version_id FROM file WHERE snapshot_id = ?`)
    .all(snapshotId) as FileQueryRow[];

  for (const f of rows) {
    const parsed = parse(f.name);
    if (!parsed.ok || parsed.region === null) continue;
    const holders = byRegion.get(parsed.region);
    if (!holders?.length) continue;

    // A file with no version cannot be superseded by anything, but it is still
    // on the drive -- so it counts towards the total and never towards reclaim.
    const versionId = f.asset_version_id;
    for (const m of holders) {
      totals.set(m.id, (totals.get(m.id) as number) + f.size);
      if (versionId === null) continue;
      const per = recoverable.get(m.id) as number[];
      for (let i = 0; i < supersededByOption.length; i += 1) {
        if ((supersededByOption[i] as Set<number>).has(versionId)) per[i] = (per[i] as number) + f.size;
      }
    }
  }

  return machines.map((m) => {
    const capacityBytes = m.capacityBytes ?? opts.capacityBytes ?? DEFAULT_DRIVE_CAPACITY_BYTES;
    const usable = usableBytesOf(capacityBytes, reserveFraction);
    const totalBytes = totals.get(m.id) as number;
    const per = recoverable.get(m.id) as number[];

    const options: ExportMachineOption[] = keepNs.map((keepN, i) => {
      const recoverableBytes = per[i] as number;
      const remainingBytes = totalBytes - recoverableBytes;
      return {
        keepN,
        recoverableBytes,
        remainingBytes,
        remainingFraction: usable > 0 ? remainingBytes / usable : 0,
        state: driveState(remainingBytes, usable),
      };
    });

    return {
      machineId: m.id,
      name: m.name,
      role: m.role,
      regions: [...m.regions].sort((a, b) => a - b),
      capacityBytes,
      reserveBytes: capacityBytes - usable,
      usableBytes: usable,
      totalBytes,
      usedFraction: usable > 0 ? totalBytes / usable : 0,
      state: driveState(totalBytes, usable),
      options,
    };
  });
}

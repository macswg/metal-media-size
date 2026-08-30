/**
 * =============================================================================
 *  RIG SURVEY  --  WHAT IS ACTUALLY ON THE MACHINES, AGAINST WHAT SHOULD BE
 * =============================================================================
 *
 * Every other view in this application describes the ARCHIVE. This one
 * describes the RIG, and then puts the two side by side, which is the only way
 * to answer the question an operator actually has the night before a show:
 * *is the right media on the right machine?*
 *
 * `/api/machines` already says what machine 301 SHOULD hold -- it carries
 * regions 6 and 7, so it should hold every region6 and region7 file in the
 * archive. This module walks 301 and says what it DOES hold. The categories
 * below are the whole point, so they are named for what an operator would do
 * about them rather than for their set arithmetic:
 *
 *   missingKept        Media that is current and is NOT on the machine.
 *                      The alarm. A show that needs this file will not play it.
 *   presentSuperseded  Media on the machine that a newer version has replaced.
 *                      Space that can come back, measured on the actual drive.
 *   sizeMismatch       Same name, different size. A copy that did not finish,
 *                      or a re-render that never reached the archive. Reported
 *                      loudly because BOTH readings are bad.
 *   missingSuperseded  Old media already cleaned off. Not a problem; counted so
 *                      the arithmetic closes and a tidy machine looks tidy.
 *   presentKept        Correct, current, present. The boring majority.
 *   extraForeign       A file whose region belongs to some OTHER machine. On a
 *                      rig where every region is mirrored on exactly two
 *                      machines this is how a mis-copy shows up.
 *   extraUnknown       A file the archive has never heard of.
 *
 * NOTHING HERE READS FILE BYTES. It is names, sizes and timestamps, exactly as
 * the duplicate detector is -- see CLAUDE.md. A size that matches is not proof
 * the contents match, and the UI says so.
 *
 * NOTHING HERE DELETES, and nothing here proposes a manifest. It reports.
 *
 * MATCHING IS BY FILE NAME, and that is sound here rather than convenient: an
 * asset base carries its song number (`140_RIVER_ANIMATIC_LL180_v008_region1.mov`),
 * so a basename identifies a file across the whole delivery. Collisions are
 * counted and reported rather than resolved arbitrarily, because a collision
 * would mean the grammar's assumption had changed.
 * =============================================================================
 */

/** One file found on a machine. Sizes and times only -- no bytes are read. */
export interface RemoteFile {
  /** Path relative to the surveyed directory, `/` separated. */
  relPath: string;
  name: string;
  size: number;
  mtime: number;
}

/**
 * One file the archive says belongs on this machine, with the verdict the
 * whole-snapshot reclaim gave its version.
 */
export interface ExpectedFile {
  name: string;
  size: number;
  region: number;
  songFolder: string;
  base: string;
  verLabel: string;
  versionId: number;
  status: 'kept' | 'superseded' | 'unknown';
}

/** A file that is on the machine and in the archive, with its two sizes. */
export interface MatchedFile {
  name: string;
  relPath: string;
  archiveSize: number;
  machineSize: number;
  status: 'kept' | 'superseded' | 'unknown';
  verLabel: string;
  base: string;
  songFolder: string;
  region: number;
}

export interface Bucket {
  count: number;
  bytes: number;
}

export interface MachineComparison {
  missingKept: ExpectedFile[];
  missingSuperseded: ExpectedFile[];
  presentKept: Bucket;
  presentSuperseded: MatchedFile[];
  sizeMismatch: MatchedFile[];
  extraForeign: RemoteFile[];
  extraUnknown: RemoteFile[];
  /** Files on the machine, and their total. */
  actual: Bucket;
  /** Files the archive expects here, and their total. */
  expected: Bucket;
  /**
   * Archive basenames that appeared more than once in the expectation set.
   * Should be zero; a non-zero value means filenames stopped being unique and
   * the matching below is no longer trustworthy, so it is surfaced rather than
   * swallowed.
   */
  nameCollisions: number;
}

const emptyBucket = (): Bucket => ({ count: 0, bytes: 0 });

function add(b: Bucket, bytes: number): void {
  b.count += 1;
  b.bytes += bytes;
}

/**
 * Compare one machine's actual contents against what the archive expects.
 *
 * Pure: no I/O, no clock, no database. The caller supplies both sides, which
 * is what makes this testable without a rig on the other end of a network.
 *
 * `regionOfName` decides whether an unexpected file at least belongs to some
 * machine; it is injected rather than imported so the survey uses the same
 * parser the scan used, built from the same config pattern.
 */
export function compareMachine(
  actual: readonly RemoteFile[],
  expected: readonly ExpectedFile[],
  opts: {
    /** Regions this machine carries. A file outside them is `extraForeign`. */
    regions: readonly number[];
    /** Region of a file name, or null when the grammar cannot read one. */
    regionOfName: (name: string) => number | null;
  },
): MachineComparison {
  const mine = new Set(opts.regions);

  const byName = new Map<string, ExpectedFile>();
  let nameCollisions = 0;
  for (const e of expected) {
    if (byName.has(e.name)) {
      nameCollisions += 1;
      continue;
    }
    byName.set(e.name, e);
  }

  const out: MachineComparison = {
    missingKept: [],
    missingSuperseded: [],
    presentKept: emptyBucket(),
    presentSuperseded: [],
    sizeMismatch: [],
    extraForeign: [],
    extraUnknown: [],
    actual: emptyBucket(),
    expected: emptyBucket(),
    nameCollisions,
  };

  for (const e of expected) add(out.expected, e.size);

  const seen = new Set<string>();

  for (const f of actual) {
    add(out.actual, f.size);
    const e = byName.get(f.name);

    if (!e) {
      // Not expected here. Two very different reasons, kept apart: a file that
      // belongs on another machine is a copy that went to the wrong place; a
      // file the archive has never seen is something else entirely.
      const region = opts.regionOfName(f.name);
      if (region !== null && !mine.has(region)) out.extraForeign.push(f);
      else out.extraUnknown.push(f);
      continue;
    }

    seen.add(e.name);

    // A size difference outranks the keep/supersede verdict in what it means:
    // whatever this file is, it is not the file the archive recorded.
    if (f.size !== e.size) {
      out.sizeMismatch.push(toMatched(f, e));
      continue;
    }
    if (e.status === 'superseded') out.presentSuperseded.push(toMatched(f, e));
    else add(out.presentKept, f.size);
  }

  for (const e of expected) {
    if (seen.has(e.name)) continue;
    // A name that collided was skipped from `byName`, so it can never be seen;
    // it would otherwise be reported as missing on the strength of a duplicate.
    if (byName.get(e.name) !== e) continue;
    if (e.status === 'superseded') out.missingSuperseded.push(e);
    else out.missingKept.push(e);
  }

  // Worst first, and within that biggest first: the operator reads from the
  // top and the top should be the thing that costs the most to be wrong about.
  out.missingKept.sort((a, b) => b.size - a.size);
  out.missingSuperseded.sort((a, b) => b.size - a.size);
  out.presentSuperseded.sort((a, b) => b.machineSize - a.machineSize);
  out.sizeMismatch.sort((a, b) => b.machineSize - a.machineSize);
  out.extraForeign.sort((a, b) => b.size - a.size);
  out.extraUnknown.sort((a, b) => b.size - a.size);

  return out;
}

function toMatched(f: RemoteFile, e: ExpectedFile): MatchedFile {
  return {
    name: f.name,
    relPath: f.relPath,
    archiveSize: e.size,
    machineSize: f.size,
    status: e.status,
    verLabel: e.verLabel,
    base: e.base,
    songFolder: e.songFolder,
    region: e.region,
  };
}

/** Totals for one machine, in the shape the UI puts on a row. */
export interface MachineTotals {
  actualFiles: number;
  actualBytes: number;
  expectedFiles: number;
  expectedBytes: number;
  missingKeptFiles: number;
  missingKeptBytes: number;
  missingSupersededFiles: number;
  missingSupersededBytes: number;
  presentSupersededFiles: number;
  presentSupersededBytes: number;
  sizeMismatchFiles: number;
  extraForeignFiles: number;
  extraForeignBytes: number;
  extraUnknownFiles: number;
  extraUnknownBytes: number;
  nameCollisions: number;
  /** True when every expected file is present at the expected size. */
  inSync: boolean;
}

const sumBytes = (rows: readonly { size: number }[]): number =>
  rows.reduce((n, r) => n + r.size, 0);

export function totalsOf(c: MachineComparison): MachineTotals {
  return {
    actualFiles: c.actual.count,
    actualBytes: c.actual.bytes,
    expectedFiles: c.expected.count,
    expectedBytes: c.expected.bytes,
    missingKeptFiles: c.missingKept.length,
    missingKeptBytes: sumBytes(c.missingKept),
    missingSupersededFiles: c.missingSuperseded.length,
    missingSupersededBytes: sumBytes(c.missingSuperseded),
    presentSupersededFiles: c.presentSuperseded.length,
    presentSupersededBytes: c.presentSuperseded.reduce((n, r) => n + r.machineSize, 0),
    sizeMismatchFiles: c.sizeMismatch.length,
    extraForeignFiles: c.extraForeign.length,
    extraForeignBytes: sumBytes(c.extraForeign),
    extraUnknownFiles: c.extraUnknown.length,
    extraUnknownBytes: sumBytes(c.extraUnknown),
    nameCollisions: c.nameCollisions,
    // Deliberately strict, and deliberately NOT about the extras: a machine
    // holding the whole current delivery at the right sizes is in sync even if
    // it is also carrying old media, because that is a space problem and not a
    // playback one.
    inSync: c.missingKept.length === 0 && c.sizeMismatch.length === 0,
  };
}

/* ===========================================================================
 *  THE MASTER LIST  --  EVERYTHING MISSING, ACROSS THE WHOLE RIG
 * ===========================================================================
 *
 * A per-machine card answers "what is wrong with 301?". It cannot answer the
 * question an operator asks first, which is "what is wrong with the SHOW?" --
 * and on this rig those are genuinely different questions, because every region
 * sits on exactly two machines. A file absent from one of its two holders still
 * plays; the rig has lost its redundancy and nothing else. The same file absent
 * from BOTH is media that nothing on the rig can put on screen.
 *
 * Only a cross-machine roll-up can tell those apart, and telling them apart is
 * the entire reason this exists. Hence three states, in the order they matter:
 *
 *   gone         no surveyed holder has a good copy, and every holder was
 *                looked at. Nothing can play this.
 *   unconfirmed  no surveyed holder has a good copy, but a holder was NOT
 *                surveyed -- offline, unreachable, or not in the list. It may
 *                be safe on the machine we could not see. Never reported as
 *                `gone`: we did not look, and saying otherwise would be
 *                inventing the finding.
 *   reduced      at least one good copy exists, but not on every holder. The
 *                show plays; the redundancy is gone.
 *
 * A WRONG-SIZED COPY IS NOT A COPY. A holder carrying the right name at the
 * wrong size does not count towards `presentOn` -- whatever that file is, it is
 * not the one the archive recorded, and treating it as a spare would turn a
 * `gone` into a `reduced` and hide the worst finding the survey can make.
 * =========================================================================== */

export type MissingState = 'gone' | 'unconfirmed' | 'reduced';

export interface MissingRow {
  name: string;
  size: number;
  region: number;
  songFolder: string;
  base: string;
  verLabel: string;
  /** Surveyed holders that do not have it at all. */
  missingFrom: string[];
  /** Surveyed holders carrying that name at a different size. Not a copy. */
  wrongSizeOn: string[];
  /** Surveyed holders that have it, at the right size. */
  presentOn: string[];
  /** Holders that were not surveyed, so nothing is known about them. */
  unknownOn: string[];
  state: MissingState;
}

export interface MissingByRegion {
  region: number;
  /** Machines that carry this region, whether or not they were surveyed. */
  holders: string[];
  files: number;
  bytes: number;
  /** Of those, how many no surveyed holder can play. */
  gone: number;
}

export interface MissingRollup {
  rows: MissingRow[];
  counts: Record<MissingState, number>;
  bytes: Record<MissingState, number>;
  byRegion: MissingByRegion[];
  /** Machines whose contents are unknown, so the roll-up cannot be complete. */
  unsurveyedHolders: string[];
  /** True when nothing is missing from any surveyed machine. */
  clean: boolean;
}

/** One machine's contribution, in the shape the roll-up needs. */
export interface MissingSource {
  machineId: string | null;
  comparison: MachineComparison | null;
  error: string | null;
}

/**
 * Roll every machine's missing list into one list for the rig.
 *
 * Pure: the caller supplies the results and the region allocation. `regionHolders`
 * is every machine that CARRIES a region, not every machine that was surveyed --
 * the difference is exactly what `unknownOn` is for.
 */
export function rollUpMissing(
  machines: readonly MissingSource[],
  regionHolders: ReadonlyMap<number, readonly string[]>,
): MissingRollup {
  /** machineId -> what that machine said, for the machines we actually read. */
  const surveyed = new Map<string, { missing: Set<string>; wrongSize: Set<string> }>();
  for (const m of machines) {
    if (m.machineId === null || m.error !== null || !m.comparison) continue;
    surveyed.set(m.machineId, {
      missing: new Set(m.comparison.missingKept.map((f) => f.name)),
      wrongSize: new Set(m.comparison.sizeMismatch.map((f) => f.name)),
    });
  }

  // Every distinct file reported missing by anybody. Keyed by name, which is
  // unique across the delivery because a base carries its song number.
  const files = new Map<string, ExpectedFile>();
  for (const m of machines) {
    if (m.machineId === null || m.error !== null || !m.comparison) continue;
    for (const f of m.comparison.missingKept) if (!files.has(f.name)) files.set(f.name, f);
  }

  const rows: MissingRow[] = [];
  for (const f of files.values()) {
    // Holders from the allocation, plus any machine that reported it missing --
    // if a machine expected it, it holds that region by definition, and this
    // way the row is right even if the two ever disagreed.
    const holders = new Set(regionHolders.get(f.region) ?? []);
    for (const [id, said] of surveyed) if (said.missing.has(f.name)) holders.add(id);

    const missingFrom: string[] = [];
    const wrongSizeOn: string[] = [];
    const presentOn: string[] = [];
    const unknownOn: string[] = [];

    for (const id of [...holders].sort()) {
      const said = surveyed.get(id);
      if (!said) unknownOn.push(id);
      else if (said.missing.has(f.name)) missingFrom.push(id);
      else if (said.wrongSize.has(f.name)) wrongSizeOn.push(id);
      else presentOn.push(id);
    }

    const state: MissingState =
      presentOn.length > 0 ? 'reduced' : unknownOn.length > 0 ? 'unconfirmed' : 'gone';

    rows.push({
      name: f.name,
      size: f.size,
      region: f.region,
      songFolder: f.songFolder,
      base: f.base,
      verLabel: f.verLabel,
      missingFrom,
      wrongSizeOn,
      presentOn,
      unknownOn,
      state,
    });
  }

  // Worst first, then biggest first: the operator reads from the top, and the
  // top should be what costs the most to be wrong about.
  const rank: Record<MissingState, number> = { gone: 0, unconfirmed: 1, reduced: 2 };
  rows.sort((a, b) => rank[a.state] - rank[b.state] || b.size - a.size || a.name.localeCompare(b.name));

  const counts: Record<MissingState, number> = { gone: 0, unconfirmed: 0, reduced: 0 };
  const bytes: Record<MissingState, number> = { gone: 0, unconfirmed: 0, reduced: 0 };
  const regions = new Map<number, MissingByRegion>();
  for (const r of rows) {
    counts[r.state] += 1;
    bytes[r.state] += r.size;
    const entry = regions.get(r.region) ?? {
      region: r.region,
      holders: [...(regionHolders.get(r.region) ?? [])].sort(),
      files: 0,
      bytes: 0,
      gone: 0,
    };
    entry.files += 1;
    entry.bytes += r.size;
    if (r.state === 'gone') entry.gone += 1;
    regions.set(r.region, entry);
  }

  const unsurveyed = new Set<string>();
  for (const r of rows) for (const id of r.unknownOn) unsurveyed.add(id);

  return {
    rows,
    counts,
    bytes,
    byRegion: [...regions.values()].sort((a, b) => b.gone - a.gone || b.bytes - a.bytes || a.region - b.region),
    unsurveyedHolders: [...unsurveyed].sort(),
    clean: rows.length === 0,
  };
}

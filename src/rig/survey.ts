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

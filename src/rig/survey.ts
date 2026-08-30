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
 *   extraUnknown       A file carrying a region THIS machine holds that the
 *                      archive has never heard of. Unexpected media.
 *   extraUnparsed      A name this grammar cannot read at all. Not a delivery
 *                      as far as anything here can tell.
 *   regionless         A name with no region token. NOT A FINDING, and not
 *                      listed: the allocation is by region, so a file with no
 *                      region belongs to no machine and is neither missing from
 *                      one nor extra on it. Counted so the arithmetic closes.
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
 * A file on the machine that the archive did not expect here, with what its
 * NAME says about it.
 *
 * The parse is a reading of the name, not a fact from the index -- these are
 * exactly the files the index has no row for, or no row that belongs here. It
 * is the same grammar the scan uses, injected as `describeName`, and it is why
 * `extraForeign` can be told from `extraUnknown` at all: the region in the name
 * is what says the file belongs to some other machine.
 */
export interface ForeignFile extends RemoteFile {
  /** Region the NAME carries, or null when the grammar cannot read one. */
  region: number | null;
  /** Version as the name spells it, e.g. `v019`. Empty when unreadable. */
  verLabel: string;
  /** Asset identity the name carries. Empty when unreadable. */
  base: string;
}

/** What the scan's grammar can say about a file name. */
export interface NameDescription {
  region: number | null;
  verLabel: string;
  base: string;
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
  extraForeign: ForeignFile[];
  extraUnknown: ForeignFile[];
  /** Names the grammar cannot read. Kept apart from the two above on purpose. */
  extraUnparsed: ForeignFile[];
  /**
   * Valid names carrying NO region. The rig allocates by region, so these
   * belong to no machine: they are not missing from one and not extra on one,
   * and reporting them as either is a finding that is not there. Counted, never
   * listed. `regionless` and `unparsed` are different things -- see CLAUDE.md,
   * where `/api/machines` draws the same line -- and merging them would hide
   * the second inside the first.
   */
  regionless: ForeignFile[];
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
 * `describeName` reads what a file name says -- its region, its version, its
 * base. It is injected rather than imported so the survey uses the same parser
 * the scan used, built from the same config pattern, and it does two jobs at
 * once: the region decides whether an unexpected file at least belongs to some
 * OTHER machine, and the rest is what the UI puts in its columns for a file the
 * index has no row for.
 */
export function compareMachine(
  actual: readonly RemoteFile[],
  expected: readonly ExpectedFile[],
  opts: {
    /** Regions this machine carries. A file outside them is `extraForeign`. */
    regions: readonly number[];
    /** What the grammar reads off a file name, or null when it cannot read it. */
    describeName: (name: string) => NameDescription | null;
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
    extraUnparsed: [],
    regionless: [],
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
      const said = opts.describeName(f.name);
      const region = said?.region ?? null;
      // Carried on the row so the UI can column it the way every other list is
      // columned. The archive has nothing to say about these files; the name
      // does, and the row is explicit about which of the two it is showing.
      const row: ForeignFile = {
        ...f,
        region,
        verLabel: said?.verLabel ?? '',
        base: said?.base ?? '',
      };
      // Four different things, and only the first three are findings:
      //   a name nothing here can read;
      //   a valid name with no region, which belongs to no machine at all;
      //   a region some OTHER machine holds -- a copy in the wrong place;
      //   a region THIS machine holds, that the archive does not have.
      if (said === null) out.extraUnparsed.push(row);
      else if (region === null) out.regionless.push(row);
      else if (!mine.has(region)) out.extraForeign.push(row);
      else out.extraUnknown.push(row);
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
  out.extraUnparsed.sort((a, b) => b.size - a.size);
  out.regionless.sort((a, b) => b.size - a.size);

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
  extraUnparsedFiles: number;
  extraUnparsedBytes: number;
  /** Files carrying no region. Reported as a count, never as a finding. */
  regionlessFiles: number;
  regionlessBytes: number;
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
    extraUnparsedFiles: c.extraUnparsed.length,
    extraUnparsedBytes: sumBytes(c.extraUnparsed),
    regionlessFiles: c.regionless.length,
    regionlessBytes: sumBytes(c.regionless),
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
 * question an operator asks first, which is "what is wrong with the SHOW?".
 *
 * THE TWO HOLDERS OF A REGION ARE NOT EQUAL. Every region sits on two machines,
 * but one of them is the machine that PLAYS it -- an actor, or the director for
 * region 0 -- and the other is a backup. **Confirmed by the user:** *"the
 * understudy machines are backups, so if files are not found on the main
 * (actor) machine they are missing."*
 *
 * So the verdict is decided by the PRIMARY holder, and the backup decides only
 * what it costs to fix:
 *
 *   missing      not on its primary, and no surveyed machine has a good copy.
 *                The show cannot play it and the rig cannot supply it: it has
 *                to come back from the archive.
 *   recoverable  not on its primary, so the show cannot play it -- but the
 *                backup has a good copy, so it can be restored from the rig
 *                without going back to the archive. STILL AN ALARM. This is the
 *                state that used to read as `reduced`, which was wrong: it said
 *                the show plays, and it does not. (`missing` was called `gone`
 *                until the user asked for the plainer word.)
 *   unconfirmed  the PRIMARY was not surveyed -- offline, unreachable, or not
 *                in the list. The machine that decides was not read, so there
 *                is no finding to make. Never reported as an alarm: we did not
 *                look. Note this is now about the primary alone; a backup we
 *                did not read leaves the alarm perfectly well determined and
 *                only the repair route unknown.
 *   spareLost    the primary HAS it; some backup does not. The show plays and
 *                the redundancy is gone -- the only state here that is not an
 *                alarm.
 *
 * WHEN NO HOLDER IS A PRIMARY -- an allocation with no roles, or machine ids
 * this rig does not know -- every holder decides, which is exactly the old
 * behaviour: any good copy makes it `spareLost`, none makes it `missing`.
 *
 * A WRONG-SIZED COPY IS NOT A COPY. A holder carrying the right name at the
 * wrong size does not count towards `presentOn` -- whatever that file is, it is
 * not the one the archive recorded, and treating it as a copy would turn a
 * `missing` into a `recoverable` and hide the worst finding the survey can make.
 * =========================================================================== */

export type MissingState = 'missing' | 'recoverable' | 'unconfirmed' | 'spareLost';

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
  /** The holders that PLAY this region. What decides the state. */
  primaryOn: string[];
  state: MissingState;
}

/**
 * One region of the canvas, as it stands on the RIG.
 *
 *   short       the machine that plays it is missing files. The finding.
 *   spare       the machine that plays it is complete; a backup is short.
 *   unsurveyed  nobody read the machine that plays it, so nothing is known.
 *               NOT the same as `ok`, and the difference is the whole reason
 *               this list covers every region rather than only the ones with
 *               findings: a region nobody looked at used to be absent from the
 *               tab entirely, which reads exactly like a region that is fine.
 *   ok          the machine that plays it was read and is short of nothing.
 */
export type RigRegionState = 'short' | 'spare' | 'unsurveyed' | 'ok';

export interface MissingByRegion {
  region: number;
  /** Machines that carry this region, whether or not they were surveyed. */
  holders: string[];
  /** Of those holders, the ones that play the region rather than back it up. */
  primaries: string[];
  /** Of THOSE, the ones actually read. Empty means nothing can be said. */
  surveyedPrimaries: string[];
  files: number;
  bytes: number;
  /** Of those, how many the archive is the only remaining source for. */
  missing: number;
  /** Of those, how many are not on the machine that plays them. The alarm. */
  unplayable: number;
  /** Bytes of that. */
  unplayableBytes: number;
  state: RigRegionState;
}

export interface MissingRollup {
  rows: MissingRow[];
  counts: Record<MissingState, number>;
  bytes: Record<MissingState, number>;
  /**
   * EVERY region the allocation knows about, in canvas order -- not only the
   * ones with findings. A region with nothing wrong says so, and a region
   * nobody looked at says THAT, which is the state the tab could not express
   * before: it was simply absent, which reads as fine.
   */
  byRegion: MissingByRegion[];
  /** Machines whose contents are unknown, so the roll-up cannot be complete. */
  unsurveyedHolders: string[];
  /**
   * Of those, the ones that PLAY a region. These are the omissions that matter:
   * a primary nobody read is a finding this list cannot make at all, where an
   * unread backup only leaves the repair route unknown.
   */
  unsurveyedPrimaries: string[];
  /** Files that are not on the machine that plays them: `missing` + `recoverable`. */
  unplayable: { files: number; bytes: number };
  /** True when nothing is missing from any surveyed machine. */
  clean: boolean;
}

/** One machine's contribution, in the roll-ups' shape. */
export interface MissingSource {
  machineId: string | null;
  comparison: MachineComparison | null;
  error: string | null;
}

/**
 * Roll every machine's missing list into one list for the rig.
 *
 * Pure: the caller supplies the results and the allocation. `regionHolders` is
 * every machine that CARRIES a region, not every machine that was surveyed --
 * the difference is exactly what `unknownOn` is for. `primaryHolders` is which
 * of them PLAY what they carry rather than backing it up; see the header above
 * for why that decides the verdict.
 */
export function rollUpMissing(
  machines: readonly MissingSource[],
  regionHolders: ReadonlyMap<number, readonly string[]>,
  primaryHolders: ReadonlySet<string> = new Set(),
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

    // The holders that decide. Normally the actor (or, for region 0, the
    // director); with no roles to go on, everybody decides, which is the old
    // any-copy-will-do behaviour and the only safe reading without them.
    const primaryOn = [...holders].sort().filter((id) => primaryHolders.has(id));
    const deciding = primaryOn.length > 0 ? primaryOn : [...holders].sort();
    const decidingHasIt = deciding.some((id) => presentOn.includes(id));
    const decidingWasRead = deciding.some((id) => surveyed.has(id));
    const backupHasIt = presentOn.some((id) => !deciding.includes(id));

    const state: MissingState = decidingHasIt
      ? 'spareLost'
      : !decidingWasRead
        ? 'unconfirmed'
        : backupHasIt
          ? 'recoverable'
          : 'missing';

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
      primaryOn,
      state,
    });
  }

  // Worst first, then biggest first: the operator reads from the top, and the
  // top should be what costs the most to be wrong about.
  // Alarms first, worst first: nothing can supply it, then the rig can, then
  // the question we could not answer, then the one that is not an alarm.
  const rank: Record<MissingState, number> = { missing: 0, recoverable: 1, unconfirmed: 2, spareLost: 3 };
  rows.sort((a, b) => rank[a.state] - rank[b.state] || b.size - a.size || a.name.localeCompare(b.name));

  const counts: Record<MissingState, number> = { missing: 0, recoverable: 0, unconfirmed: 0, spareLost: 0 };
  const bytes: Record<MissingState, number> = { missing: 0, recoverable: 0, unconfirmed: 0, spareLost: 0 };

  // SEEDED FROM THE ALLOCATION, not from the findings. A region with no missing
  // files must still appear -- as `ok` if its machine was read and as
  // `unsurveyed` if it was not, and those two are not the same answer. Region 0
  // is a region here like any other: it belongs to the director machines, and
  // if 306 has not got it that is a finding, not a footnote.
  const regions = new Map<number, MissingByRegion>();
  for (const [region, holders] of regionHolders) {
    const all = [...holders].sort();
    const primaries = all.filter((id) => primaryHolders.has(id));
    // With no roles to go on, every holder decides -- the same fallback the
    // row states use, and for the same reason.
    const deciding = primaries.length > 0 ? primaries : all;
    regions.set(region, {
      region,
      holders: all,
      primaries: deciding,
      surveyedPrimaries: deciding.filter((id) => surveyed.has(id)),
      files: 0,
      bytes: 0,
      missing: 0,
      unplayable: 0,
      unplayableBytes: 0,
      state: 'ok',
    });
  }

  for (const r of rows) {
    counts[r.state] += 1;
    bytes[r.state] += r.size;
    const entry = regions.get(r.region);
    // A region no machine claims cannot be seeded from the allocation, but a
    // file for it was still found missing somewhere. Reported rather than
    // dropped: the alternative is a finding that exists in the rows and in no
    // summary.
    const row = entry ?? {
      region: r.region,
      holders: [],
      primaries: [],
      surveyedPrimaries: [],
      files: 0,
      bytes: 0,
      missing: 0,
      unplayable: 0,
      unplayableBytes: 0,
      state: 'ok' as RigRegionState,
    };
    row.files += 1;
    row.bytes += r.size;
    if (r.state === 'missing') row.missing += 1;
    if (r.state === 'missing' || r.state === 'recoverable') {
      row.unplayable += 1;
      row.unplayableBytes += r.size;
    }
    regions.set(r.region, row);
  }

  for (const entry of regions.values()) {
    entry.state =
      entry.unplayable > 0
        ? 'short'
        : entry.surveyedPrimaries.length === 0
          ? 'unsurveyed'
          : entry.files > 0
            ? 'spare'
            : 'ok';
  }

  const unsurveyed = new Set<string>();
  for (const r of rows) for (const id of r.unknownOn) unsurveyed.add(id);

  return {
    rows,
    counts,
    bytes,
    // CANVAS ORDER, not worst-first: this is a strip you read across to find
    // the region you care about, and the state is carried by colour. Region 0
    // sorts first, where the whole-canvas copy belongs.
    byRegion: [...regions.values()].sort((a, b) => a.region - b.region),
    unsurveyedHolders: [...unsurveyed].sort(),
    unsurveyedPrimaries: [...unsurveyed].filter((id) => primaryHolders.has(id)).sort(),
    unplayable: {
      files: counts.missing + counts.recoverable,
      bytes: bytes.missing + bytes.recoverable,
    },
    clean: rows.length === 0,
  };
}

/* ===========================================================================
 *  THE OTHER HALF  --  MEDIA THAT IS HERE, AND IN THE WRONG PLACE
 * ===========================================================================
 *
 * `missingKept` asks "what is the rig short of?". This asks the question that
 * sits next to it: **what is on the rig, in the wrong place?** Both are needed,
 * and neither implies the other -- on a rig where a copy went to the wrong
 * machine, the file is simultaneously missing from one drive and taking up
 * space on another, and the two facts are reported on different cards.
 *
 * A per-machine card already says "this file belongs to another machine"
 * (`extraForeign`). It cannot say the thing an operator wants next, which is
 * whether the machine it belongs to HAS it -- because that is a fact about a
 * different machine. Hence a roll-up, and hence four states:
 *
 *   rescue       a rightful holder is short of this file, and here it is. The
 *                nearest copy is on the rig, not in the archive. Actionable,
 *                and it is the reason this exists.
 *   duplicate    every rightful holder already has a good copy. This one is
 *                just space on the wrong drive -- a cleanup, not an alarm.
 *   unconfirmed  a rightful holder was not surveyed, so which of the two above
 *                this is cannot be said. Never guessed at.
 *   unknown      the archive has no row for this name. The region in the name
 *                still says which machines carry that slice, but whether
 *                anything needs the file cannot be answered from here.
 *
 * A SUPERSEDED FILE IS NEVER A RESCUE. If the archive has replaced it, no
 * machine is short of it however few copies exist, and moving it would be
 * moving old media around. It reads as `duplicate`, which is what it is: space.
 *
 * A WRONG-SIZED COPY ON THE RIGHTFUL HOLDER COUNTS AS NEEDING IT. Whatever that
 * file is, it is not the one the archive recorded -- the same rule the missing
 * roll-up uses, pointing the same way: towards reporting the finding.
 * =========================================================================== */

export type MisplacedState = 'rescue' | 'duplicate' | 'unconfirmed' | 'unknown';

export interface MisplacedRow {
  name: string;
  /** Size on the machine that should not have it. */
  size: number;
  /** The region the NAME carries. Never null: that is what made it misplaced. */
  region: number;
  /** Where it sits on the machine it was found on, `/` separated. */
  relPath: string;
  base: string;
  verLabel: string;
  /** Machines carrying it that the allocation does not put it on. */
  foundOn: string[];
  /** Machines the allocation DOES put it on. */
  belongsOn: string[];
  /** Of those, the ones short of it -- absent, or carrying the wrong size. */
  needIt: string[];
  /** Of those, the ones that have a good copy. */
  haveIt: string[];
  /** Of those, the ones nobody read. */
  unknownOn: string[];
  /** What the archive says about the name, or null when it has never seen it. */
  archiveStatus: 'kept' | 'superseded' | 'unknown' | null;
  state: MisplacedState;
}

export interface MisplacedByRegion {
  region: number;
  holders: string[];
  files: number;
  bytes: number;
  /** Of those, how many a rightful holder is actually short of. */
  rescue: number;
}

export interface MisplacedRollup {
  rows: MisplacedRow[];
  counts: Record<MisplacedState, number>;
  bytes: Record<MisplacedState, number>;
  byRegion: MisplacedByRegion[];
  /** Rightful holders nobody read, so some of this cannot be classified. */
  unsurveyedHolders: string[];
  /** Everything here, however classified: space sitting on the wrong drive. */
  total: { files: number; bytes: number };
  clean: boolean;
}

/**
 * Roll every machine's `extraForeign` into one list for the rig.
 *
 * Pure, like `rollUpMissing`, and over the same inputs plus one: what the
 * ARCHIVE says about each name. Without that, a file the archive has never seen
 * would be classified as `duplicate` -- "the right machines already have it" --
 * on the strength of nobody having reported it missing, which is not evidence
 * of anything. `archiveStatusByName` covers the whole snapshot; a name absent
 * from it is a name the archive does not have.
 */
export function rollUpMisplaced(
  machines: readonly MissingSource[],
  regionHolders: ReadonlyMap<number, readonly string[]>,
  archiveStatusByName: ReadonlyMap<string, 'kept' | 'superseded' | 'unknown'> = new Map(),
): MisplacedRollup {
  /** What each machine we actually read had to say about a name. */
  const surveyed = new Map<
    string,
    { missing: Set<string>; wrongSize: Set<string>; hasSuperseded: Set<string> }
  >();
  for (const m of machines) {
    if (m.machineId === null || m.error !== null || !m.comparison) continue;
    surveyed.set(m.machineId, {
      missing: new Set([
        ...m.comparison.missingKept.map((f) => f.name),
        ...m.comparison.missingSuperseded.map((f) => f.name),
      ]),
      wrongSize: new Set(m.comparison.sizeMismatch.map((f) => f.name)),
      hasSuperseded: new Set(m.comparison.presentSuperseded.map((f) => f.name)),
    });
  }

  /** name -> the misplaced copies of it, collapsed across machines. */
  const found = new Map<string, { file: ForeignFile; on: string[] }>();
  for (const m of machines) {
    if (m.machineId === null || m.error !== null || !m.comparison) continue;
    for (const f of m.comparison.extraForeign) {
      const entry = found.get(f.name);
      if (entry) entry.on.push(m.machineId);
      else found.set(f.name, { file: f, on: [m.machineId] });
    }
  }

  const rows: MisplacedRow[] = [];
  for (const { file, on } of found.values()) {
    // `extraForeign` is defined by having a region, so this is never null; the
    // guard keeps the type honest rather than asserting.
    if (file.region === null) continue;
    const holders = [...(regionHolders.get(file.region) ?? [])].sort();
    const archiveStatus = archiveStatusByName.get(file.name) ?? null;

    const needIt: string[] = [];
    const haveIt: string[] = [];
    const unknownOn: string[] = [];
    for (const id of holders) {
      const said = surveyed.get(id);
      if (!said) unknownOn.push(id);
      else if (said.missing.has(file.name) || said.wrongSize.has(file.name)) needIt.push(id);
      else haveIt.push(id);
    }

    // A file the archive has replaced is not needed anywhere, however few
    // copies of it exist. A file the archive has never seen cannot be said to
    // be needed at all. Only a KEPT file can be a rescue.
    const rescuable = archiveStatus === 'kept';
    const state: MisplacedState =
      archiveStatus === null
        ? 'unknown'
        : rescuable && needIt.length > 0
          ? 'rescue'
          : unknownOn.length > 0
            ? 'unconfirmed'
            : 'duplicate';

    rows.push({
      name: file.name,
      size: file.size,
      region: file.region,
      relPath: file.relPath,
      base: file.base,
      verLabel: file.verLabel,
      foundOn: [...on].sort(),
      belongsOn: holders,
      needIt,
      haveIt,
      unknownOn,
      archiveStatus,
      state,
    });
  }

  // Worst first, then biggest first, exactly as the missing list orders itself.
  const rank: Record<MisplacedState, number> = { rescue: 0, unconfirmed: 1, unknown: 2, duplicate: 3 };
  rows.sort((a, b) => rank[a.state] - rank[b.state] || b.size - a.size || a.name.localeCompare(b.name));

  const counts: Record<MisplacedState, number> = { rescue: 0, duplicate: 0, unconfirmed: 0, unknown: 0 };
  const bytes: Record<MisplacedState, number> = { rescue: 0, duplicate: 0, unconfirmed: 0, unknown: 0 };
  const regions = new Map<number, MisplacedByRegion>();
  const unsurveyed = new Set<string>();
  for (const r of rows) {
    counts[r.state] += 1;
    bytes[r.state] += r.size;
    for (const id of r.unknownOn) unsurveyed.add(id);
    const entry = regions.get(r.region) ?? {
      region: r.region,
      holders: r.belongsOn,
      files: 0,
      bytes: 0,
      rescue: 0,
    };
    entry.files += 1;
    entry.bytes += r.size;
    if (r.state === 'rescue') entry.rescue += 1;
    regions.set(r.region, entry);
  }

  return {
    rows,
    counts,
    bytes,
    byRegion: [...regions.values()].sort(
      (a, b) => b.rescue - a.rescue || b.bytes - a.bytes || a.region - b.region,
    ),
    unsurveyedHolders: [...unsurveyed].sort(),
    total: {
      files: rows.length,
      bytes: rows.reduce((n, r) => n + r.size, 0),
    },
    clean: rows.length === 0,
  };
}

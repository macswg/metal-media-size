/**
 * =============================================================================
 *  THE PROGRAMMED-MEDIA CROSS-CHECK  --  parsing a d3 show-file capture
 * =============================================================================
 *
 * A capture exported from the d3 project (`programmed_media_crosscheck/*.json`)
 * lists every piece of media the SHOW ACTUALLY PLAYS. The archive's supersession
 * rules know which version is newest; they do not know which version is
 * programmed. Those are different questions, and the second one outranks the
 * first: a version the show is cued to play is not superseded by anything,
 * however many newer renders exist beside it.
 *
 * WHAT A CAPTURE SAYS, AND WHAT IT DOES NOT
 *
 * Each media entry carries a `name` and a `version`:
 *
 *   { "name": "110_engine_solo_fire_out_alpha_ll180.mov",
 *     "path": "objects/videoclip/110_engine/...",
 *     "version": "011", "regionSet": "12k-ll180-65deg" }
 *
 * The name is the archive's `base` in lower case, with no `_vNNN` and no
 * `_regionN`. The version is the archive's version, zero-padding aside, and it
 * CARRIES SUB-LETTERS (`005b`) -- so the cross-check is version-precise rather
 * than asset-wide. Measured on the real capture of 2026-09-08: of 1,699 media
 * references that matched an archive asset, 1,699 matched an existing version
 * EXACTLY, number and sub-letter both. Not one miss.
 *
 * That measurement is why this file parses `version` at all. If a future
 * capture starts disagreeing, `resolveProgrammed` reports it as
 * `versionNotInArchive` rather than quietly protecting nothing -- see the note
 * on failing loud in `protect.ts`.
 *
 * EVERY AMBIGUITY RESOLVES TOWARDS PROTECTION
 *
 * This module can only ever ADD protection, so the safe direction is always
 * "match more". A name that over-normalises onto the wrong asset protects a
 * version nobody needed to protect, which costs some reclaim. A name that fails
 * to match protects nothing, which is how a programmed master gets removed.
 * The two errors are not comparable and the code is not balanced between them:
 *
 *   - an entry with NO readable version protects the WHOLE asset;
 *   - a name that will not normalise is REPORTED, never dropped in silence.
 * =============================================================================
 */

/** One media reference from a show-file capture, normalised for matching. */
export interface ProgrammedRef {
  /** Archive `base` identity, lower-cased and stripped. Match key. */
  base: string;
  /**
   * Archive version number, or null when the capture named none -- in which
   * case EVERY version of the asset is protected. Null is the loud reading:
   * "the show plays this asset and we cannot tell which render".
   */
  verNum: number | null;
  /** Sub-letter, part of the version identity: `v002` and `v002d` differ. */
  subLetter: string | null;
  /** The name exactly as the show file wrote it. Reporting only. */
  rawName: string;
  /** The version string exactly as written (`003`, `0003`, `005b`). */
  rawVersion: string | null;
  /** Track the reference was found on, for the operator's own reporting. */
  trackName: string | null;
  /**
   * The track's id in the capture -- its name, disambiguated where two tracks
   * share one. This is the key the track filter and the drill-down use, so a
   * name two tracks share cannot merge them.
   */
  trackId: string | null;
  /**
   * Setlists the track is on, by name. Every track in a capture is on at least
   * one -- the top-level `tracks` array is the union of what the setlists
   * reference -- but an older capture with no `transports` block leaves this
   * empty, and that is reported as "setlist unknown", never as "on none".
   */
  setlists: string[];
}

/** One setlist in a capture, as the transport that plays it names it. */
export interface ProgrammedSetlist {
  setlist: string;
  /** Transport the setlist is loaded on (`show_a`, `editor`). */
  transport: string | null;
  /** Track ids, in running order. */
  trackIds: string[];
}

/** A whole capture file, parsed. */
export interface ProgrammedCapture {
  /** File it came from, for the banner and the UI. */
  sourceFile: string;
  /**
   * Absolute path of that file, set by the loader -- where the project being
   * analysed actually sits. Absent on a capture parsed from memory (tests).
   */
  location?: string;
  /** `capturedAt` from the file. A capture is a POINT IN TIME -- see below. */
  capturedAt: string | null;
  project: string | null;
  schemaVersion: number | null;
  /** Every media reference, in file order. Duplicates are kept. */
  refs: ProgrammedRef[];
  /** Setlists the capture's transports carry. Empty on a capture without them. */
  setlists: ProgrammedSetlist[];
  /**
   * What the file was. A Susan summary is the plugin's export; a d3 project is
   * the `.d3` archive itself, read by `src/programmed/d3.ts`. Both reach this
   * shape through the same parser.
   */
  kind: 'summary' | 'project';
  /**
   * Where `capturedAt` came from. A summary states its own capture time; a
   * `.d3` archive does not, so its date is the file's modification time -- when
   * the project was last saved, or when it was copied by something that does
   * not preserve dates. Carried so no banner calls a file date a capture date.
   */
  capturedAtSource: 'capture' | 'file-mtime';
  /**
   * Things the extractor could not resolve -- a track or media resource the
   * archive names but does not hold. Each one is a reference that protects
   * less than it should, so they are printed at startup, never dropped.
   */
  warnings: string[];
}

/**
 * Trailing edit markers a d3 layer name carries that the archive filename does
 * not: a frame pick (` f23`, `_f755`, `_f0`) or a hand-named trim.
 *
 * These are stripped so the reference still finds its asset. Stripping is the
 * generous direction and that is deliberate: were `640_slot_outro_0000b_ll180
 * start` left unmatched, the asset behind it would be unprotected.
 */
const EDIT_MARKER = /[ _](?:f\d+|trim|hold|start)$/;

/** Container extensions a capture may carry. Stripped to reach the base. */
const EXTENSION = /\.(?:mov|mp4|mxf|png|jpg|jpeg|tif|tiff|exr)$/;

/**
 * Reduce a show-file media name to an archive `base`.
 *
 * Markers and extensions are stripped REPEATEDLY and in either order, because
 * the real capture writes them both ways round:
 *
 *   `120_liquid_cue_a_ll180_f755`                  -> marker last
 *   `540_amps_..._loop_ll180.mov hold`             -> extension in the middle
 *
 * A single pass in a fixed order gets the second one wrong and silently fails
 * to match a programmed asset, so this loops to a fixed point.
 */
export function normaliseProgrammedName(name: string): string {
  let s = name.trim().toLowerCase();
  for (;;) {
    const before = s;
    s = s.replace(EXTENSION, '').replace(EDIT_MARKER, '').trim();
    if (s === before) return s;
  }
}

/**
 * Parse a d3 version string into the archive's `(number, letter)` identity.
 *
 * Widths vary between captures (`003` and `0003` both occur in one file), so
 * leading zeros are insignificant. The sub-letter is not: `v002` and `v002d`
 * are two different versions, which is why this returns the pair rather than a
 * number. Returns null for anything unreadable -- the caller protects the whole
 * asset in that case.
 */
export function parseProgrammedVersion(
  raw: string | null | undefined,
): { verNum: number; subLetter: string | null } | null {
  if (typeof raw !== 'string') return null;
  const m = /^0*(\d+)([a-z]?)$/.exec(raw.trim().toLowerCase());
  if (!m) return null;
  return { verNum: Number(m[1]), subLetter: m[2] ? (m[2] as string) : null };
}

/** Shape of the bits of a capture this module reads. Everything else ignored. */
interface RawLayer {
  media?: Array<{ name?: unknown; version?: unknown }> | null;
  layers?: RawLayer[] | null;
}

/**
 * Parse a capture's JSON text.
 *
 * Throws on anything it cannot read. THAT IS THE POINT: a capture that half
 * parses would protect half of what the show plays, and the half it missed
 * would go into a removal manifest looking exactly like ordinary superseded
 * media. Callers are expected to refuse to export rather than continue.
 */
export function parseProgrammedCapture(text: string, sourceFile: string): ProgrammedCapture {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Programmed-media capture ${sourceFile} is not readable JSON: ${(e as Error).message}. ` +
        'Refusing to treat it as an empty list -- an unreadable capture protects nothing, ' +
        'which is indistinguishable from a show that plays nothing.',
    );
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`Programmed-media capture ${sourceFile} is not a JSON object.`);
  }
  const d = doc as Record<string, unknown>;
  if (!Array.isArray(d.tracks)) {
    throw new Error(
      `Programmed-media capture ${sourceFile} has no "tracks" array. This does not look ` +
        'like a d3 show-file capture; refusing to read it as one.',
    );
  }

  const refs: ProgrammedRef[] = [];
  const walk = (layers: RawLayer[] | null | undefined, trackName: string | null): void => {
    for (const layer of layers ?? []) {
      if (layer === null || typeof layer !== 'object') continue;
      for (const m of layer.media ?? []) {
        if (m === null || typeof m !== 'object') continue;
        if (typeof m.name !== 'string' || m.name.trim() === '') continue;
        const base = normaliseProgrammedName(m.name);
        if (base === '') continue;
        const v = parseProgrammedVersion(
          typeof m.version === 'string' ? m.version : null,
        );
        refs.push({
          base,
          verNum: v ? v.verNum : null,
          subLetter: v ? v.subLetter : null,
          rawName: m.name,
          rawVersion: typeof m.version === 'string' ? m.version : null,
          trackName,
          // Filled in by the caller, which knows the track's id and setlists.
          trackId: null,
          setlists: [],
        });
      }
      // Nested groups. The real capture is flat today; a nested one that went
      // unwalked would silently under-protect, so this recurses regardless.
      if (Array.isArray(layer.layers)) walk(layer.layers, trackName);
    }
  };

  // Setlists first, so every reference can say which setlists its track is on.
  // `trackRefs` names track ids (schema 5 and later); a capture without a
  // `transports` block simply has no setlists to report.
  const setlists: ProgrammedSetlist[] = [];
  const setlistsOfTrack = new Map<string, string[]>();
  for (const t of Array.isArray(d.transports) ? (d.transports as unknown[]) : []) {
    if (t === null || typeof t !== 'object') continue;
    const tr = t as { name?: unknown; setlist?: unknown; trackRefs?: unknown };
    if (typeof tr.setlist !== 'string' || tr.setlist === '') continue;
    const trackIds = Array.isArray(tr.trackRefs)
      ? tr.trackRefs.filter((x): x is string => typeof x === 'string')
      : [];
    setlists.push({
      setlist: tr.setlist,
      transport: typeof tr.name === 'string' ? tr.name : null,
      trackIds,
    });
    for (const id of trackIds) {
      const list = setlistsOfTrack.get(id) ?? [];
      if (!list.includes(tr.setlist)) list.push(tr.setlist);
      setlistsOfTrack.set(id, list);
    }
  }

  for (const t of d.tracks as unknown[]) {
    if (t === null || typeof t !== 'object') continue;
    const track = t as { id?: unknown; name?: unknown; layers?: RawLayer[] | null };
    const trackName = typeof track.name === 'string' ? track.name : null;
    const trackId = typeof track.id === 'string' ? track.id : trackName;
    const before = refs.length;
    walk(track.layers, trackName);
    const onSetlists = trackId === null ? [] : (setlistsOfTrack.get(trackId) ?? []);
    for (let i = before; i < refs.length; i += 1) {
      const ref = refs[i] as ProgrammedRef;
      ref.trackId = trackId;
      ref.setlists = [...onSetlists];
    }
  }

  return {
    sourceFile,
    capturedAt: typeof d.capturedAt === 'string' ? d.capturedAt : null,
    project: typeof d.project === 'string' ? d.project : null,
    schemaVersion: typeof d.schemaVersion === 'number' ? d.schemaVersion : null,
    refs,
    setlists,
    kind: 'summary',
    capturedAtSource: 'capture',
    warnings: [],
  };
}

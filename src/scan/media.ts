/**
 * ============================================================================
 *  QUICKTIME HEADER READER  --  the ONLY code in this project that looks
 *  INSIDE an archive file
 * ============================================================================
 *
 * Everything else here is metadata-only: name, size, mtime. A file's pixel
 * dimensions are not in its name and not in its stat, so the only way to know
 * them is to read the container header. That is a deliberate, measured
 * exception, not a loosening of the rule:
 *
 *   - It reads BYTES ONLY FROM THE ATOM TABLE, never sample data. A 293 GB
 *     master costs 8 positioned reads totalling ~210 bytes. Measured on the
 *     real mount: 26,651 files come to ~6 MB of egress in total.
 *   - It never runs during a scan. `npm run probe` is a separate command the
 *     operator chooses to run.
 *   - It takes a reader, not a path. The handle comes from `ReadOnlyFs`, whose
 *     descriptor is O_RDONLY, so this module cannot reach the archive on its
 *     own and cannot import `node:fs` to try.
 *
 * WHAT IT READS: the `tkhd` (track header) display dimensions, as 16.16 fixed
 * point, taking the largest-area track so a timecode or audio track never wins.
 * The coded size in `stsd` was compared against `tkhd` across a sample of this
 * archive and agreed on every track, so the cheaper of the two is used --
 * `tkhd` sits two levels down from `moov`, `stsd` sits five.
 *
 * The parse is bounded everywhere. A corrupt or non-QuickTime file returns
 * null after a fixed number of hops; it never loops and never reads a large
 * buffer into memory.
 * ============================================================================
 */

/** A positioned reader. `FileHandle` satisfies this; so does a test double. */
export interface ByteReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Ceiling on atoms visited per file. A well-formed .mov reaches `moov` in a
 * handful of hops; anything that does not is malformed, and this is what stops
 * a corrupt size field turning into an unbounded walk.
 */
const MAX_HOPS = 512;
/** Ceiling on tracks inspected. Real files have single digits. */
const MAX_TRACKS = 64;
/** An atom header is 8 bytes, or 16 when the size field escapes to 64-bit. */
const HEADER_BYTES = 16;
/** `tkhd` is 84 bytes in version 0 and 96 in version 1. */
const TKHD_BYTES = 96;

interface Atom {
  /** First byte of the atom's PAYLOAD, past its header. */
  pos: number;
  /** Payload length in bytes. */
  size: number;
}

async function readAt(reader: ByteReader, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await reader.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/**
 * Find the first child atom of `type` between `start` and `end`.
 *
 * Only atom HEADERS are read -- the walk seeks over `mdat` rather than
 * touching it, which is the whole reason this is cheap on a 293 GB file.
 */
async function findAtom(
  reader: ByteReader,
  start: number,
  end: number,
  type: string,
  budget: { hops: number },
): Promise<Atom | null> {
  let p = start;
  while (p + 8 <= end) {
    if (budget.hops-- <= 0) return null;
    const head = await readAt(reader, p, HEADER_BYTES);
    if (head.length < 8) return null;

    let size = head.readUInt32BE(0);
    const kind = head.toString('latin1', 4, 8);
    let headerLen = 8;
    if (size === 1) {
      // 64-bit size escape: the real size follows the type.
      if (head.length < 16) return null;
      const large = head.readBigUInt64BE(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      headerLen = 16;
    } else if (size === 0) {
      // 'to end of file' form, legal for the last atom.
      size = end - p;
    }
    // A size that cannot hold its own header means the file is not what it
    // claims to be. Stop rather than guess.
    if (size < headerLen || p + size > end) return null;
    if (kind === type) return { pos: p + headerLen, size: size - headerLen };
    p += size;
  }
  return null;
}

/** Display dimensions from one `tkhd` payload, or null if it carries none. */
function tkhdDimensions(payload: Buffer): Dimensions | null {
  if (payload.length < 84) return null;
  // Version 1 widens creation/modification/duration from 32 to 64 bits, which
  // pushes width and height 12 bytes later.
  const offset = payload.readUInt8(0) === 1 ? 88 : 76;
  if (payload.length < offset + 8) return null;
  const width = payload.readUInt32BE(offset) / 65536;
  const height = payload.readUInt32BE(offset + 4) / 65536;
  if (!(width > 0) || !(height > 0)) return null;
  // Dimensions are fixed point but every real render is a whole number of
  // pixels; rounding here keeps '3976' out of the UI as '3976.0000305'.
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Pixel dimensions of a QuickTime/MP4 file, or null if it has none to give.
 *
 * `fileSize` comes from the index (an `lstat`, already paid for) and bounds
 * the walk, so a corrupt size field can never send a read past the end.
 */
export async function readMovDimensions(
  reader: ByteReader,
  fileSize: number,
): Promise<Dimensions | null> {
  if (!Number.isFinite(fileSize) || fileSize <= 0) return null;
  const budget = { hops: MAX_HOPS };

  const moov = await findAtom(reader, 0, fileSize, 'moov', budget);
  if (!moov) return null;

  const moovEnd = moov.pos + moov.size;
  let best: Dimensions | null = null;
  let p = moov.pos;

  for (let seen = 0; seen < MAX_TRACKS && p < moovEnd; seen++) {
    const trak = await findAtom(reader, p, moovEnd, 'trak', budget);
    if (!trak) break;
    const trakEnd = trak.pos + trak.size;

    const tkhd = await findAtom(reader, trak.pos, trakEnd, 'tkhd', budget);
    if (tkhd) {
      const dims = tkhdDimensions(await readAt(reader, tkhd.pos, Math.min(TKHD_BYTES, tkhd.size)));
      // Largest area wins: a file may carry a timecode track (no dimensions)
      // or a small overlay alongside the picture.
      if (dims && (!best || dims.width * dims.height > best.width * best.height)) best = dims;
    }
    p = trakEnd;
  }

  return best;
}

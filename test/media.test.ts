/**
 * ============================================================================
 *  QUICKTIME HEADER READER
 * ============================================================================
 *
 * These build .mov headers by hand rather than shipping a binary fixture, so
 * every byte the parser depends on is visible in the test. No file is opened:
 * the reader takes a `ByteReader`, and the double here counts its reads --
 * which is how the 'never touches sample data' claim is asserted rather than
 * asserted-in-a-comment.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { readMovDimensions, type ByteReader } from '../src/scan/media.ts';

/** A reader over a Buffer that records what was read. */
class BufferReader implements ByteReader {
  readonly reads: { pos: number; len: number }[] = [];
  constructor(private readonly data: Buffer) {}

  async read(buffer: Buffer, offset: number, length: number, position: number) {
    this.reads.push({ pos: position, len: length });
    const end = Math.min(position + length, this.data.length);
    if (position >= this.data.length) return { bytesRead: 0 };
    const n = this.data.copy(buffer, offset, position, end);
    return { bytesRead: n };
  }

  get bytesRead(): number {
    return this.reads.length;
  }
}

function atom(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

/** A v0 track header carrying the given display dimensions. */
function tkhd(width: number, height: number, version = 0): Buffer {
  const payload = Buffer.alloc(version === 1 ? 96 : 84);
  payload.writeUInt8(version, 0);
  const offset = version === 1 ? 88 : 76;
  payload.writeUInt32BE(Math.round(width * 65536), offset);
  payload.writeUInt32BE(Math.round(height * 65536), offset + 4);
  return atom('tkhd', payload);
}

function trak(...children: Buffer[]): Buffer {
  return atom('trak', Buffer.concat(children));
}

/** A whole file: ftyp, a huge mdat, then moov -- the shape a renderer writes. */
function movie(opts: { mdatBytes: number; moov: Buffer | null; moovFirst?: boolean }): Buffer {
  const ftyp = atom('ftyp', Buffer.from('qt  20050300qt  ', 'latin1'));
  const mdat = atom('mdat', Buffer.alloc(opts.mdatBytes));
  const parts = opts.moov
    ? opts.moovFirst
      ? [ftyp, opts.moov, mdat]
      : [ftyp, mdat, opts.moov]
    : [ftyp, mdat];
  return Buffer.concat(parts);
}

describe('readMovDimensions', () => {
  it('reads display dimensions from the track header', async () => {
    const buf = movie({ mdatBytes: 4096, moov: atom('moov', trak(tkhd(8996, 2584))) });
    const r = new BufferReader(buf);
    expect(await readMovDimensions(r, buf.length)).toEqual({ width: 8996, height: 2584 });
  });

  it('handles a version 1 track header, where width sits 12 bytes later', async () => {
    const buf = movie({ mdatBytes: 64, moov: atom('moov', trak(tkhd(3976, 3248, 1))) });
    expect(await readMovDimensions(new BufferReader(buf), buf.length)).toEqual({
      width: 3976,
      height: 3248,
    });
  });

  /**
   * The whole reason this is cheap on a 293 GB master: the walk SEEKS OVER
   * mdat. If a change ever made it read the payload, this is what catches it.
   */
  it('never reads sample data, whatever the size of it', async () => {
    const buf = movie({ mdatBytes: 1_000_000, moov: atom('moov', trak(tkhd(1500, 1500))) });
    const r = new BufferReader(buf);
    await readMovDimensions(r, buf.length);

    const total = r.reads.reduce((n, x) => n + x.len, 0);
    expect(total).toBeLessThan(400);
    // No read may start inside the mdat payload. mdat's header is at 24.
    const mdatStart = 24 + 8;
    const mdatEnd = mdatStart + 1_000_000;
    for (const read of r.reads) {
      expect(read.pos < mdatStart || read.pos >= mdatEnd).toBe(true);
    }
  });

  it('takes the largest track, so a timecode track never wins', async () => {
    const moov = atom(
      'moov',
      Buffer.concat([trak(tkhd(0, 0)), trak(tkhd(8996, 2584)), trak(tkhd(64, 64))]),
    );
    const buf = movie({ mdatBytes: 128, moov });
    expect(await readMovDimensions(new BufferReader(buf), buf.length)).toEqual({
      width: 8996,
      height: 2584,
    });
  });

  /**
   * The real find: `180_NIGHTLIGHT_LAYOUT_LL180_v003_region5.mov` is 140 GB of
   * mdat running to the last byte, with no moov at all -- a render that was
   * interrupted before its header was written. It must report nothing rather
   * than guessing, and must not hang looking for an atom that is not there.
   */
  it('returns null for a file whose header atom was never written', async () => {
    const buf = movie({ mdatBytes: 8192, moov: null });
    expect(await readMovDimensions(new BufferReader(buf), buf.length)).toBeNull();
  });

  it('reads a moov written before the media data', async () => {
    const buf = movie({ mdatBytes: 512, moov: atom('moov', trak(tkhd(1740, 3288))), moovFirst: true });
    expect(await readMovDimensions(new BufferReader(buf), buf.length)).toEqual({
      width: 1740,
      height: 3288,
    });
  });

  it('gives up on a truncated atom size rather than walking backwards', async () => {
    // An atom claiming size 2 cannot even hold its own header.
    const bad = Buffer.alloc(16);
    bad.writeUInt32BE(2, 0);
    bad.write('junk', 4, 'latin1');
    expect(await readMovDimensions(new BufferReader(bad), bad.length)).toBeNull();
  });

  it('is bounded when every atom claims zero forward progress', async () => {
    // size 8 with no payload: legal, and infinite if the walk forgot to stop.
    const parts = Array.from({ length: 4000 }, () => atom('free', Buffer.alloc(0)));
    const buf = Buffer.concat(parts);
    const r = new BufferReader(buf);
    expect(await readMovDimensions(r, buf.length)).toBeNull();
    // The hop budget, not the file, is what ended it.
    expect(r.reads.length).toBeLessThanOrEqual(513);
  });

  it('refuses a nonsense file size instead of reading at a negative offset', async () => {
    const buf = movie({ mdatBytes: 16, moov: atom('moov', trak(tkhd(100, 100))) });
    expect(await readMovDimensions(new BufferReader(buf), 0)).toBeNull();
    expect(await readMovDimensions(new BufferReader(buf), Number.NaN)).toBeNull();
  });

  it('reports nothing for a track with zero dimensions', async () => {
    const buf = movie({ mdatBytes: 32, moov: atom('moov', trak(tkhd(0, 0))) });
    expect(await readMovDimensions(new BufferReader(buf), buf.length)).toBeNull();
  });
});

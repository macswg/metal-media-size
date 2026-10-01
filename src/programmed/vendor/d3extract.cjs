/* Build a susan_summary snapshot from a disguise Designer .d3 project archive,
 * in the browser (or Node). A line-for-line port of d3_extract.py -- keep the
 * two in step; FORMAT.md documents the format both rely on.
 *
 *   D3Extract.buildSnapshot(arrayBuffer, {project, capturedAt, fileName})
 *     -> snapshot object
 *   D3Extract.toJson(snapshot)
 *     -> the text d3_extract.py writes (Python json.dumps, indent 2, sorted keys),
 *        so a browser export and a command-line export are byte-identical.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.D3Extract = factory();
})(this, function () {
  'use strict';

  var SCHEMA_VERSION = 7;
  var AUTOMATIC_SETLIST_PATH = 'objects/setlist/automatic.apx';
  var TRACK_ROOT = 'objects/track';
  var DIRECTOR_STATE = 'internal/localstate/_directorstate_.apx';
  var FPS_BY_CLOCK = { 0: 23.976, 1: 24.0, 2: 25.0, 3: 29.97, 4: 29.97, 5: 30.0 };
  var TAG_NAMES = { 0: 'tc', 1: 'cue', 2: 'midi' };
  var TAG_TC = 0;
  var KEYFRAMES_FORMAT_VERSION = 3;
  // Exported even with a single key -- see CDL_VALUE_TYPE in d3_extract.py.
  var CDL_VALUE_TYPE = 'CDL::RP';
  // Inferred, not confirmed in Designer -- see INTERPOLATION in d3_extract.py.
  var INTERPOLATION = { 0: 'step', 1: 'smooth', 2: 'linear' };
  var OBJECT_MAGIC = [0x72, 0x19, 0x04, 0x07];

  var utf8 = new TextDecoder('utf-8');
  var latin1 = new TextDecoder('latin1');

  function ParseError(message) {
    this.name = 'ParseError';
    this.message = message;
  }
  ParseError.prototype = Object.create(Error.prototype);

  // --- numbers ---------------------------------------------------------------

  /* Exact decimal rounding of a double, half away from zero -- what Python's
   * Decimal(x).quantize(..., ROUND_HALF_UP) does, which in turn is what the
   * plugin's Python 2 round() produced. Multiplying by 1e6 in floating point
   * is not exact and splits values like 1476.0078125 the other way. */
  var f64buf = new DataView(new ArrayBuffer(8));
  function roundHalfAway(x, places) {
    if (!isFinite(x) || x === 0) return x;
    f64buf.setFloat64(0, x);
    var hi = f64buf.getUint32(0), lo = f64buf.getUint32(4);
    var neg = hi >>> 31, exp = (hi >>> 20) & 0x7ff;
    var mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    if (exp === 0) exp = 1; else mant |= 1n << 52n;
    var e = exp - 1075;                       // x = mant * 2^e
    var scaled = mant * 10n ** BigInt(places);
    var q;
    if (e >= 0) {
      q = scaled << BigInt(e);
    } else {
      var div = 1n << BigInt(-e);
      q = scaled / div;
      if ((scaled % div) * 2n >= div) q += 1n;
    }
    var digits = q.toString();
    if (places > 0) {
      digits = digits.padStart(places + 1, '0');
      digits = digits.slice(0, -places) + '.' + digits.slice(-places);
    }
    return parseFloat((neg ? '-' : '') + digits);
  }

  function num(value) {
    return value === null || value === undefined ? null : roundHalfAway(value, 6);
  }

  // --- container -------------------------------------------------------------

  function Archive(buffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    var b = this.bytes, v = this.view;
    var magic = [0x72, 0x19, 0x04, 0x07, 0x62, 0x6c, 0x69, 0x70]; // r\x19\x04\x07blip
    for (var m = 0; m < 8; m++) {
      if (b[m] !== magic[m]) throw new ParseError('not a d3 project archive');
    }
    this.entries = new Map();
    this.folded = new Map();
    // A record starting `----` is a dead copy: Designer saves a change by
    // appending a new copy of the resource and marking the old one dead in
    // place. Stepped over like a live record, never indexed; `dead` counts them.
    this.dead = 0;
    var off = 12, size = b.length;
    while (off < size) {
      var mark = off + 32 > size ? -1 : b[off];
      if ((mark !== 42 && mark !== 45) || b[off + 1] !== mark || b[off + 2] !== mark || b[off + 3] !== mark) {
        throw new ParseError('archive record out of sync at 0x' + off.toString(16));
      }
      var total = v.getUint32(off + 4, true), plen = v.getUint32(off + 8, true);
      var nlen = v.getUint32(off + 28, true);
      if (off + total > size || 32 + nlen + plen > total) {
        throw new ParseError('archive truncated or corrupt at 0x' + off.toString(16) +
                             ' (incomplete download or copy?)');
      }
      if (mark === 45) {
        this.dead++;
        off += total;
        continue;
      }
      var name = utf8.decode(b.subarray(off + 32, off + 32 + nlen));
      this.entries.set(name, [off + 32 + nlen, plen]);
      off += total;
    }
    // Designer resource paths are case-insensitive: a setlist can reference
    // 200_song_ABC.apx for the file stored as 200_song_abc.apx.
    var self = this;
    this.entries.forEach(function (_, n) { self.folded.set(n.toLowerCase(), n); });
  }

  Archive.prototype.resolve = function (name) {
    if (this.entries.has(name)) return name;
    var hit = this.folded.get(name.replace(/\\/g, '/').toLowerCase());
    return hit === undefined ? null : hit;
  };
  Archive.prototype.has = function (name) { return this.resolve(name) !== null; };
  Archive.prototype.read = function (name) {
    var e = this.entries.get(this.resolve(name));
    return this.bytes.subarray(e[0], e[0] + e[1]);
  };
  Archive.prototype.names = function (prefix) {
    var out = [];
    this.entries.forEach(function (_, n) { if (n.startsWith(prefix)) out.push(n); });
    return out;
  };

  // --- object serialisation --------------------------------------------------

  function Reader(bytes, name) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.i = 0;
    this.name = name || '';
  }

  Reader.prototype.u8 = function () { return this.b[this.i++]; };
  Reader.prototype.u32 = function () { var x = this.v.getUint32(this.i, true); this.i += 4; return x; };
  Reader.prototype.f32 = function () { var x = this.v.getFloat32(this.i, true); this.i += 4; return x; };
  Reader.prototype.f64 = function () { var x = this.v.getFloat64(this.i, true); this.i += 8; return x; };
  Reader.prototype.skip = function (n) { this.i += n; };
  Reader.prototype.cstr = function () {
    var j = this.b.indexOf(0, this.i);
    if (j < 0) this.fail('unterminated string');
    var s = utf8.decode(this.b.subarray(this.i, j));
    this.i = j + 1;
    return s;
  };
  Reader.prototype.peekCstr = function () {
    var j = this.b.indexOf(0, this.i);
    return j < 0 ? '' : utf8.decode(this.b.subarray(this.i, j));
  };
  Reader.prototype.atEnd = function () { return this.i >= this.b.length; };
  Reader.prototype.fail = function (msg) {
    throw new ParseError(this.name + ' @0x' + this.i.toString(16) + ': ' + msg);
  };
  Reader.prototype.expect = function (text) {
    var got = this.cstr();
    if (got !== text) this.fail('expected ' + JSON.stringify(text) + ', got ' + JSON.stringify(got));
  };
  Reader.prototype.section = function (name) { this.expect(name); return this.u32(); };
  Reader.prototype.objectHead = function (cls) {
    var head = this.cstr();
    var at = head.indexOf('_UID_');
    if (at < 0) this.fail('expected an object, got ' + JSON.stringify(head));
    var gotCls = head.slice(0, at), uid = head.slice(at + 5);
    if (cls && gotCls !== cls) this.fail('expected ' + cls + ', got ' + gotCls);
    var version = this.section('Resource');
    if (version !== 9) this.fail('unsupported Resource version ' + version);
    this.skip(8 + 4 + 1 + 8);
    for (var n = this.u32(); n > 0; n--) { this.skip(4); this.cstr(); }
    return [gotCls, uid];
  };
  Reader.prototype.openObject = function () {
    for (var k = 0; k < 4; k++) if (this.b[k] !== OBJECT_MAGIC[k]) this.fail('missing object magic');
    this.skip(8);
  };

  function stem(path) {
    var base = path.replace(/\\/g, '/').split('/').pop();
    return base.endsWith('.apx') ? base.slice(0, -4) : base;
  }

  function indexOfBytes(bytes, needle, from) {
    var first = needle[0], last = bytes.length - needle.length;
    for (var i = bytes.indexOf(first, from); i >= 0 && i <= last; i = bytes.indexOf(first, i + 1)) {
      var k = 1;
      while (k < needle.length && bytes[i + k] === needle[k]) k++;
      if (k === needle.length) return i;
    }
    return -1;
  }

  function ascii(text) {
    var out = new Uint8Array(text.length);
    for (var k = 0; k < text.length; k++) out[k] = text.charCodeAt(k);
    return out;
  }

  /* Printable ASCII runs of 4+ followed by NUL -- the resource paths inside an
   * object, same as _cstrings in d3_extract.py. */
  function cstrings(bytes) {
    var out = [], start = -1;
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes[i];
      if (c >= 0x20 && c <= 0x7e) {
        if (start < 0) start = i;
      } else {
        if (c === 0 && start >= 0 && i - start >= 4) out.push(latin1.decode(bytes.subarray(start, i)));
        start = -1;
      }
    }
    return out;
  }

  // --- tracks ------------------------------------------------------------------

  var FIELD_SEQUENCE_UID = ascii('FieldSequence_UID_');

  function readArrows(r) {
    for (var n = r.u32(); n > 0; n--) {
      r.objectHead('Arrow');
      r.section('Arrow');
      r.skip(16);
    }
  }

  function readOptionalObject(r) {
    if (r.peekCstr() === 'null') { r.cstr(); return null; }
    var cls = r.objectHead()[0];
    if (cls !== 'Expression') r.fail('unexpected object ' + cls + ' in sequence');
    r.section('Expression');
    var expression = r.cstr();
    r.skip(4 + 1);
    return expression;
  }

  function readSequence(r) {
    var cls = r.objectHead()[0];
    r.section('KeyContainer');
    r.section('KeySequence');
    r.skip(4);
    r.section(cls);
    var keys = [];
    for (var n = r.u32(); n > 0; n--) {
      if (cls === 'ResourceSequence') r.cstr();
      else if (cls !== 'FloatSequence' && cls !== 'StringSequence') r.fail('unsupported sequence ' + cls);
      r.skip(8);
      var t = r.f64();
      var interp = r.u8();
      r.skip(2);
      keys.push([t, cls === 'FloatSequence' ? r.f32() : r.cstr(), interp]);
    }
    r.cstr();
    var expression = readOptionalObject(r);
    readOptionalObject(r);
    r.skip(1);
    var def = cls === 'FloatSequence' ? r.f32() : r.cstr();
    // Display label: on a Notch layer, the exposed parameter's name.
    var label = r.cstr();
    return { cls: cls, keys: keys, expression: expression, default: def, label: label };
  }

  function readFieldSequence(r) {
    r.objectHead('FieldSequence');
    r.section('FieldSequence');
    var name = r.cstr();
    var valueType = r.cstr();
    var field = readSequence(r);
    field.name = name;
    field.valueType = valueType;
    return field;
  }

  /* Returns the resource paths the config names (a Notch layer's block). */
  function skipModuleConfig(r) {
    if (r.peekCstr() === 'null') { r.cstr(); return []; }
    var j = indexOfBytes(r.b, FIELD_SEQUENCE_UID, r.i);
    if (j < 0) r.fail('no field sequences after module config');
    var paths = cstrings(r.b.subarray(r.i, j - 4)).filter(function (x) { return x.startsWith('objects/'); });
    r.i = j - 4;
    return paths;
  }

  function readLayer(r, groupPath, out) {
    var head = r.objectHead(), cls = head[0], uid = head[1];
    r.section('SuperLayer');
    var name = r.cstr();
    var tStart = r.f64();
    var duration = r.f64();
    r.skip(8);
    var renderEnable = r.u8() !== 0;
    r.skip(2);

    if (cls === 'GroupLayer') {
      r.section('GroupLayer');
      for (var c = r.u32(); c > 0; c--) readLayer(r, groupPath.concat([name]), out);
      readArrows(r);
      return;
    }
    if (cls !== 'Layer') r.fail('unsupported layer class ' + cls);

    r.section('Layer');
    r.skip(8);
    for (var nb = r.u32(); nb > 0; nb--) { r.cstr(); r.skip(4); }
    var module = r.cstr();
    var configPaths = skipModuleConfig(r);
    var fields = [];
    for (var nf = r.u32(); nf > 0; nf--) fields.push(readFieldSequence(r));
    r.skip(1);
    if (r.peekCstr() === 'null') {
      r.cstr();
    } else {
      r.objectHead('DmxPatch');
      r.section('ControlPatch');
      r.cstr();
      r.section('DmxPatch');
      r.skip(20);
    }
    for (var k = 0; k < 2; k++) r.skip(4 * r.u32());
    r.skip(4);

    out.push({
      name: name, uid: uid, type: module || 'Layer', groupPath: groupPath.slice(),
      renderEnable: renderEnable, tStart: tStart, tEnd: tStart + duration, fields: fields,
      notchBlock: configPaths.find(function (x) { return x.startsWith('objects/notchfile/'); }) || null
    });
  }

  function parseTrack(bytes, path) {
    var r = new Reader(bytes, path);
    r.openObject();
    r.objectHead('Track');
    r.section('SuperTrack');
    var layers = [];
    for (var n = r.u32(); n > 0; n--) readLayer(r, [], layers);
    r.skip(8);
    readArrows(r);
    var bpm = r.f32();
    r.skip(4);
    r.cstr();
    r.skip(8);
    var lengthSec = r.f64();
    r.f64();
    r.f64();
    r.skip(8);
    r.cstr();
    r.section('Track');
    r.skip(17);
    r.cstr();
    r.skip(20);
    r.cstr();
    r.skip(9);
    var cues = [];
    for (var c = r.u32(); c > 0; c--) cues.push([r.f64(), r.cstr()]);
    if (!r.atEnd()) r.fail((r.b.length - r.i) + ' unread bytes at end of track');
    return { layers: layers, bpm: bpm, lengthInSec: lengthSec, cues: cues };
  }

  function parseCue(bytes, path) {
    var r = new Reader(bytes, path);
    r.openObject();
    r.objectHead('Cue');
    r.section('Cue');
    var note = r.cstr();
    var tags = {};
    for (var n = r.u32(); n > 0; n--) {
      var type = r.u32();
      r.skip(4);
      var text = r.cstr();
      if (!(type in tags)) tags[type] = text;
    }
    return { note: note, tags: tags, section: r.u8() !== 0 };
  }

  // --- media -------------------------------------------------------------------

  var VIDEO_FRAGMENT = ascii('VideoFragment\0\x04\0\0\0');

  function parseVideoAsset(bytes, path) {
    var r = new Reader(bytes, path);
    r.openObject();
    r.objectHead('VideoAsset');
    r.section('VideoAsset');
    r.skip(16);
    var hasAudio = r.u8() !== 0;
    var version = null, regionSet = null;
    // Fragments: `VideoFragment\0 u32(4) 8 bytes version\0 region\0 usable-flag`,
    // newest version first. Enabled version = first one flagged usable.
    for (var i = indexOfBytes(bytes, VIDEO_FRAGMENT, r.i); i >= 0 && version === null;
         i = indexOfBytes(bytes, VIDEO_FRAGMENT, i + 1)) {
      var p = i + VIDEO_FRAGMENT.length + 8;
      var vEnd = bytes.indexOf(0, p);
      var rEnd = bytes.indexOf(0, vEnd + 1);
      if (vEnd < 0 || rEnd < 0) break;
      if (bytes[rEnd + 1] === 1) version = utf8.decode(bytes.subarray(p, vEnd));
    }
    cstrings(bytes).forEach(function (s) {
      if (s.startsWith('objects/videoregionset/')) regionSet = stem(s);
    });
    return { version: version, hasAudio: hasAudio, regionSet: regionSet };
  }

  function MediaResolver(archive, debug) {
    this.archive = archive;
    this.debug = debug;
    this.cache = new Map();
  }

  MediaResolver.prototype.record = function (ref) {
    if (!this.cache.has(ref)) this.cache.set(ref, this.build(ref));
    return Object.assign({}, this.cache.get(ref));
  };

  MediaResolver.prototype.build = function (ref) {
    var rec = { name: stem(ref), path: ref.endsWith('.apx') ? ref.slice(0, -4) : ref,
                version: null, hasAudio: false, regionSet: null };
    if (!ref.startsWith('objects/videoclip/')) return rec;
    if (!this.archive.has(ref)) {
      this.debug.push('media resource missing from archive: ' + ref);
      return rec;
    }
    var asset = cstrings(this.archive.read(ref)).find(function (s) {
      return s.startsWith('objects/videoasset/');
    });
    if (!asset || !this.archive.has(asset)) {
      this.debug.push('no video asset for ' + ref);
      return rec;
    }
    try {
      Object.assign(rec, parseVideoAsset(this.archive.read(asset), asset));
    } catch (error) {
      this.debug.push('video asset unreadable: ' + error.message);
    }
    return rec;
  };

  // --- snapshot assembly -------------------------------------------------------

  function slug(text) {
    return Array.from(text).map(function (c) {
      return /^[\p{L}\p{N}]$/u.test(c) ? c.toLowerCase() : '_';
    }).join('');
  }

  function trackId(name, path) {
    if (!path) return name;
    var parts = path.split('/');
    var st = stem(parts[parts.length - 1]);
    var folder = parts.slice(0, -1).join('/');
    var bits = [];
    if (folder !== TRACK_ROOT) {
      var prefix = folder;
      if (prefix.endsWith(TRACK_ROOT)) prefix = prefix.slice(0, -TRACK_ROOT.length).replace(/^\/+|\/+$/g, '');
      if (prefix) bits.push(prefix);
    }
    if (slug(st) !== slug(name)) bits.push(st);
    return bits.length ? name + ' #' + bits.join('/') : name;
  }

  function tcSeconds(text, fps) {
    var parts = text.trim().split(/[:;.]/);
    if (parts.length !== 4) return null;
    var h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
    var s = parseInt(parts[2], 10), f = parseInt(parts[3], 10);
    var nominal = Math.round(fps);
    return (((h * 60 + m) * 60 + s) * nominal + f) / fps;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatTimecode(seconds, fps) {
    if (seconds === null || !fps) return null;
    var sign = seconds < 0 ? '-' : '';
    var total = Math.abs(seconds);
    var whole = Math.trunc(total);
    var frames = Math.trunc(roundHalfAway((total - whole) * fps, 0));
    if (frames >= Math.trunc(roundHalfAway(fps, 0))) { frames = 0; whole += 1; }
    return sign + pad2(Math.floor(whole / 3600)) + ':' + pad2(Math.floor((whole % 3600) / 60)) +
           ':' + pad2(whole % 60) + '.' + pad2(frames);
  }

  function uidInt(hex) {
    return /^[0-9a-fA-F]+$/.test(hex) ? BigInt('0x' + hex) : null;
  }

  function derivedLayerId(record) {
    function fixed(value) { return value === null || value === undefined ? '?' : value.toFixed(2); }
    var path = (record.groupPath || []).concat([record.name || 'Unknown']).join('/');
    return path + ' @' + fixed(record.tStart) + '-' + fixed(record.tEnd);
  }

  function assignLayerIds(records, debug) {
    var counts = new Map();
    records.forEach(function (record) {
      var base, source;
      if (record.uid !== null) { base = '#' + record.uid.toString(); source = 'uid'; }
      else { base = derivedLayerId(record); source = 'derived'; }
      var seen = (counts.get(base) || 0) + 1;
      counts.set(base, seen);
      record.id = seen === 1 ? base : base + '~' + seen;
      record.idSource = source;
    });
    Array.from(counts.keys()).sort().forEach(function (base) {
      var n = counts.get(base);
      if (n > 1 && base.startsWith('#')) {
        debug.push('layer uid ' + base.slice(1) + ' captured ' + n + ' times on one track -- same ' +
                   'resource reached twice, not ' + n + ' layers');
      }
    });
  }

  function TrackBuilder(archive, debug) {
    this.archive = archive;
    this.debug = debug;
    this.media = new MediaResolver(archive, debug);
    this.records = new Map();
    this.byPath = new Map();
  }

  TrackBuilder.prototype.idFor = function (path) {
    return this.byPath.get(path) || trackId(stem(path), path);
  };

  TrackBuilder.prototype.add = function (path, fps) {
    path = this.archive.resolve(path) || path;
    if (this.byPath.has(path)) return this.byPath.get(path);
    var id = trackId(stem(path), path);
    this.byPath.set(path, id);
    var record = this.record(path, fps);
    record.id = id;
    this.records.set(id, record);
    return id;
  };

  TrackBuilder.prototype.sortedRecords = function () {
    var self = this;
    return Array.from(this.records.keys()).sort(pyCompare).map(function (k) { return self.records.get(k); });
  };

  TrackBuilder.prototype.record = function (path, fps) {
    var self = this;
    var base = { name: stem(path), path: path, trashed: path.split('/').indexOf('trash') >= 0 };
    if (!this.archive.has(path)) {
      this.debug.push('track missing from archive: ' + path);
      return Object.assign(base, {
        lengthInSec: null, lengthInBeats: null, bpm: null, hasTimecode: false, fps: null,
        firstTimecodeBeat: null, cues: [], layerCount: 0, layers: [],
        error: 'track missing from archive'
      });
    }
    var track = parseTrack(this.archive.read(path), path);
    var spb = track.bpm ? 60.0 / track.bpm : 1.0;
    function toTime(beat) { return beat * spb; }
    function toBeat(t) { return t / spb; }

    var cues = [];
    track.cues.forEach(function (entry) {
      if (!self.archive.has(entry[1])) {
        self.debug.push('cue missing from archive: ' + entry[1]);
        return;
      }
      var cue = parseCue(self.archive.read(entry[1]), entry[1]);
      cue.beat = entry[0];
      cues.push(cue);
    });
    cues.sort(function (a, b) { return a.beat - b.beat; });

    var tcTags = cues.filter(function (c) { return c.tags[TAG_TC]; })
                     .map(function (c) { return [c.beat, c.tags[TAG_TC]]; });
    var hasTc = tcTags.length > 0 && fps !== null;
    var firstTc = hasTc ? Math.min.apply(null, tcTags.map(function (t) { return t[0]; })) : null;

    function timecode(beat) {
      if (!hasTc || beat === null || beat < firstTc) return null;
      var best = null;
      tcTags.forEach(function (t) {
        if (t[0] <= beat && (best === null || t[0] > best[0] || (t[0] === best[0] && t[1] > best[1]))) best = t;
      });
      var baseSec = tcSeconds(best[1], fps);
      if (baseSec === null) return null;
      return formatTimecode(baseSec + toTime(beat) - toTime(best[0]), fps);
    }

    var sectionBeats = cues.filter(function (c) { return c.section; }).map(function (c) { return c.beat; });
    function sectionOf(beat) {
      return Math.max(sectionBeats.filter(function (b) { return b <= beat; }).length - 1, 0);
    }

    var cueRecords = [];
    cues.forEach(function (cue) {
      var tags = [];
      Object.keys(TAG_NAMES).forEach(function (t) {
        if (cue.tags[t]) tags.push({ type: TAG_NAMES[t], text: cue.tags[t] });
      });
      if (!(cue.section || cue.note || tags.length)) return;
      cueRecords.push({
        beat: num(cue.beat), isSection: cue.section, note: cue.note || null, tags: tags,
        section: sectionOf(cue.beat), t: num(toTime(cue.beat)), timecode: timecode(cue.beat)
      });
    });

    var layers = track.layers.map(function (layer) {
      var bStart = num(toBeat(layer.tStart)), bEnd = num(toBeat(layer.tEnd));
      return {
        name: layer.name, uid: uidInt(layer.uid), type: layer.type, groupPath: layer.groupPath,
        renderEnable: layer.renderEnable, tStart: num(layer.tStart), tEnd: num(layer.tEnd),
        bStart: bStart, bEnd: bEnd, tcStart: timecode(bStart), tcEnd: timecode(bEnd),
        media: self.layerMedia(layer)
      };
    });
    assignLayerIds(layers, this.debug);

    return Object.assign(base, {
      lengthInSec: num(track.lengthInSec), lengthInBeats: num(toBeat(track.lengthInSec)),
      bpm: num(track.bpm), hasTimecode: hasTc, fps: hasTc ? fps : null,
      firstTimecodeBeat: hasTc ? num(firstTc) : null, cues: cueRecords,
      layerCount: layers.length, layers: layers
    });
  };

  TrackBuilder.prototype.layerMedia = function (layer) {
    // The last `video` field, as when fields were keyed by name.
    var videos = layer.fields.filter(function (f) { return f.name === 'video'; });
    var field = videos.length ? videos[videos.length - 1] : null;
    if (!field || field.cls !== 'ResourceSequence') return [];
    var out = [], seen = new Set(), self = this;
    field.keys.forEach(function (key) {
      var ref = key[1];
      if (!ref || ref === 'null' || seen.has(ref)) return;
      seen.add(ref);
      out.push(self.media.record(ref));
    });
    return out;
  };

  function pathsIn(bytes, prefix) {
    return cstrings(bytes).filter(function (s) { return s.startsWith(prefix); });
  }

  function transportFps(archive, tmBytes, debug) {
    var ltcs = pathsIn(tmBytes, 'objects/timecodetransport');
    var marker = ascii('TimecodeTransportLtc\0');
    for (var k = 0; k < ltcs.length; k++) {
      if (!archive.has(ltcs[k])) continue;
      var bytes = archive.read(ltcs[k]);
      var at = indexOfBytes(bytes, marker, 0);
      if (at < 0) continue;
      var r = new Reader(bytes, ltcs[k]);
      r.i = at;
      r.section('TimecodeTransportLtc');
      r.cstr();
      var clock = r.u32();
      if (clock in FPS_BY_CLOCK) return Math.fround(FPS_BY_CLOCK[clock]);
      debug.push('unknown SMPTE clock type ' + clock + ' on ' + ltcs[k]);
    }
    return null;
  }

  function parseSetlist(bytes, path) {
    var r = new Reader(bytes, path);
    r.openObject();
    var cls = r.objectHead()[0];
    r.section('SetList');
    if (cls !== 'UserSetList') return [];
    r.section('UserSetList');
    var out = [];
    for (var n = r.u32(); n > 0; n--) out.push(r.cstr());
    return out;
  }

  function objectClass(bytes) {
    if (bytes.length < 9) return null;
    for (var k = 0; k < 4; k++) if (bytes[k] !== OBJECT_MAGIC[k]) return null;
    var end = bytes.indexOf(0, 8);
    var head = utf8.decode(bytes.subarray(8, end < 0 ? bytes.length : end));
    var at = head.indexOf('_UID_');
    return at < 0 ? null : head.slice(0, at);
  }

  function buildInfo(archive, debug) {
    var fields = ['version', 'versionName', 'releaseType', 'phase', 'branch', 'buildId',
                  'customRelease', 'tags', 'platform', 'osImage', 'renderStream',
                  'starter', 'beta', 'rc', 'custom', 'debugBuild', 'localPatches'];
    var build = {};
    fields.forEach(function (k) { build[k] = null; });
    build.error = null;
    if (!archive.has('conf/depends.txt')) {
      build.error = 'conf/depends.txt not in archive';
      return build;
    }
    var line = utf8.decode(archive.read('conf/depends.txt')).trim().split(/\r?\n/)[0];
    var parts = line.split(/\s+/);
    if (parts.length >= 4 && parts[0] === 'd3') {
      build.versionName = parts[1];
      build.version = parts[1] + ', rev ' + parts[2];
      build.buildId = parts[3];
      var m = /^r[\d.]+_(.+)-branch$/.exec(parts[1]);
      if (m) build.branch = m[1];
    } else {
      build.error = 'unrecognised depends.txt: ' + line;
    }
    debug.push('system.build from conf/depends.txt; release flags are not in the archive');
    return build;
  }

  function localIso(date) {
    function p(n) { return String(n).padStart(2, '0'); }
    var offset = -date.getTimezoneOffset();
    var sign = offset >= 0 ? '+' : '-';
    offset = Math.abs(offset);
    return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) + 'T' +
           p(date.getHours()) + ':' + p(date.getMinutes()) + ':' + p(date.getSeconds()) +
           sign + p(Math.floor(offset / 60)) + ':' + p(offset % 60);
  }

  /* Python's default str ordering: by code point, not UTF-16 unit. */
  function pyCompare(a, b) {
    var ai = a[Symbol.iterator](), bi = b[Symbol.iterator]();
    for (;;) {
      var x = ai.next(), y = bi.next();
      if (x.done || y.done) return x.done === y.done ? 0 : (x.done ? -1 : 1);
      var cx = x.value.codePointAt(0), cy = y.value.codePointAt(0);
      if (cx !== cy) return cx - cy;
    }
  }

  function buildSnapshot(buffer, options) {
    options = options || {};
    var debug = [];
    var archive = new Archive(buffer);
    var fileStem = (options.fileName || 'project.d3').replace(/\.[^.]*$/, '');
    var snapshot = {
      schemaVersion: SCHEMA_VERSION,
      capturedAt: options.capturedAt || localIso(new Date()),
      project: options.project || fileStem,
      scope: 'all',
      activeTransport: null,
      transportCount: 0,
      transports: [],
      trackCount: 0,
      tracks: [],
      showfile: { source: AUTOMATIC_SETLIST_PATH, trackIds: null, trackCount: null, error: null },
      system: {
        build: buildInfo(archive, debug),
        options: {
          project: { source: null, values: null,
                     error: 'internal/options/options.bin is not packed into a .d3 archive' },
          machine: { source: null, values: null,
                     error: 'machine.bin lives outside the project and is not in a .d3 archive' }
        }
      },
      writtenTo: options.writtenTo || null,
      error: null,
      debug: debug
    };

    var transports = new Map();
    archive.names('objects/transportmanager/').forEach(function (path) {
      var bytes = archive.read(path);
      if (objectClass(bytes) === 'TransportManager') transports.set(stem(path), bytes);
    });

    var active = null;
    if (archive.has(DIRECTOR_STATE)) {
      var refs = pathsIn(archive.read(DIRECTOR_STATE), 'objects/transportmanager/');
      if (refs.length) active = stem(refs[refs.length - 1]);
    }
    snapshot.activeTransport = active;
    var activeFps = transports.has(active) ? transportFps(archive, transports.get(active), debug) : null;

    var order = (transports.has(active) ? [active] : []).concat(
      Array.from(transports.keys()).filter(function (t) { return t !== active; }).sort(pyCompare));
    var builder = new TrackBuilder(archive, debug);
    order.forEach(function (name) {
      var bytes = transports.get(name);
      var record = { name: name, setlist: null, trackCount: 0, trackRefs: [], error: null };
      var setlists = pathsIn(bytes, 'objects/usersetlist/').concat(pathsIn(bytes, 'objects/setlist/'));
      if (!setlists.length || !archive.has(setlists[0])) {
        record.error = 'transport has no setlist';
        snapshot.transports.push(record);
        return;
      }
      record.setlist = stem(setlists[0]);
      var fps = transportFps(archive, bytes, debug);
      if (fps === null) fps = activeFps;
      record.trackRefs = parseSetlist(archive.read(setlists[0]), setlists[0]).map(function (t) {
        return builder.add(t, fps);
      });
      record.trackCount = record.trackRefs.length;
      snapshot.transports.push(record);
    });

    snapshot.transportCount = snapshot.transports.length;
    snapshot.tracks = builder.sortedRecords();
    snapshot.trackCount = snapshot.tracks.length;

    var census = archive.names(TRACK_ROOT + '/').filter(function (p) {
      return p.endsWith('.apx') && p.split('/').length === 3;
    }).sort(pyCompare);
    snapshot.showfile.trackIds = census.map(function (p) { return builder.idFor(p); });
    snapshot.showfile.trackCount = census.length;
    return snapshot;
  }

  // --- keyframes ---------------------------------------------------------------

  /* A float32 as the shortest decimal that reads back to the same float32, so a
   * key stored as 0.998f exports as 0.998. Same search as _f32_value. */
  function f32Value(value) {
    if (!isFinite(value)) return null;
    var target = Math.fround(value);
    for (var p = 1; p < 10; p++) {
      var candidate = parseFloat(value.toPrecision(p));
      if (Math.fround(candidate) === target) return candidate;
    }
    return value;
  }

  function keyframeValue(cls, value) {
    if (cls === 'FloatSequence') return f32Value(value);
    if (value === null || value === undefined || value === '' || value === 'null') return null;
    return cls === 'ResourceSequence' && value.endsWith('.apx') ? value.slice(0, -4) : value;
  }

  /* Same as _cdl_archive_path: an imported .cc is referenced under
   * objects/lutfile/ but packed under internal/lutfile/. */
  function cdlArchivePath(ref) {
    if (ref.startsWith('objects/lutfile/')) return 'internal/lutfile/' + ref.slice('objects/lutfile/'.length) + '.apx';
    return ref + '.apx';
  }

  /* CDL v2: f32 slope[3], power[3], offset[3], saturation. Order inferred; see
   * parse_cdl in d3_extract.py. */
  function parseCdl(bytes, path) {
    var r = new Reader(bytes, path);
    r.openObject();
    r.objectHead('CDL');
    var version = r.section('CDL');
    if (version !== 2) r.fail('unsupported CDL version ' + version);
    var v = [];
    for (var k = 0; k < 10; k++) v.push(f32Value(r.f32()));
    return { slope: v.slice(0, 3), power: v.slice(3, 6), offset: v.slice(6, 9), saturation: v[9] };
  }

  function cdlRecord(archive, ref) {
    var path = cdlArchivePath(ref);
    var name = stem(ref);
    var rec = { name: ref.endsWith('.cc') ? name.slice(0, -3) : name,
                source: ref.startsWith('objects/lutfile/') ? 'ccFile' : 'designer',
                archivePath: path, slope: null, power: null, offset: null,
                saturation: null, error: null };
    if (!archive.has(path)) {
      rec.error = 'not in archive';
      return rec;
    }
    try {
      Object.assign(rec, parseCdl(archive.read(path), path));
    } catch (error) {
      rec.error = 'unreadable CDL resource';
    }
    return rec;
  }

  /* Every animated layer parameter in the show: two or more keys, or driven by
   * an expression, plus any CDL field that applies a CDL. Same document as
   * build_keyframes in d3_extract.py. */
  function buildKeyframes(buffer, options) {
    options = options || {};
    var archive = buffer instanceof Archive ? buffer : new Archive(buffer);
    var fileName = options.fileName || 'project.d3';
    var codes = {};
    Object.keys(INTERPOLATION).forEach(function (k) { codes[k] = INTERPOLATION[k]; });
    var doc = {
      format: 'd3_keyframes',
      formatVersion: KEYFRAMES_FORMAT_VERSION,
      capturedAt: options.capturedAt || localIso(new Date()),
      project: options.project || fileName.replace(/\.[^.]*$/, ''),
      source: fileName,
      scope: 'animated',
      interpolation: {
        codes: codes,
        note: 'Inferred from how the codes are used across a real show; not confirmed in Designer.'
      },
      trackCount: 0, layerCount: 0, fieldCount: 0, keyCount: 0,
      cdlCount: 0, cdls: {},
      tracks: [],
      writtenTo: options.writtenTo || null
    };
    var census = archive.names(TRACK_ROOT + '/').filter(function (p) {
      return p.endsWith('.apx') && p.split('/').length === 3;
    }).sort(pyCompare);
    var parsed = census.map(function (path) { return [path, parseTrack(archive.read(path), path)]; });

    // Show-wide names for exposed attributes, borrowed by a layer that carries
    // the id without a name (RenderStream) only when every named occurrence
    // agrees. See build_keyframes in d3_extract.py.
    var names = new Map();
    parsed.forEach(function (entry) {
      entry[1].layers.forEach(function (layer) {
        layer.fields.forEach(function (field) {
          if (!field.label || field.name.indexOf('::Attributes::') < 0) return;
          if (!names.has(field.name)) names.set(field.name, new Set());
          names.get(field.name).add(field.label);
        });
      });
    });

    var tracks = [];
    parsed.forEach(function (entry) {
      var path = entry[0], track = entry[1];
      var layers = [];
      track.layers.forEach(function (layer) {
        var fields = [];
        layer.fields.forEach(function (field) {
          var cls = field.cls;
          var cdlRefs = [];
          if (field.valueType === CDL_VALUE_TYPE) {
            cdlRefs = [keyframeValue(cls, field.default)].concat(field.keys.map(function (key) {
              return keyframeValue(cls, key[1]);
            })).filter(function (v) { return v; });
          }
          if (field.keys.length < 2 && !field.expression && !cdlRefs.length) return;
          cdlRefs.forEach(function (ref) {
            if (!Object.prototype.hasOwnProperty.call(doc.cdls, ref)) doc.cdls[ref] = cdlRecord(archive, ref);
          });
          var label = field.label || null, source = field.label ? 'layer' : null;
          if (label === null && names.has(field.name) && names.get(field.name).size === 1) {
            label = names.get(field.name).values().next().value;
            source = 'show';
          }
          fields.push({
            name: field.name,
            label: label,
            labelSource: source,
            valueType: field.valueType,
            expression: field.expression,
            default: keyframeValue(cls, field.default),
            keys: field.keys.map(function (key) {
              return {
                t: num(key[0]),
                value: keyframeValue(cls, key[1]),
                interpolation: INTERPOLATION.hasOwnProperty(key[2]) ? INTERPOLATION[key[2]] : 'unknown (' + key[2] + ')'
              };
            })
          });
        });
        if (!fields.length) return;
        var uid = uidInt(layer.uid);
        layers.push({
          id: uid !== null ? '#' + uid.toString() : null,
          uid: uid,
          name: layer.name,
          type: layer.type,
          groupPath: layer.groupPath,
          tStart: num(layer.tStart),
          tEnd: num(layer.tEnd),
          notchBlock: layer.notchBlock,
          fields: fields
        });
        doc.fieldCount += fields.length;
        fields.forEach(function (f) { doc.keyCount += f.keys.length; });
      });
      if (layers.length) {
        tracks.push({ id: trackId(stem(path), path), name: stem(path), path: path,
                      bpm: num(track.bpm), layers: layers });
        doc.layerCount += layers.length;
      }
    });
    doc.tracks = tracks.sort(function (a, b) { return pyCompare(a.id, b.id); });
    doc.trackCount = tracks.length;
    doc.cdlCount = Object.keys(doc.cdls).length;
    return doc;
  }

  // --- JSON, written the way Python's json.dumps(indent=2, sort_keys=True) does --

  // Keys whose values are Python floats: 60.0 must print as 60.0, not 60.
  var FLOAT_KEYS = new Set(['beat', 't', 'tStart', 'tEnd', 'bStart', 'bEnd', 'lengthInSec', 'value', 'default',
                            'lengthInBeats', 'bpm', 'fps', 'firstTimecodeBeat',
                            'slope', 'power', 'offset', 'saturation']);

  function pyFloat(x) {
    if (!isFinite(x)) return x !== x ? 'NaN' : (x > 0 ? 'Infinity' : '-Infinity');
    if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
    var parts = x.toExponential().split('e');         // shortest round-trip digits
    var digits = parts[0].replace('-', '').replace('.', '');
    var exp = parseInt(parts[1], 10);
    var sign = x < 0 ? '-' : '';
    if (exp < -4 || exp >= 16) {
      var mant = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
      return sign + mant + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
    }
    var point = exp + 1;
    var s;
    if (point <= 0) s = '0.' + '0'.repeat(-point) + digits;
    else if (point >= digits.length) s = digits + '0'.repeat(point - digits.length) + '.0';
    else s = digits.slice(0, point) + '.' + digits.slice(point);
    return sign + s;
  }

  function pyString(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 0x22) out += '\\"';
      else if (c === 0x5c) out += '\\\\';
      else if (c === 0x0a) out += '\\n';
      else if (c === 0x0d) out += '\\r';
      else if (c === 0x09) out += '\\t';
      else if (c === 0x08) out += '\\b';
      else if (c === 0x0c) out += '\\f';
      else if (c < 0x20 || c > 0x7e) out += '\\u' + c.toString(16).padStart(4, '0');
      else out += s[i];
    }
    return out + '"';
  }

  function toJson(value) {
    function write(v, key, indent) {
      if (v === null || v === undefined) return 'null';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'number') {
        return FLOAT_KEYS.has(key) || !Number.isInteger(v) ? pyFloat(v) : String(v);
      }
      if (typeof v === 'string') return pyString(v);
      var inner = indent + '  ';
      if (Array.isArray(v)) {
        if (!v.length) return '[]';
        return '[\n' + v.map(function (x) { return inner + write(x, key, inner); }).join(',\n') +
               '\n' + indent + ']';
      }
      var keys = Object.keys(v).sort(pyCompare);
      if (!keys.length) return '{}';
      return '{\n' + keys.map(function (k) {
        return inner + pyString(k) + ': ' + write(v[k], k, inner);
      }).join(',\n') + '\n' + indent + '}';
    }
    return write(value, null, '');
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    ParseError: ParseError,
    buildSnapshot: buildSnapshot,
    buildKeyframes: buildKeyframes,
    toJson: toJson,
    localIso: localIso,
    // exposed for tests
    _parseTrack: parseTrack, _parseCue: parseCue, _parseVideoAsset: parseVideoAsset,
    _parseSetlist: parseSetlist, _Archive: Archive, _roundHalfAway: roundHalfAway, _f32Value: f32Value
  };
});

/**
 * ============================================================================
 *  FREEFILESYNC XML  --  THE PROOF THAT WE EMIT THE VERIFIED SHAPE
 * ============================================================================
 *
 * The golden fixture is not a copy of the expected output pasted into a test:
 * it is READ OUT OF `docs/ffs-format.md`, which itself was read verbatim from a
 * real config written by the user's FreeFileSync 14.10. If the spec changes,
 * this test changes with it; if the renderer drifts from the spec, it fails.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_DELETION_POLICIES,
  MACOS_EXCLUDES,
  REMOVAL_CHANGES,
  assertDeletionPolicy,
  assertFilterSafePath,
  buildChunkManifest,
  buildRemovalGui,
  escapeXmlAttr,
  escapeXmlText,
  renderFfsGui,
  unescapeXml,
} from '../src/export/ffs.ts';
import type { DeletionPolicy, ExportChunk } from '../src/export/types.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = readFileSync(join(PROJECT_ROOT, 'docs', 'ffs-format.md'), 'utf8');

/** The verified real config, lifted out of the spec's first ```xml block. */
function goldenFromSpec(): string {
  const m = /```xml\n([\s\S]*?)```/.exec(SPEC);
  if (!m) throw new Error('docs/ffs-format.md no longer contains an xml fixture block');
  return m[1] as string;
}

// ---------------------------------------------------------------------------
// A very small XML reader. Enough to assert structure and to prove the emitted
// document is balanced; deliberately not a general-purpose parser.
// ---------------------------------------------------------------------------

interface Node {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
}

function parseXml(xml: string): Node {
  const body = xml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const root: Node = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: Node[] = [root];
  const tagRe = /<(\/)?([A-Za-z_][\w.-]*)((?:\s+[\w.-]+="[^"]*")*)\s*(\/)?>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(body)) !== null) {
    const top = stack[stack.length - 1] as Node;
    top.text += body.slice(last, m.index);
    last = tagRe.lastIndex;
    const [, closing, name, rawAttrs, selfClose] = m;
    if (closing) {
      const popped = stack.pop();
      if (!popped || popped.name !== name) {
        throw new Error(`Unbalanced XML: </${name}> closes <${popped?.name}>`);
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs ?? '').matchAll(/([\w.-]+)="([^"]*)"/g)) {
      attrs[a[1] as string] = unescapeXml(a[2] as string);
    }
    const node: Node = { name: name as string, attrs, children: [], text: '' };
    top.children.push(node);
    if (!selfClose) stack.push(node);
  }
  if (stack.length !== 1) {
    throw new Error(`Unbalanced XML: ${stack.length - 1} element(s) left open`);
  }
  // A stray '&' that is not an entity would be malformed XML.
  const stray = body.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, '').includes('&');
  if (stray) throw new Error('Malformed XML: unescaped & in the document');
  return root;
}

function child(n: Node, name: string): Node {
  const c = n.children.find((x) => x.name === name);
  if (!c) throw new Error(`missing <${name}> under <${n.name}>`);
  return c;
}

function items(n: Node): string[] {
  return n.children.filter((c) => c.name === 'Item').map((c) => unescapeXml(c.text));
}

/** Strip XML comments, where a literal '&' is legal and needs no entity. */
function withoutComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

/** Text content of a child element, with entities decoded. */
function textOf(n: Node, name: string): string {
  return unescapeXml(child(n, name).text);
}

// ---------------------------------------------------------------------------

describe('renderFfsGui reproduces the verified FFS 14.10 config byte for byte', () => {
  it('matches the golden fixture in docs/ffs-format.md exactly', () => {
    const got = renderFfsGui({
      notes: '',
      changes: {
        left: { Create: 'right', Update: 'right', Delete: 'none' },
        right: { Create: 'none', Update: 'none', Delete: 'none' },
      },
      deletionPolicy: 'RecycleBin',
      versioningStyle: 'Replace',
      versioningFolder: '',
      include: ['*_region0.mov'],
      exclude: [
        '*/._*',
        '*/.DS_Store',
        '*/.fseventsd/',
        '*/.DocumentRevisions-V100/',
        '*/.Spotlight-V100/',
        '*/.TemporaryItems/',
        '*/.Trashes/',
        '/x_ArchiveFrom2025/',
        '*/desktop.ini',
      ],
      pairs: [
        {
          left: '/Users/Shared/ObjectMount.noindex/show-archive/SHOW_2026/00_D3_Delivery',
          right: '/Volumes/d3 Projects/showproject/objects/VideoFile',
        },
      ],
    });
    expect(got).toBe(goldenFromSpec());
  });

  it('omits <DetectMovedFiles> when the model does not set it', () => {
    // The verified real config does NOT carry the element. Reproducing it means
    // not emitting it, so `detectMovedFiles` is optional and absent by default.
    // This assertion is what keeps the golden fixture an honest transcript of
    // the user's file rather than something edited to suit our output.
    expect(goldenFromSpec()).not.toContain('DetectMovedFiles');
  });

  it('the macOS excludes we ship are the verified ones, minus the user’s own job filter', () => {
    const golden = goldenFromSpec();
    for (const e of MACOS_EXCLUDES) expect(golden).toContain(`<Item>${e}</Item>`);
    // Their project-specific archive filter is theirs, not ours.
    expect(MACOS_EXCLUDES).not.toContain('/x_ArchiveFrom2025/');
    expect(golden).toContain('<Item>/x_ArchiveFrom2025/</Item>');
  });
});

// ---------------------------------------------------------------------------

const CHUNK: ExportChunk = {
  index: 1,
  songFolders: ['010_SONG & CO [LL180]'],
  baseFolder: '/archive/root/010_SONG & CO [LL180]',
  pairRightFolder: '/archive/root/010_SONG & CO [LL180]',
  basePrefix: '010_SONG & CO [LL180]/',
  includes: [
    '/010_SONG & CO [LL180]_MAIN_v001_region1.mov',
    '/010_SONG & CO [LL180]_MAIN_v001_region2.mov',
    '/sub dir/a <b> "c" \'d\'.mov',
  ],
  relPaths: [
    '010_SONG & CO [LL180]/010_SONG & CO [LL180]_MAIN_v001_region1.mov',
    '010_SONG & CO [LL180]/010_SONG & CO [LL180]_MAIN_v001_region2.mov',
    '010_SONG & CO [LL180]/sub dir/a <b> "c" \'d\'.mov',
  ],
  versionIds: [7],
  bytes: 3 * 1024 ** 4,
  fileCount: 3,
  guiFileName: 'removal-01-010_SONG_CO_LL180.ffs_gui',
  manifestFileName: 'removal-01-010_SONG_CO_LL180.paths.txt',
};

const GUI_OPTS = {
  emptyLeftFolder: '/project/exports/export-X/_empty_left',
  deletionPolicy: 'Versioning' as const,
  versioningFolder: '/Users/Shared/reclaim-versions',
  manifestFileName: CHUNK.manifestFileName,
  chunkCount: 1,
  runId: 'TESTRUN',
  generatedAt: '2026-08-25T12:00:00.000Z',
  note: null,
};

describe('the emitted removal job', () => {
  const xml = buildRemovalGui(CHUNK, GUI_OPTS);
  const doc = parseXml(xml);
  const root = child(doc, 'FreeFileSync');

  it('is a GUI document at XmlFormat 23 and never a batch file', () => {
    expect(xml).toContain('<FreeFileSync XmlType="GUI" XmlFormat="23">');
    expect(root.attrs.XmlType).toBe('GUI');
    expect(root.attrs.XmlFormat).toBe('23');
    expect(xml).not.toContain('<Batch');
    expect(xml).not.toContain('XmlType="BATCH"');
  });

  it('uses <Changes> with <Left>/<Right>, never the hypothesised <Differences>', () => {
    expect(xml).not.toContain('<Differences');
    const changes = child(child(root, 'Synchronize'), 'Changes');
    expect(child(changes, 'Left').attrs).toEqual({
      Create: 'none',
      Update: 'none',
      Delete: 'right',
    });
    expect(child(changes, 'Right').attrs).toEqual({
      Create: 'none',
      Update: 'none',
      Delete: 'none',
    });
  });

  it('can never copy anything INTO the archive', () => {
    expect(REMOVAL_CHANGES.left.Create).toBe('none');
    expect(REMOVAL_CHANGES.left.Update).toBe('none');
    expect(REMOVAL_CHANGES.right.Create).toBe('none');
    expect(REMOVAL_CHANGES.right.Update).toBe('none');
    expect(REMOVAL_CHANGES.right.Delete).toBe('none');
  });

  it('uses only element names verified against a real config or the 14.10 binary', () => {
    const names = new Set([...xml.matchAll(/<\/?([A-Za-z][\w.-]*)/g)].map((m) => m[1] as string));
    // Every name here is either present in the verified real config quoted in
    // docs/ffs-format.md, or confirmed in the FreeFileSync 14.10 binary's XML
    // literal pool. Nothing is guessed.
    const verified = new Set([
      'FreeFileSync', 'Notes', 'Compare', 'Variant', 'Symlinks', 'IgnoreTimeShift',
      'Synchronize', 'Changes', 'Left', 'Right', 'DetectMovedFiles', 'DeletionPolicy',
      'VersioningFolder', 'Filter', 'Include', 'Exclude', 'Item', 'SizeMin', 'SizeMax',
      'TimeSpan', 'FolderPairs', 'Pair', 'Errors', 'PostSyncCommand', 'LogFolder',
      'EmailNotification', 'GridViewType',
    ]);
    for (const nm of names) expect([nm, verified.has(nm)]).toEqual([nm, true]);
    // And the legacy shape the spec explicitly warns against is never emitted.
    for (const legacy of ['Differences', 'LeftOnly', 'RightOnly', 'LeftNewer', 'Batch']) {
      expect(names.has(legacy)).toBe(false);
    }
  });

  it('carries every element the verified file carries, in the verified shape', () => {
    const names = root.children.map((c) => c.name);
    expect(names).toEqual([
      'Notes',
      'Compare',
      'Synchronize',
      'Filter',
      'FolderPairs',
      'Errors',
      'PostSyncCommand',
      'LogFolder',
      'EmailNotification',
      'GridViewType',
    ]);
    const cmp = child(root, 'Compare');
    expect(cmp.children.map((c) => c.name)).toEqual(['Variant', 'Symlinks', 'IgnoreTimeShift']);
    expect(textOf(cmp, 'Variant')).toBe('TimeAndSize');
    expect(textOf(cmp, 'Symlinks')).toBe('Exclude');
    // <LogFolder> is TOP LEVEL, not <Batch><LogfileFolder>.
    expect(xml).toContain('\n    <LogFolder/>\n');
    expect(child(root, 'EmailNotification').attrs.Condition).toBe('Always');
    expect(textOf(root, 'GridViewType')).toBe('Action');
    expect(child(root, 'Errors').attrs).toEqual({ Ignore: 'false', Retry: '0', Delay: '5' });
    const filter = child(root, 'Filter');
    expect(child(filter, 'SizeMin').attrs.Unit).toBe('None');
    expect(child(filter, 'SizeMax').attrs.Unit).toBe('None');
    expect(child(filter, 'TimeSpan').attrs.Type).toBe('None');
  });

  it('pairs an empty left-hand folder against the song folder, forward slashes only', () => {
    const pair = child(child(root, 'FolderPairs'), 'Pair');
    expect(textOf(pair, 'Left')).toBe(GUI_OPTS.emptyLeftFolder);
    expect(textOf(pair, 'Right')).toBe(CHUNK.baseFolder);
    expect(child(pair, 'Left').attrs.Threads).toBe('8');
    expect(child(pair, 'Right').attrs.Threads).toBe('8');
    expect(xml).not.toMatch(/<(Left|Right) Threads="8">[^<]*\\/);
  });

  it('switches move detection off, inside <Synchronize>', () => {
    const sync = child(root, 'Synchronize');
    expect(textOf(sync, 'DetectMovedFiles')).toBe('false');
    expect(xml).toContain('        <DetectMovedFiles>false</DetectMovedFiles>\n');
    // Element ORDER is inferred, not verified, so it is asserted here to keep it
    // stable and reviewable rather than drifting silently between releases.
    expect(sync.children.map((c) => c.name)).toEqual([
      'Changes',
      'DetectMovedFiles',
      'DeletionPolicy',
      'VersioningFolder',
    ]);
  });

  it('explains in the banner why move detection is off, and still says to look', () => {
    const comment = /<!--([\s\S]*?)-->/.exec(xml)?.[1] ?? '';
    expect(comment).toContain('MOVE DETECTION IS SWITCHED OFF');
    expect(comment).toContain('read-only');
    expect(comment).toContain('check');
    expect(comment).toContain('GUI');
    expect(comment).not.toContain('--');
  });

  it('sets Versioning with a TimeStamp-Folder versioning path', () => {
    const sync = child(root, 'Synchronize');
    expect(textOf(sync, 'DeletionPolicy')).toBe('Versioning');
    const vf = child(sync, 'VersioningFolder');
    expect(vf.attrs.Style).toBe('TimeStamp-Folder');
    expect(unescapeXml(vf.text)).toBe('/Users/Shared/reclaim-versions');
  });

  it('ships the standard macOS excludes', () => {
    expect(items(child(child(root, 'Filter'), 'Exclude'))).toEqual([...MACOS_EXCLUDES]);
  });

  it('carries a prominent header comment saying what it does', () => {
    const comment = /<!--([\s\S]*?)-->/.exec(xml)?.[1] ?? '';
    expect(comment).toContain('REMOVAL JOB');
    expect(comment).toContain('COMPARE');
    expect(comment).toContain('SYNCHRONIZE');
    expect(comment).toContain('MOVED (not deleted)');
    expect(comment).toContain(GUI_OPTS.versioningFolder);
    expect(comment).toContain(CHUNK.manifestFileName);
    // A comment may not contain a double hyphen.
    expect(comment).not.toContain('--');
    // And the same banner is in <Notes>, which FreeFileSync shows in its GUI.
    expect(child(root, 'Notes').text).toContain('REMOVAL JOB');
  });

  it('says plainly that it moves rather than deletes under Versioning', () => {
    expect(xml).toContain('MOVED (not deleted)');
    const recycle = buildRemovalGui(CHUNK, {
      ...GUI_OPTS,
      deletionPolicy: 'RecycleBin',
      versioningFolder: null,
    });
    expect(recycle).toContain('RECYCLE BIN');
    expect(parseXml(recycle).children[0]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------

describe('XML escaping round-trips real filenames', () => {
  const doc = parseXml(buildRemovalGui(CHUNK, GUI_OPTS));
  const include = items(child(child(child(doc, 'FreeFileSync'), 'Filter'), 'Include'));

  it('recovers every include pattern exactly, ampersands and brackets included', () => {
    expect(include).toEqual(CHUNK.includes);
  });

  it('escapes & < > in the document text', () => {
    const xml = buildRemovalGui(CHUNK, GUI_OPTS);
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;b&gt;');
    // Brackets and spaces are literal text in XML and stay readable.
    expect(xml).toContain('[LL180]');
    expect(xml).toContain('sub dir/');
  });

  it('escapes an ampersand in a folder-pair path and recovers it', () => {
    const xml = renderFfsGui({
      changes: REMOVAL_CHANGES,
      deletionPolicy: 'RecycleBin',
      versioningStyle: 'Replace',
      include: ['/x.mov'],
      exclude: [],
      pairs: [{ left: '/a & b', right: '/c "d"' }],
      gridViewType: 'Action',
    });
    expect(xml).toContain('<Left  Threads="8">/a &amp; b</Left>');
    const pair = child(child(child(parseXml(xml), 'FreeFileSync'), 'FolderPairs'), 'Pair');
    expect(textOf(pair, 'Left')).toBe('/a & b');
    expect(textOf(pair, 'Right')).toBe('/c "d"');
    // Attribute values escape the quote characters as well.
    expect(escapeXmlAttr('a & "b" <c> \'d\'')).toBe('a &amp; &quot;b&quot; &lt;c&gt; &apos;d&apos;');
    expect(unescapeXml(escapeXmlAttr('a & "b" <c>'))).toBe('a & "b" <c>');
  });

  it('leaves the right-hand folder empty when the operator will set it', () => {
    const chunk: ExportChunk = { ...CHUNK, pairRightFolder: '' };
    const xml = buildRemovalGui(chunk, GUI_OPTS);
    const root = child(parseXml(xml), 'FreeFileSync');
    // Empty, and still a well-formed pair with the empty left folder beside it.
    expect(textOf(child(child(root, 'FolderPairs'), 'Pair'), 'Right')).toBe('');
    expect(textOf(child(child(root, 'FolderPairs'), 'Pair'), 'Left')).toBe(
      GUI_OPTS.emptyLeftFolder,
    );
    // The filter is untouched by any of this -- it is what binds the job to
    // whatever folder the operator picks.
    expect(items(child(child(root, 'Filter'), 'Include'))).toEqual(chunk.includes);
    // And the job says so, loudly, before it says anything else.
    const comment = /<!--([\s\S]*?)-->/.exec(xml)?.[1] as string;
    expect(comment).toContain('SET THE RIGHT-HAND FOLDER BEFORE YOU DO ANYTHING ELSE');
    expect(comment).toContain('IT MUST BE THAT FOLDER ITSELF');
    // The folder it was scanned from is still stated, as the thing to match.
    expect(comment).toContain(CHUNK.baseFolder);
  });

  it('handles a real sibling project name: 22_DEAD_&_COMPANY', () => {
    const song = '22_DEAD_&_COMPANY';
    const rel = `${song}/22_DEAD_&_COMPANY_MAIN_v002d_region1.mov`;
    const chunk: ExportChunk = {
      ...CHUNK,
      songFolders: [song],
      baseFolder: `/archive/${song}`,
      pairRightFolder: `/archive/${song}`,
      basePrefix: `${song}/`,
      includes: ['/22_DEAD_&_COMPANY_MAIN_v002d_region1.mov'],
      relPaths: [rel],
      fileCount: 1,
    };
    const xml = buildRemovalGui(chunk, GUI_OPTS);
    // No bare ampersand anywhere in the markup. (An XML comment is the one
    // place a literal '&' is legal, and the banner is prose meant to be read
    // as written, so it is checked separately for comment-safety instead.)
    expect(withoutComments(xml)).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/);
    expect(/<!--([\s\S]*?)-->/.exec(xml)?.[1]).not.toContain('--');
    const root = child(parseXml(xml), 'FreeFileSync');
    expect(textOf(child(child(root, 'FolderPairs'), 'Pair'), 'Right')).toBe(`/archive/${song}`);
    expect(items(child(child(root, 'Filter'), 'Include'))).toEqual(chunk.includes);
    // And the label survives verbatim, so v002d is never shown as v002.
    expect(items(child(child(root, 'Filter'), 'Include'))[0]).toContain('v002d');
  });

  it('escapes every attribute-significant character in attribute context', () => {
    expect(escapeXmlAttr('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &apos;');
    const xml = renderFfsGui({
      changes: REMOVAL_CHANGES,
      deletionPolicy: 'RecycleBin',
      // Style is an attribute; force an awkward value through it.
      versioningStyle: 'Replace' as 'Replace',
      include: ['/x.mov'],
      exclude: [],
      pairs: [{ left: '/a & b', right: '/c' }],
    });
    expect(withoutComments(xml)).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/);
  });

  it('round-trips through escape and unescape for a pile of awkward names', () => {
    const names = [
      '140_RIVER & TWO [LL180]_v008d_region12.mov',
      'a<b>c&d"e\'f.mov',
      'spaces   and   more.mov',
      '100% & <not> a tag.mov',
      '&amp; literally.mov',
    ];
    for (const n of names) expect(unescapeXml(escapeXmlText(n))).toBe(n);
  });
});

// ---------------------------------------------------------------------------

describe('the manifest is generated from the same array as the filter', () => {
  it('lists exactly the paths the <Include> filter names', () => {
    const xml = buildRemovalGui(CHUNK, GUI_OPTS);
    const include = items(child(child(child(parseXml(xml), 'FreeFileSync'), 'Filter'), 'Include'));
    const manifest = buildChunkManifest(CHUNK, '/archive/root', GUI_OPTS);
    const listed = manifest
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.replace('/archive/root/', ''));

    expect(listed).toEqual(CHUNK.relPaths);
    // include pattern -> root-relative path must reproduce the manifest exactly
    expect(include.map((i) => CHUNK.basePrefix + i.slice(1))).toEqual(listed);
  });
});

// ---------------------------------------------------------------------------

describe("DeletionPolicy 'Permanent' is unreachable", () => {
  it('throws from assertDeletionPolicy', () => {
    expect(() => assertDeletionPolicy('Permanent')).toThrow(/Permanent.*forbidden/s);
  });

  it('throws when smuggled in as untyped JSON through the renderer', () => {
    expect(() =>
      renderFfsGui({
        changes: REMOVAL_CHANGES,
        deletionPolicy: 'Permanent' as unknown as 'RecycleBin',
        versioningStyle: 'Replace',
        include: ['/x.mov'],
        exclude: [],
        pairs: [{ left: '/a', right: '/b' }],
      }),
    ).toThrow(/Permanent/);
  });

  it('throws when smuggled in through the removal-job builder', () => {
    expect(() =>
      buildRemovalGui(CHUNK, {
        ...GUI_OPTS,
        deletionPolicy: 'Permanent' as unknown as 'RecycleBin',
      }),
    ).toThrow(/Permanent/);
  });

  it('rejects any other value as well', () => {
    for (const bad of ['permanent', 'Delete', '', null, undefined, 3]) {
      expect(() => assertDeletionPolicy(bad)).toThrow();
    }
  });

  it('never appears ANYWHERE in an emitted document, comment and Notes included', () => {
    for (const policy of ['Versioning', 'RecycleBin'] as const) {
      const xml = buildRemovalGui(CHUNK, {
        ...GUI_OPTS,
        deletionPolicy: policy,
        versioningFolder: policy === 'Versioning' ? GUI_OPTS.versioningFolder : null,
        note: 'operator note',
      });
      expect(xml).not.toContain('Permanent');
      expect(xml).not.toContain('permanent');
      expect(textOf(child(parseXml(xml), 'FreeFileSync'), 'Synchronize')).not.toContain(
        'Permanent',
      );
    }
  });

  it('is not constructible: the union has exactly two members', () => {
    expect([...ALLOWED_DELETION_POLICIES].sort()).toEqual(['RecycleBin', 'Versioning']);
    // A type-level check: assigning 'Permanent' to DeletionPolicy must not
    // compile. `@ts-expect-error` fails the build if the error disappears.
    // @ts-expect-error 'Permanent' is not assignable to DeletionPolicy
    const forced: DeletionPolicy = 'Permanent';
    // ...and even forced in at run time it is rejected.
    expect(() => assertDeletionPolicy(forced)).toThrow(/forbidden/);
  });
});

// ---------------------------------------------------------------------------

describe('refusals that stop an over-broad job being written', () => {
  it('refuses an empty include list, which FreeFileSync reads as "everything"', () => {
    expect(() =>
      buildRemovalGui({ ...CHUNK, includes: [], relPaths: [], fileCount: 0 }, GUI_OPTS),
    ).toThrow(/empty include/i);
  });

  it('refuses a chunk whose filter and manifest lengths disagree', () => {
    expect(() =>
      buildRemovalGui({ ...CHUNK, includes: CHUNK.includes.slice(0, 2) }, GUI_OPTS),
    ).toThrow(/inconsistent/);
  });

  it('refuses Versioning without a versioning folder', () => {
    expect(() => buildRemovalGui(CHUNK, { ...GUI_OPTS, versioningFolder: null })).toThrow(
      /requires a versioningFolder/,
    );
  });

  it('refuses a filename containing a filter wildcard', () => {
    expect(() => assertFilterSafePath('song/star*name.mov')).toThrow(/wildcard/);
    expect(() => assertFilterSafePath('song/who?.mov')).toThrow(/wildcard/);
    expect(() => assertFilterSafePath('song/back\\slash.mov')).toThrow(/backslash/);
    expect(() => assertFilterSafePath('song/ordinary & [fine].mov')).not.toThrow();
  });
});

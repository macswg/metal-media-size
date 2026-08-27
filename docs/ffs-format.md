# FreeFileSync export spec — VERIFIED against the user's own install

## Status: ground truth, not inference

FreeFileSync **14.10** is installed at `/Applications/FreeFileSync.app`.
A real config written by that exact version was read verbatim from:
`~/Library/Application Support/FreeFileSync/LastRun.ffs_gui`

Everything in the "Verified shape" section below is copied from that real file.
Element names that file never exercised were verified separately against the
14.10 binary — see "Also verified — against the 14.10 BINARY" below, including
the caveat that a *negative* strings result proves nothing.
It **supersedes** the earlier source-code-derived research, which got the
`<Synchronize>` shape wrong (it hypothesised `<Differences LeftOnly=… RightOnly=…/>`;
the real format uses `<Changes>` with `<Left>`/`<Right>` children). Do not use the
hypothesised shape.

- Root: `<FreeFileSync XmlType="GUI" XmlFormat="23">` — **XmlFormat 23 confirmed**.
- `XmlType` is `"GUI"` for `.ffs_gui`, `"BATCH"` for `.ffs_batch` (batch adds a
  `<Batch>` block — that part is NOT yet verified against a real file).

## Verified shape (real file, FFS 14.10, reformatted and path-sanitised)

> **Paths in the block below were replaced before this repository was made
> public.** Folder names, the archive root and the media-server path are
> substitutes; everything else — element names, nesting, ordering, attribute
> names and values, the empty-element convention — is exactly as FreeFileSync
> 14.10 wrote it.
>
> That is the part the golden test protects and the part the exporter depends
> on. A path is an input to the format, not a fact about it. Do not edit
> anything else in the block: the test asserts it byte-for-byte, and it is the
> only ground truth we have about this file format.

```xml
<?xml version="1.0" encoding="utf-8"?>
<FreeFileSync XmlType="GUI" XmlFormat="23">
    <Notes/>
    <Compare>
        <Variant>TimeAndSize</Variant>
        <Symlinks>Exclude</Symlinks>
        <IgnoreTimeShift/>
    </Compare>
    <Synchronize>
        <Changes>
            <Left  Create="right" Update="right" Delete="none"/>
            <Right Create="none"  Update="none"  Delete="none"/>
        </Changes>
        <DeletionPolicy>RecycleBin</DeletionPolicy>
        <VersioningFolder Style="Replace"/>
    </Synchronize>
    <Filter>
        <Include>
            <Item>*_region0.mov</Item>
        </Include>
        <Exclude>
            <Item>*/._*</Item>
            <Item>*/.DS_Store</Item>
            <Item>*/.fseventsd/</Item>
            <Item>*/.DocumentRevisions-V100/</Item>
            <Item>*/.Spotlight-V100/</Item>
            <Item>*/.TemporaryItems/</Item>
            <Item>*/.Trashes/</Item>
            <Item>/x_ArchiveFrom2025/</Item>
            <Item>*/desktop.ini</Item>
        </Exclude>
        <SizeMin Unit="None">0</SizeMin>
        <SizeMax Unit="None">0</SizeMax>
        <TimeSpan Type="None">0</TimeSpan>
    </Filter>
    <FolderPairs>
        <Pair>
            <Left  Threads="8">/Users/Shared/ObjectMount.noindex/show-archive/SHOW_2026/00_D3_Delivery</Left>
            <Right Threads="8">/Volumes/d3 Projects/showproject/objects/VideoFile</Right>
        </Pair>
    </FolderPairs>
    <Errors Ignore="false" Retry="0" Delay="5"/>
    <PostSyncCommand Condition="Completion"/>
    <LogFolder/>
    <EmailNotification Condition="Always"/>
    <GridViewType>Action</GridViewType>
</FreeFileSync>
```

### Facts settled by this file

| Question | Answer |
|---|---|
| `XmlFormat` | `23` |
| Sync directions element | `<Changes>` with `<Left>`/`<Right>`, attrs `Create`/`Update`/`Delete`, values `right`/`left`/`none` |
| `<LogFolder>` | Top-level, sibling of `<Errors>`. Empty element when unset. NOT `<Batch><LogfileFolder>` |
| Path separator on macOS | **Forward slash** — `*/._*`, `*/.DS_Store` |
| Root-relative folder filter | Leading + trailing slash: `/x_ArchiveFrom2025/` |
| Folder-pair threading | `<Left Threads="8">` — `Threads` attribute on the pair elements |
| Extra elements to emit | `<Notes/>`, `<EmailNotification Condition="Always"/>`, `<GridViewType>Action</GridViewType>` |
| Empty-value convention | Self-closing: `<IgnoreTimeShift/>`, `<LogFolder/>`, `<VersioningFolder Style="Replace"/>` |
| `<DeletionPolicy>` | Confirmed value `RecycleBin`. Source also lists `Permanent`, `Versioning` |
| `<VersioningFolder Style>` | Confirmed attr. Source lists `Replace`, `TimeStamp-Folder`, `TimeStamp-File` |

## Also verified — against the 14.10 BINARY (second source, added later)

The XML block above is a verbatim transcript of the user's real `LastRun.ffs_gui`
and is **not edited**, ever. It records what FreeFileSync actually wrote. Element
names that job never exercised were checked separately, against the binary.

**Method.** The app bundle's launcher stub `/Applications/FreeFileSync.app/Contents/
MacOS/FreeFileSync` contains no strings — a naive check there comes back empty and
looks like a negative result. The real executable is:

```
strings -n 6 /Applications/FreeFileSync.app/Contents/MacOS/FreeFileSync_main \
  | grep -nx "DetectMovedFiles"
```

**Confirmed present** (exact whole-line matches): `DetectMovedFiles` (2),
`TimeStamp-Folder` (2), `VersioningFolder` (2), `DeletionPolicy`, `Versioning`,
`RecycleBin`, `Permanent`, `GridViewType`, `Synchronize`, `FolderPairs`, `Errors`,
`PostSyncCommand`, `LogFolder`, `EmailNotification`, `IgnoreTimeShift`.

### ⚠ ABSENCE PROVES NOTHING WITH THIS METHOD

`Changes` returns **zero** exact-line hits, and `Changes` is unquestionably in the
user's real config — it is quoted verbatim above. Short strings evidently get
merged into other literals or stored inline in this binary.

> **Presence is evidence. Absence is not.** Never use a null result from a strings
> search to justify dropping or renaming an element. If a name does not turn up,
> that tells you nothing at all.

A second caveat on what the pool does and does not tell you: it is a
**deduplicated literal pool serving every format version FreeFileSync can READ**,
not a list of what version 23 writes. It contains `Differences`, `LeftOnly`,
`RightOnly`, `LeftNewer` — the legacy shape this document warns against. Presence
in the pool means "this string exists in the program", not "emit this".

### What this changes

- `<DetectMovedFiles>` — name **verified**. Now emitted as
  `<DetectMovedFiles>false</DetectMovedFiles>` in every generated removal job.
  Its **position** is still inferred (the real config does not carry the element,
  so there is no observed ordering to copy). We place it inside `<Synchronize>`,
  between `</Changes>` and `<DeletionPolicy>`. FreeFileSync reads its config by
  element name rather than by position, so ordering is not expected to matter.
- `Style="TimeStamp-Folder"` and `DeletionPolicy=Versioning` — both values
  **verified** in the binary. They are no longer source-reading guesses.
- `Permanent` is confirmed to be a real accepted value, which is exactly why the
  exporter makes it unrepresentable rather than merely un-defaulted.


## The user's existing job — do not collide with it

`LastRun.ffs_gui` shows an active workflow:

- **Left:** the archive folder we analyse.
- **Right:** `/Volumes/d3 Projects/showproject/objects/VideoFile` (a d3 media server; **not
  currently mounted**).
- **Directions:** `Left Create="right" Update="right" Delete="none"` — a one-way
  push to the server. Nothing is deleted.
- **Include filter:** `*_region0.mov` — they were pushing only the proxy files.

Our removal manifest is a **different job** and must be written to our own
`exports/` directory. Never write to `~/Library/Application Support/FreeFileSync/`,
and never overwrite `LastRun.ffs_gui`.

## Emitting a removal job

Pattern (no "delete this list" mode exists in FFS): **empty left + Mirror + Include
filter** ⇒ files present on the right but not the left are removed from the right.

Safety requirements, non-negotiable:

- `<DeletionPolicy>Versioning</DeletionPolicy>` with
  `<VersioningFolder Style="TimeStamp-Folder">…</VersioningFolder>` — every removal
  is a **move into a dated folder**, fully reversible. Never emit `Permanent`.
- `<Errors Ignore="false" Retry="0" Delay="5"/>` — stop on error, never push through.
- Emit a companion plain-text/JSON manifest of the literal resolved paths. The human
  reviews that concrete list, not the filter patterns.
- Cutting the set into jobs is the operator's choice, and both shapes are emitted
  from the same path list:
  - **one job for the whole run** (the default) — the pair is the archive root and
    the `<Include>` filter is the only thing narrowing it. One file to open, one
    Compare to read. The job says so in its own banner.
  - **one job per song folder** — the pair sits inside the song, so a job cannot
    reach the rest of the archive even if its filter were emptied. Bounds the blast
    radius; costs one file per song.
- Include the standard macOS excludes from the real file above.
- The archive mount is read-only, so FFS cannot write `sync.ffs_lock` or `.ffs_db`
  there. Emit `<DetectMovedFiles>false</DetectMovedFiles>` inside `<Synchronize>`.
  The element name is verified against the 14.10 binary (see above); its position
  is inferred. It cannot change a removal job's outcome either way — the left side
  is empty, so no right-side item has anything to be paired with as a move.

## Still unverified — flag to the user, don't paper over

- The `<Batch>` block shape (`.ffs_batch`) — no real batch file was found. Either emit
  `.ffs_gui` (verified) and let the user run it interactively, which is safer anyway,
  or have the user save one batch job from the GUI so we can read its real shape.
- Whether a filename containing a literal backslash can be filter-matched at all.
  Not relevant to this delivery folder (no such names there), so out of v1 scope.
  The exporter refuses such a path rather than guessing.
- **The position of `<DetectMovedFiles>` within `<Synchronize>`.** Name verified,
  ordering inferred. Expected to be harmless; confirm if a real config ever
  surfaces one.
- **Anchored per-file `<Include>` items** (`/SONG/file.mov`). The real config only
  shows a bare `*_region0.mov` include and an anchored *folder* exclude. Exact
  per-file includes rely on FFS traversing a directory when a child might match.
  Mitigated: each generated job states its expected row count and tells the human
  to stop if Compare disagrees.
- **An EMPTY `<Right>` folder-pair path.** Emitted by default since 2026-08-26:
  the job is generated on the machine that scanned the archive and run on one
  that reaches the same delivery folder by a different path, so the operator
  sets the folder in FreeFileSync. The real config has a path in both halves, so
  what FFS 14.10 does with an empty one — opens with a blank field, as intended,
  or complains on load — is **inferred, not verified**. Confirm by opening one
  generated job once; if FFS objects, type the destination path into the
  export dialog instead and the job ships with it filled in.
  The include items are anchored and relative, so they bind to whatever folder
  is chosen; the risk that moves with them is that the chosen folder must be the
  delivery folder ITSELF. A parent finds nothing (safe). A different archive
  with the same song and file names would find those (not safe). The job's
  banner says both, and the manifest lists every literal path.
- **A top-level XML comment.** The real config has none. Generated jobs carry one,
  and duplicate the same text into `<Notes>` — a verified element FFS displays — so
  the warning survives even if the comment is discarded.

`Style="TimeStamp-Folder"` and `DeletionPolicy=Versioning` were on this list and
have been **moved off it**: both are confirmed in the 14.10 binary.

## DECIDED with the user — build exactly this

1. **Emit `.ffs_gui` only.** Do not emit `.ffs_batch` at all — its `<Batch>` block
   shape is unverified. The GUI form is verified byte-for-byte and opens in
   FreeFileSync so the user reviews the file list and presses Compare before
   anything moves. The human-in-the-loop step is deliberate.
2. **Deletion policy is chosen per export**, surfaced in the UI:
   - `RecycleBin` — the **default**, listed first and visibly recommended.
     It is what the operator's existing FreeFileSync jobs already do, it needs
     no extra path typed in, and recovery is a gesture everyone already knows.
   - `Versioning` + `Style="TimeStamp-Folder"` — offered second. Requires a
     versioning folder path from the user, and is the better choice when a run
     is too large for the Bin.
   - `Permanent` — **never offered, never emitted.** Not a UI option, not reachable
     by config. Assert against it in the exporter and cover it with a unit test.

   *(Changed on 2026-08-26 at the user's request. Versioning was previously the
   default. Both remain reversible, which is the property that actually
   matters and which the exporter still enforces; the swap is about which
   reversible option the operator meets first.)*
3. Always emit the companion manifest (JSON + Markdown) of literal resolved paths
   alongside the `.ffs_gui`. The human reviews the concrete list, not the filter.
4. Always emit the standard macOS excludes from the verified real file.
5. Write only into the project's `exports/` directory. Never into
   `~/Library/Application Support/FreeFileSync/`; never overwrite `LastRun.ffs_gui`.
6. **The right-hand folder is left BLANK by default**, and set by the operator in
   FreeFileSync. *(Added 2026-08-26 at the user's request: "the right side of the
   ffs file should not have a location, we'll need to set the location manually
   because we'll be running it on a different location than what we're scanning".)*
   The export dialog takes an absolute path if the destination IS known, in which
   case the job ships with it filled in; under `per-song` the song folder is
   appended to it. See the unverified-list entry above for what is inferred here.
7. **Job layout is chosen per export**, surfaced in the UI:
   - `single` — the **default**. One `.ffs_gui` for everything, paired at the
     archive root, with every selected path in the include filter.
   - `per-song` — one job per song folder, each pair scoped inside its song.

   *(Added on 2026-08-26 at the user's request: "i want a single ffs file that is
   ready to remove all the files marked for deletion". Per-song was the original
   and only shape, and it is the more defensive of the two — but a keep-1 run
   produced 37 jobs to open one at a time, and a human working through 37
   near-identical jobs is a human who stops reading them. Both layouts emit the
   same path list, the same reversible policies, the same literal-path manifest,
   and both refuse to emit an empty include list.)*

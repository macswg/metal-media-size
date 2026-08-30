# HTTP API contract

Fixed up front by the coordinator so the API, frontend and exporter agents can
build in parallel. **This is a contract — do not change a route or field name
without saying so in your report.** If something here is genuinely wrong or
missing, implement what makes sense, then flag the deviation loudly.

Server binds **127.0.0.1 only**. No auth, no CORS, no external exposure.
JSON everywhere. All byte values are raw integers; the frontend formats them.

The browser app in `src/web/` is served statically at **`/`** by the same
process (`@fastify/static`), so `http://127.0.0.1:8787/` loads `index.html`.
Explicit `/api/...` routes always win over the static wildcard, and a miss
inside the wildcard falls through to the JSON 404 handler.

Start both with `npm run serve -- [--config config/d3-delivery.json] [--port 8787]`.

## Conventions

- `snapshotId` defaults to the latest complete snapshot when omitted.
- Paging: `?limit=` (default 200, max 2000) and `?offset=`. Every list response
  carries `{ rows, total, matchedBytes }` so the header can show running totals
  without a second request.
- Sorting: `?sort=<column>&dir=asc|desc`. Reject unknown columns rather than
  interpolating them into SQL.
- `keepN` defaults to **3** where a route accepts it. The conservative end of
  the range, so a caller who forgets it under-states what is deletable.
- Errors: `{ error: { code, message } }` with a sensible HTTP status. Some
  errors add `error.details` (the sort allowlist, for one).

## Routes

### Snapshots
```
GET  /api/snapshots                  -> SnapshotRow[]   newest first
GET  /api/snapshots/:id              -> SnapshotRow
DELETE /api/snapshots/:id            -> { deleted:{snapshotId,files,assets,versions,totalBytes},
                                          remaining, snapshots[], note }
POST /api/scan            {name?}    -> 202 { snapshotId, running, root }
GET  /api/scan/status                -> { running, snapshotId?, filesSeen?, elapsedMs? }
GET  /api/snapshots/:a/diff/:b?limit -> { a, b, added[], removed[], grown[], shrunk[], summary }
GET  /api/health                     -> { ok, root, scanRunning }
```

`DELETE /api/snapshots/:id` removes an INDEX ENTRY, never a file. The archive
is not touched and is not reachable from the route. A scan in flight is a 409
`scan_running` — the runner is writing rows into a snapshot and cascading them
out underneath it would be a race. Counts in the response are taken BEFORE the
delete, so they state what actually went. Deleting the last snapshot is
allowed; an empty index answers `no_snapshot` everywhere, which is a supported
state, not a broken one.

Note the ordering above: `/api/snapshots` is **newest first**. Clients that
read positionally (`[length - 1]` for the newest) must sort first — assuming
ascending order is what made the UI open on the oldest snapshot and call it
the latest.

`SnapshotRow` (camelCase; the table is snake_case):
```
{ id, root, name, status, startedAt, finishedAt, elapsedMs, fileCount,
  totalBytes, dirCount, excludedCount, excludedBytes, unparsedCount,
  skipped: [{ path, reason }] }
```

`POST /api/scan` returns **202** as soon as the snapshot row exists; the walk
continues in the background. One scan at a time — a second POST while one is in
flight is a 409 (`scan_already_running`). `/api/scan/status` also carries
`stage`, `startedAt`, `finishedAt`, `error` and `lastSnapshotId`.

**Diff** matches files by `relPath`. `added` / `removed` rows are
`{ relPath, songFolder, size, mtime }`; `grown` / `shrunk` rows are
`{ relPath, songFolder, sizeA, sizeB, delta, mtimeA, mtimeB }`. `a` and `b` are
full `SnapshotRow`s. Each list is capped at `?limit=` (default 1000, max 20000)
but **`summary` counts and byte totals are always exact**:
```
summary: { snapshotA, snapshotB, fileCountA, fileCountB,
           totalBytesA, totalBytesB,
           addedCount, addedBytes, removedCount, removedBytes,
           grownCount, grownBytes, shrunkCount, shrunkBytes,
           netBytes, listsClipped }
```

### Files
```
GET /api/files?<filters>&sort=size&dir=desc&limit=&offset=
```
Row: `{ id, relPath, songFolder, name, ext, size, mtime, parseOk,
        assetVersionId, assetId }`

`assetId` is the asset the file belongs to, so a file row can open the version
ladder without a second lookup. **Nullable** — it is null exactly when
`parseOk` is false, because an unparsed file has no asset-version and therefore
no asset.

Response envelope: `{ snapshotId, keepN, limit, offset, sort, dir, rows, total,
matchedBytes }`. The same envelope wraps `/api/versions`, `/api/songs` and
`/api/duplicates`.

Sortable columns: `id, relPath, songFolder, name, ext, size, mtime, parseOk,
assetVersionId`. Default `size desc`.

### Asset versions — the primary view
```
GET /api/versions?<filters>&keepN=<int>
```
Row: everything in `v_asset_version`, plus per-row reclaim verdict:
`{ versionId, assetId, songFolder, base, family, verNum, subLetter, verLabel,
   isPatch, patchFrame, bytes, fileCount, proxyBytes, region0Bytes, regionCount,
   latestMtime, status: 'kept'|'superseded', keepReason: KeepReason }`

`keepReason` comes straight from `computeReclaim`'s `KeepReason` union — surface
it verbatim so the UI can explain *why* a version is kept or dropped.

Sortable columns: `versionId, assetId, songFolder, base, family, verNum,
subLetter, verLabel, isPatch, patchFrame, bytes, fileCount, proxyBytes,
region0Bytes, regionCount, latestMtime, status`. Default `bytes desc`. `status` is resolved in
JS rather than SQL, but is allowlisted like the rest.

### Version ladder for one asset
```
GET /api/assets/:assetId/versions?keepN=
```
`{ asset, keepN, versions: [ ...rows, oldest first ] }`

```
asset: { assetId, snapshotId, songFolder, base, family,
         versionCount, totalBytes, supersededBytes }
```
`versions` are the same rows `/api/versions` returns. Oldest first, ordered by
`(verNum, subLetter)` with the bare version ahead of its lettered siblings, then
full ahead of its patches, then `patchFrame`.

### Reclaim math for the slider
```
GET /api/reclaim?keepN=<int>&<filters>
```
```
{ snapshotId, keepN,
  reclaimBytes, supersededCount, protectedPatchBytes, totalBytes,
  bySong: [{ songFolder, reclaimBytes, supersededCount,
             totalBytes, versionCount }],

  // additions, all derived from the same verdicts
  filtered,              // boolean: was any filter active
  ignoredStatusFilter,   // 'kept' | 'superseded' | null — see below
  versionCount, totalFiles, keptBytes, supersededFiles,
  protectedPatchCount, reclaimProxyBytes,
  region0Bytes,          // region0 (offline-edit) bytes across the rows in view
  archive: { reclaimBytes, supersededCount, supersededFiles,
             protectedPatchBytes, totalBytes } }
```

Must honour the active filter set — the slider reads "reclaims X TB **of what
I'm currently looking at**". `archive` carries the unfiltered totals alongside,
so the UI can show "X of Y" without a second request.

**HOW FILTERS COMPOSE.** `computeReclaim` ranks versions *within* an asset, so
it is always run over the **whole snapshot, unfiltered**; the filter then selects
which verdict rows are *summed*. Filtering the input instead would re-rank, and
hiding the newest version with a filter would promote an older one to "latest
kept" — reporting a live master as reclaimable. The consequence, stated plainly:
filter down to a single old version and it is still reported superseded, because
its successor genuinely exists off-screen. That is the only direction that
cannot lose a master.

**`status` IS IGNORED HERE.** `status=kept|superseded` is a predicate on the
answer this route computes, so applying it makes the figure circular:
`superseded` would always read "100% of the view is reclaimable, 0 retained",
`kept` always zero. The route parses it (a bogus value is still a 400), discards
it, and echoes it back as `ignoredStatusFilter`. Every other filter still
applies. `/api/versions` **does** honour `status` — narrowing a list to one
verdict is a reasonable thing to ask.

**Naming.** This route says `reclaimBytes` / `supersededCount`, per the contract.
The underlying `ReclaimResult` in `src/scan/reclaim.ts` calls the same numbers
`reclaimableBytes` / `supersededVersions`. Deliberate: the HTTP shape follows the
contract, the internal shape follows the scanner. They are the same quantities.

### Rollups
```
GET /api/songs?<filters>&keepN=<int>&sort=&dir=&limit=&offset=
GET /api/summary?keepN=<int>&curveMax=<int>
```

`/api/songs` row: `{ songFolder, fileCount, totalBytes, assetCount,
versionCount, supersededBytes, supersededCount, latestMtime }`, in the standard
list envelope. It **does** take `keepN` — `supersededBytes` and
`supersededCount` are meaningless without one. Sortable on any of those columns;
default `totalBytes desc`.

A song row mixes two domains: `fileCount` / `totalBytes` / `latestMtime` come
from the FILE domain, `assetCount` / `versionCount` / `supersededBytes` /
`supersededCount` from the VERSION domain. Shared filters are mapped into each
per the table at the foot of this document, so `minSize` bounds file size for the
first three and version bytes for the rest.

`/api/summary` — headline totals for the dashboard strip, always unfiltered:

```
{ snapshot: SnapshotRow, snapshotId, keepN,
  files: { count, totalBytes, totalTiB, unparsedCount, zeroByteCount,
           earliestMtime, latestMtime },
  songCount, assetCount, versionCount, patchVersionCount,
  patchBytes, versionBytes, proxyBytes, region0Bytes,
  songFolders: string[],                     // every song folder, sorted
  extensions: string[],                      // extensions present, commonest first
  byExtension: [{ ext, count, bytes }],      // the same list with counts
  excluded: { count, bytes },
  byFamily: [{ family, versions, bytes }],   // DISPLAY ONLY, never a delete signal
  reclaim: { keepN, reclaimBytes, reclaimTiB, supersededCount, supersededFiles,
             protectedPatchBytes, protectedPatchGiB, keptBytes },
  reclaimByKeepN: [{ keepN, reclaimBytes, reclaimTiB, supersededCount,
                     protectedPatchBytes }] }
```
`reclaimByKeepN` precomputes the slider curve (N = 1..5 by default, `?curveMax=`
up to 20) so the UI does not need one request per notch.

`songFolders` and `extensions` exist for the same reason: they let the filter
panel populate itself from the load the page already does. Without them the UI
had to call `/api/songs?limit=2000` a second time purely to read the folder
names off, and the extension filter could only be a free-text box, where a typo
matches nothing and says nothing. Both lists are scoped to the resolved
snapshot. `byExtension` is the counted form, alongside `byFamily`; unlike
`family`, `ext` is a real property of a file and may be filtered on.

### Duplicates — metadata only
```
GET /api/duplicates?mode=name-size
```
**Never reads file bytes.** `name-size` groups files sharing a basename and a
size across two or more paths — the same deliverable copied into two song
folders. Label results "likely duplicate — content not verified"; the UI must
not imply certainty.

`name-size` is the only mode and the default. `size-mtime` and `version-shape`
were removed at the user's request; a saved link carrying either still opens,
on `name-size`, because `version-shape` used to be the default. Any other
unknown mode → 400 `bad_mode`. Accepts the shared filters plus `limit` /
`offset`. Zero-byte files are skipped — those are an anomaly, not a duplicate.

```
{ snapshotId, mode, keepN, limit, offset,
  verified: false,          // ALWAYS false. Nothing here is content-verified.
  label: 'likely duplicate — content not verified',
  note,                     // the long-form caveat, safe to show verbatim
  rows, total, matchedBytes,
  wastedBytes }             // sum of group.wastedBytes
```

Group row:
```
{ key, kind, count, totalBytes,
  wastedBytes,              // totalBytes minus one member: one copy has to stay
  verified: false, label,
  songFolders: string[],
  members: [...] }
```
`members` are file rows (`{ fileId, relPath, songFolder, name, size, mtime,
assetVersionId }`).

### Resolution scan (extended pass)
```
POST /api/probe?snapshotId=          { concurrency?: 1..256 }   -> 202
POST /api/probe/cancel                                          -> 200
GET  /api/probe/status?snapshotId=                              -> 200
```
Reads pixel dimensions out of each file's own header — the only route that
opens an archive file. It takes hours, so the POST returns as soon as the work
list is known and the client polls `/status`.

**Unlike a scan, this can be cancelled.** A scan is one atomic walk that is
either a snapshot or nothing; a probe is tens of thousands of independent reads
whose results are written in batches as they land, so stopping halfway loses
none of the work already done and the next run resumes from it. A second POST
while one is in flight is `409 probe_already_running`, never a queued job.

```
status: { running, done, total, withDimensions, noHeader, elapsedMs,
          rate, etaMs, startedAt, finishedAt, snapshotId, error, cancelled,
          coverage: { probed, withDimensions, total } }
```
`done`/`total` describe the CURRENT run; `coverage` describes the whole
snapshot and outlives any single run. `rate` and `etaMs` are null until there
is enough elapsed time to divide by — an ETA computed from noise is worse than
no ETA.

### Anomalies
```
GET /api/anomalies?severity=high|low&limit=
```
`{ missingRegions[], orphanRegions[], unparsed[], zeroByte[], noHeader[],
   excluded{}, counts{}, severity{}, severityFilter, probeCoverage{} }`

Include the excluded-file counts from `snapshot.excluded_*` so FreeFileSync
bookkeeping files are visible rather than silently dropped.

#### Severity

`noHeader` is a file that `npm run probe` read cleanly and found to carry no
`moov` atom — a render interrupted before its header was written, so the bytes
are on disk and no player can open them. It is the ONLY category that does not
cover the whole archive: it covers what has been probed, which is why
`probeCoverage: { probed, withDimensions, total }` is returned alongside it.
**An empty `noHeader` on an unprobed snapshot is not a clean bill of health,**
and a client must not present it as one. Zero-byte files stay in `zeroByte`
rather than being reported twice.

Every row in `missingRegions`, `orphanRegions`, `unparsed`, `zeroByte` and
`noHeader` carries two extra fields:

```
severity:     'high' | 'low'
supersededBy: string | null      // ver_label, null when severity is 'high'
```

- **`'high'`** — no FULL version of that asset ranks newer than the version the
  defect sits on. This is a live master with a problem.
- **`'low'`** — a newer full version exists, so a later re-render has presumably
  already fixed it. Still reported, never hidden; the UI should de-emphasise it
  and can say "missing region 4 — superseded by v008".

**Severity does not depend on `keepN`.** A newer full version either exists or it
does not — that is a property of the archive, not of the current view. If it
tracked the reclaim slider, the same defect would change importance as the
operator dragged it. `/api/anomalies` ignores `keepN` entirely.

Patches never confer severity: a `_frameNNNNN` patch is a partial re-render and
does not replace anything, exactly as in `reclaim.ts`.

`unparsed` and `zeroByte` rows also carry `assetId` and `base`, attributed by
matching the longest asset `base` that prefixes the file name within the same
song folder (the `..._v0003b_region4_.mov` case). **A file that cannot be
attributed to an asset is `'high'` with a null `supersededBy`** — we cannot
prove anything supersedes it, so the conservative answer wins.

#### Counts and filtering

```
counts:   { missingRegions, orphanRegions, unparsed, zeroByte, noHeader,
            unparsedRecordedBySnapshot, excluded, skippedDirs }
severity: { high, low,
            byCategory: { missingRegions: {high, low}, orphanRegions: {…},
                          unparsed: {…}, zeroByte: {…}, noHeader: {…} } }
```

`?severity=high|low` filters which ROWS are emitted. **`counts` and `severity`
are always tallied over the whole snapshot** and are unaffected by `?severity=`
or `?limit=`, so a "7 high, 3 low" chip pair does not move when one is clicked.
An unknown value is a 400 (`bad_severity`).

### Region coverage — versions holding some of the canvas but not all
```
GET /api/coverage?severity=high|low&includePatches=0|1&keepN=&limit=&offset=
    + every filter param below
```
`{ requiredRegions[], requiredCount, allocationSource, rows[], counts{},
   severity{}, severityFilter, listedBytes, listedMissingSlices,
   total, matchedBytes, limit, offset, keepN, includePatches }`

A playable delivery is the whole canvas. `requiredRegions` is the set of
**non-zero** regions the playback machines carry — the same allocation
`/api/machines` reads, so on the real rig it is `1..14` and `allocationSource`
says whether that came from the built-in rig or `config/machines.json`. It is
derived rather than a hard-coded 14, so a different rig moves this view with it.

**Region 0 is never required.** It is the whole-canvas copy the offline edit is
cut against, not a slice, so a version consisting of nothing but region 0 has no
gaps to report — it is counted in `proxyOnlyVersions` instead.

Each row:
```
versionId, assetId, songFolder, base, family, verLabel, isPatch,
bytes, fileCount, region0Bytes, latestMtime, status,
present[], presentCount,     // slices this version has, never including 0
missing[], missingCount,     // required slices it does not have
extra[],                     // slices present that no machine carries
severity, supersededBy       // exactly as in /api/anomalies
```
Rows are ordered worst-first: live masters, then the widest gap, then the
largest version. There is no `?sort=` — this is a report, and the order it is
read in is part of what it says.

#### How this differs from the `missingRegions` anomaly

Both say "missing regions" and neither subsumes the other:

- `/api/anomalies` compares a version against **its own asset's modal layout**.
  It finds versions that disagree with their siblings. An asset whose every
  version has ten slices is self-consistent and invisible there.
- `/api/coverage` compares a version against **the canvas**. That same asset is
  ten-fourteenths of a delivery in every version it has, and shows up here.

#### Counts

```
counts: { completeVersions, incompleteVersions, incompletePatchVersions,
          proxyOnlyVersions, regionlessVersions,
          listedVersions, listedAssets }
```

**The first four are a partition**: every version the filters matched lands in
exactly one of `complete` / `incomplete` / `proxyOnly` / `regionless`, whatever
`includePatches` is set to, so a client can add them up and get the whole
archive. `regionless` (a legal whole-canvas deliverable, no region token) and
`proxyOnly` are separate categories and merging them hides one inside the other.

`listedVersions` / `listedAssets` describe the narrower set the route actually
LISTS, and `listedBytes` / `listedMissingSlices` are over that same set. Like
`/api/anomalies`, none of them move with `?severity=` or `?limit=`.

`includePatches=1` adds partial patch versions to `rows`. Off by default: a
`_frameNNNNN` render covers a frame range and is *expected* to touch only some
slices, so listing every patch as broken would make the view useless. They are
counted in `incompletePatchVersions` either way and are never invisible.

#### Filtering narrows the report, never the evidence

The region index is built over the **whole snapshot**, always. The filters
decide which versions are reported; they must never decide which files count as
evidence about a version, or a `path=*_region1.mov` filter would strip the
slices out from under every version on screen and report the archive as full of
holes. Same principle as *"`/api/reclaim` filters the OUTPUT, not the input"*.

Severity is exactly the `/api/anomalies` verdict and **does not depend on
`keepN`** — this route reads `keepN` only to annotate each row's `status`.

This route proposes nothing for removal. An incomplete version may be a delivery
still in flight.

### Export
```
POST /api/export
{ versionIds: number[], formats: ('json'|'markdown'|'ffs_gui')[],
  deletionPolicy: 'Versioning'|'RecycleBin',
  jobLayout?: 'single'|'per-song',
  rightFolder?: string | null,
  versioningFolder?: string, note?: string }
-> { files: [{ format, path, bytes }], summary: { fileCount, totalBytes } }
```
`deletionPolicy` is **required** and must be one of exactly those two values.
`'Permanent'` must be rejected with a 400 — see `docs/ffs-format.md`. That check
runs **first**, before any other validation and before the exporter is even
loaded, so it can never be skipped by an otherwise-malformed request.

Returns **201**. Actual response:
```
{ files: [{ format, path, bytes }],
  summary: { fileCount, totalBytes, versionCount, assetCount, songCount,
             chunkCount, artifactBytes, runId, exportDir, deletionPolicy,
             warnings },
  selection: { versionCount, fileCount, totalBytes, snapshotId, keepN,
               deletionPolicy },
  note }
```
`summary.fileCount` / `totalBytes` are the **archive files the export proposes
to move**, not the artefacts written. `summary.artifactBytes` is the artefacts.

`jobLayout` decides how many FreeFileSync jobs come out. `'single'` (the
default) emits ONE `.ffs_gui` for the whole run, paired at the archive root with
every selected path in its include filter. `'per-song'` emits one per song
folder, each pair scoped inside its own song so a job cannot reach the rest of
the archive. Same path list, same reversible policies, same companion manifest
either way; an unknown value is a 400 (`bad_job_layout`). See
`docs/ffs-format.md`.

`rightFolder` is the folder the emitted job will act on. **Absent or empty is
the default and leaves the job's `<Right>` blank** — the operator sets it in
FreeFileSync, because the machine that runs the job reaches the delivery folder
by a different path than the machine that scanned it. The include patterns are
anchored and relative, so they bind to whatever folder is chosen. A supplied
value must be an ABSOLUTE path (`bad_right_folder` otherwise); under
`per-song` the song folder is appended to it.

**`files[].format` includes `'ffs_manifest'`**, which is not one of the three
requested `formats`. Every `.ffs_gui` job ships with a companion literal-path
manifest so a human reviews concrete paths rather than filter patterns; it is
emitted whenever `ffs_gui` is requested. Clients must tolerate the extra value.

Further validation, all 400:
| code | when |
|---|---|
| `deletion_policy_required` | `deletionPolicy` absent |
| `deletion_policy_forbidden` | `deletionPolicy: 'Permanent'` |
| `bad_job_layout` | `jobLayout` present and not `single` or `per-song` |
| `bad_right_folder` | `rightFolder` present, non-empty, and not an absolute path |
| `bad_deletion_policy` | any other value |
| `versioning_folder_required` | policy is `'Versioning'` with no `versioningFolder` |
| `bad_formats` | empty, or a format outside the three |
| `bad_version_ids` | empty, or not all positive integers |
| `unknown_version_ids` | an id that does not exist |
| `mixed_snapshots` | ids spanning two snapshots — that path list never existed |

`503 exporter_unavailable` if `src/export/index.ts` is missing. The route never
improvises an exporter.

## Filter query params (shared by /files, /versions, /reclaim, /songs)

```
songFolder=<exact>          ext=mov,tif
minSize=<bytes>             maxSize=<bytes>
mtimeFrom=<epochMs>         mtimeTo=<epochMs>
path=<glob>                 pathRe=<regex>
family=<label>              status=kept|superseded   (ignored by /api/reclaim)
isPatch=0|1                 hasProxy=0|1|only
q=<substring>
```

A file row carries `width`, `height` and `probed`. Dimensions come from
`npm run probe`, a separate pass that reads the file's own header; a scan never
does. `probed: false` means nobody has looked. `probed: true` with null
dimensions means the file was read and has NO header atom — an interrupted
render, which is a different fact and must be shown as one. `sort=resolution`
orders by pixel count (`width * height`), because 8996x2584 and 3976x3248
cannot be ordered on either axis alone; unprobed rows sort as zero.
`/api/summary` reports `media: { probed, withDimensions, total }`.

`hasProxy` spans BOTH subtotals: `proxyBytes > 0 OR region0Bytes > 0`. Region0
is the whole canvas and `_proxyN` is a resolution — two facts that coincide in
this delivery and need not in the next, so the filter asks about either. The
param keeps its name; the UI calls the control **Proxy/region0**.

`hasProxy=only` is the third state: that, AND `regionCount = 0` — a version
that is a whole canvas with nothing behind it, shown as **Has Region 0 only**.
Those are not deliveries of the asset (see the proxy-only rule), which is why
they are separately selectable.

`region0Bytes` is a per-version subtotal of the bytes held in region0 files.
`/api/reclaim` returns it summed over the rows in view (kept and superseded
alike — it is a property of the archive, not of the keep-N verdict), and
`/api/summary` returns it for the whole snapshot.

Build these with parameterised SQL. `pathRe` must be applied in JS over a
bounded candidate set, never interpolated into SQL.

## Hard rules for every agent

1. **Nothing may write to the archive.** Only `src/export/writer.ts` may write
   anything at all, and only inside `exports/`.
2. Do not import `node:fs` outside `src/fs/readonly.ts` and
   `src/export/writer.ts` — `test/readonly-enforcement.test.ts` fails the build.
3. Do not use `family` to classify anything as removable. Display only.
4. Reuse `computeReclaim` / `loadReclaimInput` from `src/scan/reclaim.ts` and
   `src/db/index.ts`. Do not reimplement the patch rule.

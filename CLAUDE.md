# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`metal-media-size` analyses a large d3 (disguise) media-delivery archive and
identifies superseded asset versions so they can be removed. It is a **read-only
instrument**. It scans, indexes, filters and exports. It never modifies the
archive.

Target: `/Users/Shared/ObjectMount.noindex/show-archive/SHOW_2026/00_D3_Delivery`
— a read-only macFUSE object mount. ~26.7k files, ~133.8 TiB, 65 song folders,
two levels deep. A full walk takes ~12 s cold.

Run it: `npm run scan` then `npm run serve`, then open `http://127.0.0.1:<port>/`.
`npm run probe` is a separate, optional pass that reads pixel dimensions from
the file headers — see "The one place that reads bytes" below.

## The safety invariants — do not weaken these

These are the reason the project is trustworthy. Every one is enforced by a test
that **fails the build**. If a change requires weakening one, stop and ask.

1. **`src/fs/readonly.ts` is the only module that touches the archive.** It
   exposes `readdir`, `lstat` and `openRead` (flag hard-coded `'r'`). Nothing else.
2. **`src/export/writer.ts` is the only module allowed to write anything at all.**
   `test/readonly-enforcement.test.ts` walks `src/` and fails if any write
   primitive (`writeFile`, `unlink`, `rename`, `rm`, `rmdir`, `chmod`, `utimes`,
   `truncate`, `mkdir`, `copyFile`, `appendFile`, `createWriteStream`) appears
   outside it, or if `node:fs` is imported outside those two files.
   **The check does not strip comments** — avoid those words in prose too.
3. **The export jail.** `writer.ts` resolves real paths and refuses to write at or
   under the object mount, any scan root, `/Volumes`, FreeFileSync's config
   directory **on any platform** (`~/Library/Application Support/FreeFileSync`,
   `%APPDATA%\FreeFileSync`, `~/.config/FreeFileSync` — all of them are in the
   list, not just this machine's), or **any UNC path** (`\\server\share`), which
   is the Windows analogue of `/Volumes` and cannot be expressed as a root
   prefix. It also refuses the filename `LastRun.ffs_gui`. Exports may only land
   inside `exports/`. See "Windows" below for why the platform spread matters.
4. **`DeletionPolicy: 'Permanent'` is unreachable.** Not in the type union, the
   builder asserts against it, and the string appears nowhere in emitted XML.
   Only `RecycleBin` (the default, and what the UI recommends) and `Versioning`
   are permitted. Both are reversible; that is the property being enforced.
5. **The app never deletes.** It emits a manifest; the human runs FreeFileSync.
   No UI copy may imply otherwise.

## Domain rules that are easy to get wrong

### Filename grammar
```
<base>_v<NNN>[<letter>][_frame<NNNNN>][_proxy3]_region<N>.mov
```
A logical *version* is up to 15 files: `region1`–`region14`, the slices the
media is cut into for the venue, plus `proxy3_region0`, a low-res whole-canvas
preview. "Up to" is load-bearing: a version missing a slice is an anomaly, and
one carrying only the proxy is not a playable version at all.

**The slices within a region set are wildly unequal in size.** Never estimate a
version's bytes from its region count, and never treat a large region as more
significant than a small one — the split reflects how the canvas is carved up,
not how much of the picture each slice carries. Only summed bytes mean anything.

`base` is the asset identity and is used **verbatim**. Do not normalise, stem or
fuzzy-match it — `140_RIVER_ANIMATIC_LL180` and `140_RIVER_ANIMATIC_IMAG_LL180` are
different deliverables and merging them would be wrong.

### `region0` is the whole canvas; `_proxyN` is a resolution
Two different facts that happen to coincide here. **Confirmed by the user:**
*"the region0 files are also proxies, but that will not always be the case. The
region0 files are necessary for offline editing."*

So they are counted separately and neither is derived from the other:

- `asset_version.proxy_bytes` — bytes in files carrying a `_proxyN` token.
- `asset_version.region0_bytes` — bytes in files whose region is 0.
- **`region_count` counts slices, and region0 is never one of them** — with or
  without the proxy token on the name. It used to be excluded only when it was
  a proxy; a full-resolution `_region0` would have ranked as a playable slice
  and let a version carrying nothing but the offline-edit copy supersede a
  master. Excluding region0 outright is the protective direction and measured
  as a no-op on this archive (all 2,151 region0 files here are `_proxy3`, and
  the integration ground truth did not move by a byte).
- Anything asking "is there a whole-canvas copy here?" — the `hasProxy` filter,
  in the UI the **Proxy/region0** control — asks about **both**. `hasProxy=only`
  means a whole canvas with no slices behind it, shown as **Has Region 0 only**.
- The board carries a **REGION 0s** figure next to Retained: how much of what is
  in view is offline-edit material. 2.175 TiB measured 2026-08-26, exactly
  equal to the proxy subtotal — the coincidence this rule expects to outlive.

Pinned by `test/region0-rule.test.ts`. The query param stays named `hasProxy`
so saved links keep working.

### `v002d` is a SEPARATE VERSION from `v002`
Ordering is `(ver_num, sub_letter)` with an absent letter first:
`v002 < v002a < v002d < v002f < v003`. **Confirmed directly by the user.**

An earlier implementation folded sub-letters into the version number. That was
wrong, cost ~900 GB of under-reported reclaim, and must not be reinstated. The
reasoning is recorded in `src/scan/reclaim.ts` and `src/scan/derive.ts`.

### The patch rule
`_frameNNNNN` marks a **partial re-render / patch**, not a replacement.
- Version ranking considers **full (non-patch) versions only**.
- A full version can **never** be superseded by a patch.
- A patch is kept iff no kept full version is newer than it.
- Consequently protected-patch bytes are constant across every keep-N.
- **A patch layers on the newest full BELOW it — its base — and a kept patch
  always keeps that base.** Confirmed by the user: *"v004 and a v005 patch are
  both needed. A v006 replaces v004 and the v005 patch."* This needs no code:
  a kept patch has no kept full newer than it, and the latest full is kept at
  every N, so the patch's base *is* the latest full. Structural, not
  incidental — asserted in `test/patch-rule.test.ts` and against the real
  archive in the integration suite, because it is what would break silently if
  rule 3 were ever rewritten to key patches off their own version number.

### The proxy-only rule — a preview never supersedes a master
**Confirmed by the user:** *"proxy only files can be used for offline editing,
but cannot be used for show, so do not count them as a valid version for
playback."*

A version may consist of nothing but its `proxy3_region0` preview, with no
region files at all (`regionCount === 0`). That is **not a delivery of the
asset** and must never be ranked as one.
- Supersession ranking considers **region-bearing full versions only**. A
  proxy-only version takes no slot in the keep-N window and pushes nothing out.
- A proxy-only version is kept iff no kept region-bearing version is newer —
  the same test the patch rule uses.
- **Exception, and it matters:** an asset with *no* region-bearing version at
  all ranks its previews normally. There is no master to protect, and 326
  assets in the archive are preview-only. Leaving them permanently
  unreclaimable would forfeit real space for nothing.
- `regionCount` is required on `ReclaimVersionInput`; a missing value reads as
  0 (proxy-only). An unplumbed caller must lose reclaim, never regain the
  power to delete masters.

Without this rule the policy marked 85 region-bearing versions (3.86 TiB, of
which 3.17 TiB was the last full-resolution copy of its asset) as superseded by
a preview. `580_CAUSEWAY_0000A_LL180` was the clearest case: v002 is 475 GiB of
masters, v003 is a single 1.5 GiB proxy, and keep-1 proposed deleting v002. The
correction moved keep-1 from 52.87 → **49.69 TiB**. Do not reinstate the old
figure. Reasoning is recorded in `src/scan/reclaim.ts` and pinned by
`test/proxy-only-rule.test.ts`.

Those two numbers are a record of what the fix did on the archive as it stood
that day, not a live reading — the archive grows, and keep-1 measures 49.87 TiB
at snapshot 8. What must never come back is the 3.17 TiB of last-copy masters
the rule protects; the headline figure is expected to drift.

### Region gaps measure against the CANVAS, anomalies against the SIBLINGS

`/api/coverage` and the **Region gaps** tab answer one question: which versions
carry *some* of the canvas but not all of it. `requiredRegions` is the set of
**non-zero** regions the rig carries, read from `src/machines.ts` — so it is
`1..14` today, derived rather than a `14` written down, and it follows
`config/machines.json` if that ever supplies a different rig.

This is the one place the machine allocation informs a statement about the
archive, and it is a *reporting* use only. It still decides nothing about
supersession: `status` on every row arrives from the usual whole-snapshot
`computeReclaim`, and severity comes from `src/server/severity.ts`.

**It does not duplicate the `missingRegions` anomaly.** That one compares a
version against its own asset's modal layout and finds versions that disagree
with their siblings; an asset whose every version has ten slices is
self-consistent and invisible there. This one compares against the canvas, and
that asset is ten-fourteenths of a delivery in every version it has. Neither
subsumes the other. On the archive at snapshot 12 the two happen to agree
exactly — 2 versions, `520_GOSE_..._v003b` missing region 4 on a live master and
`140_ONE_SOLDIERS_LL180 v002` missing 8 — because every asset's layout *is* the
full fourteen. That agreement is a finding, not a reason to merge them.

- **Region 0 is never required**, for the same reason it is never a slice.
- **The region index is built over the WHOLE snapshot**, never the filtered
  rows. Filters choose which versions are reported; they must never choose which
  files count as evidence about a version, or `path=*_region1.mov` would report
  the archive as full of holes. `test/server/coverage.test.ts` pins this.
- **The four buckets are a partition** — complete / with-gaps / region0-only /
  regionless — so the panel can add them up to every version in view and have
  the arithmetic hold. `regionless` is a legal whole-canvas deliverable and is
  not the same thing as `proxyOnly`; merging them hides one inside the other.
- **Patches are counted but not listed by default.** A `_frameNNNNN` render
  covers a frame range and is expected to touch only some slices.
- `presentCount` is re-derived from file names with the scan's own parser and is
  asserted equal to `asset_version.region_count` for every version — two
  implementations of one rule, pinned to each other. Measured as an exact match
  on all 2,530 versions of the real archive.

### Severity lives in `src/server/severity.ts`

Shared by `/api/anomalies` and `/api/coverage`. `high` = no full version of the
asset ranks newer; `low` = one does, so a re-render presumably fixed it.
**It never depends on keepN**, and nothing in that module may consult the
reclaim policy. It was extracted from the anomalies route when the second
consumer arrived: a second implementation would be a second idea of which
version is newest, and the two would disagree the first time the grammar moved.
`compareVersions` does the ordering, as it does in `reclaim.ts`.

### `noHeader` is the only anomaly that needs a probe
Every other category is derived from names, sizes and counts, so it covers the
whole archive by construction. `noHeader` covers only what `npm run probe` has
read. `/api/anomalies` therefore returns `probeCoverage` alongside it, and the
UI must say what was checked — **an empty list on an unprobed archive is not a
clean bill of health, and must never be shown as one.** Zero-byte files stay in
`zeroByte`; do not report them twice.

### Anomaly severity does not depend on keepN
`high` = no newer full version exists (a defect on a live master).
`low` = a newer full version exists and presumably fixes it — still reported,
never hidden, just de-emphasised. Severity reflects the archive, not the current
view; `/api/anomalies` has no access to the reclaim policy at all. Keep it that way.

### `/api/reclaim` filters the OUTPUT, not the input
`computeReclaim` runs over the whole snapshot; filters are applied to its
verdicts. Filtering the input would let hiding the newest version promote the
next one down to "latest kept" — reporting a live master as reclaimable. There is
a test named for this: *hiding a successor does not make a version safe*.

### Duplicates are metadata-only
Never read file bytes to compare them. The mount is object storage and reading
means egress. Always label results "likely duplicate — content not verified".

### The one place that reads bytes: `npm run probe`
A file's pixel dimensions are in neither its name nor its stat, so the only way
to know them is to read the container header. That is a **measured, opt-in
exception**, not a loosening of the rule above:

- `src/scan/media.ts` walks the QuickTime atom table only. It **seeks over
  `mdat`** and never touches sample data — a 293 GB master costs 8 positioned
  reads totalling ~210 bytes. Measured on the real mount: ~6 MB for all 26,651
  files. `test/media.test.ts` asserts no read lands inside `mdat`.
- **A scan never does this.** `npm run probe` is a separate command the operator
  runs on purpose — or the "Run resolution scan" button, which drives the same
  pass through `POST /api/probe`. Do not fold it into `npm run scan`.
- **It needs `UV_THREADPOOL_SIZE`.** Node's libuv pool is **4 threads** by
  default, and every header read goes through it. At the default, asking for 64
  lanes gets you four: the archive probes at ~4.7 files/s instead of ~10, and
  worse, the web UI starves — `index.html` took **4.1 s** to serve while a probe
  ran, because static reads queue behind ~1 s archive reads.
  **`src/cli/threadpool.ts` sets it, in Node, and it must stay the FIRST import
  of `serve.ts` and `probe.ts`** — ES modules evaluate imports before the
  importing module's body, so anywhere else and the pool may already exist. It
  used to be a shell prefix in the npm script, which did not run on Windows at
  all (see below). An explicit value in the environment still wins.
- **It is cancellable, and a scan is not.** That difference is deliberate: a
  scan is one atomic walk, a probe is thousands of independent reads written in
  batches as they land. `POST /api/probe/cancel` stops it and keeps everything
  already read. Only one probe at a time, in-process — do not run the CLI and
  the server pass at once, or two writers will contend for the same SQLite file.
- Results land in `file_media`, a table of its own, so the insert-only promise
  on a scan's rows holds literally: the probe adds rows and edits none. It is
  resumable, and `carryForwardMedia` re-uses results across a rescan for files
  whose (path, size, mtime) did not change.
- A file that reads cleanly but has **no `moov` atom** is a render interrupted
  before its header was written — bytes on disk that nothing can play. Report
  that as its own state; never merge it with "not probed yet". The archive has
  at least one: `180_NIGHTLIGHT_LAYOUT_LL180_v003_region5.mov`, 140 GB.
- Dimensions are display dimensions from `tkhd`. The coded size in `stsd` was
  compared across a sample of this archive and agreed on every track, so the
  cheaper of the two is read.

### The machine allocation is NOT a partition

`src/machines.ts` maps canvas regions to playback machines. The same region may
be held by several machines — a redundant pair, a spare, an editorial box — so
per-machine bytes **sum to more than the archive holds**, and the difference is
real duplicated media rather than an arithmetic slip.

Nothing may present those totals as shares of a whole. `/api/machines` returns a
`reconcile` block putting every byte in view into exactly one of four
categories — allocated (counted once, however many machines hold it),
unallocated (a region no machine claims), regionless (a valid name with no
region token), unparsed (a name the grammar cannot read) — and the UI states the
overlap as a number. `test/server/machines.test.ts` asserts the four sum to the
matched total.

Two things that look alike and are not: **regionless** is a legal deliverable
covering the whole canvas; **unparsed** is a name nothing here understands.
Merging them hides the second inside the first.

The allocation is a statement about the RIG, never about the archive. Nothing in
that module decides what is superseded; the verdict arrives on each file row
from the usual whole-snapshot `computeReclaim`.

**The rig.** Fourteen **actors** (101–206) carry the fourteen canvas slices, one
each. Seven **understudies** (207–305) carry the same fourteen, two each. **306**
is the director and **307** its understudy, both on region 0. So every region
sits on exactly two machines and every playable byte is stored twice — the rig
holds 2.00× what the archive does. `test/server/machines.test.ts` asserts that
shape, including that the pairing is mutual.

`role` decides exactly one thing, and only since the user confirmed it: **which
of a region's two holders actually plays it.** `isPrimaryRole` says actors and
directors do and understudies do not, and `rollUpMissing` keys off that — see
"the master list" below. Nowhere else may read it; it is a label everywhere else,
and it still decides nothing about supersession. `peers` is derived from the
region lists, never stated, so it cannot drift from them.

**101–206 vs 207–305 is a confirmed boundary.** It was first given with 206 in
both ranges; the user then confirmed *"101-206 are actors, 207-305 are
understudies"*. 206 holds one slice (r2) exactly as every other actor holds one.

`allocationSource` is `'built-in'` — the real rig, compiled into the source. It
is not a guess and the UI must not disclaim it as one. It becomes `'config'`
when `config/machines.json` is read.

**A 32 TB drive holds 29.10 TiB, not 32 TiB.** `DEFAULT_DRIVE_CAPACITY_BYTES` is
`32_000_000_000_000` — the decimal figure a manufacturer labels, confirmed with
the user. This is the most consequential constant in the view: at 32 TiB the
fullest machine reads 85.8% and looks comfortable, at the real capacity it reads
94.4% and does not. A test pins it against `32 * 1024 ** 4`.

`DEFAULT_DRIVE_RESERVE_FRACTION` (5%, also confirmed) is held back before
anything is called full. **Fullness percentages are of USABLE space**, so `over`
means "into the reserve" rather than "physically full" — reachable while the
drive still has bytes on it, and the line worth flagging. 301 sits at 99.4%.
Capacity and reserve are separate constants rather than one usable figure, so
the meter can draw the headroom as a visible part of the drive instead of
silently shrinking it.

### `family` is a display label
Never use it to classify anything as removable.

## The rig survey — the one thing that leaves this machine

`/api/rig/*` and the **Region Gaps (cluster)** tab read a directory on each
playback machine over SMB and compare it with the archive. The tab sits directly
after **Region gaps** and is named for it, at the user's request: it asks the
same question — which slices of the canvas are actually here — of the machines
instead of the archive. **The id stays `rig`** everywhere else (route, panel,
tab id, saved links); only the label moved. It is the only feature that touches
anything outside this Mac, and it is fenced accordingly.

### The mount is read-only, and the kernel enforces it

`src/rig/mounts.ts` mounts every share with `mount_smbfs -N -o rdonly,nobrowse`.
From `mount(8)`: *"even the super-user may not write it."* That is a stronger
guarantee than "this application does not write" — **nothing** on this Mac can
write through those mountpoints, Finder and root included. Verified on the real
rig: `touch` and `mkdir` both fail with `Read-only file system`, locally, before
anything reaches the machine.

`readOnly` is read back out of the mount table, never assumed, and `mountShare`
**refuses to return** a mount that did not come back read-only. A share the
operator connected in Finder is read-write; that is reported as
`otherWritableMount` rather than hidden, and the UI says "also open in Finder".

### `src/rig/mounts.ts` is a chokepoint, like `readonly.ts`

- **The only file in `src/` that may import `node:child_process`**, and the only
  one that may name `mkdir`. Both enforced by `test/readonly-enforcement.test.ts`.
- **Exactly four commands**, all absolute, all via `execFile` so there is no
  shell: `/sbin/mount`, `/bin/mkdir`, `/sbin/mount_smbfs`, `/sbin/umount`.
- **The `mkdir` is LOCAL and EMPTY.** A mountpoint is a directory on *this* Mac
  that a share is grafted onto; the remote machine never hears about it. Jailed
  to `MOUNT_ROOT` under the system temp dir — not `/Volumes`, which is
  `root:wheel`.
- **`umount` is jailed to the same root.** It can never reach `/Volumes`, a
  volume the operator connected, or the object mount holding the archive.
- Nothing here removes a directory or writes a file.
- `assertHost` is an **allowlist of shapes** (IPv4 or DNS name), because the
  host becomes both a URL component and a directory name. `10.10.1.999` is
  refused: it is a valid DNS name and always actually a typo'd address.

### The password is in the command line, deliberately

`mount_smbfs` takes a credential in exactly one place — the URL. There is no
stdin or environment form. The user was told and chose it: *"the passwords for
the smb share are just guest accounts so they're not meant to be secure"*. Do
not silently reverse that on the grounds that it looks wrong in isolation; the
trade bought a kernel-enforced read-only mount. `-N` is always passed, or a bad
password makes `mount_smbfs` prompt on a terminal a server has not got.

### Nothing about the machines is stored

Addresses, mountpoints, results and the credential live in `RigSession`, an
object in memory. Not in `data/index.db`, not in `config/`, not in `exports/`,
not in a log. The only artefacts that outlive the session are the two files the
operator saves **from the browser**, and neither is written by this application
— both are rendered into a response body and handed to the operator's own save
dialog, so where they land is the operator's choice:

- the **target YAML**, which carries addresses and **never** a credential —
  `formatTargetsYaml` takes no credential argument, so it cannot;
- the **missing-list CSV** (`GET /api/rig/missing.csv`,
  `src/rig/missing-csv.ts`), which carries machine **ids** and no address or
  credential, because the roll-up has neither in it. Asserted behaviourally
  against a session that holds both, not left to inspection.

The CSV is the WHOLE roll-up, not the 500 rows the tab paints: an export that
stopped where the table stops would be a list of findings with findings missing
from it. Sizes are raw bytes — a spreadsheet can sum and sort a number and can
do neither with `2.06 TiB`.

### The survey never opens a file

It calls `readdir` and `lstat` and nothing else — not one byte of any file on a
machine is read. Pinned by a test. Comparison is by name and size only, exactly
like the duplicate detector, and results say so.

### `objects/VideoFile` is where d3 keeps the media

On a playback machine the media sits at `<project>/objects/VideoFile`, so the
survey directory is nearly always a project folder plus those two segments. The
**append d3 VideoFile path** checkbox beside Browse is that fact — ticked by
default, because it is what the operator wants nearly every time.

- The typed directory and the checkbox are two ways of writing ONE path.
  `surveyDirectory()` is the only thing that composes them, and everything that
  surveys or stores a path calls it.
- **Appending is idempotent**: a directory already ending in the suffix is left
  alone, so typing it out *and* ticking the box cannot produce
  `.../objects/VideoFile/objects/VideoFile`.
- **The session stores the composed path**, and `splitVideoFile` takes it back
  apart on load. Without that, a reloaded tab would show the suffix in the box
  beside an unticked checkbox, and ticking it would append a second copy.
- The line under the field states the whole path, updated on every keystroke and
  on the checkbox — a control whose effect the screen does not show is a control
  somebody surveys the wrong folder with. The directory picker's footer says the
  same composed path, for the same reason.

### The directory may be browsed, and browsing is less than surveying

`GET /api/rig/browse` (`src/rig/browse.ts`, the **Browse…** button beside the
survey directory) lists **one directory, one level deep, on one mounted
machine**, so the path can be picked instead of typed. Typing still works.

It exists because that field's mistake is *silent*: a directory that is not
there walks as an empty machine, and an empty machine reports as one with
nothing on it — or, where the archive expects nothing of it, as a clean one.

- **`readdir` and nothing else.** No recursion, no `lstat`, no file opened —
  strictly less than the survey, through the same `ReadOnlyFs` fenced to that
  machine's mountpoint. **No size is in the payload**: a size costs a round trip
  per file on SMB, and comparing sizes is the survey's job.
- **One machine, and the response names it.** The survey applies one directory
  to every machine, so this is choosing a path, not inspecting a rig. A path on
  301 and not on 302 is a finding the **survey** makes; a picker that listed
  somewhere else would pre-empt it.
- **A symlink is neither a folder nor a file here** — not descended into, not
  counted. Following one is how a listing leaves the share.
- **A cut-short list says so** (`truncated`, at 500 entries) and **a missing
  directory is an error, not an empty listing** — either one reading as
  complete would recreate the failure the feature removes.
- Escape is refused twice, as for a typed path: `assertRelativeDirectory` for
  the message, `ReadOnlyFs` for the guarantee.

### What the comparison means

Buckets are named for what an operator would DO about them, and every file on a
machine lands in exactly one: `missingKept` (the alarm — current media absent),
`sizeMismatch` (same name, different size — both readings are bad),
`presentSuperseded` (space a cleanup returns), `missingSuperseded` (already
cleaned off, not a problem), `presentKept`, `extraForeign` (a region another
machine holds — a copy in the wrong place), `extraUnknown` (a region THIS
machine holds, that the archive has no file for), `extraUnparsed` (a name the
grammar cannot read), `regionless`. `inSync` is deliberately about playback, not
tidiness: old media on a drive is a space problem, not a show-stopper.

**A file with no region is not a finding.** The allocation is *by region*, so a
name carrying no `_regionN` belongs to no machine: it is neither missing from
one nor extra on one, and reporting it as either invents a finding. It goes to
`regionless`, which is counted (the buckets must still sum to what is on the
drive) and stated in one quiet line, never listed as something to act on.
Confirmed by the user: *"if not in the archive at all just means content without
a region ignore these files"*. On the first real rig this was 388 files, 0.63
TiB, on one machine — whole-canvas deliverables reading as strangers.

**`regionless` and `extraUnparsed` are not the same thing**, for exactly the
reason `/api/machines` keeps them apart: one is a legal whole-canvas deliverable,
the other is a name nothing here understands. Merging them hides the second
inside the first — and the second is real: `120_LIQUID_CUE_H_LL180_v006_region0_proxy3.mov`
writes its tokens in the wrong order, and there are 45 such files on one machine.

**Every list is columned, and every column resizes.** Song, file, version and
region are four questions and get four columns — `src/web/js/gridtable.js`, with
the drag itself in `src/web/js/colsize.js`, shared with the virtualized Files
table so there is only one idea of what dragging a column edge means.

**Which rows, then which order — two decisions, and `gridTable` keeps them
apart.** Lists are capped (300 per section, 500 on the master list), so rows
arrive in the SERVER's order — biggest first, alarms first — and `max` takes
from the top of that; `order` then decides how the survivors are read. So a
capped list is still the largest 300 *and* reads by song, which is what the user
asked for. There is no sort control: a header that re-ordered the list would undo
the first half silently and the cap would stop meaning anything.

**"Still on" names machines that HAVE it, and nothing else.** A holder that was
not surveyed shows an em dash, not its id: the column answers "where can I still
get this?", and naming a machine while saying nothing about it reads as a
finding at a glance and is not one. The id is on the tooltip, and "we did not
look at 207" is stated once in the card's own warning rather than a thousand
times down a column. Asked for by the user. The three other readings stay
distinct: green ids (a good copy), `NNN (wrong size)`, and `nowhere` — which
means every holder was surveyed and none has it.

**On the master list, song order never crosses a state.** A `missing` file sorted
under a late song, below a screenful of `spare lost`, is exactly the failure the
states exist to prevent. `bySongWithinState` reads the group order off the rows
rather than restating it, so it cannot drift from `rollUpMissing`'s ranking.

For a file the index has no row for, the version and region columns are read off
the NAME by the scan's own grammar (`describeName`, injected exactly as
`regionOfName` was). The label is composed by `formatVerLabel` in
`src/scan/parse.ts` — the same function that composes `asset_version.ver_label`
at index time, so there is one spelling of a version in the whole application.
Anything that HAS a stored label still reads that label out of the database.

**Two buckets are counted but not displayed**, both at the user's request, and
both still in `totals`:

- `missingSuperseded` — media already off a machine. Nothing to do about it.
- `extraUnknown` — media carrying a region this machine plays that the archive
  has no row for. It is the one bucket the archive can form no opinion about, so
  it could only ever be read and wondered at. (On the real rig it is empty: what
  used to fill that section was `regionless`, which is now ignored outright.)

### The master list: the actor decides, the understudy is a backup

`rollUpMissing` folds every machine's `missingKept` into one list at the top of
the tab. It exists because a per-machine card answers *"what is wrong with
301?"* and an operator asks *"what is wrong with the show?"*.

**The two holders of a region are not equal.** **Confirmed by the user:** *"the
understudy machines are backups, so if files are not found on the main (actor)
machine they are missing."* So the verdict is decided by the **primary** holder
— the actor, or the director for region 0 — and the backup decides only what it
costs to fix:

- **`missing`** — not on its primary, and no surveyed machine has a good copy.
  The archive is the only place left to get it from. (Called `gone` until the
  user asked for the plainer word; the state key was renamed with the label, so
  the CSV and the API say what the screen says.)
- **`recoverable`** — not on its primary, so the show cannot play it, but the
  understudy has a good copy: restore from the rig, not from the archive.
  **Still an alarm.** This is what used to be called `reduced` and read as "the
  show still plays" — which was wrong, and wrong quietly.
- **`unconfirmed`** — the **primary** was not surveyed. The machine that decides
  was not read, so there is no finding to make. **Never report this as an
  alarm.** Note the scope: an unread *backup* leaves every verdict intact and
  only the repair route unknown, and is reported as a hint rather than a
  warning. An unread *primary* is a finding the list cannot make at all, and
  `unsurveyedPrimaries` is what the loud warning is keyed on.
- **`spareLost`** — the primary has it; a backup does not. The show plays and
  the redundancy is gone. The only state here that is not an alarm.

`unplayable` is `missing + recoverable`: the files the show cannot play. That,
not `missing` alone, is what the header pill and the per-region chips count.

**When no holder is a primary** — an allocation naming no roles, or machine ids
this rig does not know — every holder decides, which is the old
any-copy-will-do behaviour and the only safe reading without them. Pinned by a
test.

**A wrong-sized copy is not a copy.** A holder carrying the right name at the
wrong size does not count towards `presentOn` — that would turn a `missing` into
a `recoverable` and hide the fact that the archive is the only source left.

**What this replaced, and why the old numbers moved.** The first version treated
both holders as equal, so a file missing from the actor but present on the
understudy was `reduced` ("the show plays"), and a file missing from a surveyed
actor with the understudy unsurveyed was `unconfirmed` ("we did not look"). On
the first real run that made all 1,293 findings `unconfirmed`. Under the user's
rule those are missing from the machine that plays them: surveying 207 could
only ever have moved them from `missing` to `recoverable`, never to fine. The
honesty rule did not go away — it moved onto the primary, which is the only
machine whose absence is the finding.

An address with no machine id is surveyed but **not compared** — expectations
are keyed by machine, and guessing which machine an address is would invent the
one fact the comparison rests on.

### The other half: media that is here, in the wrong place

`rollUpMisplaced` and the **On the wrong machine** card answer the question that
sits beside the missing list. A per-machine card can say *"this file belongs to
another machine"* (`extraForeign`); it cannot say whether the machine it belongs
to HAS it, because that is a fact about a different machine. A file copied to
the wrong place is missing from one drive and taking up space on another — two
findings, on two cards, and neither implies the other.

Four states, named for what an operator would do:

- **`rescue`** — a rightful holder is short of it, and here it is. The nearest
  copy is on the rig, not in the archive. This is the reason the card exists.
- **`duplicate`** — every rightful holder has a good copy. Space on the wrong
  drive; a cleanup, not an alarm.
- **`unconfirmed`** — a rightful holder was not surveyed, so which of the two
  above this is cannot be said.
- **`unknown`** — the archive has no row for the name. Its region still says
  which machines carry that slice, but whether anything needs it cannot be
  answered from here.

**A superseded file is never a rescue.** If the archive has replaced it, no
machine is short of it however few copies exist, and moving it would be moving
old media around the rig.

**A wrong-sized copy on the rightful holder counts as needing it** — the same
rule the missing roll-up uses, pointing the same way: towards the finding.

**`archiveStatusByName` is not optional.** Nobody reports a file the archive has
never seen as missing, so without it silence would classify a stray as
`duplicate` — *"the right machines already have it"* — on no evidence at all. It
covers every name in the snapshot, regionless files included, because the
question it answers is "does the archive have this name", which is not a
question about regions. Built in the same pass as the expectations.

## FreeFileSync

See `docs/ffs-format.md`. It records what is **verified** (against the user's real
`LastRun.ffs_gui` from FFS 14.10, and against the 14.10 binary) versus what is
inferred. Respect that distinction — do not promote an inferred claim to verified
without new evidence, and do not edit the golden XML block: apart from paths,
which were substituted before this repo went public, it is a verbatim transcript
of a real config and the golden test asserts exact equality against it. The
structure is the ground truth; a path is an input to the format, not a fact
about it.

Emit **`.ffs_gui` only**, never `.ffs_batch` — the `<Batch>` block shape is
unverified, and the GUI form keeps a human in the loop before anything moves.

Note: **presence of a string in the FFS binary is evidence; absence is not.**
The binary holds a deduplicated literal pool covering every format version it can
*read*, including the legacy `<Differences>` shape. `Changes` returns zero hits
despite being in the real config.

## Windows

`start-analyser.bat` is real: this runs on a PC as well as a Mac, and three
things had quietly broken there. All three were invisible on macOS, which is
what made them worth tests rather than comments. `test/portability.test.ts`
pins them.

- **No shell syntax in an npm script.** `UV_THREADPOOL_SIZE=64 node ...` is a
  POSIX assignment and a Windows *program name* — npm runs scripts through
  `cmd.exe`, so `npm run serve` and `npm run probe` did not start at all, and
  `start-analyser.bat` calls `npm run serve` as its last line. Set environment
  variables in Node, never in the script.
- **Quote globs with double quotes.** `cmd.exe` strips those and leaves single
  quotes in place, so `--exclude '**/x'` reaches the tool with the quotes
  attached and matches nothing.
- **A forbidden root written for one platform protects nothing on another**, and
  says nothing while it fails to. See the export jail above.

What is already portable, and should stay so: `walk.ts` normalises `rel_path` to
forward slashes at the point of capture (it is stored in the index, shown in the
UI and written into the FreeFileSync manifest); every path-boundary check uses
`root + sep`, never `'/'`, or `C:\archive-other` would look like it was inside
`C:\archive`; `better-sqlite3` ships `win32-x64` and `win32-arm64` prebuilds, so
no build tools are needed.

**The rig survey is the one macOS-only feature.** `src/rig/mounts.ts` runs
`/sbin/mount_smbfs` and friends. On Windows there is nothing to mount — a UNC
path is read directly, and `ReadOnlyFs` would fence it exactly as it fences
anything else — but there is also no `-o rdonly` equivalent, so the read-only
guarantee would have to come from the share's own permissions instead of from
the kernel. Do not port it by quietly dropping that guarantee; it is the reason
the feature is shaped the way it is.

## Stack

Node 26, TypeScript, ESM, **no build step** — runs under
`node --experimental-strip-types`. Avoid TS parameter properties; strip-only mode
rejects them. `better-sqlite3` is pinned to **13.0.3** (v11 will not compile on
Node 26). Frontend is plain ESM modules with no bundler. Tests are vitest.

## Conventions

- `data/index.db` and `exports/` are gitignored. Never commit either — the index
  is a structural map of the archive and exports contain real run output.
- Snapshots are insert-only and diffable. A scan never mutates a prior snapshot.
- The archive is **live** — it changed during development. Expect counts to drift.
- Update `PROGRESS.md` by prepending a dated entry; don't rewrite history.
- Edit `PLAN.md` in place; don't append a "v2" section.

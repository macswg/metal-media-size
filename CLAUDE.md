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
   under the object mount, any scan root, `/Volumes`, or the FreeFileSync
   application-support directory. It also refuses the filename `LastRun.ffs_gui`.
   Exports may only land inside `exports/`.
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
  means a whole canvas with no slices behind it, shown as **Region 0 only**.
- The board carries a **Region 0** figure next to Retained: how much of what is
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
  ran, because static reads queue behind ~1 s archive reads. `npm run probe` and
  `npm run serve` both set `UV_THREADPOOL_SIZE=64`. If you launch either with a
  bare `node` command, expect both symptoms back.
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

### `family` is a display label
Never use it to classify anything as removable.

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

# PROGRESS.md

Running log, newest on top. Prepend new entries; don't rewrite history.

## 2026-08-26 — first human-driven verification; THE PROXY-ONLY RULE added

Ran the whole thing from a clean checkout against the live archive. The scan
reproduced the recorded figures exactly (26,655 files, 133.57 TiB, keep-1
52.87 TiB / 864). Then found a policy defect that changes those figures.

### The defect: a preview could supersede a master

`computeReclaim` ranked every non-patch version against every other. But 671 of
2,403 versions consist of **nothing but** their `proxy3_region0` preview — no
region files at all. The policy treated those as complete deliveries, so a
preview sitting above a master marked the master superseded.

Archive-wide that was **85 region-bearing versions, 3.86 TiB**, of which
**3.17 TiB was the last full-resolution copy of its asset**. The clearest case:

- `580_CAUSEWAY_0000A_LL180` — v002 is 15 files and 475 GiB of masters, v003 is
  a single 1.5 GiB proxy. keep-1 proposed deleting v002 and keeping v003.
- `520_THICKET_HERON_IDLE_0000A_ALPHA_LOOP_LL180` — both v003 and v003b (625 GiB
  of masters) superseded by a 4 GiB proxy at v004.

The at-risk previews cluster on **2026-08-20 and 2026-08-25**, days old, sitting
above masters from July. They are previews of work **in progress** whose regions
have not been delivered yet. Running that export would have left assets with no
playable master, on an archive with no backup.

### The fix

Rules 6 and 7 in `src/scan/reclaim.ts`, deliberately shaped as the patch rule's
sibling: supersession ranking considers region-bearing versions only; a
proxy-only version is kept iff no kept region-bearing version is newer.

**The exception matters as much as the rule.** An asset with no region-bearing
version at all ranks its previews normally — 326 assets are preview-only, and
a blanket "previews never rank" would have made 571 GiB permanently
unreclaimable to protect nothing. Confirmed working: 268 stale previews are
still reclaimed at keep-1, and the 8 preview-only assets that have more than one
version still supersede internally.

`regionCount` is now required on `ReclaimVersionInput` and a missing value reads
as **0 (proxy-only)** — an unplumbed caller loses reclaim, which is visible and
harmless, rather than silently regaining the power to delete masters.

### Numbers moved — this is the correction, not a regression

```
            before            after
keep 1   52.87 TiB / 864   49.69 TiB / 795
keep 2   19.83 TiB / 316   18.19 TiB / 400
keep 3    5.97 TiB / 127    5.63 TiB / 304
```

Superseded **counts rise** at keep 2/3 while bytes fall: previews no longer
occupy kept slots, so more fall out of the window — but they are tiny, and the
masters they were displacing are now retained. Do not "restore" 52.87 TiB.

**354 tests passing** (was 315). New `test/proxy-only-rule.test.ts` (14 tests),
verified genuinely red — 9 of 14 fail when the ranking line is reverted. Two new
archive-wide invariants in the integration suite: *never marks a master
superseded by a preview alone*, and *keeps the newest master of every asset at
every keep-N*.

### Also verified by hand this session

- Clean install, `npm run scan`, `npm run serve`, all API routes exercised.
  Note the server listens on **8787**, not 8803 as an earlier entry said.
- Generated a real export and read the `.ffs_gui` by hand: `<Include>` list is
  byte-identical to the companion `.paths.txt`, all 45 paths exist on disk,
  `Delete="right"` on the left pair only, `DeletionPolicy` is `Versioning`, and
  `Permanent` appears nowhere in any emitted XML.
- The stale export generated earlier in the session under the buggy policy was
  deleted rather than left sitting in `exports/`.

### Section 3 defect #1 resolved: it is the filename, not the render

`520_THICKET_CANOPY_AFTERGLOW_0000B_ALPHA_LOOP_LL180_v0003b_region4_.mov` is
**4,340,164,566 bytes** against v0003's region4 at **4,339,374,903** — a 0.02%
delta — and carries the same mtime as all 14 of its v0003b siblings. The render
is healthy; only the name has a stray trailing underscore. The grammar was left
alone: the file is correctly reported as an anomaly and can never enter an
export. Tolerating a trailing underscore is now a safe, optional change.

### Section 3 defect #2 confirmed, no action needed

`140_RIVER_MARCHERS_LL180` v003 and v008 are byte-identical across all 15 files
(19,006,476,511 bytes). v007 and v009 differ, so it is not a copied ladder —
v008 specifically reproduces the v003 render. Both are superseded by v009 at
keep-1 already, so this changes nothing. Still metadata-only: **likely
duplicate, content not verified.**

### Still needs a human

- Drive the UI in a browser. Headline should now read **49.69 TiB / 795** at
  keep-1. Flick-scroll the table; the *feel* of virtualization is still
  unmeasured.
- Open an export in FreeFileSync and press **Compare only**.
- Confirm the proxy-only reading with someone who knows the pipeline: a version
  delivered as a preview with no regions is never a replacement for the masters
  below it. Everything above rests on that, and it is the one assumption the
  filenames do not state outright.

---

## 2026-08-25 — initial build complete, checkpoint pushed

Built in one session by four parallel agents against a fixed schema and HTTP
contract. **315 tests passing.** Verified rendering in Chrome against the live
API: 52.87 TiB headline, 864 superseded versions, 2,403 rows, working slider,
zero console messages on a clean reload.

**Done**
- Scanner, parser, SQLite index, snapshots, `computeReclaim`
- Read-only enforcement tests — verified genuinely red by introducing real
  violations (8 different `fs`-import forms, all caught)
- HTTP API, all routes; static mount at `/`
- Frontend: table, filters, version ladder, reclaim slider, anomalies,
  duplicates, snapshot diff, export dialog
- Exporters: JSON, Markdown, `.ffs_gui` + literal-path manifest; export jail
  (34 tests, incl. symlinks planted in `exports/` pointing at the archive)
- FreeFileSync format verified byte-for-byte against the user's real
  `LastRun.ffs_gui` (FFS 14.10) and against the 14.10 binary

**Corrections made during the build, worth remembering**
- `v002d` and `v002f` are **separate versions**, not sub-revisions of v002. The
  planning prototype folded them and the core agent reconciled to that wrong
  figure. Unfolding moved keep-1 from 51.99 → **52.87 TiB** (~900 GB). Ordering
  confirmed by the user: `v002 < v002a < v002d < v002f < v003`.
- `/api/reclaim` was circular under a `status` filter; it now ignores `status`.
- Anomaly severity was added so a defect on a superseded version is reported but
  de-emphasised. Deliberately independent of keep-N.
- "Verified against the FFS binary" was overstated — the binary holds a literal
  pool covering every format version it can *read*. Presence is evidence;
  absence is not. Recorded in `docs/ffs-format.md`.

**Findings in the archive itself**
- `520_THICKET_CANOPY_AFTERGLOW_..._v003b` is **missing region 4**, and it is that
  asset's newest full version — so nothing downstream fixes it. The file on disk
  is `..._v0003b_region4_.mov` with a stray trailing underscore. Unresolved:
  whether that's a bad render or just a bad filename.
- `140_RIVER_MARCHERS_LL180` v003 and v008 have byte-identical per-region sizes
  across all 15 files (17.7 GiB) — almost certainly a re-render producing
  identical output.
- Only 8 anomalies archive-wide, all `high`. The archive is in good shape.
- `find` at the mount root and on `25_EAGLES` **stalls indefinitely**. The target
  delivery folder is unaffected. Cause unidentified.

**Also fixed during the checkpoint push**
- Two source files (`src/web/mock/mock-api.js`, `src/server/routes/duplicates.ts`)
  contained **raw NUL bytes** — intentional sentinels in glob→regex conversion,
  but written as literal bytes instead of `\x00` escapes. Git classified both as
  binary, so they would never have produced a readable diff. Escaped; behaviour
  unchanged. Worth re-checking if new generated code lands:
  `find src test -name '*.ts' -o -name '*.js' | xargs grep -lP '\x00'`

---

# PICK UP HERE

## Start it

```sh
cd ~/git/metal-media-size
npm install
npm run scan      # ~12s; writes data/index.db (gitignored)
npm run serve     # then open http://127.0.0.1:8803/
```

`src/web/mock/fixture.json` is gitignored and won't exist on a fresh clone. That
is fine — the UI probes the live API first. Mock mode simply won't be available
until someone regenerates a fixture; **there is no generator script for it yet**
(it was produced ad hoc). Write one if mock mode matters, or delete
`src/web/mock/` if it doesn't.

## 1. Verify with a human at the keyboard — do this first

Nothing below matters until the app is confirmed working by a person. The test
suite is green and the API agent confirmed it renders in Chrome, but no human has
driven it.

- Flick-scroll the table hard. Virtualization was instrumented but **frame
  timings could not be measured** — the tab backgrounds under browser
  automation, throttling `rAF`. The structural guarantee (constant ~1,000 DOM
  nodes, one page fetch per window) is solid; the *feel* is unverified.
- Drag the keep-N slider and sanity-check the headline against
  `PLAN.md` / this file: keep-1 should read **52.87 TiB / 864 versions**.
- Generate an export and **read the `.ffs_gui` by hand** before FreeFileSync ever
  opens it. Check the `<Include>` list matches the `.paths.txt` beside it.
- Then open it in FreeFileSync and press **Compare only** — never Synchronize on
  a first run. Confirm the row count matches the banner. Stop if it doesn't.

## 2. Confirm two domain assumptions with someone who knows the pipeline

Both are inferences that the filenames do not actually state. Both change what
the tool recommends deleting.

- **The patch rule.** `_frameNNNNN` is treated as a partial re-render that a
  later full version absorbs, so a patch below the newest full version is marked
  superseded. Deciding case: `140_RIVER_INTRO_LL180` — fulls at v001/v002/v006/v007
  with a 225 GiB patch at v004.
- **`region0`/`proxy3`.** Treated as belonging to its version and sharing its
  fate (2.17 TiB total). If proxies are ever needed independently of their
  version, this is wrong.

## 3. Two real defects found in the archive — not tool bugs

- `520_THICKET_CANOPY_AFTERGLOW_..._v003b` is **missing region 4**, on the newest
  full version, so nothing downstream fixes it. The file on disk is
  `..._v0003b_region4_.mov` — a stray trailing underscore. Determine whether the
  render is bad or only the filename. If it's the filename, the grammar could
  tolerate a trailing underscore; if the render is bad, that's a delivery issue.
- `140_RIVER_MARCHERS_LL180` v003 and v008 have byte-identical per-region sizes
  across all 15 files (17.7 GiB). Almost certainly a re-render producing
  identical output — a candidate for removal, but confirm before trusting it.

## 4. Known gaps, deliberately deferred

None of these block use.

- **`/api/summary`** returns no song or extension lists, so the song dropdown
  costs a second `/api/songs?limit=2000` call and the extension filter is
  free-text only.
- **Select-all-filtered** expands to explicit `versionIds` by paging at limit
  2000. Fine at ~2.4k versions; would need a filter-based export if that grows.
- **`.ffs_batch` is not emitted** — only `.ffs_gui`, which is the verified
  format. To add batch support, save a real batch job from the FreeFileSync GUI
  and read it byte-for-byte first. Do not infer the `<Batch>` block.
- **Anchored per-file `<Include>` items** and top-level XML comments in the
  emitted `.ffs_gui` are unverified against a real config. See
  `docs/ffs-format.md`, which separates verified from inferred throughout.
- **The mount-root `find` stall** is unidentified. Irrelevant to this tool (the
  root allowlist prevents wandering there) but real, and it will bite any other
  tool pointed at that mount.
- `project_code/show_2026/` is an **empty leftover directory** on disk.

## 5. If you extend it to another show

The parser, exclusions and families are all in `config/d3-delivery.json` — no code
change needed for another **d3 delivery folder** using the `_regionN` convention
(`25_EAGLES`, `26_EJ`, `26_JAY`, `26_RAYE` all have one).

But **other projects on that mount use entirely different region conventions** —
`MS`/`FF` screen codes, embedded screen names, bracketed `[part_N]` tags, or no
region concept at all. Those need new parse rules, not just a new root. Do not
assume this grammar generalises.

# PROGRESS.md

Running log, newest on top. Prepend new entries; don't rewrite history.

## 2026-08-27 — the report is named for when it was produced

> *"name the report with the current date and time like this
> media_cleanup_report_27Aug2026_1112"* — the user

`report.html` in a mail thread is indistinguishable from last month's
`report.html`, which is a real hazard for the one artefact here designed to be
forwarded. It is now
`media_cleanup_report_27Aug2026_1131.html`.

Two decisions inside that:

**LOCAL time, not UTC.** The name is read by the person who produced the report,
on the machine that produced it, and a stamp seven hours off the clock on their
wall is worse than useless for telling two runs apart. The UTC instant is still
printed inside the document, so the precise fact is not lost.

**Fixed month literals, not the platform's.** A locale-aware month would name
the same run `27ago2026` on another machine. The twelve strings are in the
source. Day and time are zero-padded so a folder of these sorts within a month.

Tested against Dates built from LOCAL components rather than `Date.UTC`, so the
expectations hold in any time zone — a UTC fixture would have asserted one thing
here and another in CI.

## 2026-08-27 — the summary names the folder it is talking about

> *"change 'on the storage today' to 'total assets today' then just below these
> stats put the storage path scanned so it is very clear what directory we're
> scanning"* — the user

The first tile is **TOTAL ASSETS TODAY**, and under the pair of them the scan
root, in full and in mono:

    FOLDER SCANNED — EVERY FIGURE IN THIS REPORT COMES FROM HERE AND NOWHERE ELSE
    /Users/Shared/ObjectMount.noindex/.../00_D3_Delivery

The path was already in the report, on page three under provenance. That is too
late for the reader this page exists for, who may never turn it: a headline
figure with no folder attached is a number about nothing, and the archive has
sibling delivery folders that would produce a different one. Naming it beside
the figures is what makes them checkable.

## 2026-08-27 — the summary opens with the storage, not with the options

> *"at the top of the summary i want these stats (current size of everything in
> the storage location, current size of region 0 assets)"* — the user

Two stat tiles above the safety banner: **133.77 TiB** on the storage today
(26,685 files across 65 song folders), and **2.17 TiB** of region 0 — 1.6% of
it. The reader now has the size of the thing before being asked what to do
about it.

`region0_bytes` is summed straight out of `v_asset_version` rather than off
`reclaimInput`, because region 0 is not something the reclaim policy needs in
order to rank a version and has no business on that input. It also stays
summed independently of `proxy_bytes`: the two coincide on this archive and are
not required to, which is exactly the rule that would rot if one were derived
from the other. Both are on the dataset as `storage`, which is archive-wide by
construction — a test proves the tiles do not move when the proposal shrinks.

The fixture had been writing `region0_bytes` as the column default, 0, so the
figure was untestable until the seed started inserting it. It now carries 3 GiB
across two whole-canvas copies, and the assertions are real.

Built as stat tiles rather than a chart, and the values wear text tokens rather
than the accent — the accent belongs to the bars, where it carries meaning.
They also take the font's proportional figures on purpose: `tabular-nums` gives
every digit the width of a zero, which reads loose at 26px, and these are
standalone numbers rather than a column that has to line up.

Also, at the user's word: the banner reads *"No file on the storage has been
touched"*, and the column is **Left on the drive(s)**.

## 2026-08-27 — the summary stopped pointing at a row nobody asked about

> *"the this export flag is confusing. i want a summary that just presents the
> options, the executive will not know which export is selected. also instead of
> archive reclaim call is Media Cleanup"* — the user

Page one badged the row the attached job used, `THIS EXPORT`, and tinted it.
That was written for the operator, who knows what they selected. The person the
page is actually for does not know an export exists, and a highlighted row reads
to them as a recommendation nobody made. The badge, the tint and the whole
"What is on the table right now" block are gone; page one is four options and
the key to reading them, and nothing on it belongs to the attached job.

The tie-back moved to page two, where the export is the subject rather than an
intrusion: **The proposal attached to this report** carries the headline figure,
names which option it is (*"the current + 2 previous versions option on page
one"*), and says so plainly when the operator narrowed the selection and the job
covers only part of that option.

What page one gained in its place is the material that holds whichever option is
chosen — the current version is never removed, fixes are never treated as
replacements, a preview never displaces a master, nothing is erased. Those are
the facts that make the table trustworthy, and none of them depend on the choice.

`test/report.test.ts` pins it structurally: the choice table carries no badge and
no tinted row, and the export's headline block does not appear anywhere before
page two starts.

Retitled **Media cleanup — executive summary**, in the masthead and the `<title>`.

### Dark on screen, ink on paper

The palette is dark, as asked. Every colour was already a token, so the
`@media print` block redefines the lot and the document prints black-on-white
exactly as before — 90 pages, unchanged. That is not a hedge: printing a dark
page either floods it with toner or, when the browser drops the backgrounds,
leaves pale text on white. The PDF route is the whole reason this artefact is
HTML, so it has to come out of a printer legible. A test asserts both palettes.

## 2026-08-27 — a report you can send to someone who will never open this tool

> *"i want to add an export that is an easily sharable report... an executive
> summary of the options; how much space will be recovered if only the current
> version is kept, if current and one previous version..."* — the user

New export format, `report`, producing `report.html` beside the existing
artefacts. Page one is the decision and nothing else:

    If we keep…                       Recovered   Cost of one more   Left on the drive(s)
    Current version only               49.87 TiB              —              83.89 TiB
    Current + 1 previous version       18.26 TiB      −31.61 TiB             115.50 TiB
    Current + 2 previous  THIS EXPORT   5.71 TiB      −12.56 TiB             128.06 TiB
    Current + 3 previous                1.49 TiB       −4.22 TiB             132.28 TiB

Measured on snapshot 11. The third column was "Archive after" until the user
asked what it meant, which was answer enough: it is now "Left on the drive(s)",
and a "Reading the columns" line under the table defines all three and says the
two figures on each row add back up to the 133.77 TiB the folder holds today. The pages after it are what the Markdown review
already carried, re-cut for someone reading it cold: what this export contains
and what running it does, provenance, the per-song split at every setting,
every affected asset showing what goes next to what stays, then the file list.

### HTML, not PDF

Producing a PDF directly means a PDF library or a headless browser — a large
dependency in a project with three, in the one module whose output a person is
expected to trust — to gain a format the browser will produce from this file
with `Cmd-P → Save as PDF`. So the report is HTML with a print stylesheet
(`@page`, `break-after: page`, `break-inside: avoid` on every table and ladder,
`print-color-adjust: exact` so the bars survive printing). The full keep-3 set
comes out as a 100-page PDF that paginates cleanly.

Self-contained is a property, not a preference: inline CSS, no script, no font,
no image, no link. It has to render on the machine of whoever it is forwarded
to, offline, with no part of it silently missing. `test/report.test.ts` asserts
the emitted file contains no `http:`, no `<script`, no `src=`, no `@import`.

### The scenario table is archive-wide; the rest of the document is this export

Two different scopes in one document, so both are stated on the page rather
than left to be inferred. The reason is the rule that already governs
`/api/reclaim`: `computeReclaim` ranks an asset's versions against each other,
so narrowing its input promotes an old version to "latest kept" and reports a
live master as reclaimable. `buildScenarios` therefore runs over the whole
snapshot at every N, and a test proves the four rows do not move when the
export's selection shrinks from six versions to one — while the export's own
totals do, which is the whole distinction.

The arithmetic an executive cannot check is asserted instead: keeping more
versions can never free more space (and `buildScenarios` throws rather than
render an impossible table); each row's stated cost equals the gap to the row
above; the total under management is identical in every row; the patch
protection does not move when the choice does.

### The number the report will not print

The path list is capped at 2,000 entries. When the cap bites the page says how
many it is not printing and points at the `.paths.txt` manifest — a truncated
list that looked complete is the single worst failure this document could have.

### Fixture

`test/report.test.ts` builds its own archive rather than borrowing the export
suite's: five full versions so keep-1 through keep-4 are genuinely different
(a table of four identical rows would pass a monotonicity assertion), a live
patch so the constant protection is not trivially zero, a preview-only version,
and a song folder called `010_ONE & TWO <LL180>` so escaping is exercised by
the same names the archive actually uses.

## 2026-08-26 — the emitted job no longer names the folder it will act on

> *"the right side of the ffs file should not have a location, we'll need to set
> the location manually because we'll be running it on a different location than
> what we're scanning right now"* — the user

The `.ffs_gui` now ships with `<Right Threads="8"></Right>` — empty — and the
operator sets the folder in FreeFileSync. This works, and only works, because
the include items are anchored and RELATIVE: `/110_ENGINE/..._v001.mov` binds to
whatever folder is chosen, so the same job is correct against any mount of the
same delivery folder.

The risk moves with it, and the job says so before it says anything else:

    SET THE RIGHT-HAND FOLDER BEFORE YOU DO ANYTHING ELSE.
    ...
    IT MUST BE THAT FOLDER ITSELF, not its parent and not a subfolder.
    Point it one level too high and Compare finds nothing, which is the safe
    failure. Point it at a DIFFERENT archive that happens to share song and
    file names and it would find those instead, which is not.

It also states the folder as scanned, as the thing to match, and the checklist
gains a step 0. The companion manifest's header says `Pair right: (blank in the
job -- set it in FreeFileSync before running)` and explains that its literal
paths are written against the scan root while the job matches on the part after
it.

### An empty pair path is INFERRED, not verified

The real 14.10 config has a path in both halves. What FFS does with an empty one
— open with a blank field, or complain on load — has not been observed, so it is
on the unverified list in `docs/ffs-format.md` with the mitigation named: open
one generated job once, and if FFS objects, type the destination path into the
export dialog instead and the job ships with it filled in.

### One meaning per value

`rightFolder` was briefly `string | null | undefined` with `undefined` meaning
"as scanned". A test caught the obvious: `{ rightFolder: undefined }` is not
distinguishable from omitting the key in any way a caller should have to reason
about, and the failure mode is a blank job nobody asked for. It is
`string | null` now — blank unless a path is given, and a caller who wants the
scanned path passes it.

## 2026-08-26 — a redeployed module could come back from the browser cache

Found while verifying the export dialog: a headless run reported the new control
missing from a page that was definitely serving it. The file on the wire had it;
the browser replayed an older copy.

`@fastify/static` was configured `cacheControl: false`, whose comment read "no
caching". It does not mean that. It only stops the plugin SENDING a
Cache-Control header, and a response with no Cache-Control may still be cached
heuristically — browsers guess a lifetime from Last-Modified. So every redeploy
was a race between the operator's reload and a guess.

The static handler now sends `Cache-Control: no-cache`, which means "store it,
but revalidate every time". Confirmed on the live server: the header is present
and a conditional request still answers 304, so revalidation stays cheap.

Worth keeping in mind for anything that looks shipped-but-missing on a page that
has been open across a restart.

## 2026-08-26 — one FreeFileSync job, not thirty-seven

> *"when i export a manifest i get a bunch of ffs files, but i want a single ffs
> file that is ready to remove all the files marked for deletion"* — the user

The exporter cut the removal set one job per song folder, and split a song again
past 750 paths. A keep-1 run therefore produced 37 `.ffs_gui` files (plus 37
companion manifests) to open one at a time.

`jobLayout` is now an export option, defaulting to `'single'`: one `.ffs_gui`
for the whole run, its folder pair at the archive root, every selected path in
the include filter. Measured on the live index at keep-1: **one 668 KiB job
naming all 8,091 files, 49.87 TiB, across 37 song folders**, with a 1,089 KiB
literal-path manifest beside it.

### What the layout actually trades

Per-song is the more defensive shape and it stays available in the dialog: each
pair points INSIDE one song, so a job cannot reach the rest of the archive even
if its filter were emptied. The single job gives that up — the pair is the
archive root and the include filter is the only thing narrowing it.

Everything else is identical, and deliberately so: `Create="none"`
`Update="none"` `Delete="right"`, a reversible deletion policy, the literal path
manifest beside the job, the refusal to emit an empty include list. The single
job also says its own scope out loud in the banner — that the pair is the root,
that the filter is what narrows it, and to check the row count after Compare
every time.

That is a trade for the operator to make, not for this tool to make quietly, so
it is a labelled choice in the export dialog with the consequence written next
to each option.

### The path-list invariant now runs under both layouts

`THE PATH LIST CANNOT DIVERGE` is the suite that proves the XML filter, the JSON
manifest, the text manifest and the Markdown all render the same array. It was
written against song-relative patterns; it is parameterised over both layouts
now, because the two resolve their patterns against different pair roots and
must still land on the same absolute paths. Six new tests cover the single job
itself, including that `maxPathsPerChunk` does not split it — not splitting is
the whole point — and that an empty include list is still refused.

## 2026-08-26 — on a phone, the page scrolls

The desktop shell is 100dvh with `overflow: hidden` and one scroller, inside
the table. On a phone that pins the topbar, the reclaim strip, the tabs and the
toolbar to the glass forever: chrome you have already read, taking a third of
the screen, with no way to push it out of the way.

Below 760px the DOCUMENT scrolls now. The chrome scrolls off the top, the list
gets the whole screen once it has, the column header stays legible by being
sticky, and the status bar is pinned to the bottom edge.

### The virtualizer had to learn a second scroll container

`vtable.js` measured `scroller.scrollTop` against `scroller.clientHeight`. In
page mode the scroller does not scroll at all, so it reads the spacer instead:
how far `.vt-canvas` has travelled above the top of the window IS the offset
into the list. One `getBoundingClientRect` per frame, taken before any write,
and no cached page offset to go stale when the chrome above changes height.

Which mode is in force comes from `viewport.js` — the one place the breakpoint
is written for both the stylesheet and the JS. **Reading it back off the
scroller's computed `overflow-y` was tried first and is a trap:** at
construction the answer came back `auto`, so the table ignored the page scroll
entirely and only came right when something forced a resize. The breakpoint is
a media query; ask the media query.

### The sticky footer was extending the document

`position: sticky; bottom: 0` on the LAST child has its displacement counted
into the scrollable overflow: 81px of dead document under the bar, and in those
81px the bar drifted up off the bottom edge. It is `position: fixed` now, with
its height measured by a ResizeObserver and published as `--statusbar-h` for
the shell to reserve — measured, not assumed, because the bar wraps to two
lines exactly when the figures are long enough to matter.

### Verified in a real browser, over CDP

Headless Chrome under `--virtual-time-budget` dispatches no scroll events and
runs no animation frames, so it will report a scroll-driven feature as broken
whether or not it is. Driving a real headless browser over the DevTools
protocol instead (Node's built-in `fetch` and `WebSocket`, no dependencies):

    at scrollY 5000   rows 141-191 mounted
    at scrollY 30000  rows 975-1025 mounted
    at the bottom     row 2404 mounted, 36 rows in the DOM
    last row bottom 717 = status bar top 717, 0px of dead document

Desktop re-checked at 1440x900 and unchanged: the page does not scroll, the
scroller still owns it, the status bar is still a grid row. All four tabs flow
into the page on a phone.

## 2026-08-26 — the Region 0 figure was reaching the browser as an em dash

Shipped in v0.5.5 and immediately invisible. The server returned
`region0Bytes`, the strip rendered the fact, and the value read `—`.

`normaliseReclaim` in `web/js/api.js` rebuilds the reclaim response from an
explicit allowlist of fields — it exists so that a server calling the figure
`reclaimableBytes` instead of `reclaimBytes` degrades to a cosmetic problem
rather than a blank headline. The cost of that shape is that a field nobody
adds to the list is silently dropped between the fetch and the paint. Six
files were plumbed; the seventh was the one that mattered.

Worth remembering as a class, not an incident: **adding a field to a reclaim
response means adding it to the normaliser too.** Nothing fails, nothing logs,
and the UI shows the em dash it shows for "the server did not tell us".

Caught by rendering the real page headless and reading the DOM rather than by
trusting the curl of the endpoint, which was correct all along.

## 2026-08-26 — region0 counted in its own right

The board gained a **Region 0** figure beside Retained, and the proxy filter
became the **Proxy/region0** filter. The reason the change is more than a label:
region0 and `_proxy3` are two different facts about a file that this delivery
happens to apply to the same 2,151 files.

> *"the region0 files are also proxies, but that will not always be the case.
> The region0 files are necessary for offline editing."* — the user

So `asset_version` now carries `region0_bytes` alongside `proxy_bytes`, derived
from the region token and not from the proxy token, and nothing derives one
from the other. Measured on the live archive: 2.175 TiB in 2,151 region0 files,
equal to the proxy subtotal **to the byte** — 143,359,229,135,106 bytes across
all 60 snapshots in the integration index. That equality is what the separation
is guarding: it is a property of this delivery, not of the grammar.

### region_count now excludes region0 unconditionally

It excluded region0 only when the name also carried `_proxyN`. A
full-resolution `_region0` would therefore have counted as a playable slice,
and a version holding nothing but the offline-edit copy could have ranked as a
delivery and superseded a master — the exact failure the proxy-only rule exists
to prevent, arriving through the other door.

**No drift on the real archive**, as expected: every region0 file here is a
`_proxy3`, so all 27 integration assertions pass unchanged, keep-1 included.
The change is protective and currently inert; it stops being inert the first
time a delivery ships a full-resolution whole canvas.

### The filter is a union, and the schema migrates itself

`hasProxy` now matches `proxy_bytes > 0 OR region0_bytes > 0`, and
`hasProxy=only` means a whole canvas with no slices behind it — labelled
**Region 0 only**, which is what it has always meant and never quite said. The
param keeps its name so existing links and saved views keep working.

Schema version 2. `openDb` adds the column and backfills it from the file rows
already on record, so an existing index reports a real figure without a
rescan — reporting a confident `0` would have been worse than reporting
nothing. The backfill is the one place outside `parse.ts` that recognises a
region token; it is a legacy path by construction, since those rows were
written by a scanner that did not record the subtotal.

Pinned by `test/region0-rule.test.ts` (10 tests: derivation, the filter union,
and the migration).

## 2026-08-26 — snapshot 8, and the integration ground truth re-pinned

The five failing integration tests were archive drift, so the fix was a fresh
scan and a deliberate re-measure rather than widening bands until they passed.

    snapshot 7 (2026-08-25): 26,655 files  133.568 TiB  keep-1 49.69 TiB / 795
    snapshot 8 (2026-08-26): 26,685 files  133.771 TiB  keep-1 49.87 TiB / 797

Re-pinned together, not one at a time: the reclaim figures move with the bytes,
and re-pinning them piecemeal is how a real regression gets absorbed into a
band nobody re-derived. New values: keep 1/2/3 -> 49.87 / 18.26 / 5.71 TiB and
797 / 401 / 305 versions; total 133.6-134.1 TiB; walked 26,600-26,800.

**The structural invariants did not move, which is the reassuring part.** 28
assets still carry two sub-letters under one version number, protected patch
bytes are still 530.8 GiB at every keep-N, and the asset_version lower bound
still sits above the letter-folded figure (2,405 measured, 2,377 if folded,
guard at 2,403).

### The excluded-files guard was asserting the wrong thing

`excluded.count >= 30` was the assertion that broke hardest, and it deserved
to. FreeFileSync creates its bookkeeping files and clears them again — 37 at
snapshot 7, 2 at snapshot 8 — so that guard was really asserting *FFS has run
recently*, which is not a fact about this codebase.

Replaced with the invariant that actually matters and cannot drift: **nothing
matching an exclusion pattern may reach the analysed set.** The walk's own
output is checked against a fresh `ExclusionMatcher`, with the byte ceiling
kept. `test/exclude.test.ts` still covers the matcher exhaustively; this is the
end-to-end half. 27 integration tests now, up from 26.

### Snapshot 8 inherited its resolutions for free

`carryForwardMedia` matched 26,651 files by (path, size, mtime) and moved their
dimensions across without a single read; only the 30 genuinely new files were
opened. Snapshot 8 is at 100% coverage, and it is the same 5 headerless files —
no new interrupted renders in this delivery.

## 2026-08-26 — give the phone screen back to the asset list

The chrome above the table was 621px of an 844px screen; the list you came for
got 248px, about seven rows. Now 441px of chrome and **403px of table — 48% of
the screen**, roughly double what it was. Measured, not eyeballed:

                before   after
    topbar        141px    124px
    reclaim       233px    135px
    tabs           44px     40px
    toolbar       107px     71px
    TABLE         248px    403px

The rule throughout: **cut what is said twice, never what is said once.**

- `headline-sub` ("795 versions slated for removal · 8,061 files · 37.2% of
  what is in view") wrapped to two lines, and the status bar carries the same
  count and byte figure along the bottom. Gone on narrow.
- The manifest line in the toolbar repeats the status bar too -- except when
  you have overrides, when it carries the Reset button, which lives nowhere
  else. So it is hidden only when there is no button in it. This had to be
  decided in JS: `paintSelectAll` sets `style.display` inline, and an inline
  style beats any stylesheet rule trying to hide it. A `:has()` selector
  looked right, matched correctly, and lost anyway -- worth remembering.
- Control heights come down where the control is a secondary action. Text
  fields keep 40px and their 16px font, because a smaller font makes iOS zoom
  the page on focus and never zoom back.

### The keep-N slider is a stepper on a phone (the user's idea, and a good one)

A 7-stop range input, dragged with a thumb that covers three stops, costing two
rows -- the track and the tick numbers. It is now one row: the label on the left and `[−][+]` joined as a pair on the
right, so one thumb nudges N in both directions without crossing the screen.
Exact on the first tap, and 40px cheaper than a track plus its tick numbers.
The slider stays on desktop, where a drag across seven stops is precise and the
ticks are readable. Crossing the breakpoint rebuilds the control, so a rotated
phone does not keep whichever one it booted with.

Verified with real touch events: tapping + reads "keep latest 2", tapping −
returns to 1, and the bounds disable themselves at each end. Neither the slider
nor the ticks exist in the narrow DOM at all.

Desktop confirmed unchanged at 1440x900 -- slider and ticks present, stepper
absent, every hidden line still shown, topbar still 46px, no overflow. Every
changed CSS line is inside the narrow query; the JS changes are all behind
`isNarrow()`.

## 2026-08-26 — the phone layout was inert, and had been since day one

Reported from a real iPhone: no button worked and the page would not scroll.
It was not a scroll-container problem and not the new controls. It was one
declaration, present since the initial commit:

    .scrim { display: block; ... position: fixed; inset: 0; z-index: 30; }

The scrim is marked up as `<div class="scrim" hidden>` and JS toggles that
attribute. But an AUTHOR `display: block` beats the UA's `[hidden] { display:
none }`, so the scrim was always painted — a full-viewport, zero-opacity layer
sitting over the entire app. Invisible, and it swallowed every tap and every
scroll gesture.

Proved before touching anything, with `document.elementFromPoint` at seven
places on a 390x844 emulated viewport: hamburger, Rescan, the probe Stop
button, the slider, a table row, the tab bar, the status bar — all seven
returned `div#sidebarScrim`. After the fix each returns the control you can
see. Two independent guards now, since either alone would have prevented it:
`.scrim[hidden] { display: none }` so the attribute wins, and
`pointer-events: none` unless `.open`, so a displayed-but-closed scrim can
never take a tap.

This is the bug that CDP screenshots could not have found and did not: the
layer is invisible, so every screenshot looked perfect. Hit-testing is the
check that would have caught it, and it is cheap.

Also verified by driving real touch events: the hamburger opens the sheet,
tapping the scrim closes it, a touch-drag scrolls the table (0 -> 235), and
tapping a row opens the ladder sheet.

Two smaller things while in there:

- The toolbar was 132px of an 844px screen, more than half of what was left for
  the table. Its explainer wraps to two lines and the status bar carries the
  same figures, so the narrow layout drops it: toolbar 132 -> 107px, table
  223 -> 248px.
- `mediaCoverage` counted every file as probeable, but the parser only reads
  .mov — so the four .tif/.txt rows sat permanently in the remainder, coverage
  could never reach 100%, and the button offered "Resume" on a finished pass
  forever. It now counts the probeable population, and the control reads
  "Resolutions read" and disables itself.

Every changed CSS line is inside `@media (max-width: 760px)`, checked
mechanically against the diff.

**A caching trap worth knowing:** headless Chrome served app.css from cache
between runs, so one measurement said a fix had done nothing when it had.
`Network.setCacheDisabled` is now set in the harness scripts. If a CSS change
appears to have no effect, suspect that before suspecting the CSS.

### Integration suite: the archive moved, again

Five integration tests now fail, and none of them is a regression. A read-only
walk against the live archive versus snapshot 7:

    snapshot 7 : 26,655 files  133.568 TiB  37 excluded
    live now   : 26,680 files  133.733 TiB   2 excluded
    delta      : +25 files    +169.6 GiB    -35 excluded

A delivery landed while we were working, and the FreeFileSync bookkeeping files
were cleaned out (37 -> 2), which is what trips the `excluded.count >= 30`
guard. The pinned reclaim figures move with the bytes: keep-1 is 49.87 TiB
against a band that tops out at 49.75.

**The thresholds have deliberately NOT been loosened.** They are the guard on
the reclaim policy, and quietly widening them to fit whatever the archive says
today is how a real regression gets waved through. Re-pinning them is a
decision to take with the numbers from a fresh scan in hand.

## 2026-08-26 — the probe was starving the web server (and itself)

The user reported the page taking a long time to load while a resolution scan
ran. It was not bandwidth and it was not the database: **Node's libuv pool is 4
threads**, every header read goes through it, and each one is a ~1 s round trip
to object storage. Static assets queued behind them. Measured: `index.html`
took **4.14 s** to serve while the API answered in 11 ms — the giveaway, since
the API is pure SQLite and never touches the pool.

The same bug was throttling the probe itself. "Concurrency 64" was fiction: with
four threads the effective concurrency was four, which is exactly the 4.7
files/s that had been confusing me since the first benchmark. Measured on 120
cold files each, distinct offsets so nothing was served from cache:

    UV_THREADPOOL_SIZE=(default 4)  conc=32   4.7 files/s
    UV_THREADPOOL_SIZE=64           conc=32  11.3 files/s
    UV_THREADPOOL_SIZE=128          conc=64   9.0 files/s

`npm run probe` and `npm run serve` now set `UV_THREADPOOL_SIZE=64`. After the
fix: `index.html` 4.14 s -> **0.017 s**, probe 4.7 -> **9.5 files/s**, ETA for
the remaining archive 74 min -> 27 min.

Worth remembering as a shape, not just a fix: a slow *page* whose *API* is fast
is not a database problem. Anything that shares the threadpool with a thousand
slow file reads will look broken while those reads are in flight.

One note for whoever runs the tests next: **do not run the integration suite
while a probe is in flight.** It walks the real archive, the probe was holding
the mount, and 16 of its 26 tests timed out. With the probe finished the same
suite passes in 3.2 s. Contention, not regression -- but it looks exactly like
a regression if you do not know why.

### The probe finished: 26,651 of 26,651 .mov files

**Five files carry no header at all — 151.1 GB that nothing can play:**

    141.0 GB  high  180_NIGHTLIGHT_LAYOUT_LL180_v003_region5.mov
      4.7 GB  low   210_GRADIENTS_VERSE_G_LL180_v002_region13.mov
      4.4 GB  low   210_GRADIENTS_VERSE_G_LL180_v002_region14.mov
      1.0 GB  low   140_ONE_SOLDIERS_LL180_v007_region6.mov
      1.2 MB  high  360_PYRAMID_MATTE3A_LL180_v002_region6.mov

Two sit on live masters. 180_NIGHTLIGHT_LAYOUT has exactly one version (v003,
14 regions, 1.66 TB) and 141 GB of it is unopenable. 360_PYRAMID_MATTE3A v002
is the newest full version of its asset, and region 6 of its 14 is broken --
tiny, but it is a hole in a current delivery.

The other three are `low`: a newer full render already exists above them.

Everything else read cleanly: 26,646 files with dimensions, from 1000x1000
previews up to 8996x2584 masters.

## 2026-08-26 — a mobile pass, with the desktop page provably untouched

The phone layout already existed; this fixed what was actually broken in it,
and nothing else. Verified by driving headless Chrome over CDP at a real
390x844 emulated viewport — the first attempt lied, because `--window-size` on
headless Chrome clamps to a 500px minimum, so a "390px screenshot" was a 500px
layout clipped to 390 and everything looked cut off.

**The one real bug: `.app` is a grid.** Grid items carry `min-width: auto` and
refuse to shrink below their own min-content, so the topbar blew out to 475px
inside a 390px viewport and dragged the whole document with it — every row
looked clipped on the right, and none of them were at fault. `.app > * {
min-width: 0 }` inside the narrow query fixes all of it: `doc.scrollWidth` is
now exactly the viewport width on every tab.

Also, narrow-only: the resolution strip gets its own row (with its meter and
note back, since a full row has the space a topbar slot did not); `.snap-meta`
is dropped, being ellipsised to "103 f…"; the search ✕ becomes a 36px target;
column-resize grips are hidden, since a 6px grip with `touch-action: none` on
every header edge turns a missed tap into a stuck gesture; and the manifest
tick box is 20px again — `width` alone had lost to the flex automatic minimum,
leaving a 13px target on the one control that changes what gets exported.

**Every changed CSS line is inside `@media (max-width: 760px)`** — checked
mechanically against the diff, not by eye. The desktop page cannot have moved.

One non-mobile fix along the way: the topbar's "N broken" pill counted only the
current run, so it read "1 broken" beside an anomalies panel saying 4. It now
derives the count from snapshot-wide coverage.

## 2026-08-25 — the probe control was the wrong shape for where it lives

It rendered as a bordered banner appended to `#snapshotBar` — which is
`.topbar-mid`, a flex ROW inside a header pinned to 46px. So it competed with
the snapshot picker for width and then wrapped inside itself. Rebuilt as an
inline group like `.snap-actions`: a 52px meter, a terse note (`4,650 / 26,655`
idle, `4.6/s · 74 min left` running), and one button. The meter carries the
proportion so the text only carries what a meter cannot. Below 1320px the note
drops, below 1100px the meter does; the button always survives.

Also: an ✕ inside the search field, shown only when there is something to clear,
with Escape bound to the same thing and focus kept in the field. A search you
have to select-all-and-delete to undo is one people leave on by accident and
then wonder why the table is empty.

## 2026-08-25 — the resolution scan gets a button, and a stop button

`POST /api/probe`, `POST /api/probe/cancel`, `GET /api/probe/status`, and a
strip under the snapshot bar that drives them: a coverage meter, live rate and
ETA while running, and a Run/Resume/Stop button. Worded so the difference from
Rescan is visible — a scan reads names and sizes, this opens each file's header.

**Cancellable, where a scan is not.** A scan is one atomic walk that is either a
snapshot or nothing. A probe is tens of thousands of independent reads written
in batches as they land, so stopping halfway is a legitimate outcome that loses
nothing — the next run resumes from what is on disk. A second start is a 409,
never a queued job. `test/server/probe.test.ts` runs in its own fixture because
a probe writes, and the other API tests assert on exactly which files carry
dimensions.

**"no header" is now red, not amber.** Amber means "a newer version replaces
this" — a normal, safe state. A file with no header is broken. They should not
read as the same kind of news.

**The Parsed column is gone.** `parse_ok = 0` and `asset_version_id IS NULL`
are the same set — checked in both directions against the live index, 0 rows
disagree either way — so the column repeated what the Status pill ("no version")
and the Version column ("—") already said, and read "yes" for 26,650 of 26,655
rows. The Status pill now carries the explanation, and the Anomalies tab still
lists those five files with the reason.

## 2026-08-25 — headerless files are an anomaly, not a footnote

`noHeader` joins the anomalies page: a file the probe read cleanly that carries
no `moov` atom. Severity works exactly as every other category does — high when
no newer full render of the asset exists — and it earns its place immediately.

**The first one found is `high`:** `180_NIGHTLIGHT_LAYOUT_LL180` has exactly one
version, v003, 14 regions, 1.66 TB. Region 5 of it is 141 GB with no header.
There is no newer version to fix it. That is a live master with an unplayable
slice, and nothing in the index could have told us — the name parses, the size
is enormous, the mtime is fine.

It is the only anomaly category that does not cover the whole archive, so
`/api/anomalies` returns `probeCoverage` with it and the card says what was
actually checked. An empty list on an unprobed archive is not a clean bill of
health and is not shown as one. Zero-byte files stay in `zeroByte`; they are not
reported twice.

Also fixed while there: anomaly rows showed a size only for version-level rows
(`bytes`), so file-level rows rendered blank. A 141 GB unplayable file is the
entire point of its row.

## 2026-08-25 — pixel resolution, from an EXTENDED scan that reads headers

The file list can now show a file's resolution. Nothing in the filename or the
stat carries it, so this is the first code here that opens an archive file —
deliberately, measurably, and never as part of a scan.

**Measured before committing to it.** One small file, one 293 GB master, one
proxy: the mount serves real range reads, so finding `moov` and reading `tkhd`
costs **8 positioned reads and ~210 bytes**, whatever the file weighs. Whole
archive: ~6 MB of egress, ~50 min of wall clock at concurrency 64. It is
latency-bound, not bandwidth-bound — the reads are trivial, the round trips are
not, which is why concurrency is what makes it finish.

**`npm run probe`, separate from `npm run scan`.** A scan stays metadata-only.
The probe is opt-in, resumable (work = 'no row in `file_media` yet'), and
carries results across a rescan for files whose (path, size, mtime) did not
change. Results live in their own table so the insert-only promise on a scan's
rows holds literally: the probe inserts and edits nothing.

**Display vs coded dimensions.** `tkhd` and `stsd` were compared across a
sample of the archive and agreed on every track, so the cheaper is read —
`tkhd` sits two levels under `moov`, `stsd` five.

**A finding, from 650 files in:** `180_NIGHTLIGHT_LAYOUT_LL180_v003_region5.mov`
is 140 GB whose `mdat` runs to the last byte with **no `moov` at all**. That is
a render interrupted before its header was written: the bytes are there and
nothing can play them. So "probed, no dimensions" is kept distinct from "not
probed" all the way through — table, API and UI — and the file list says
**no header** rather than a dash.

The Resolution column only appears once something has been probed; before that
it would be a column of dashes explaining nothing.

## 2026-08-25 — the Why column says who decided

Un-ticking a slated version made the Status cell read "keeping", but the Why
cell still showed the policy's sentence — which reads as though the tool
decided to keep it. It now says **manual override**, in the keep colour, with
the policy's original verdict moved into the tooltip. Files rows gained a row
signature so an override made in the versions view repaints them too.

## 2026-08-25 — proxy-only filter, resizable columns, Proxy column dropped

Three UI changes, no policy change.

**`hasProxy=only`.** The proxy filter gained a fourth state: versions that are
*nothing but* their preview (`proxy_bytes > 0` AND `region_count = 0`). The
policy has treated those as a special case since the proxy-only rule went in;
until now there was no way to look at them. 417 versions in snapshot 7.
Parsed in `proxyParam()` rather than the boolean helper, applied in both filter
domains, and the fixture gained `500_ECHO_PREVIEW_LL180` — a region-bearing
v001 under a proxy-only v002 — so the API test asserts on a real row and also
re-checks that the preview does not supersede the master.

**Resizable columns.** Every table header carries a 6px grip; a drag pins that
one column in pixels and the flexible columns absorb the difference, so nothing
to its left moves and the table never overflows its pane. Double-click resets a
column. Widths persist per layout (`aa.colWidths.<mode>`), and the narrow
layout keeps its own.

**Proxy column removed** from the asset-versions table. It showed the proxy
byte subtotal, which is already inside the version size — a number that never
decided anything. The per-version figure is still in the ladder drawer, where
the rest of a version's detail lives, and a proxy-only row is now identifiable
by `Regions = —` or by the new filter.

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

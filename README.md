# metal-media-size

A **read-only** size-analysis tool for large d3 (disguise) media-delivery
archives. It scans a delivery folder, indexes it, and shows you which asset
versions are superseded — so you can decide what to remove and see exactly how
much space that reclaims.

It never modifies the archive. It exports a manifest; you carry out the removals
yourself in FreeFileSync.

---

## Running it

**Double-click one file to start. Double-click the other to stop.**

| | Start | Stop |
|---|---|---|
| **macOS** | `start-analyser.command` | `stop-analyser.command` |
| **Windows** | `start-analyser.bat` | `stop-analyser.bat` |

That is the whole thing. **Start** checks Node, installs dependencies the first
time, launches the server and opens your browser. **Stop** shuts it down.

You need [Node](https://nodejs.org) 22 or newer installed. Nothing else.

### First run

**1. Tell it where your archive is.** The scan root is not committed — it names
your storage layout — so you set it once, locally:

```sh
cp config/local.example.json config/local.json
```

Then edit `root` in that file to point at your delivery folder. It is
gitignored and never leaves your machine.

```jsonc
{
  "name": "my_show_2026",
  "root": "/Volumes/YourArchive/SHOW/00_D3_Delivery"
}
```

Prefer an environment variable? `ARCHIVE_ROOT=/path/to/delivery` works too, and
takes precedence over the file.

**2. Double-click the start script.** It opens a terminal window and, after a
moment, your browser.

**3. Press Scan now.** It walks the archive and builds the index — around ten
seconds on a 27k-file delivery folder. The scan is stored, so next time it
opens straight onto your data.

### Stopping it

The server runs **inside the window the start script opened**. Close that
window, or press Ctrl-C in it, and the server stops. There is no background
service to forget about.

The **stop** script is for when one gets left behind anyway — a window closed
badly, or a server started from a window you can no longer find. It locates the
server by the port it is listening on rather than by a PID file, so it cannot be
fooled by stale state, and it checks the server's own health endpoint before
terminating anything: if some *other* program holds the port, it tells you what
that program is and leaves it alone.

### If something goes wrong

| | |
|---|---|
| macOS refuses to open the `.command` | Right-click → **Open**, once. Or `chmod +x start-analyser.command` |
| Port 8787 is busy | `PORT=8788` before either script |
| "Node is not installed" | Install Node 22+ from [nodejs.org](https://nodejs.org) |
| "No archive root configured" | Create `config/local.json` — see First run above |

### From a terminal instead

```sh
npm install
npm run scan      # walk the archive into a local SQLite index
npm run serve     # then open http://127.0.0.1:8787/
```

Rescanning and removing old snapshots are both available in the UI, from the
snapshot bar at the top.

---

## Configuration

Config resolves in three layers, each overriding the one before:

| | Where | Committed? |
|---|---|---|
| 1 | `config/d3-delivery.json` — filename grammar, exclusions, family labels | yes |
| 2 | `config/local.json` — your `root`, `name`, `allowedRoots` | **no**, gitignored |
| 3 | `ARCHIVE_ROOT`, `ARCHIVE_NAME`, `ARCHIVE_ALLOWED_ROOTS` in the environment | n/a |

The split is on purpose: the generic rules are the same for any archive of this
shape and are worth sharing, while a scan root names a client's storage layout
and is not. Nothing identifying an archive is ever committed.

Layer 1 alone is enough to point it at another **d3 delivery folder using the
`_regionN` convention** without touching code.

Other conventions — screen codes, embedded screen names, bracketed part tags —
need new parse rules, not just a new root. Don't assume the grammar generalises.

## Sharing it

Nobody needs to install anything to *use* this. Node has to run on the machine
holding the archive, but the UI is a plain web page: expose it over Tailscale
(`tailscale serve --bg http://127.0.0.1:8787`) and it works from any browser on
your tailnet — phone, tablet, someone else's laptop — with a proper TLS
certificate and nothing to install. The interface adapts to a phone screen.

That is tailnet-only, not public. `funnel` is the one that puts a service on the
open internet, and this tool has no business there.

## Why it exists

This is built for media that is **sliced into 15 regions for a specific venue**:
`region1`–`region14`, plus a `proxy3_region0` low-res whole-canvas preview. One
logical *version* of an asset is therefore fifteen files, not one.

Spread across fifteen files, a version has no size you can read off the folder —
and no obvious way to tell which versions are still needed and which have been
superseded. That is what this tool works out.

## What it does

- **Sortable, virtualized table** of files, asset-versions or song folders, with
  a filter panel and live running totals. Holds 26k+ rows at a constant ~1,000
  DOM nodes.
- **Version ladder** per asset — every version oldest→newest with its rolled-up
  size, region count, proxy and region0 subtotals, date, and a plain-English
  reason why it is kept or superseded.
- **Keep-latest-N slider** recomputing reclaimable bytes live across whatever
  you currently have filtered. It scales to the asset with the most versions.
- **Anomalies** — missing regions, versions with no proxy, unparsed and
  zero-byte files. Graded: a defect on a current master is loud; one already
  fixed by a newer version is reported but de-emphasised.
- **Region gaps** — which versions carry *some* of the canvas but not all of it.
  Everything else in the tool measures in bytes, and a version missing ten of
  its fourteen slices can still be enormous, so this one measures in slices:
  every row draws the whole canvas with the missing cells hollow. The required
  set is read from the rig (`1`–`14`), not hard-coded, and region 0 is never one
  of them. It is not the same check as the missing-region anomaly — that
  compares a version against its own siblings, this compares it against the
  canvas — and the panel accounts for every version in view in one of four
  buckets so the numbers add up. Nothing here is proposed for removal.
- **Duplicates** — metadata only, never reads file bytes (the mount is object
  storage; reading means egress). Always labelled "content not verified".
- **Per-machine** — a fourth Browse mode: how much media each playback machine
  has to hold, keyed by the canvas regions allocated to it, and how much of that
  is superseded. A region can be held by several machines, so the rows overlap
  by design and the view states the duplication rather than presenting them as
  shares of a total. The rig is 14 actors (one slice each), 7 understudies (two
  each) and two director machines on region 0, so every byte is stored twice:
  133.29 TiB allocated, 266.59 TiB across the rig. Each row carries a drive
  meter — what stays after a cleanup, what a cleanup would free, unused space
  and the reserved headroom, drawn as one 32 TB drive — so a machine that is
  nearly full is visible at a glance. The allocation lives in `src/machines.ts`
  and will move to a config file.
- **Region Gaps (cluster)** — the only view that describes the machines rather
  than the archive: the same question as **Region gaps**, which it sits beside,
  asked of the playback rig.
  Paste (or import from YAML) a list of addresses, connect, and it walks the
  same directory on every playback machine and compares it with what the archive
  says should be there: current media missing, same-name-different-size,
  superseded media still taking up drive space, files that belong to another
  machine. **Every share is mounted read-only** (`mount_smbfs -o rdonly`), which
  the kernel enforces against every process on the Mac including root, and the
  survey never opens a file — it reads directory entries and stats only. The
  directory can be **browsed** off a connected machine rather than typed, which
  matters because a mistyped path surveys an empty directory and reports a rig
  as clean. No address, mountpoint or password is ever written to disk; the list
  can be saved as a YAML file that carries addresses and never a credential.
- **Snapshots** — every scan is retained and two can be diffed. The archive is
  live, so this matters. Old snapshots can be removed from the index.
- **Exports** — a shareable HTML report, JSON, Markdown, and a FreeFileSync
  `.ffs_gui` removal job with a literal-path manifest beside it.
- **The report** (`media_cleanup_report_27Aug2026_1112.html`, named for the local
  date and time it was produced) is the one meant to leave this machine. Page
  one opens with two figures — what is on the storage today, and how much of it
  is region 0 — and is otherwise the options and nothing else: what comes back
  if only the current version is kept, and what each extra version of insurance
  costs, at keep-1 through keep-4 over the whole archive. It does not mark
  which option the attached job uses — the person it is written for does not
  know an export was ever selected. The pages after it are the detail: which
  option the job is and what it contains, where the numbers come from, the
  per-song split, every affected asset showing what goes next to what stays,
  and the file list. Page one also carries the per-machine drive fill, costed at
  every option, so it is visible which option rescues a machine that is nearly
  full. One self-contained file, no scripts and no external
  references, so it opens offline on any machine. Dark on screen; the print
  stylesheet inverts the whole palette, so *Save as PDF* still gives ink on
  paper.

## Safety

This tool points at irreplaceable master renders. The read-only guarantee is
enforced, not merely intended:

- One module (`src/fs/readonly.ts`) may touch the archive, and only via
  `readdir` / `lstat` / `openRead`.
- One module (`src/export/writer.ts`) may write anything, jailed to `exports/`.
- A test walks the source tree and **fails the build** if a write primitive or a
  stray `node:fs` import appears anywhere else. It was verified by deliberately
  introducing violations and confirming a red build.
- FreeFileSync jobs are emitted with a reversible deletion policy. `Permanent`
  is not merely un-defaulted — it is unreachable, and a test proves it.
- Every generated job carries a banner telling you to run Compare and inspect
  before you press Synchronize.
- Deleting a snapshot removes an **index entry**, never a file.

See [CLAUDE.md](CLAUDE.md) for the full invariants and the domain rules that are
easy to get wrong — particularly how versions are ranked, which decides what the
tool will and will not call superseded.

## Stack

Node 22+, TypeScript, ESM, no build step (`--experimental-strip-types`).
SQLite via `better-sqlite3`. Fastify. Frontend is plain ESM modules — no
bundler, no CDN, no web fonts. Tests are vitest: **366 passing**.

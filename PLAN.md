# PLAN.md

The design. Edit in place — don't append a "v2" section.

## Problem

`SHOW_2026/00_D3_Delivery` holds ~26.6k files / ~133.6 TiB across 65 song
folders on a read-only macFUSE object mount. A logical *version* is up to 15
files (14 unequal regions + a proxy), so version-level tonnage is invisible
from the folder. The goal is to make superseded tonnage visible, trustworthy and
actionable — without ever touching the archive.

## Architecture

```
scan  ──> SQLite index (snapshots, insert-only, diffable)
                │
                ├─> HTTP API (Fastify, 127.0.0.1 only)
                │       └─> web UI (plain ESM, no build step)
                └─> exporters (JSON / Markdown / .ffs_gui)
```

The scan is cheap (~12 s cold), so there is deliberately **no** worker pool,
checkpointing or streaming-progress machinery. Assets and versions are derived at
scan time and stored, so the UI queries a prepared index rather than re-deriving
the filename grammar per request.

## Module map

| Path | Role |
|---|---|
| `src/fs/readonly.ts` | Sole archive access. `readdir`/`lstat`/`openRead` only. Root allowlist + per-directory timeout |
| `src/scan/walk.ts` | Breadth-first walk through the chokepoint |
| `src/scan/parse.ts` | Filename → `{base, ver, sub, isPatch, patchFrame, isProxy, region}` |
| `src/scan/derive.ts` | Files → assets → versions. `compareVersions` lives here |
| `src/scan/reclaim.ts` | `computeReclaim` — keep-latest-N and the patch rule |
| `src/db/schema.ts` | The 4-table schema + two views. The cross-agent contract |
| `src/server/` | Fastify app, query layer, routes, static mount |
| `src/export/writer.ts` | Sole write path. The export jail |
| `src/export/{json,markdown,ffs}.ts` | Pure renderers |
| `src/export/scenarios.ts` | Keep-N costed at 1–4 over the whole snapshot |
| `src/export/report.ts` | The shareable HTML report. Print-styled, self-contained |
| `src/web/` | Frontend, served statically at `/` |

## Key decisions

- **Scope is one delivery folder.** Do not walk the mount root or sibling
  projects — `find` stalls indefinitely there (a 25-minute run produced no
  output). The root allowlist enforces this.
- **Snapshots are insert-only and diffable.** The archive is live; it changed
  during development.
- **Reclaim filters the output, not the input** — see CLAUDE.md.
- **Duplicates are metadata-only.** Object storage; reading bytes means egress.
- **Emit `.ffs_gui`, never `.ffs_batch`.** Only the GUI form is verified against
  a real config, and it keeps a human in the loop.
- **One FFS job per song folder.** The folder pair's right side is the song
  folder, so a job physically cannot see the rest of the archive.

## Not in scope (v1)

- Junk-file flagging as a feature (bookkeeping files are excluded and counted,
  not surfaced as a panel).
- Content-based duplicate verification.
- Acting on removals — the tool exports a manifest and stops.

## Open questions

- `_frameNNNNN` patch semantics rest on the assumption that a later full render
  absorbs an earlier patch. Sound, but it's an inference about the render
  pipeline rather than something the filenames state. Worth confirming in use.
- Anchored per-file `<Include>` items and top-level XML comments in `.ffs_gui`
  are unverified against a real FreeFileSync config — see `docs/ffs-format.md`.
- The cause of the mount-root `find` stall is unidentified.

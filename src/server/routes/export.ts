/**
 * ============================================================================
 *  `POST /api/export`
 * ============================================================================
 *
 * This route VALIDATES a proposed removal set and hands it to the exporter,
 * which is owned by another agent. The route itself never touches the archive
 * and never puts a byte on disk; `src/export/writer.ts` is the only thing in
 * the codebase that does, and it is jailed to the project `exports/` folder.
 *
 * WHAT THE ROUTE GUARANTEES BEFORE THE EXPORTER IS EVEN LOADED:
 *
 *   1. `deletionPolicy` is present and is exactly `'Versioning'` or
 *      `'RecycleBin'`. `'Permanent'` is a 400 -- always, first, before any
 *      other check and whether or not an exporter exists. An export may only
 *      ever propose a RECOVERABLE removal. See `docs/ffs-format.md`.
 *   2. `'Versioning'` carries a `versioningFolder`, or FreeFileSync would have
 *      nowhere to move the renders to.
 *   3. Every `versionId` exists, and they all belong to ONE snapshot -- mixing
 *      snapshots would produce a path list that never existed at any instant.
 *
 * The exporter's own module is loaded dynamically. If it has not shipped, the
 * route answers 503 rather than improvising: a half-right FreeFileSync config
 * aimed at 133 TB of masters is worse than none at all.
 *
 * The interface is `writeExport(opts): Promise<ExportResult>` from
 * `src/export/index.ts`; the option names below track that module.
 * ============================================================================
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { badRequest, unavailable } from '../errors.ts';
import { DEFAULT_KEEP_N } from '../query.ts';

export const EXPORT_FORMATS = ['json', 'markdown', 'ffs_gui'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const DELETION_POLICIES = ['Versioning', 'RecycleBin'] as const;
export type DeletionPolicy = (typeof DELETION_POLICIES)[number];

/** Ceiling on one export request, so a stray client cannot ask for millions. */
const MAX_VERSION_IDS = 100_000;

interface ExportBody {
  versionIds?: unknown;
  formats?: unknown;
  deletionPolicy?: unknown;
  versioningFolder?: unknown;
  note?: unknown;
  snapshotId?: unknown;
  keepN?: unknown;
}

/**
 * What this route sends to `writeExport`. A structural subset of the
 * exporter's own `WriteExportOptions`, restated here so the two modules stay
 * decoupled: the route does not import the exporter's types, because the
 * exporter may not exist.
 */
export interface ExportRequest {
  db: unknown;
  versionIds: number[];
  formats: ExportFormat[];
  deletionPolicy: DeletionPolicy;
  versioningFolder?: string;
  note?: string;
  keepN: number;
  /** Roots the writer must refuse to write into. The archive, always. */
  forbiddenRoots: string[];
  /** Test-only override of the export directory; omitted in normal operation. */
  exportsDir?: string;
}

export interface ExportResult {
  files: { format: string; path: string; bytes: number }[];
  summary?: Record<string, unknown> & { fileCount?: number; totalBytes?: number };
}

type ExportModule = { writeExport?: (req: ExportRequest) => Promise<ExportResult> };

function validatePolicy(raw: unknown): DeletionPolicy {
  if (raw === undefined || raw === null || raw === '') {
    throw badRequest(
      'deletion_policy_required',
      `deletionPolicy is required and must be one of: ${DELETION_POLICIES.join(', ')}.`,
    );
  }
  if (raw === 'Permanent') {
    throw badRequest(
      'deletion_policy_forbidden',
      "deletionPolicy 'Permanent' is refused. The archive is 133 TB of irreplaceable " +
        'masters on a mount with no backup, so an export may only propose a recoverable ' +
        "deletion: 'Versioning' (moves into a versioning folder) or 'RecycleBin'. " +
        'See docs/ffs-format.md.',
    );
  }
  if (typeof raw !== 'string' || !(DELETION_POLICIES as readonly string[]).includes(raw)) {
    throw badRequest(
      'bad_deletion_policy',
      `deletionPolicy must be one of: ${DELETION_POLICIES.join(', ')}. Got ${JSON.stringify(raw)}.`,
    );
  }
  return raw as DeletionPolicy;
}

function validateFormats(raw: unknown): ExportFormat[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest(
      'bad_formats',
      `formats must be a non-empty array drawn from: ${EXPORT_FORMATS.join(', ')}`,
    );
  }
  const bad = raw.filter((f) => !(EXPORT_FORMATS as readonly unknown[]).includes(f));
  if (bad.length > 0) {
    throw badRequest(
      'bad_formats',
      `Unknown export format(s) ${JSON.stringify(bad)}. Allowed: ${EXPORT_FORMATS.join(', ')}`,
    );
  }
  return [...new Set(raw as ExportFormat[])];
}

function validateVersionIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest('bad_version_ids', 'versionIds must be a non-empty array of integers');
  }
  if (raw.length > MAX_VERSION_IDS) {
    throw badRequest('bad_version_ids', `versionIds may hold at most ${MAX_VERSION_IDS} entries`);
  }
  const ids: number[] = [];
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw badRequest('bad_version_ids', `versionIds must all be positive integers, saw ${JSON.stringify(v)}`);
    }
    ids.push(v);
  }
  return [...new Set(ids)];
}

export function registerExportRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/export', async (req, reply) => {
    const body = (req.body ?? {}) as ExportBody;

    // Order matters: the forbidden policy is rejected before anything else,
    // including before we look at whether an exporter exists.
    const deletionPolicy = validatePolicy(body.deletionPolicy);
    const formats = validateFormats(body.formats);
    const versionIds = validateVersionIds(body.versionIds);

    let versioningFolder: string | undefined;
    if (body.versioningFolder !== undefined && body.versioningFolder !== null) {
      if (typeof body.versioningFolder !== 'string' || body.versioningFolder.trim() === '') {
        throw badRequest('bad_versioning_folder', 'versioningFolder must be a non-empty string');
      }
      versioningFolder = body.versioningFolder;
    }
    if (deletionPolicy === 'Versioning' && versioningFolder === undefined) {
      throw badRequest(
        'versioning_folder_required',
        "deletionPolicy 'Versioning' needs a versioningFolder to move superseded renders into. " +
          'Without one FreeFileSync has nowhere to put them.',
      );
    }

    let note: string | undefined;
    if (body.note !== undefined && body.note !== null) {
      if (typeof body.note !== 'string') throw badRequest('bad_note', 'note must be a string');
      if (body.note.length > 4000) throw badRequest('bad_note', 'note must be at most 4000 characters');
      note = body.note;
    }

    let expectedSnapshotId: number | undefined;
    if (body.snapshotId !== undefined && body.snapshotId !== null) {
      if (typeof body.snapshotId !== 'number' || !Number.isInteger(body.snapshotId)) {
        throw badRequest('bad_param', 'snapshotId must be an integer');
      }
      expectedSnapshotId = body.snapshotId;
    }

    let keepN = DEFAULT_KEEP_N;
    if (body.keepN !== undefined && body.keepN !== null) {
      if (typeof body.keepN !== 'number' || !Number.isInteger(body.keepN) || body.keepN < 1) {
        throw badRequest('bad_param', 'keepN must be an integer >= 1');
      }
      keepN = body.keepN;
    }

    // Every id must exist, and they must all come from ONE snapshot. A mixed
    // selection would describe a state of the archive that never existed.
    const placeholders = versionIds.map(() => '?').join(', ');
    const found = ctx.db
      .prepare(
        `SELECT av.version_id AS id, av.snapshot_id AS snapshot_id,
                av.bytes AS bytes, av.file_count AS file_count
           FROM v_asset_version av
          WHERE av.version_id IN (${placeholders})`,
      )
      .all(...versionIds) as {
      id: number;
      snapshot_id: number;
      bytes: number;
      file_count: number;
    }[];

    if (found.length !== versionIds.length) {
      const known = new Set(found.map((r) => r.id));
      const missing = versionIds.filter((id) => !known.has(id));
      throw badRequest(
        'unknown_version_ids',
        `${missing.length} versionId(s) do not exist: ` +
          `${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}`,
      );
    }

    const snapshotIds = [...new Set(found.map((r) => r.snapshot_id))];
    if (snapshotIds.length > 1) {
      throw badRequest(
        'mixed_snapshots',
        `versionIds span ${snapshotIds.length} snapshots (${snapshotIds.join(', ')}). ` +
          'An export must describe one snapshot, or its path list describes a state ' +
          'the archive was never in.',
      );
    }
    const snapshotId = snapshotIds[0] as number;
    if (expectedSnapshotId !== undefined && expectedSnapshotId !== snapshotId) {
      throw badRequest(
        'snapshot_mismatch',
        `versionIds belong to snapshot ${snapshotId}, not ${expectedSnapshotId}.`,
      );
    }

    const selection = found.reduce(
      (acc, r) => ({
        versionCount: acc.versionCount + 1,
        fileCount: acc.fileCount + r.file_count,
        totalBytes: acc.totalBytes + r.bytes,
      }),
      { versionCount: 0, fileCount: 0, totalBytes: 0 },
    );

    const request: ExportRequest = {
      db: ctx.db,
      versionIds,
      formats,
      deletionPolicy,
      keepN,
      // The archive itself is never a legal write target, whatever else is.
      forbiddenRoots: [...ctx.cfg.allowedRoots, ctx.cfg.root],
      ...(versioningFolder === undefined ? {} : { versioningFolder }),
      ...(note === undefined ? {} : { note }),
      ...(ctx.exportsDir === undefined ? {} : { exportsDir: ctx.exportsDir }),
    };

    // TODO(exporter agent): `src/export/index.ts` is owned by another agent.
    // The specifier is built at runtime -- as an absolute URL so it resolves
    // identically under `node --experimental-strip-types` and under vitest --
    // so a module that has not shipped yet is a catchable import failure
    // rather than a load-time crash of the whole server.
    const specifier = new URL('../../export/index.ts', import.meta.url).href;
    let mod: ExportModule;
    try {
      mod = (await import(specifier)) as ExportModule;
    } catch {
      throw unavailable(
        'exporter_unavailable',
        'The exporter module (src/export/index.ts) is not available in this build. ' +
          'The request validated cleanly; nothing was written. Retry once the exporter ships.',
      );
    }
    if (typeof mod.writeExport !== 'function') {
      throw unavailable(
        'exporter_unavailable',
        'src/export/index.ts does not export writeExport(request). ' +
          'The request validated cleanly; nothing was written.',
      );
    }

    const result = await mod.writeExport(request);

    reply.code(201);
    return {
      files: result.files,
      summary: result.summary ?? {
        fileCount: selection.fileCount,
        totalBytes: selection.totalBytes,
      },
      selection: { ...selection, snapshotId, keepN, deletionPolicy },
      note: 'This export DESCRIBES a proposed removal. Nothing in the archive was changed.',
    };
  });
}

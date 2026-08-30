/**
 * =============================================================================
 *  `/api/rig/*`  --  READ A DIRECTORY ON EVERY MACHINE, AND COMPARE
 * =============================================================================
 *
 *   POST   /api/rig/targets          parse a pasted list or an imported YAML
 *   GET    /api/rig/targets.yaml     the same list, as the file to save
 *   POST   /api/rig/credentials      a user name and password, for this session
 *   POST   /api/rig/connect          mount every target's share, READ-ONLY
 *   POST   /api/rig/disconnect       unmount the ones we mounted
 *   POST   /api/rig/survey           walk them all and compare (cancellable)
 *   POST   /api/rig/survey/cancel    stop before the next machine
 *   GET    /api/rig/status           targets, mounts, progress, results
 *   GET    /api/rig/mounts           SMB shares mounted on this Mac right now
 *   DELETE /api/rig/session          forget everything, credential included
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE IS PERSISTED. The whole session lives in `ctx.rig`, an object in
 * memory. No route writes to the index, the config or the exports directory,
 * and no address or credential is logged. The YAML is generated into a response
 * body for the browser to save wherever the operator wants; the server never
 * puts it on disk. See `src/server/rig-session.ts`.
 *
 * THE CREDENTIAL IS WRITE-ONLY. It goes in at `POST /api/rig/credentials` and
 * the only thing that ever reads it is the mount. `status` reports whether one
 * is held and the user name, never the password.
 *
 * EVERY MOUNT IS READ-ONLY. `mount_smbfs -o rdonly` -- the kernel refuses every
 * write through these mountpoints, from any process on this Mac including root.
 * See `src/rig/mounts.ts`. A share the operator separately connected in Finder
 * is read-write, and `alsoWritableElsewhere` says so rather than hiding it.
 *
 * THE DIRECTORY CANNOT ESCAPE THE SHARE. It is relative by construction --
 * absolute paths and `..` segments are refused here with a plain message, and
 * `ReadOnlyFs` refuses them again structurally, fenced to the one mountpoint.
 * Two checks because the first is a good error message and the second is the
 * guarantee.
 *
 * THE VERDICT COMES FROM THE ARCHIVE, NOT FROM THE MACHINE. What *should* be on
 * a machine is `computeReclaim` over the whole snapshot plus the region
 * allocation in `src/machines.ts`, exactly as `/api/machines` computes it. This
 * route contributes the other half -- what IS there -- and never lets one side
 * decide the other.
 * ---------------------------------------------------------------------------
 */

import type { FastifyInstance } from 'fastify';
import { isAbsolute, join } from 'node:path';
import type { AppContext } from '../context.ts';
import { resolveSnapshot } from '../context.ts';
import { badRequest } from '../errors.ts';
import { parseKeepN, type Query } from '../query.ts';
import { ExclusionMatcher } from '../../scan/exclude.ts';
import { makeParser } from '../../scan/parse.ts';
import { machinesByRegion, resolveMachines } from '../../machines.ts';
import { formatTargetsYaml, parseTargetList, type RigTarget } from '../../rig/targets.ts';
import { listSmbMounts } from '../../rig/mounts.ts';
import type { ExpectedFile } from '../../rig/survey.ts';
import type { SurveyJob } from '../rig-session.ts';

/** The share every d3 machine offers, unless the operator says otherwise. */
export const DEFAULT_SHARE = 'd3 Projects';

/**
 * A directory under the share root, or '' for the share root itself.
 *
 * Refuses anything that could leave the share. `..` is refused even when it
 * would be harmless after normalisation, because a path that talks about
 * leaving is a path the operator did not mean to type.
 */
export function assertRelativeDirectory(input: unknown): string {
  const raw = String(input ?? '').trim().replace(/\\/g, '/');
  if (raw === '' || raw === '.' || raw === '/') return '';
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw badRequest(
      'bad_directory',
      'The directory is relative to the share root, so it must not start with a slash or a drive letter.',
    );
  }
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw badRequest('bad_directory', 'The directory may not contain `..`.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw badRequest('bad_directory', 'The directory contains a control character.');
  }
  return segments.join('/');
}

interface TargetsBody {
  text?: unknown;
  share?: unknown;
  directory?: unknown;
}

interface CredentialsBody {
  username?: unknown;
  password?: unknown;
}

interface SurveyBody {
  directory?: unknown;
  keepN?: unknown;
  concurrency?: unknown;
}

export function registerRigRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Parse a pasted list or an imported YAML file. Stores nothing on disk. */
  app.post('/api/rig/targets', (req) => {
    const body = (req.body ?? {}) as TargetsBody;
    const text = typeof body.text === 'string' ? body.text : '';
    const parsed = parseTargetList(text);

    const share =
      typeof body.share === 'string' && body.share.trim() !== ''
        ? body.share.trim()
        : (parsed.share ?? ctx.rig.getShare() ?? DEFAULT_SHARE);
    const directory =
      body.directory !== undefined
        ? assertRelativeDirectory(body.directory)
        : (parsed.directory ?? ctx.rig.getDirectory() ?? '');

    ctx.rig.setTargets(parsed.targets, share, directory);

    return {
      targets: ctx.rig.getTargets(),
      share,
      directory,
      /** Lines that could not be read. Reported, never silently dropped. */
      errors: parsed.errors,
      /** Which machine ids in the list this rig actually knows about. */
      unknownMachineIds: unknownMachineIds(parsed.targets),
    };
  });

  /**
   * The target list as the file the operator saves.
   *
   * Generated into the response body and never written here -- the browser
   * offers it as a download so it lands wherever the operator chooses, outside
   * this project. Addresses only; no credential is ever rendered.
   */
  app.get('/api/rig/targets.yaml', (_req, reply) => {
    const yaml = formatTargetsYaml({
      targets: ctx.rig.getTargets(),
      share: ctx.rig.getShare(),
      directory: ctx.rig.getDirectory(),
    });
    void reply
      .header('content-type', 'text/yaml; charset=utf-8')
      .header('content-disposition', 'attachment; filename="rig-targets.yaml"')
      .send(yaml);
  });

  /** Hold a credential for this session only. Never stored, never returned. */
  app.post('/api/rig/credentials', (req) => {
    const body = (req.body ?? {}) as CredentialsBody;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    ctx.rig.setCredentials(username || null, password || null);
    // Deliberately echoes only what is safe to see.
    return { hasCredentials: ctx.rig.hasCredentials(), username: username || null };
  });

  /** Ask macOS to mount each target's share. Sequential; see the session. */
  app.post('/api/rig/connect', async (req) => {
    const body = (req.body ?? {}) as TargetsBody;
    const share =
      typeof body.share === 'string' && body.share.trim() !== ''
        ? body.share.trim()
        : (ctx.rig.getShare() ?? DEFAULT_SHARE);
    if (ctx.rig.getTargets().length === 0) {
      throw badRequest('no_targets', 'Add some machine addresses first.');
    }
    const targets = await ctx.rig.connect(share);
    return {
      share,
      targets,
      connected: targets.filter((t) => t.mountPoint !== null).length,
      failed: targets.filter((t) => t.mountPoint === null).length,
      /**
       * Every mount this application makes is read-only, enforced by the
       * kernel. Reported as a count read back from the mount table rather than
       * asserted, so a UI badge can never claim a protection that is not there.
       */
      readOnly: targets.filter((t) => t.readOnly).length,
      /** Machines that are ALSO mounted read-write by somebody else. */
      alsoWritableElsewhere: targets.filter((t) => t.otherWritableMount !== null).length,
    };
  });

  /**
   * Take away the mountpoints this application made. Jailed to our own mount
   * root, so it can never reach a volume the operator connected or the object
   * mount holding the archive.
   */
  app.post('/api/rig/disconnect', async () => {
    const { disconnected, errors } = await ctx.rig.disconnect();
    return { disconnected, errors };
  });

  /** SMB shares mounted on this Mac right now, whether or not we mounted them. */
  app.get('/api/rig/mounts', async () => ({ mounts: await listSmbMounts() }));

  /** Walk every mounted target and compare it with the archive. */
  app.post('/api/rig/survey', (req) => {
    const q = req.query as Query;
    const body = (req.body ?? {}) as SurveyBody;
    const snapshot = resolveSnapshot(ctx, q);
    const keepN = parseKeepN({ ...q, ...(body.keepN === undefined ? {} : { keepN: body.keepN }) });
    const directory =
      body.directory !== undefined
        ? assertRelativeDirectory(body.directory)
        : (ctx.rig.getDirectory() ?? '');
    ctx.rig.setDirectory(directory);

    const targets = ctx.rig.getTargets();
    if (targets.length === 0) throw badRequest('no_targets', 'Add some machine addresses first.');
    const mounted = targets.filter((t) => t.mountPoint !== null);
    if (mounted.length === 0) {
      throw badRequest('not_connected', 'No machine is mounted. Connect first.');
    }

    const parse = makeParser(ctx.cfg.parse.pattern, ctx.cfg.parse.flags);
    const regionOfName = (name: string): number | null => {
      const p = parse(name);
      return p.ok ? p.region : null;
    };

    const { machines } = resolveMachines();
    const regionsById = new Map(machines.map((m) => [m.id, [...m.regions]]));
    // Every machine that carries each region, from the allocation rather than
    // from the target list: a region whose second holder was not surveyed must
    // read as "not looked at", never as "gone from the rig".
    const regionHolders = new Map<number, string[]>();
    for (const [region, holders] of machinesByRegion(machines)) {
      regionHolders.set(region, holders.map((m) => m.id));
    }
    const expectedByRegion = expectationsByRegion(ctx, snapshot.id, keepN, regionOfName);

    const jobs: SurveyJob[] = targets.map((target) => {
      const regions = target.machineId ? (regionsById.get(target.machineId) ?? null) : null;
      // Region 0 is the whole-canvas copy and IS legitimately held by the
      // director machines, so it is expected wherever the allocation says so --
      // this is the rig's own list, not the "required slices" of a delivery.
      const expected: ExpectedFile[] = [];
      for (const r of regions ?? []) expected.push(...(expectedByRegion.get(r) ?? []));
      return {
        target,
        root: target.mountPoint ? join(target.mountPoint, directory) : '',
        regions,
        expected,
      };
    });

    ctx.rig.start({
      jobs,
      directory,
      keepN,
      snapshotId: snapshot.id,
      exclusions: new ExclusionMatcher(ctx.cfg.exclusions.globs, ctx.cfg.exclusions.caseInsensitive),
      dirTimeoutMs: ctx.cfg.dirTimeoutMs,
      regionOfName,
      regionHolders,
      ...(typeof body.concurrency === 'number' ? { concurrency: body.concurrency } : {}),
    });

    return { started: true, machines: jobs.length, keepN, snapshotId: snapshot.id, directory };
  });

  app.post('/api/rig/survey/cancel', () => ({ cancelling: ctx.rig.cancel() }));

  app.get('/api/rig/status', () => ctx.rig.status());

  /** Forget the addresses, the mountpoints, the results and the credential. */
  app.delete('/api/rig/session', () => {
    ctx.rig.clear();
    return { cleared: true };
  });
}

/** Machine ids in the list that this rig has never heard of. */
function unknownMachineIds(targets: readonly RigTarget[]): string[] {
  const known = new Set(resolveMachines().machines.map((m) => m.id));
  return [...new Set(targets.map((t) => t.machineId).filter((id): id is string => id !== null))]
    .filter((id) => !known.has(id))
    .sort();
}

/**
 * What the archive says lives on each canvas region, with the whole-snapshot
 * reclaim verdict on every file.
 *
 * Built once per survey and shared across machines: on this rig every region
 * sits on two machines, so computing it per machine would do all the work
 * twice and -- worse -- leave two lists that could drift.
 */
function expectationsByRegion(
  ctx: AppContext,
  snapshotId: number,
  keepN: number,
  regionOfName: (name: string) => number | null,
): Map<number, ExpectedFile[]> {
  const rows = ctx.db
    .prepare(
      `SELECT f.name AS name, f.size AS size, f.song_folder AS songFolder,
              f.asset_version_id AS versionId, av.base AS base, av.ver_label AS verLabel
         FROM file f
         LEFT JOIN v_asset_version av ON av.version_id = f.asset_version_id
        WHERE f.snapshot_id = ?`,
    )
    .all(snapshotId) as {
    name: string;
    size: number;
    songFolder: string;
    versionId: number | null;
    base: string | null;
    verLabel: string | null;
  }[];

  const verdicts = ctx.reclaim.get(snapshotId, keepN).byVersionId;
  const out = new Map<number, ExpectedFile[]>();

  for (const r of rows) {
    const region = regionOfName(r.name);
    // A file with no region is not allocated to any machine -- it is the
    // `regionless` category the machine view already reports. It is not
    // expected anywhere, and finding one on a machine is `extraUnknown`.
    if (region === null) continue;
    const v = r.versionId === null ? undefined : verdicts.get(r.versionId);
    const list = out.get(region) ?? [];
    list.push({
      name: r.name,
      size: r.size,
      region,
      songFolder: r.songFolder,
      base: r.base ?? '',
      verLabel: r.verLabel ?? '',
      versionId: r.versionId ?? -1,
      status: v === undefined ? 'unknown' : v.keep ? 'kept' : 'superseded',
    });
    out.set(region, list);
  }
  return out;
}

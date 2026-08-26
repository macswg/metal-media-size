/**
 * Configuration loading. The app reads its root path, parse pattern, exclusion
 * globs and allowlist from a JSON config file rather than hardcoding them.
 *
 * NOTE: this module reads a PROJECT file (config/*.json), not the archive.
 * It deliberately does not use `node:fs` -- it goes through `import ... with
 * { type: 'json' }`-equivalent via a JSON module read performed by the caller,
 * or the async loader below which uses the readonly chokepoint pointed at the
 * project directory. See `loadConfig`.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';
import { ReadOnlyFs } from './fs/readonly.ts';

export interface ExclusionConfig {
  globs: string[];
  caseInsensitive?: boolean;
}

export interface ParseConfig {
  pattern: string;
  flags?: string;
}

export interface AppConfig {
  name: string;
  /** Absolute path to the directory to scan. */
  root: string;
  /** Absolute paths the read-only fs layer will permit access under. */
  allowedRoots: string[];
  /** Path to the SQLite index, relative to the project root unless absolute. */
  dbPath: string;
  dirTimeoutMs: number;
  parse: ParseConfig;
  exclusions: ExclusionConfig;
  /** family label -> tokens that, if present in `base`, select that label. */
  families: Record<string, string[]>;
  defaultFamily: string;
}

/** Absolute path of the project root (the directory containing package.json). */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function abs(p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(PROJECT_ROOT, p);
}

/**
 * Where a local, UNCOMMITTED override may live. Gitignored.
 *
 * The committed config carries the generic rules -- filename grammar,
 * exclusions, family labels -- which are the same for any archive of this
 * shape. It deliberately does NOT carry `root`, because a scan root names a
 * client's storage layout and does not belong in a repository that might be
 * shared or made public.
 */
export const LOCAL_CONFIG = 'config/local.json';

/**
 * Environment overrides, highest precedence. Handy for a one-off scan or a
 * second archive without editing any file:
 *
 *   ARCHIVE_ROOT=/path/to/delivery npm run scan
 */
const ENV_ROOT = 'ARCHIVE_ROOT';
const ENV_NAME = 'ARCHIVE_NAME';
const ENV_ALLOWED = 'ARCHIVE_ALLOWED_ROOTS';

/** Read a project file through the chokepoint, or null if it is not there. */
async function readProjectFile(fs: ReadOnlyFs, p: string): Promise<string | null> {
  try {
    const handle = await fs.openRead(p);
    try {
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Load and validate a config file.
 *
 * Three layers, lowest precedence first:
 *
 *   1. the committed config -- generic rules, no paths
 *   2. `config/local.json` -- gitignored, where YOUR root lives
 *   3. ARCHIVE_ROOT / ARCHIVE_NAME / ARCHIVE_ALLOWED_ROOTS in the environment
 *
 * The config files live inside the project, so they are read through a
 * ReadOnlyFs fenced to the project root -- still no write primitives, and
 * still no `node:fs` import outside the chokepoint.
 */
export async function loadConfig(configPath: string): Promise<AppConfig> {
  const p = abs(configPath);
  const projectFs = new ReadOnlyFs({ allowedRoots: [PROJECT_ROOT], dirTimeoutMs: 10_000 });

  const raw = await readProjectFile(projectFs, p);
  if (raw === null) throw new Error(`Config file not found: ${p}`);
  let merged = JSON.parse(raw) as Partial<AppConfig>;
  const sources = [p];

  const localRaw = await readProjectFile(projectFs, abs(LOCAL_CONFIG));
  if (localRaw !== null) {
    // Shallow merge is deliberate: an override replaces a whole key rather
    // than being deep-merged into it. Half-overriding `parse` or `exclusions`
    // would be a very confusing way to break a scan.
    merged = { ...merged, ...(JSON.parse(localRaw) as Partial<AppConfig>) };
    sources.push(abs(LOCAL_CONFIG));
  }

  const envRoot = process.env[ENV_ROOT];
  const envName = process.env[ENV_NAME];
  const envAllowed = process.env[ENV_ALLOWED];
  if (envRoot) {
    merged = { ...merged, root: envRoot };
    // A root supplied by the environment carries its own allowlist unless one
    // is given too, or the interlock below would reject it against a stale
    // allowedRoots from the file layer.
    if (!envAllowed) merged = { ...merged, allowedRoots: [envRoot] };
    sources.push(`$${ENV_ROOT}`);
  }
  if (envName) merged = { ...merged, name: envName };
  if (envAllowed) {
    merged = { ...merged, allowedRoots: envAllowed.split(':').filter(Boolean) };
    sources.push(`$${ENV_ALLOWED}`);
  }

  return normaliseConfig(merged, sources.join(' + '));
}

export function normaliseConfig(input: Partial<AppConfig>, source = '<inline>'): AppConfig {
  const need = <K extends keyof AppConfig>(k: K): NonNullable<AppConfig[K]> => {
    const v = input[k];
    if (v === undefined || v === null) {
      // `root` is absent from the committed config ON PURPOSE, so this is the
      // expected first-run state rather than a corrupt file. Say what to do.
      if (k === 'root') {
        throw new Error(
          `No archive root configured.\n\n` +
            `The scan root is not committed -- it names your storage layout.\n` +
            `Set it in one of two ways:\n\n` +
            `  1. Create ${LOCAL_CONFIG} (gitignored):\n` +
            `       { "root": "/path/to/your/00_D3_Delivery" }\n\n` +
            `  2. Or set the environment variable:\n` +
            `       ${ENV_ROOT}=/path/to/your/00_D3_Delivery\n\n` +
            `See config/local.example.json. Checked: ${source}`,
        );
      }
      throw new Error(`Config ${source} is missing required key ${String(k)}`);
    }
    return v as NonNullable<AppConfig[K]>;
  };

  const root = resolve(need('root'));
  const allowedRoots = (input.allowedRoots?.length ? input.allowedRoots : [root]).map((r) =>
    resolve(r),
  );

  // Safety interlock: the scan root must itself be inside the allowlist,
  // otherwise the first readdir would be refused and the misconfiguration
  // would only surface mid-scan.
  const probe = new ReadOnlyFs({ allowedRoots });
  if (!probe.isAllowed(root)) {
    throw new Error(
      `Config ${source}: root ${root} is not inside any allowedRoots entry ` +
        `(${allowedRoots.join(', ')}). Refusing to run.`,
    );
  }

  return {
    name: input.name ?? 'default',
    root,
    allowedRoots,
    dbPath: input.dbPath ?? 'data/index.db',
    dirTimeoutMs: input.dirTimeoutMs ?? 30_000,
    parse: need('parse'),
    exclusions: {
      globs: input.exclusions?.globs ?? [],
      caseInsensitive: input.exclusions?.caseInsensitive ?? true,
    },
    families: input.families ?? {},
    defaultFamily: input.defaultFamily ?? 'OTHER',
  };
}

/** Resolve the configured db path to an absolute path under the project. */
export function resolveDbPath(cfg: AppConfig): string {
  return abs(cfg.dbPath);
}

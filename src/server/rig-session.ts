/**
 * =============================================================================
 *  RIG SESSION  --  IN MEMORY, AND NOWHERE ELSE
 * =============================================================================
 *
 * Everything this feature knows about the machines lives in one object owned by
 * the running server process:
 *
 *   the addresses, the machine ids, the share and directory names, the mount
 *   points macOS chose, the survey results -- and the credential.
 *
 * NONE OF IT IS WRITTEN ANYWHERE. Not to `data/index.db`, not to `config/`, not
 * to `exports/`, not to a log. Stop the server and it is gone; that is the
 * design, at the operator's request, and it is why this is a plain object with
 * a `clear()` rather than a table. The one artefact that outlives the process
 * is the YAML file the operator chooses to save from the browser, which carries
 * addresses and never a credential -- see `src/rig/targets.ts`.
 *
 * THE CREDENTIAL NEVER COMES BACK OUT. `password` is private, `status()` never
 * includes it, and the only things that read it are `mountShare` and `scrub`.
 * `hasCredentials` is how the UI knows to stop asking. There is no getter,
 * deliberately: an accessor would eventually be called by something that logs.
 *
 * EVERY MOUNT IS READ-ONLY, enforced by the kernel -- see `src/rig/mounts.ts`.
 * `ConnectedTarget.readOnly` is read back out of the mount table per machine
 * rather than asserted here, so this object never claims a protection that is
 * not actually in force.
 *
 * A SURVEY IS CANCELLABLE AND A SCAN IS NOT, for the same reason a probe is:
 * a scan is one atomic walk of one mount, a survey is N independent walks of N
 * machines over a network that may be busy. Cancelling stops before the next
 * machine starts and keeps every machine already surveyed -- nothing is thrown
 * away, and the partial result says which machines it covers.
 * =============================================================================
 */

import { ReadOnlyFs } from '../fs/readonly.ts';
import { walk } from '../scan/walk.ts';
import type { ExclusionMatcher } from '../scan/exclude.ts';
import {
  compareMachine,
  rollUpMissing,
  totalsOf,
  type ExpectedFile,
  type MachineComparison,
  type MachineTotals,
  type MissingRollup,
  type RemoteFile,
} from '../rig/survey.ts';
import type { RigTarget } from '../rig/targets.ts';
import { mountShare, unmountShare, type MountOutcome } from '../rig/mounts.ts';

/** How many machines to walk at once. A show network is not a data centre. */
export const DEFAULT_SURVEY_CONCURRENCY = 4;

export interface ConnectedTarget extends RigTarget {
  mountPoint: string | null;
  alreadyMounted: boolean;
  /**
   * Whether the mountpoint this survey reads through is read-only. Always true
   * for a mount this application made -- `mountShare` refuses to report
   * otherwise -- and reported per target rather than asserted globally so the
   * UI never claims a protection it cannot see.
   */
  readOnly: boolean;
  /**
   * A separate read-WRITE mount of the same share that somebody else made,
   * typically in Finder. Our mountpoint is read-only; that one is not, and the
   * machine is still writable through it. Surfaced rather than hidden.
   */
  otherWritableMount: string | null;
  /** Why this machine could not be mounted, or null. */
  error: string | null;
}

/** One machine's slice of a survey, as the route assembles it. */
export interface SurveyJob {
  target: ConnectedTarget;
  /** Absolute path to walk: the mountpoint plus the operator's directory. */
  root: string;
  /** Regions this machine carries, or null when the address named no machine. */
  regions: number[] | null;
  /** What the archive says belongs here. Empty when there is no machine to ask about. */
  expected: ExpectedFile[];
}

export interface SurveyPlan {
  jobs: SurveyJob[];
  directory: string;
  keepN: number;
  snapshotId: number;
  exclusions: ExclusionMatcher;
  dirTimeoutMs: number;
  regionOfName: (name: string) => number | null;
  /**
   * Every machine that CARRIES each region, from the rig allocation -- not just
   * the ones being surveyed. The difference is what lets the master list say
   * "this is gone from the rig" as opposed to "we did not look at its other
   * holder", which are very different findings.
   */
  regionHolders: Map<number, string[]>;
  concurrency?: number | undefined;
}

export interface MachineResult {
  machineId: string | null;
  host: string;
  mountPoint: string;
  root: string;
  /** Null when this address named no machine: listed, but nothing to compare. */
  totals: MachineTotals | null;
  comparison: MachineComparison | null;
  /** Present for an unmatched address: the listing, with no verdict attached. */
  files: RemoteFile[] | null;
  fileCount: number;
  totalBytes: number;
  /** Directories abandoned during the walk (timeout, permission). */
  skipped: { path: string; reason: string }[];
  elapsedMs: number;
  error: string | null;
}

export interface RigStatus {
  share: string | null;
  directory: string | null;
  targets: ConnectedTarget[];
  /** True once a user name and password have been supplied this session. */
  hasCredentials: boolean;
  /** The user name, which is not secret and is worth showing back. */
  username: string | null;
  survey: {
    running: boolean;
    cancelled: boolean;
    startedAt: number | null;
    finishedAt: number | null;
    done: number;
    total: number;
    keepN: number | null;
    snapshotId: number | null;
    error: string | null;
    results: MachineResult[];
    /**
     * Everything missing, across every machine, in one list. A per-machine card
     * answers "what is wrong with 301?"; this answers "what is wrong with the
     * SHOW?", which on a rig that mirrors every region is a different question.
     */
    missing: MissingRollup;
  };
}

export class RigSession {
  private share: string | null = null;
  private directory: string | null = null;
  private targets: ConnectedTarget[] = [];
  private username: string | null = null;
  /** Never read except by `connect`. Never returned. Never logged. */
  private password: string | null = null;

  private running = false;
  private cancelRequested = false;
  private cancelled = false;
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private done = 0;
  private total = 0;
  private keepN: number | null = null;
  private snapshotId: number | null = null;
  private error: string | null = null;
  private results: MachineResult[] = [];
  private regionHolders: Map<number, string[]> = new Map();
  private inFlight: Promise<void> | undefined;

  isRunning(): boolean {
    return this.running;
  }

  getTargets(): readonly ConnectedTarget[] {
    return this.targets;
  }

  getShare(): string | null {
    return this.share;
  }

  getDirectory(): string | null {
    return this.directory;
  }

  hasCredentials(): boolean {
    return this.username !== null && this.password !== null;
  }

  /**
   * Replace the target list. Any survey results are dropped with it -- results
   * describe a list of machines, and keeping them beside a different list is
   * how a stale reading gets read as a current one.
   */
  setTargets(targets: readonly RigTarget[], share: string | null, directory: string | null): void {
    this.assertIdle();
    this.targets = targets.map((t) => ({
      ...t,
      mountPoint: null,
      alreadyMounted: false,
      readOnly: false,
      otherWritableMount: null,
      error: null,
    }));
    this.share = share;
    this.directory = directory;
    this.clearResults();
  }

  setDirectory(directory: string | null): void {
    this.directory = directory;
  }

  setShare(share: string | null): void {
    this.share = share;
  }

  /** Hold a credential for this session. Cleared by `clear()` and never returned. */
  setCredentials(username: string | null, password: string | null): void {
    this.username = username && username !== '' ? username : null;
    this.password = password && password !== '' ? password : null;
  }

  /**
   * Mount every target's share, read-only, in sequence.
   *
   * Sequential on purpose: these are playback machines on a show network, and
   * twenty-three simultaneous SMB session setups is not something to do to a
   * rig that may be loading a show. One failure never stops the others -- the
   * error is recorded on that target and the loop continues, because a rig
   * with one machine off is exactly when this view is most worth having.
   */
  async connect(shareOverride?: string): Promise<ConnectedTarget[]> {
    this.assertIdle();
    const share = shareOverride ?? this.share;
    if (!share) throw new Error('No share name has been set.');
    this.share = share;

    for (const t of this.targets) {
      try {
        const outcome: MountOutcome = await mountShare({
          host: t.host,
          share,
          username: this.username ?? undefined,
          password: this.password ?? undefined,
        });
        t.mountPoint = outcome.mountPoint;
        t.alreadyMounted = outcome.alreadyMounted;
        t.readOnly = outcome.readOnly;
        t.otherWritableMount = outcome.otherWritableMount;
        t.error = null;
      } catch (err) {
        t.mountPoint = null;
        t.alreadyMounted = false;
        t.readOnly = false;
        t.otherWritableMount = null;
        // From `mount_smbfs`. It is not given the password back, so it cannot
        // echo one -- but the message is scrubbed anyway, since a URL it failed
        // to parse could contain what was typed.
        t.error = this.scrub(err instanceof Error ? err.message : String(err));
      }
    }
    return this.targets;
  }

  /** Begin a survey. Returns as soon as it is under way; poll `status()`. */
  start(plan: SurveyPlan): void {
    this.assertIdle();
    this.clearResults();
    this.running = true;
    this.cancelRequested = false;
    this.cancelled = false;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.total = plan.jobs.length;
    this.keepN = plan.keepN;
    this.snapshotId = plan.snapshotId;
    this.directory = plan.directory;
    this.regionHolders = plan.regionHolders;

    this.inFlight = this.run(plan)
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.running = false;
        this.finishedAt = Date.now();
        this.cancelled = this.cancelRequested;
      });
  }

  /**
   * Take away every mountpoint this application made, and forget the results
   * that described them. Jailed inside `unmountShare`: nothing outside our own
   * mount root can be unmounted, so a volume the operator connected -- or the
   * object mount holding the archive -- is unreachable from here.
   */
  async disconnect(): Promise<{ disconnected: number; errors: string[] }> {
    this.assertIdle();
    const errors: string[] = [];
    let disconnected = 0;
    for (const t of this.targets) {
      if (!t.mountPoint) continue;
      try {
        await unmountShare(t.mountPoint);
        disconnected += 1;
      } catch (err) {
        errors.push(`${t.host}: ${this.scrub(err instanceof Error ? err.message : String(err))}`);
        continue;
      }
      t.mountPoint = null;
      t.alreadyMounted = false;
      t.readOnly = false;
      t.otherWritableMount = null;
    }
    this.clearResults();
    return { disconnected, errors };
  }

  /**
   * Remove anything that looks like the credential from a message before it is
   * shown or stored. `mount_smbfs` is not handed the password back and does not
   * echo it, but a message is the one place a typed secret could surface, and
   * the cost of being sure is one string replacement.
   */
  private scrub(message: string): string {
    let out = message;
    if (this.password) out = out.split(this.password).join('••••');
    return out;
  }

  /** Stop before the next machine. Everything already surveyed is kept. */
  cancel(): boolean {
    if (!this.running) return false;
    this.cancelRequested = true;
    return true;
  }

  /** Wait for the current survey, if any. Tests use this; routes do not. */
  async settle(): Promise<void> {
    await this.inFlight;
  }

  /**
   * Forget everything, credential included. What the operator presses when
   * they are done, and the only way the password leaves this process short of
   * stopping it.
   */
  clear(): void {
    this.assertIdle();
    this.targets = [];
    this.share = null;
    this.directory = null;
    this.username = null;
    this.password = null;
    this.clearResults();
  }

  status(): RigStatus {
    return {
      share: this.share,
      directory: this.directory,
      targets: this.targets.map((t) => ({ ...t })),
      hasCredentials: this.hasCredentials(),
      username: this.username,
      survey: {
        running: this.running,
        cancelled: this.cancelled,
        startedAt: this.startedAt,
        finishedAt: this.finishedAt,
        done: this.done,
        total: this.total,
        keepN: this.keepN,
        snapshotId: this.snapshotId,
        error: this.error,
        results: this.results,
        // Recomputed per call rather than cached, so it stays truthful while a
        // survey is still filling `results` in. It is a roll-up of a few
        // hundred rows at most; the payload costs more than the arithmetic.
        missing: rollUpMissing(this.results, this.regionHolders),
      },
    };
  }

  // -------------------------------------------------------------------------

  private assertIdle(): void {
    if (this.running) {
      throw new Error('A survey is running. Cancel it before changing the rig session.');
    }
  }

  private clearResults(): void {
    this.results = [];
    this.done = 0;
    this.total = 0;
    this.startedAt = null;
    this.finishedAt = null;
    this.error = null;
    this.cancelled = false;
    this.keepN = null;
    this.snapshotId = null;
  }

  private async run(plan: SurveyPlan): Promise<void> {
    const limit = Math.max(1, plan.concurrency ?? DEFAULT_SURVEY_CONCURRENCY);
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.cancelRequested) return;
        const i = next++;
        if (i >= plan.jobs.length) return;
        const job = plan.jobs[i] as SurveyJob;
        const result = await this.surveyOne(job, plan);
        this.results.push(result);
        this.done += 1;
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, plan.jobs.length) }, worker));

    // Stable, readable order regardless of which worker finished first.
    this.results.sort(
      (a, b) =>
        (a.machineId ?? '~').localeCompare(b.machineId ?? '~') || a.host.localeCompare(b.host),
    );
  }

  private async surveyOne(job: SurveyJob, plan: SurveyPlan): Promise<MachineResult> {
    const started = Date.now();
    const base: MachineResult = {
      machineId: job.target.machineId,
      host: job.target.host,
      mountPoint: job.target.mountPoint ?? '',
      root: job.root,
      totals: null,
      comparison: null,
      files: null,
      fileCount: 0,
      totalBytes: 0,
      skipped: [],
      elapsedMs: 0,
      error: job.target.error,
    };
    if (!job.target.mountPoint) {
      return { ...base, error: job.target.error ?? 'Not mounted.', elapsedMs: 0 };
    }

    try {
      // Fenced to THIS machine's mountpoint and nothing else: the survey can
      // reach exactly as far as the directory the operator named.
      const rofs = new ReadOnlyFs({
        allowedRoots: [job.target.mountPoint],
        dirTimeoutMs: plan.dirTimeoutMs,
      });
      const result = await walk(rofs, job.root, plan.exclusions);

      const files: RemoteFile[] = result.files.map((f) => ({
        relPath: f.relPath,
        name: f.name,
        size: f.size,
        mtime: f.mtime,
      }));

      const out: MachineResult = {
        ...base,
        fileCount: files.length,
        totalBytes: result.totalBytes,
        skipped: result.skipped.map((s) => ({ path: s.path, reason: s.reason })),
        elapsedMs: Date.now() - started,
        error: null,
      };

      if (job.regions === null) {
        // No machine id, so there is nothing to compare against. The listing is
        // returned as a listing, and the UI says why there is no verdict.
        return { ...out, files };
      }

      const comparison = compareMachine(files, job.expected, {
        regions: job.regions,
        regionOfName: plan.regionOfName,
      });
      return { ...out, comparison, totals: totalsOf(comparison) };
    } catch (err) {
      return {
        ...base,
        elapsedMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

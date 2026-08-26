/**
 * Exclusion matching. PURE -- no I/O.
 *
 * FreeFileSync already syncs the delivery folder and leaves bookkeeping files
 * behind. Those are excluded from ANALYSIS, but they are COUNTED so they are
 * never silently invisible: see `ExcludedTally` and the `excluded_*` fields on
 * the scan report.
 *
 * Only the leading `*` / trailing `*` / interior `*` wildcard is supported --
 * that is all the configured globs need, and a full glob engine would be an
 * unnecessary dependency. Patterns match the BASENAME, not the path.
 */

export interface ExcludedTally {
  /** Number of excluded entries seen. */
  count: number;
  /** Total bytes of excluded entries (they are still stat'ed to count them). */
  bytes: number;
  /** Per-pattern hit counts, so an unused pattern is visible. */
  byPattern: Record<string, number>;
}

function globToRegExp(glob: string, caseInsensitive: boolean): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, caseInsensitive ? 'i' : '');
}

export class ExclusionMatcher {
  private readonly rules: { glob: string; re: RegExp }[];
  readonly tally: ExcludedTally;

  constructor(globs: readonly string[], caseInsensitive = true) {
    this.rules = globs.map((glob) => ({ glob, re: globToRegExp(glob, caseInsensitive) }));
    this.tally = { count: 0, bytes: 0, byPattern: Object.fromEntries(globs.map((g) => [g, 0])) };
  }

  /** The pattern that excludes `name`, or null if it is not excluded. */
  match(name: string): string | null {
    for (const rule of this.rules) {
      if (rule.re.test(name)) return rule.glob;
    }
    return null;
  }

  isExcluded(name: string): boolean {
    return this.match(name) !== null;
  }

  /** Record an exclusion hit so it is counted rather than invisible. */
  record(pattern: string, bytes: number): void {
    this.tally.count += 1;
    this.tally.bytes += bytes;
    this.tally.byPattern[pattern] = (this.tally.byPattern[pattern] ?? 0) + 1;
  }
}

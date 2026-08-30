/**
 * =============================================================================
 *  THE TARGET LIST  --  WHICH MACHINES, AND WHICH ONE IS WHICH
 * =============================================================================
 *
 * The operator pastes a list of addresses. It changes occasionally, and it is
 * never stored by this application: it lives in the running server's memory
 * and in whatever file the operator chooses to save from the browser.
 *
 * TWO INPUT FORMS, ONE PARSER. Both arrive here as text, and there is exactly
 * one implementation so a list that round-trips through the YAML file cannot
 * come back meaning something different from the list that was typed.
 *
 *   PLAIN, for typing or pasting from a message:
 *       101 10.10.1.53
 *       102=10.10.1.54
 *       10.10.1.99            <- no machine id: surveyed, but not compared
 *       # anything after a hash is a comment
 *
 *   YAML, for saving and re-importing:
 *       share: d3 Projects
 *       directory: media/SHOW_2026
 *       machines:
 *         - id: "101"
 *           host: 10.10.1.53
 *         - host: 10.10.1.99
 *
 * WHY A MACHINE ID IS OPTIONAL AND WHAT IT BUYS. An address on its own can be
 * listed and walked, but nothing can be said about whether its contents are
 * RIGHT -- the archive's expectations are keyed by machine, because the region
 * allocation is (`src/machines.ts`). Tag an address with the machine it is and
 * the survey can compare; leave it untagged and the survey reports the files
 * and says plainly that it has nothing to compare them against. Guessing the
 * machine from the address would be inventing the one fact the comparison
 * rests on.
 *
 * THIS IS A DELIBERATELY MINIMAL YAML SUBSET, not a YAML implementation. It
 * reads the document this application writes and rejects everything else with
 * the line number and a reason. That is a feature: a general parser would
 * silently accept anchors, flow mappings and multi-document streams that this
 * application has no meaning for, and the failure would surface later as a
 * machine that was quietly not surveyed.
 * =============================================================================
 */

import { assertHost, InvalidTargetError, isIpv4 } from './mounts.ts';

/** One machine to survey. */
export interface RigTarget {
  /**
   * The machine in the rig this address is, or null when the operator did not
   * say. Null means "list it, but do not claim to know what should be on it".
   */
  machineId: string | null;
  /** IPv4 literal or host name. Validated by `assertHost`. */
  host: string;
}

export interface TargetListError {
  /** 1-based line number in the submitted text. */
  line: number;
  /** The offending line, verbatim, so the operator can see what was rejected. */
  text: string;
  message: string;
}

export interface TargetList {
  targets: RigTarget[];
  /** SMB share name, when the document named one. */
  share: string | null;
  /** Directory to survey, relative to the share root, when the document named one. */
  directory: string | null;
  /** Lines that could not be read. Reported, never silently dropped. */
  errors: TargetListError[];
}

/** Ceiling on a list. Far above any real rig; stops a paste of a whole file. */
export const MAX_TARGETS = 256;

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

/** Strip one layer of surrounding quotes, as the YAML we emit uses them for ids. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * A machine id as the rig writes them: `101`, `307`. Kept permissive about the
 * exact characters (a config rig may name machines differently) and strict
 * about length and shape, since it is only ever compared, never executed.
 */
function normaliseMachineId(raw: string): string {
  const id = unquote(raw);
  if (id === '' || id.length > 64 || /[\s"'\\/]/.test(id)) {
    throw new InvalidTargetError(`${JSON.stringify(raw)} is not a usable machine id.`);
  }
  return id;
}

/** True when the text looks like the YAML document this module writes. */
export function looksLikeYaml(text: string): boolean {
  return /^\s*machines:\s*$/m.test(String(text ?? ''));
}

/**
 * Parse the plain form: one machine per line, `[<id>] <host>`.
 *
 * The separator is generous -- space, comma, equals, tab, or a mix -- because
 * this list arrives pasted out of a message or a spreadsheet and the operator
 * should not have to reformat it to be understood.
 */
function parsePlain(text: string): TargetList {
  const targets: RigTarget[] = [];
  const errors: TargetListError[] = [];
  const lines = String(text ?? '').split('\n');

  lines.forEach((raw, i) => {
    const line = stripComment(raw);
    if (line === '') return;
    const parts = line.split(/[\s,=]+/).filter(Boolean);
    try {
      if (parts.length === 1) {
        targets.push({ machineId: null, host: assertHost(parts[0] as string) });
      } else if (parts.length === 2) {
        // `101 10.10.1.53` or, just as readably, `10.10.1.53 101`. Whichever
        // token is an IPv4 literal is the address -- a machine id never is.
        //
        // This is decided EXPLICITLY rather than by trying one order and
        // falling back: `101` is a syntactically valid DNS name, so a
        // try/catch would happily read `10.10.1.53 101` as machine
        // "10.10.1.53" at host "101" and survey nothing.
        const [a, b] = parts as [string, string];
        const [idToken, hostToken] = isIpv4(a) && !isIpv4(b) ? [b, a] : [a, b];
        targets.push({
          machineId: normaliseMachineId(idToken),
          host: assertHost(hostToken),
        });
      } else {
        throw new InvalidTargetError(
          'Expected an address, optionally preceded by the machine it is ' +
            `(for example "101 10.10.1.53"). Got ${parts.length} values.`,
        );
      }
    } catch (err) {
      errors.push({ line: i + 1, text: raw, message: messageOf(err) });
    }
  });

  return { targets, share: null, directory: null, errors };
}

/** Parse the YAML subset this application writes. */
function parseYaml(text: string): TargetList {
  const targets: RigTarget[] = [];
  const errors: TargetListError[] = [];
  let share: string | null = null;
  let directory: string | null = null;
  let inMachines = false;
  /** The entry being built by the `- id:` / `host:` lines beneath it. */
  let current: { machineId: string | null; host: string | null; line: number } | null = null;

  const lines = String(text ?? '').split('\n');

  const flush = (): void => {
    if (!current) return;
    const { machineId, host, line } = current;
    current = null;
    if (host === null) {
      errors.push({ line, text: lines[line - 1] ?? '', message: 'This entry has no host.' });
      return;
    }
    try {
      targets.push({ machineId, host: assertHost(host) });
    } catch (err) {
      errors.push({ line, text: lines[line - 1] ?? '', message: messageOf(err) });
    }
  };

  lines.forEach((raw, i) => {
    const line = stripComment(raw);
    if (line === '') return;
    const lineNo = i + 1;

    if (/^machines:$/.test(line)) {
      flush();
      inMachines = true;
      return;
    }

    if (!inMachines) {
      const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
      if (!m) {
        errors.push({ line: lineNo, text: raw, message: 'Expected `key: value`.' });
        return;
      }
      const [, key = '', value = ''] = m;
      if (key === 'share') share = unquote(value) || null;
      else if (key === 'directory') directory = unquote(value) || null;
      // Unknown top-level keys are IGNORED rather than rejected, so a file
      // written by a later version still imports its machines here.
      return;
    }

    // Inside `machines:`. An entry starts with `- `, and may carry its first
    // field on the same line: `- id: "101"`.
    const item = /^-\s*(.*)$/.exec(line);
    if (item) {
      flush();
      current = { machineId: null, host: null, line: lineNo };
      const rest = (item[1] ?? '').trim();
      if (rest === '') return;
      applyField(rest, lineNo, raw);
      return;
    }

    if (!current) {
      errors.push({ line: lineNo, text: raw, message: 'Expected a `- ` entry under `machines:`.' });
      return;
    }
    applyField(line, lineNo, raw);
  });

  flush();

  function applyField(fragment: string, lineNo: number, raw: string): void {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(fragment);
    if (!m || !current) {
      errors.push({ line: lineNo, text: raw, message: 'Expected `id: …` or `host: …`.' });
      return;
    }
    const [, key = '', value = ''] = m;
    if (key === 'host') {
      current.host = unquote(value);
    } else if (key === 'id' || key === 'machine') {
      try {
        current.machineId = normaliseMachineId(value);
      } catch (err) {
        errors.push({ line: lineNo, text: raw, message: messageOf(err) });
      }
    }
    // Other keys ignored, for the same forward-compatibility reason as above.
  }

  return { targets, share, directory, errors };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a pasted list or an imported YAML file into targets.
 *
 * Duplicate addresses are collapsed, keeping the first occurrence and its
 * machine id -- a list pasted twice should survey each machine once, not race
 * two walks down the same mountpoint.
 */
export function parseTargetList(text: string): TargetList {
  const parsed = looksLikeYaml(text) ? parseYaml(text) : parsePlain(text);

  const seen = new Set<string>();
  const deduped: RigTarget[] = [];
  for (const t of parsed.targets) {
    const key = t.host.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }

  if (deduped.length > MAX_TARGETS) {
    parsed.errors.push({
      line: 0,
      text: '',
      message: `${deduped.length} addresses is more than the ${MAX_TARGETS} this will accept.`,
    });
    deduped.length = MAX_TARGETS;
  }

  return { ...parsed, targets: deduped };
}

export interface YamlDocument {
  targets: readonly RigTarget[];
  share?: string | null | undefined;
  directory?: string | null | undefined;
}

/**
 * Render the target list as the YAML file the operator saves.
 *
 * NO CREDENTIAL IS EVER WRITTEN HERE, and the header says so, because the file
 * is the one artefact of this feature that outlives the session and the
 * operator has to be able to see at a glance what is in it. The username is
 * omitted for the same reason -- it is typed with the password, per session.
 */
export function formatTargetsYaml(doc: YamlDocument): string {
  const out: string[] = [
    '# Media Allocation Analyzer — rig target list',
    '#',
    '# Addresses only. No password and no user name is ever written to this file,',
    '# and this application never stores it: keep it wherever you keep your show',
    '# paperwork and import it from the Rig tab when the addresses change.',
    '',
  ];
  if (doc.share) out.push(`share: ${quoteIfNeeded(doc.share)}`);
  if (doc.directory) out.push(`directory: ${quoteIfNeeded(doc.directory)}`);
  out.push('machines:');
  for (const t of doc.targets) {
    if (t.machineId) {
      out.push(`  - id: ${JSON.stringify(t.machineId)}`);
      out.push(`    host: ${t.host}`);
    } else {
      out.push(`  - host: ${t.host}`);
    }
  }
  out.push('');
  return out.join('\n');
}

/** Quote a scalar when it could otherwise be misread -- `d3 Projects` need not be. */
function quoteIfNeeded(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 ._\-/]*$/.test(value) ? value : JSON.stringify(value);
}

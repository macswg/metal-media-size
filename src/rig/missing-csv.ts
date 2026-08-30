/**
 * =============================================================================
 *  THE MASTER LIST AS A CSV  --  RENDERED, NEVER WRITTEN
 * =============================================================================
 *
 * The rig session is not persisted: not to the index, not to `config/`, not to
 * `exports/`, not to a log. That is deliberate and it does not change here.
 * This module RENDERS text; the route puts it in a response body and the
 * browser hands it to the operator's own save dialog, exactly as the target
 * YAML has always worked. Nothing in this application writes it anywhere.
 *
 * WHAT IT CARRIES: machine IDs (`101`, `207`), file names, songs, versions,
 * regions and sizes. **No address and no credential**, because the roll-up has
 * neither -- expectations are keyed by machine id, and the addresses never
 * leave `RigSession`. Pinned by a test rather than left to inspection.
 *
 * THE WHOLE LIST, NOT THE VISIBLE ONE. The tab paints the worst 500 rows; an
 * export that quietly stopped at the same place would be a list of findings
 * with findings missing from it. Everything the roll-up found goes in, in the
 * order the roll-up put it in -- alarms first, biggest first.
 *
 * BYTES ARE BYTES. One numeric column, not "2.06 TiB": a spreadsheet can sum
 * and sort a number and cannot do either with a formatted string. The tab is
 * where sizes are for reading.
 * =============================================================================
 */

import type { MissingRollup, MissingRow } from './survey.ts';

/** The columns, in order. Fixed: a moving header breaks every saved sheet. */
export const MISSING_CSV_COLUMNS = [
  'state',
  'song',
  'file',
  'version',
  'region',
  'bytes',
  'missing_from',
  'present_on',
  'wrong_size_on',
  'not_surveyed',
] as const;

/**
 * RFC 4180: quote a field that contains a quote, a comma or a line break, and
 * double any quote inside it.
 *
 * No formula-injection guard, and that is a decision rather than an oversight:
 * every field here comes from the archive's own grammar or from a machine id,
 * so none can begin with `=`, `+` or `@`, and prefixing a `'` defensively would
 * corrupt the one thing an operator uses this file for -- looking a file name
 * up. If a field ever could carry arbitrary text, revisit this.
 */
export function csvField(value: string | number): string {
  const s = String(value);
  return /["\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Machine ids inside one cell. Space-separated: an id cannot contain a space. */
const machines = (ids: readonly string[]): string => ids.join(' ');

function row(r: MissingRow): string {
  return [
    r.state,
    r.songFolder,
    r.name,
    r.verLabel,
    r.region,
    r.size,
    machines(r.missingFrom),
    machines(r.presentOn),
    machines(r.wrongSizeOn),
    machines(r.unknownOn),
  ]
    .map(csvField)
    .join(',');
}

/**
 * The whole roll-up as CSV, with a header row.
 *
 * CRLF line endings, as RFC 4180 specifies and as Excel expects; a trailing
 * newline so the file ends on a row boundary.
 */
export function formatMissingCsv(missing: Pick<MissingRollup, 'rows'>): string {
  const lines = [MISSING_CSV_COLUMNS.join(','), ...missing.rows.map(row)];
  return `${lines.join('\r\n')}\r\n`;
}

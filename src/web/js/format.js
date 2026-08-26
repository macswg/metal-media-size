/**
 * Formatting helpers. Every number the user reads passes through here so units
 * and precision are consistent across the whole tool.
 */

const TIB = 1024 ** 4;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const KIB = 1024;

/**
 * Bytes as a binary-prefixed string with an unambiguous unit.
 * Two decimal places from MiB up, so columns line up and small differences
 * stay visible at TiB scale.
 */
export function bytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const v = Number(n);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= TIB) return `${sign}${(a / TIB).toFixed(2)} TiB`;
  if (a >= GIB) return `${sign}${(a / GIB).toFixed(2)} GiB`;
  if (a >= MIB) return `${sign}${(a / MIB).toFixed(2)} MiB`;
  if (a >= KIB) return `${sign}${(a / KIB).toFixed(2)} KiB`;
  return `${sign}${a} B`;
}

/** Split form for two-tone rendering: ['51.99', 'TiB']. */
export function bytesParts(n) {
  const s = bytes(n);
  const i = s.lastIndexOf(' ');
  return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

/** Always TiB, for the headline figures where the unit must never shift. */
export function tib(n) {
  return `${(Number(n || 0) / TIB).toFixed(2)} TiB`;
}

export function toTiB(n) {
  return Number(n || 0) / TIB;
}

/** Parse "500", "500GB", "2 TiB", "1.5t" into bytes. Returns null if empty. */
export function parseSize(text) {
  if (!text) return null;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*([kmgtp]?)(i?b?)\s*$/i.exec(String(text));
  if (!m) return null;
  const mult = { '': 1, k: KIB, m: MIB, g: GIB, t: TIB, p: 1024 ** 5 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

const NUM = new Intl.NumberFormat('en-GB');
export function count(n) {
  return NUM.format(Number(n || 0));
}

export function date(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function dateTime(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** epoch ms -> yyyy-mm-dd for <input type="date">. */
export function dateInputValue(ms) {
  return ms ? date(ms) : '';
}

export function parseDateInput(text, endOfDay) {
  if (!text) return null;
  const t = Date.parse(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
  return Number.isNaN(t) ? null : t;
}

export function duration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/* ------------------------------------------------------------------ */
/* KeepReason, in plain English.                                       */
/* The union lives in src/scan/reclaim.ts and is surfaced verbatim by  */
/* the API; this is the only place it is turned into user-facing prose.*/
/* ------------------------------------------------------------------ */

const KEEP_REASON = {
  'kept-full-latest': {
    short: 'latest full version',
    long: 'This is one of the latest full renders of the asset, inside the keep window.',
  },
  'kept-patch-newer-than-latest-full': {
    short: 'patch newer than the latest full render',
    long: 'A partial re-render that sits above the newest full version, so no full render contains its fixed frames. Protected at every keep-N.',
  },
  'kept-patch-of-latest-full': {
    short: 'patch on the current version',
    long: 'A partial re-render at the same version number as the newest full render. Nothing newer replaces it, so it is protected at every keep-N.',
  },
  'kept-no-full-versions': {
    short: 'no full version exists',
    long: 'This asset has no full render at all, so nothing can supersede this. Everything is kept.',
  },
  'superseded-full': {
    short: 'a newer full version exists',
    long: 'Newer full renders have pushed this version out of the keep window.',
  },
  'superseded-patch': {
    short: 'a newer full render absorbs this patch',
    long: 'A kept full version newer than this patch already contains the frames it fixed.',
  },
  'kept-proxy-only-newer-than-latest-full': {
    short: 'preview above the current master',
    long: 'This version is a low-res preview and nothing else — it has no region files. It sits above the newest region-bearing version, so it is most likely the preview of a render still in progress. A preview can never supersede a master, so this is protected at every keep-N.',
  },
  'superseded-proxy-only': {
    short: 'a newer full render replaces this preview',
    long: 'A low-res preview with no region files, sitting below a kept region-bearing version that supersedes it.',
  },
};

/**
 * The keep/supersede verdict, in the words the user asked for.
 *
 * The WIRE VALUE stays `superseded` -- it is the API contract, the CSS class
 * and the reclaim vocabulary, and renaming it would ripple through every
 * keepReason. Only what a person reads changes.
 *
 * "Slated" is the policy's word, at the current keep-N. What the USER ticked
 * is a different thing, labelled "manually marked" -- keeping the two verbs
 * apart is the whole point, because only one of them is a decision.
 */
export function statusLabel(status) {
  if (status === 'superseded') return 'slated for removal';
  if (status === 'kept') return 'keep';
  if (status === 'kept-by-you') return 'keeping';
  return status || '—';
}

export function keepReasonText(reason) {
  return KEEP_REASON[reason]?.short ?? reason ?? '—';
}

/**
 * What the Why column says once you have overridden the policy on a row.
 *
 * The policy's reason is still true -- a newer version really does exist --
 * but it is no longer WHY this version is staying. You are. Leaving the
 * policy's sentence in place would read as though the tool decided to keep it,
 * which is the one thing this column must never imply. The original verdict
 * moves into the tooltip rather than being thrown away.
 */
export const OVERRIDE_REASON_TEXT = 'manual override';

export function overrideReasonDetail(reason) {
  const policy = KEEP_REASON[reason]?.short;
  return (
    'You un-ticked this version, so it stays out of the export manifest and nothing will touch it.' +
    (policy ? `\n\nThe policy's verdict was: ${policy}.` : '') +
    '\n\nTick it again to hand the decision back to the policy.'
  );
}

export function keepReasonDetail(reason) {
  return KEEP_REASON[reason]?.long ?? '';
}

export function isPatchReason(reason) {
  return reason === 'kept-patch-newer-than-latest-full' || reason === 'kept-patch-of-latest-full' || reason === 'superseded-patch';
}

/* A version that carries a preview and no region files at all. */
export function isProxyOnlyReason(reason) {
  return reason === 'kept-proxy-only-newer-than-latest-full' || reason === 'superseded-proxy-only';
}

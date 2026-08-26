/**
 * Filename grammar parser. PURE -- no I/O, no fs, no clock.
 *
 * Grammar (verified against all 26,661 files in the delivery folder):
 *
 *   <base>_v<NNN>[<letter>][_frame<NNNNN>][_proxy3]_region<N>.mov
 *
 * Examples:
 *   140_RIVER_ANIMATIC_LL180_v008_region1.mov
 *   140_RIVER_ANIMATIC_IMAG_LL180_v007_proxy3_region0.mov
 *   250_HARBOR_ANIMATIC_A_LL180_v003_frame05259_region11.mov
 *   880_IMAG_CAM_A_EDIT_RECT_v001.mov            <- region-less, still valid
 *   170_EMBER_FRAME_04_LL180_v001d.mov           <- letter sub-revision
 *
 * `base` is the ASSET IDENTITY. It must NOT be normalised, stemmed, lowercased
 * or fuzzy-matched. `140_RIVER_ANIMATIC_LL180` and `140_RIVER_ANIMATIC_IMAG_LL180`
 * are DIFFERENT deliverables that happen to share a prefix. Asset identity is
 * the pair (song_folder, base).
 *
 * The lazy quantifier on `base` is load-bearing: it makes the regex bind `_v`
 * to the LAST plausible version token rather than the first, which matters for
 * names like `170_EMBER_FRAME_04_LL180_v001d.mov` that contain `FRAME` inside
 * the base.
 *
 * Never throws: an unparseable name returns `{ ok: false }` with the raw name.
 */

export const DEFAULT_PATTERN =
  '^(?<base>.+?)_[vV](?<ver>\\d+)(?<sub>[a-zA-Z])?(?<frame>_frame_?\\d+)?(?<proxy>_proxy\\d+)?(?:_region(?<region>\\d+))?\\.mov$';

export const DEFAULT_FLAGS = 'i';

export interface ParsedName {
  ok: true;
  /** Asset identity within a song folder. Verbatim, never normalised. */
  base: string;
  /** Numeric version. `v008` -> 8. */
  ver: number;
  /** Version token exactly as written, e.g. `008`, preserving zero padding. */
  verRaw: string;
  /** Lower-cased sub-revision letter, e.g. `d`, or null. */
  sub: string | null;
  /** True when the file carries a `_frameNNNNN` token: a PARTIAL re-render. */
  isPatch: boolean;
  /** Numeric frame from the patch token, or null when not a patch. */
  patchFrame: number | null;
  /** True for `_proxyN` files (low-res whole-canvas preview). */
  isProxy: boolean;
  /** Proxy level from `_proxy3` -> 3, or null. */
  proxyLevel: number | null;
  /** Region number. `region0` is the proxy canvas. null when region-less. */
  region: number | null;
  /** Lower-cased extension without the dot, e.g. `mov`. */
  ext: string;
}

export interface UnparsedName {
  ok: false;
  name: string;
  reason: string;
  /** Lower-cased extension without the dot, best-effort. */
  ext: string;
}

export type ParseResult = ParsedName | UnparsedName;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Build a parser bound to a pattern. Compiling once and reusing avoids
 * re-parsing the regex 26k times.
 */
export function makeParser(
  pattern: string = DEFAULT_PATTERN,
  flags: string = DEFAULT_FLAGS,
): (name: string) => ParseResult {
  const re = new RegExp(pattern, flags);
  return (name: string): ParseResult => {
    const ext = extensionOf(name);
    const m = re.exec(name);
    if (!m?.groups) {
      return { ok: false, name, reason: 'does not match filename grammar', ext };
    }
    const g = m.groups;

    const base = g.base ?? '';
    if (base === '') {
      return { ok: false, name, reason: 'empty base', ext };
    }

    const verRaw = g.ver ?? '';
    const ver = Number.parseInt(verRaw, 10);
    if (!Number.isFinite(ver)) {
      return { ok: false, name, reason: `unparseable version ${JSON.stringify(verRaw)}`, ext };
    }

    // `_frame05259` or `_frame_05259` -> 5259
    const frameTok = g.frame ?? null;
    const isPatch = frameTok !== null;
    let patchFrame: number | null = null;
    if (frameTok) {
      const digits = /(\d+)$/.exec(frameTok);
      patchFrame = digits?.[1] !== undefined ? Number.parseInt(digits[1], 10) : null;
    }

    // `_proxy3` -> 3
    const proxyTok = g.proxy ?? null;
    const isProxy = proxyTok !== null;
    let proxyLevel: number | null = null;
    if (proxyTok) {
      const digits = /(\d+)$/.exec(proxyTok);
      proxyLevel = digits?.[1] !== undefined ? Number.parseInt(digits[1], 10) : null;
    }

    const regionTok = g.region ?? null;
    const region = regionTok === null ? null : Number.parseInt(regionTok, 10);

    return {
      ok: true,
      base,
      ver,
      verRaw,
      sub: g.sub ? g.sub.toLowerCase() : null,
      isPatch,
      patchFrame,
      isProxy,
      proxyLevel,
      region,
      ext,
    };
  };
}

/** Convenience parser using the default grammar. */
export const parseName = makeParser();

/**
 * Informational display label derived from tokens in `base`.
 *
 * WARNING TO FUTURE AGENTS: `family` is a DISPLAY LABEL ONLY. It must never be
 * used to auto-classify a file as removable, stale, or safe to delete. Reclaim
 * decisions come from `reclaim.ts` and the patch rule -- nothing else.
 */
export function familyOf(base: string, families: Record<string, string[]>, fallback = 'OTHER'): string {
  const tokens = new Set(base.toUpperCase().split(/[^A-Z0-9]+/i).filter(Boolean));
  for (const [label, needles] of Object.entries(families)) {
    for (const needle of needles) {
      if (tokens.has(needle.toUpperCase())) return label;
    }
  }
  return fallback;
}

/**
 * Viewport breakpoint, shared by the CSS and the JS.
 *
 * The narrow layout is mostly CSS (see the NARROW SCREENS block in app.css),
 * but two things cannot be done in CSS: choosing which table columns exist at
 * all, and knowing when to close the off-canvas filter sheet. Both need the
 * breakpoint as a value, so it is defined once here and the stylesheet is
 * expected to match.
 *
 * Kept deliberately tiny and dependency-free: it is imported during boot,
 * before anything else is wired up.
 */

/** Must match the `@media (max-width: 760px)` block in app.css. */
export const NARROW_MAX_PX = 760;

const query = window.matchMedia(`(max-width: ${NARROW_MAX_PX}px)`);

/** True when the app is in its phone layout. */
export function isNarrow() {
  return query.matches;
}

/**
 * True for touch-first devices. Used to skip affordances that only make sense
 * with a pointer, not to infer screen size -- an iPad is coarse and wide.
 */
export function isCoarsePointer() {
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Run `fn(narrow)` whenever the layout crosses the breakpoint. Returns an
 * unsubscribe function. Does NOT fire on registration -- callers are already
 * rendering for the current width when they subscribe.
 */
export function onBreakpointChange(fn) {
  const handler = (e) => fn(e.matches);
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}

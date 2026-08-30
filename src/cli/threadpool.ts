/**
 * =============================================================================
 *  UV_THREADPOOL_SIZE  --  SET IT IN NODE, NOT IN THE SHELL
 * =============================================================================
 *
 * Every archive read this application makes goes through libuv's thread pool,
 * which is **four threads by default**. At four, asking for 64 lanes gets you
 * four: the probe reads at ~4.7 files/s instead of ~10, and -- worse -- the web
 * UI starves, because a static file read queues behind ~1 s archive reads.
 * `index.html` took 4.1 s to serve while a probe ran. See CLAUDE.md.
 *
 * IT USED TO BE SET IN THE NPM SCRIPT, as `UV_THREADPOOL_SIZE=64 node ...`.
 * That is shell syntax, and it is POSIX shell syntax: npm runs scripts through
 * `cmd.exe` on Windows, where a leading `NAME=value` is not an assignment but
 * the name of a program to run. `npm run serve` and `npm run probe` therefore
 * did not start at all on a PC -- and `start-analyser.bat`, which exists and is
 * a real Windows launcher, called `npm run serve` as its last line.
 *
 * So the value is set HERE instead, in Node, where it works the same on every
 * platform and cannot be lost by whoever launches the process.
 *
 * WHY THIS WORKS, MEASURED RATHER THAN ASSUMED. libuv creates the pool lazily,
 * on the first task submitted to it, and reads `UV_THREADPOOL_SIZE` at that
 * moment. Node keeps `process.env` and the real environment in step, so a write
 * here reaches libuv provided it happens before any threadpool work. Measured
 * with eight concurrent `pbkdf2` calls, which are threadpool tasks: ~130 ms at
 * the default of four (two rounds) and ~80 ms with the pool set to eight in
 * process (one round). The pool honoured it.
 *
 * IMPORT THIS FIRST. ES modules evaluate imports in source order before the
 * importing module's own body, so an assignment in `serve.ts`'s body would run
 * AFTER everything it imports. As the first import of an entry point, this
 * file's body runs before any of them. That is the entire reason it is a module
 * rather than two lines at the top of each CLI.
 *
 * AN EXPLICIT VALUE IN THE ENVIRONMENT ALWAYS WINS, so an operator can still
 * tune or shrink it from the outside without editing anything.
 * =============================================================================
 */

/** Measured on the real mount: 64 lanes is where the probe stops being the bottleneck. */
export const DEFAULT_THREADPOOL_SIZE = '64';

/**
 * What the pool size should be, given whatever the environment already says.
 *
 * Pure, and exported, so the precedence rule can be tested without
 * re-evaluating a module whose whole purpose is a one-time side effect.
 */
export function resolveThreadpoolSize(existing: string | undefined): string {
  return existing !== undefined && existing.trim() !== '' ? existing : DEFAULT_THREADPOOL_SIZE;
}

/** The value in force, after this module has had its say. */
export const threadpoolSize: string = (() => {
  const size = resolveThreadpoolSize(process.env['UV_THREADPOOL_SIZE']);
  process.env['UV_THREADPOOL_SIZE'] = size;
  return size;
})();

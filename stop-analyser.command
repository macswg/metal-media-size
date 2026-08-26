#!/bin/bash
#
# Archive Analyser -- stop (macOS / Linux)
#
# Double-click this in Finder to stop a running analyser, including one left
# behind by a Terminal window that was closed badly, or one started from a
# different window than the one you are looking at.
#
# It stops the SERVER only. Nothing in the archive is affected -- the server
# never modified it in the first place.

set -uo pipefail

PORT="${PORT:-8787}"

cd "$(cd "$(dirname "$0")" && pwd)" || exit 1

say()  { printf '%s\n' "$*"; }
hold() { printf '\nPress any key to close.'; read -r -n 1 -s; printf '\n'; }

pid_on_port() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

is_our_server() {
  curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q '"ok"'
}

say "Archive Analyser -- stop"
say "========================"
say "port : ${PORT}"
say ""

PID="$(pid_on_port)"
if [ -z "$PID" ]; then
  say "Nothing is listening on port ${PORT}. Nothing to stop."
  hold
  exit 0
fi

# Refuse to kill a stranger. If some other program has the port, saying so is
# far better than terminating it because it was in the way.
if ! is_our_server; then
  say "Port ${PORT} is held by pid ${PID}, but it does not answer as the analyser:"
  say ""
  ps -p "$PID" -o pid,command 2>/dev/null | sed 's/^/    /'
  say ""
  say "Left alone. Stop that program yourself if you meant to."
  hold
  exit 1
fi

say "Stopping the analyser (pid ${PID})…"

# SIGTERM first: serve.ts handles it, closing the HTTP server and the SQLite
# handle before exiting. SIGKILL only if it will not go.
kill -TERM "$PID" 2>/dev/null

for _ in $(seq 1 40); do
  sleep 0.25
  kill -0 "$PID" 2>/dev/null || break
done

if kill -0 "$PID" 2>/dev/null; then
  say "It did not exit on SIGTERM after 10s. Forcing."
  kill -KILL "$PID" 2>/dev/null
  sleep 0.5
fi

if [ -n "$(pid_on_port)" ]; then
  say "Port ${PORT} is STILL held. Something is wrong; check by hand:"
  say "    lsof -nP -iTCP:${PORT} -sTCP:LISTEN"
  hold
  exit 1
fi

say "Stopped. Port ${PORT} is free."
hold

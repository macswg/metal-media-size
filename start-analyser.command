#!/bin/bash
#
# Media Allocation Analyzer -- start (macOS / Linux)
#
# Double-click this in Finder. It checks Node, installs dependencies the first
# time, starts the read-only server and opens the browser.
#
# The server runs IN THIS WINDOW. Close the window, or press Ctrl-C, and it
# stops. That is deliberate: there is no daemon to forget about. If one does
# get left behind, stop-analyser.command finds it.
#
# WHAT IS RUNNING: a read-only analyser bound to 127.0.0.1. It never modifies
# the archive. See CLAUDE.md for the safety invariants.

set -uo pipefail

PORT="${PORT:-8787}"
URL="http://127.0.0.1:${PORT}/"

# `.command` files launch with the home directory as cwd, so derive the repo
# from the script's own location rather than from wherever Finder started us.
cd "$(cd "$(dirname "$0")" && pwd)" || exit 1

say()  { printf '%s\n' "$*"; }
fail() { printf '\n!! %s\n' "$*" >&2; printf '\nPress any key to close.'; read -r -n 1 -s; exit 1; }

# Who, if anyone, is on the port. The port is the source of truth: a pid file
# can go stale, a listening socket cannot.
pid_on_port() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

# Distinguishes OUR server from anything else that happens to hold the port.
is_our_server() {
  curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q '"ok"'
}

say "Media Allocation Analyzer"
say "================"
say "folder : $(pwd)"
say "port   : ${PORT}"
say ""

EXISTING="$(pid_on_port)"
if [ -n "$EXISTING" ]; then
  if is_our_server; then
    say "Already running (pid ${EXISTING}). Opening the browser."
    say "To stop it, run stop-analyser.command."
    open "$URL" 2>/dev/null || true
    say ""
    say "Press any key to close this window. The server keeps running."
    read -r -n 1 -s
    exit 0
  fi
  fail "Port ${PORT} is held by pid ${EXISTING}, which is not the analyser.
   Close that program, or start this one on another port:
       PORT=8788 ./start-analyser.command"
fi

command -v node >/dev/null 2>&1 || fail "Node is not installed, or is not on PATH.
   Install Node 22 or newer from https://nodejs.org and run this again."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node ${NODE_MAJOR} is too old. This needs Node 22 or newer (it runs
   TypeScript directly, with no build step)."
fi
say "node   : $(node --version)"

if [ ! -d node_modules ]; then
  say ""
  say "First run -- installing dependencies. This happens once."
  npm install || fail "npm install failed. The output above says why."
fi

# ---------------------------------------------------------------- archive path
#
# The scan root is not committed -- it names your storage layout -- so it lives
# in config/local.json, which is gitignored. If that is missing, or points at a
# folder that is no longer there (an unmounted volume, a moved archive), ask
# rather than failing several steps later with a stack trace.
#
# A VALID path does not prompt. This runs on every launch and a confirmation
# you must dismiss each time is a tax, not a safeguard. To change a working
# path, run:  ./start-analyser.command --set-path

LOCAL_CONFIG="config/local.json"

current_root() {
  [ -f "$LOCAL_CONFIG" ] || return 1
  node -e '
    const fs = require("fs");
    try {
      const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (c && typeof c.root === "string" && c.root) process.stdout.write(c.root);
    } catch { /* unreadable or not JSON -- treated as unset */ }
  ' "$LOCAL_CONFIG" 2>/dev/null
}

write_root() {
  # Written by node so the path is JSON-escaped properly: spaces, quotes and
  # backslashes in a volume name would otherwise produce a broken config.
  node -e '
    const fs = require("fs");
    const [file, root] = process.argv.slice(1);
    const name = (root.split("/").filter(Boolean).slice(-2, -1)[0] || "archive")
      .toLowerCase().replace(/[^a-z0-9]+/g, "_");
    fs.writeFileSync(file, JSON.stringify({ name, root }, null, 2) + "\n");
  ' "$LOCAL_CONFIG" "$1" || fail "Could not write ${LOCAL_CONFIG}."
}

prompt_for_root() {
  say ""
  say "Where is your d3 delivery folder?"
  say "Drag the folder from Finder into this window and press Return."
  say "(Or type the path. Press Return on an empty line to give up.)"
  while :; do
    say ""
    printf '  path: '
    IFS= read -r REPLY_PATH || return 1
    # Finder drag-and-drop escapes spaces with backslashes and may wrap the
    # path in quotes. Undo both, then trim trailing whitespace.
    REPLY_PATH="${REPLY_PATH%\"}"; REPLY_PATH="${REPLY_PATH#\"}"
    REPLY_PATH="${REPLY_PATH%\'}"; REPLY_PATH="${REPLY_PATH#\'}"
    REPLY_PATH="$(printf '%s' "$REPLY_PATH" | sed -e 's/\\ / /g' -e 's/[[:space:]]*$//')"
    [ -n "$REPLY_PATH" ] || return 1
    if [ ! -d "$REPLY_PATH" ]; then
      say "  !! Not a folder I can see: ${REPLY_PATH}"
      say "     If it is on a network or object mount, make sure it is mounted."
      continue
    fi
    if [ ! -r "$REPLY_PATH" ]; then
      say "  !! That folder exists but is not readable."
      continue
    fi
    write_root "$REPLY_PATH"
    say ""
    say "  Saved to ${LOCAL_CONFIG} -- gitignored, it stays on this machine."
    return 0
  done
}

ROOT="$(current_root || true)"

if [ "${1:-}" = "--set-path" ]; then
  [ -n "$ROOT" ] && say "current: ${ROOT}"
  prompt_for_root || fail "No archive path set. Nothing to scan."
  ROOT="$(current_root || true)"
elif [ -z "$ROOT" ]; then
  say ""
  say "No archive configured yet."
  prompt_for_root || fail "No archive path set. Nothing to scan.
   Set one by running this again, or by creating ${LOCAL_CONFIG} by hand --
   see config/local.example.json."
  ROOT="$(current_root || true)"
elif [ ! -d "$ROOT" ]; then
  say ""
  say "!! The configured archive is not there:"
  say "     ${ROOT}"
  say "   If it lives on a mount, it may simply not be mounted right now."
  prompt_for_root || fail "Archive path unchanged and still unreachable."
  ROOT="$(current_root || true)"
fi

say "archive: ${ROOT}"
[ "${1:-}" = "--set-path" ] || say "         (to change it: ./start-analyser.command --set-path)"

# Open the browser once the server actually answers, rather than immediately
# into a connection error.
(
  for _ in $(seq 1 40); do
    sleep 0.25
    if is_our_server; then open "$URL" 2>/dev/null; exit 0; fi
  done
) &
OPENER=$!

cleanup() {
  kill "$OPENER" 2>/dev/null
  printf '\nServer stopped.\n'
}
trap cleanup EXIT INT TERM

say ""
say "Starting. This window keeps the server alive -- close it or press Ctrl-C to stop."
say "  ${URL}"
say ""

# Foreground on purpose: the process dies with the window, so closing the
# window cannot leave an orphan behind.
npm run serve -- --port "$PORT"

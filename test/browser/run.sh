#!/bin/bash
# Headless-browser smoke test for the TIMELINE view (cue list + loudness log).
#
# Stands up a fully isolated stack — a second server instance on :8199 with its
# own IPC socket and data dirs, a fake engine (no JACK/audio needed), and a
# Vite dev server — so it never touches a running production deck. Then drives
# it with Puppeteer (chrome-headless-shell).
#
#   cd test/browser && npm install && npm test
#
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="$HERE/.work"

export AES67_SOCKET_PATH=/tmp/aes67_bt.sock
export AES67_LOGS_DIR="$WORK/data/logs"
export AES67_RECORDS_DIR="$WORK/data/records"
export AES67_DAEMON_URL=http://127.0.0.1:59999   # unreachable on purpose
export PORT=8199
export APP_URL=http://127.0.0.1:5273
export WORK_DIR="$WORK"
export DL_DIR="$WORK/downloads"
export SHOT_DIR="$WORK/shots"

PIDS=()
cleanup() {
  echo "--- teardown ---"
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  sleep 0.5
  for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; done
  rm -f "$AES67_SOCKET_PATH"
}
trap cleanup EXIT

if [ ! -x "$REPO/node_modules/.bin/vite" ] && [ ! -x "$REPO/ui/node_modules/.bin/vite" ]; then
  echo "ui deps missing — run (cd ui && npm install) first"; exit 1
fi
if [ ! -d "$HERE/node_modules/puppeteer" ]; then
  echo "test deps missing — run (cd test/browser && npm install) first"; exit 1
fi

echo "--- build server + ui typecheck ---"
( cd "$REPO/server" && npm run build ) || { echo "server build failed"; exit 1; }

rm -rf "$WORK"
mkdir -p "$WORK/data/logs" "$WORK/data/records" "$WORK/run/server" "$WORK/downloads" "$WORK/shots"

echo "--- isolated server (:$PORT, sock $AES67_SOCKET_PATH) ---"
# cwd under $WORK/run/server so its ../scenes ../projects ../rack_presets and
# *_config.json land in the sandbox, never the real repo state.
( cd "$WORK/run/server" && node "$REPO/server/dist/index.js" ) > "$WORK/server.log" 2>&1 &
PIDS+=($!)
sleep 2
grep -q "WebSocket Server listening" "$WORK/server.log" || { echo "server failed:"; cat "$WORK/server.log"; exit 1; }

echo "--- fake engine ---"
node "$HERE/fake-engine.mjs" > "$WORK/engine.log" 2>&1 &
PIDS+=($!)
sleep 1

echo "--- vite dev (:5273) ---"
( cd "$REPO/ui" && VITE_WS_URL=ws://127.0.0.1:$PORT npx vite --port 5273 --strictPort --host 127.0.0.1 ) > "$WORK/vite.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 40); do curl -sf "$APP_URL" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$APP_URL" >/dev/null 2>&1 || { echo "vite failed:"; cat "$WORK/vite.log"; exit 1; }

echo "--- puppeteer ---"
node "$HERE/test.mjs"
RC=$?

echo "--- isolated loudness log ---"
for f in "$WORK"/data/logs/loudness-*.csv; do [ -f "$f" ] && { echo "== $(basename "$f") =="; cat "$f"; }; done
echo "screenshots: $WORK/shots/"
exit $RC

#!/bin/bash
# Mixer-panel feature showcase: drives the real UI (against an isolated stack
# with an animated fake engine) through a scripted tour, capturing a numbered
# series of screenshots plus an animated GIF of the whole run.
#
#   cd test/browser && npm install && npm run showcase
#
# Output: test/browser/.work/showcase/
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="$HERE/.work"

export AES67_SOCKET_PATH=/tmp/aes67_showcase.sock
export AES67_LOGS_DIR="$WORK/sc-data/logs"
export AES67_RECORDS_DIR="$WORK/sc-data/records"
export AES67_DAEMON_URL=http://127.0.0.1:59998
export PORT=8198
export APP_URL=http://127.0.0.1:5274
export WORK_DIR="$WORK"
export OUT_DIR="$WORK/showcase"

PIDS=()
cleanup() {
  echo "--- teardown ---"
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  sleep 0.5
  for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; done
  rm -f "$AES67_SOCKET_PATH"
}
trap cleanup EXIT

[ -d "$HERE/node_modules/puppeteer" ] || { echo "run (cd test/browser && npm install) first"; exit 1; }
[ -d "$REPO/ui/node_modules" ] || { echo "run (cd ui && npm install) first"; exit 1; }

echo "--- build server ---"
( cd "$REPO/server" && npm run build ) || exit 1

rm -rf "$WORK/sc-data" "$WORK/sc-run"
mkdir -p "$WORK/sc-data/logs" "$WORK/sc-data/records" "$WORK/sc-run/server"

echo "--- isolated server (:$PORT) ---"
( cd "$WORK/sc-run/server" && node "$REPO/server/dist/index.js" ) > "$WORK/sc-server.log" 2>&1 &
PIDS+=($!)
sleep 2
grep -q "WebSocket Server listening" "$WORK/sc-server.log" || { cat "$WORK/sc-server.log"; exit 1; }

echo "--- animated fake engine ---"
node "$HERE/showcase-engine.mjs" > "$WORK/sc-engine.log" 2>&1 &
PIDS+=($!)
sleep 1

echo "--- vite dev (:5274) ---"
( cd "$REPO/ui" && VITE_WS_URL=ws://127.0.0.1:$PORT npx vite --port 5274 --strictPort --host 127.0.0.1 ) > "$WORK/sc-vite.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 40); do curl -sf "$APP_URL" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$APP_URL" >/dev/null 2>&1 || { cat "$WORK/sc-vite.log"; exit 1; }

echo "--- run the tour ---"
node "$HERE/showcase.mjs"
RC=$?
echo "output: $OUT_DIR"
exit $RC

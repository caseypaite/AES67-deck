#!/bin/bash
echo "Starting AES67-Deck development environment..."

# Start Node.js IPC/WebSocket Server
echo "Starting Server..."
(cd server && npm run start) &
SERVER_PID=$!

# Start React Vite UI
echo "Starting UI..."
(cd ui && npm run dev) &
UI_PID=$!

# Wait a second for servers to bind
sleep 2

# Start C++ DSP Engine. The engine is a JACK client, and it exits (by
# design — see JackClient::shutdown_callback_wrapper) whenever the JACK
# server goes down under it, which happens any time PipeWire itself gets
# restarted (config change, crash, etc.), not just when the engine crashes.
# Without this loop that silently killed the whole mixer — no ports, no
# routing — until someone noticed and relaunched it by hand. The server's
# "C++ Engine connected via IPC" handler re-applies all persisted routing
# on every reconnect, so once this loop brings the engine back the signal
# chain self-heals with no manual "Apply" step needed.
echo "Starting DSP Engine..."
(
  trap 'kill $CURRENT_ENGINE_PID 2>/dev/null; exit 0' INT TERM
  while true; do
    ./engine/build/aes67_deck_engine &
    CURRENT_ENGINE_PID=$!
    wait $CURRENT_ENGINE_PID
    echo "DSP Engine exited — restarting in 1s..."
    sleep 1
  done
) &
ENGINE_PID=$!

echo "All services running. UI available at http://localhost:5173"
echo "Press Ctrl+C to stop all services."

# Trap SIGINT and cleanup
trap "echo 'Stopping...'; kill $SERVER_PID $UI_PID $ENGINE_PID; exit" INT
wait

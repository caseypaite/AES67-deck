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

# Start C++ DSP Engine
echo "Starting DSP Engine..."
./engine/build/aes67_deck_engine &
ENGINE_PID=$!

echo "All services running. UI available at http://localhost:5173"
echo "Press Ctrl+C to stop all services."

# Trap SIGINT and cleanup
trap "echo 'Stopping...'; kill $SERVER_PID $UI_PID $ENGINE_PID; exit" INT
wait

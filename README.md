# AES67-Deck
Professional Linux AES67 Mixing Console & Multitrack DAW

AES67-Deck is a touch-first, low-latency live mixing console and integrated Digital Audio Workstation (DAW) designed to run on Linux. It ingests and broadcasts network audio via AES67, hosts LV2 plugin racks (LSP & Calf Audio), supports hardware control surfaces, and provides a full timeline editor for non-destructive editing and remastering.

## Project Structure

- `config/`: Configuration for AES67 daemon and Linux realtime networking.
- `engine/`: C++ real-time DSP, LV2 plugin hosting, AES67 networking, and DAW backend.
- `server/`: WebSocket API & session state server bridging the C++ engine and Web UI.
- `ui/`: Touch Kiosk & Web DAW Interface (React / Svelte).
- `scripts/`: Utilities for dependency installation, kiosk setup, and running development environments.

## Setup

1. Run `scripts/install-deps.sh` to install system requirements.
2. Build the C++ engine in `engine/`.
3. Install UI dependencies in `ui/` and server dependencies in `server/`.
4. Run `scripts/run-dev.sh` to start the local development mock runner.

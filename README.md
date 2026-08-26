# AES67-Deck

**Professional Linux AES67 Mixing Console & Multitrack DAW**

AES67-Deck is a touch-first, low-latency live mixing console with an integrated
timeline editor, built for Linux. It runs as a JACK/PipeWire client, ingests and
broadcasts network audio via AES67, hosts LV2 plugin racks (Calf / LSP), and
provides real-time metering and loudness analysis for broadcast and streaming
delivery.

---

## Architecture

Three processes talk over local sockets:

```
 ┌──────────────┐   Unix socket    ┌───────────────┐   WebSocket :8081   ┌──────────────┐
 │  C++ engine  │ ◀──────────────▶ │  Node server  │ ◀─────────────────▶ │   React UI   │
 │  (JACK RT)   │ /tmp/aes67_deck  │  (ts-node)    │                     │  (Vite :5173)│
 └──────────────┘     .sock        └───────────────┘                     └──────────────┘
        │                                  │
   JACK / PipeWire                    scenes/, rack_presets/,
   (AES67 via RAVENNA                 mixer_state.json
    daemon + local I/O)
```

- **`engine/`** — C++ real-time DSP. A JACK client (`AES67_Deck`) that owns the
  mixing graph, LV2 plugin hosting (lilv), metering, and disk recording. The
  audio callback is lock-free; plugin-chain edits are marshalled through a
  ring buffer, never allocating or locking on the RT thread.
- **`server/`** — Node/TypeScript WebSocket bridge. Forwards a fixed allow-list
  of UI→engine commands, relays all engine→UI messages (metering rides along),
  and persists session state (scenes, FX-rack presets, fader/pan/mute/aux).
- **`ui/`** — React + TypeScript + Vite + Tailwind + Zustand. Single-page
  console with three views (Mixer / Timeline / Patchbay). "19-inch rack"
  visual language with dimensional analog knobs, faders, switches and meters.
- **`config/`** — AES67 daemon config and Linux realtime / PipeWire tuning.
- **`scripts/`** — dependency install, kiosk setup, dev runner, audio fixes.
- **`docs/`** — UI design language, FX editor spec, latency-tuning write-up.

### Fixed mixing topology

| Element        | IDs        | Notes |
|----------------|------------|-------|
| Input channels | `1–32`     | source-only; mapped to AES67/PipeWire ports in the Patchbay |
| Master bus     | `100`      | stereo main out, insert rack, BS.1770 loudness |
| Aux buses      | `101–108`  | 8 stereo aux/group buses, each with an insert rack |
| Monitor bus    | `109`      | dedicated operator monitor, insert rack |
| Talkback       | `110`      | push-to-talk mic, fans out to selected buses |

---

## Implemented

### Mixing console (Mixer view)

- 32 input channels in banks of 16, plus the 8 aux buses, Monitor and Master
  as fixed right-hand groups.
- Per-channel fader, pan, mute, solo, record-arm; 8 aux sends; channel rename.
- Merged Monitor + Master section, section-tinted grouping, VU metering on
  every strip.
- All moves are sent to the engine live and persisted by the server
  (`mixer_state.json`, debounced) so state survives an engine restart — the
  server replays routing on every engine reconnect.

### FX racks

- Insert rack on every channel and bus: add / remove / reorder / replace
  plugins, per-slot bypass, applied to the engine's live insert chain without
  audio dropouts.
- LV2 hosting via lilv; the engine scans all system LV2 plugins on start.
- **Dedicated analog editors for 9 Calf plugins**, with parameter maps taken
  from the real `.ttl` files (gain ports handled as linear coefficients):
  Saturator, Crusher (bitcrusher), Compressor, De-Esser, 8-Band EQ,
  5-Band EQ, Vintage Delay, Reverb, Limiter.
- Editors follow a shared design system (`docs/fx-ui-design.md`): input/output
  VU rails, realistic 3D knobs (`ui/src/components/analog/`), and a graph
  "screen" per category —
  - **Compressor / Limiter** — draggable transfer-curve with live
    operating-point dot, comet trail, and gain-reduction drop-line driven by
    the real signal.
  - **EQ** — full-width log-frequency response with draggable band nodes and
    a colour-gradient RTA spectrum behind the curve.
  - **Saturator / Crusher** — waveshaper / bit-staircase transfer curve.
  - **Delay / Reverb** — tap-timeline / decay-envelope screens.
- Non-mapped plugins fall back to a generic parameter list.

### Metering & analysis

- ~40 Hz metering stream from the engine (every 3rd audio callback).
- Per-strip peak VU for all 42 channels/buses.
- **Per-focused-plugin metering** — when a plugin editor is open the engine
  reports that slot's input/output peaks plus a 31-band Goertzel RTA, so the
  editor graphs react to the actual audio at that point in the chain.
- **BS.1770-4 loudness on the Master** — K-weighting biquads, Momentary (400 ms),
  Short-term (3 s), two-stage gated Integrated, and a 2× oversampled True-Peak
  estimate. Shown on the BUS SENDS strip (`LufsPanel`) with a −14 LUFS target
  line and an integrated reset.
- **Master analyser** — 31-band spectrum, L/R correlation, and a 45°-rotated
  goniometer scatter, all from the post-master-FX mix.

### Mastering suite (Master / Monitor selected)

- `MasteringPanel` fills the sends area when Master or Monitor is selected:
  master spectrum (gradient RTA), goniometer, correlation meter, and the full
  BS.1770 M/S/I/TP readout with an integrated reset.
- **Preset browser** with 7 built-in mastering chains modelled on published
  practice — Streaming −14, Broadcast R128 (−23), Club/Loud, Warm/Analog,
  Bright/Air, Punchy, Transparent — each a Calf EQ8 → Glue Comp → Limiter
  (± Saturator) chain. **LOAD** applies the chain to the selected bus's rack;
  **SAVE** captures the current rack. User-saved rack presets appear in the
  same list.

### Patchbay view

- Maps input channels to AES67 / PipeWire / JACK source ports and buses to
  destination ports.
- SAP stream discovery (name + address); port identifiers filled in per
  stream. Mappings persist server-side and are re-synced to the engine on
  reconnect.

### Timeline view

- Non-destructive clip editor over the 32 input tracks: select, move, trim,
  slice at playhead, copy/paste, delete, per-track heights, snap-to-grid,
  zoom. Playhead animation follows the transport.
- Transport (play / stop / record) with SMPTE-style timecode.
- Recording captures the **Master bus** stereo to disk
  (`/tmp/aes67_deck_master.wav`) via a dedicated disk-writer thread.

### Scenes & persistence

- **Scenes** — full snapshot (mixer + patchbay) saved to `scenes/` and
  recalled from the toolbar.
- **FX-rack presets** — saved to `rack_presets/`, loadable onto any channel.
- **Mixer state** — faders / pans / mutes / solos / aux sends auto-saved to
  `server/mixer_state.json`.

### Engine / system

- Supervisor loop in `run-dev.sh` restarts the engine automatically if JACK
  goes down under it (e.g. a PipeWire restart); routing self-heals on
  reconnect.
- PipeWire / kernel latency tuning documented in `docs/latency-tuning.md`
  (quantum 128, RAVENNA period 48, CPU governor `performance` → ~5–6 ms
  round trip on the reference machine).

---

## Not yet implemented

- Per-track multitrack disk recording (recording is Master-stereo only; the
  Timeline creates clips but does not yet capture per-channel audio files).
- Clip audio playback / waveform rendering on the timeline.
- Hardware control-surface (MIDI / OSC / Mackie) support.
- In-app AES67 stream transmit configuration (handled today by the external
  `aes67-linux-daemon` + PipeWire RAVENNA module).
- Undo/redo.

---

## Setup

Reference platform: Arch Linux with PipeWire (JACK-compatible). Debian/Ubuntu
is also handled by the install script.

1. **Install dependencies** — `scripts/install-deps.sh`
   (build tools, `lilv`, `calf`, `lsp-plugins`, `pipewire-jack`,
   `libsndfile`, `libsamplerate`, Node).
2. **Build the engine:**
   ```bash
   cmake -S engine -B engine/build && cmake --build engine/build
   ```
3. **Install JS deps:**
   ```bash
   (cd server && npm install) && (cd ui && npm install)
   ```
4. **AES67 / realtime (optional):** apply `config/` and run
   `scripts/setup-aes67-daemon.sh`.

## Running

```bash
scripts/run-dev.sh
```

Starts the WebSocket server, the Vite dev server, and the engine (under a
restart supervisor). Open **http://localhost:5173**.

For a kiosk deployment, `scripts/setup-kiosk.sh` has notes on running the UI
full-screen under `cage`.

## Development

```bash
# UI
cd ui && npm run dev            # Vite dev server
npm run lint && npx tsc --noEmit && npm run build

# Engine
cmake --build engine/build

# Server
cd server && npm run start
```

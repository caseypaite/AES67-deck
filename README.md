# AES67-Deck

**Linux AES67 mixing console + multitrack DAW, in one touch-first app.**

AES67-Deck is a low-latency live mixing console with an integrated timeline
recorder/editor, built for Linux. It runs as a JACK/PipeWire client, receives
and transmits network audio over **AES67** (via the RAVENNA ALSA driver +
`aes67-linux-daemon`), hosts **LV2 plugin racks** (Calf / LSP) with dedicated
analog editors, records every input to disk, and provides real-time metering
and **ITU-R BS.1770** loudness analysis for broadcast and streaming delivery.

It is designed to run headless on a dedicated appliance box (reference target:
a Lenovo ThinkCentre, Ubuntu, i5-4570 / 4 GB — see [`deploy/`](deploy/)), with
the operator UI served over the network to a tablet or touchscreen.

---

## Architecture

Three processes talk over local sockets:

```
 ┌──────────────┐   Unix socket    ┌───────────────┐   WebSocket :8081   ┌──────────────┐
 │  C++ engine  │ ◀──────────────▶ │  Node server  │ ◀─────────────────▶ │   React UI   │
 │  (JACK RT)   │ /tmp/aes67_deck  │  (ts-node)    │                     │  (Vite / SPA)│
 └──────────────┘     .sock        └───────────────┘                     └──────────────┘
        │                                  │
   JACK / PipeWire                   session state (JSON):
   AES67 in/out via RAVENNA          mixer_state · fx_racks · scenes ·
   + aes67-linux-daemon (REST)       patchbay/routing · rx_sinks · tx_sources ·
                                     projects/ (arrangements) · records/ (.rpp bundles)
```

- **`engine/`** — C++ real-time DSP. A JACK client (`AES67_Deck`) that owns the
  32-in mixing graph, LV2 plugin hosting (lilv), a sample-accurate transport
  clock, multitrack disk capture, disk-streaming timeline playback, metering
  and loudness. The audio callback is lock-free; plugin-chain edits, the clip
  schedule and transport commands are marshalled through ring buffers — never
  allocating or locking on the RT thread.
- **`server/`** — Node/TypeScript bridge. Forwards a fixed allow-list of
  UI→engine commands, relays every engine→UI message (metering + transport
  ride along), proxies the AES67 daemon's REST API, and **persists the whole
  session** — replayed to a reconnecting UI and self-healed into a restarted
  engine.
- **`ui/`** — React + TypeScript + Vite + Tailwind + Zustand. Single-page
  console, three views (Mixer / Timeline / Patchbay). The arrange surface is a
  single `<canvas>` with an imperative render loop decoupled from React.
- **`deploy/`** — appliance provisioning: RT/PipeWire tuning, RAVENNA DKMS
  module, `linuxptp`, systemd user services, nginx site, Secure Boot / MOK.
- **`config/` · `scripts/` · `docs/`** — daemon config & tuning, dev/install
  scripts, and the UI / FX-editor / latency write-ups.

### Fixed mixing topology

| Element        | IDs        | Notes |
|----------------|------------|-------|
| Input channels | `1–32`     | source-only; mapped to AES67 / PipeWire / JACK ports in the Patchbay |
| Master bus     | `100`      | stereo main out, insert rack, BS.1770 loudness + analyser |
| Aux buses      | `101–108`  | 8 stereo aux/group buses, each with an insert rack |
| Monitor bus    | `109`      | dedicated operator monitor, insert rack |
| Talkback       | `110`      | push-to-talk mic, fans out to selected buses |

---

## Implemented

### Mixing console (Mixer view)

<video src="https://github.com/caseypaite/AES67-deck/raw/master/docs/media/mixer-showcase.mp4" controls muted loop playsinline width="900"></video>

<sub>Mixer walkthrough — channel strips, insert FX racks, the LED-ring analog
knob, plug-in editors, aux sends, the mastering suite and scenes. Scripted
1280×720 headless capture ([`docs/media/mixer-showcase.mp4`](docs/media/mixer-showcase.mp4));
regenerate with `npm run showcase` in [`test/browser/`](test/browser/).</sub>

- 32 input channels in banks of 16, plus the 8 aux buses, Monitor and Master
  as fixed right-hand groups.
- Per-channel fader, pan, mute, solo, **polarity invert (ø)**, record-arm;
  8 aux sends; channel rename.
- Merged Monitor + Master section, section-tinted grouping, VU metering on
  every strip.
- Push-to-talk **talkback** mic with a selectable set of destination buses.

### FX racks

- Insert rack on every channel and bus: add / remove / reorder / replace
  plugins, per-slot bypass, applied to the engine's live insert chain with no
  audio dropout (edits marshalled through a ring buffer).
- LV2 hosting via lilv; the engine scans every system LV2 plugin on start and
  serves the catalog to the rack browser.
- **Dedicated analog editors for 9 Calf plugins**, parameter maps taken from
  the real `.ttl` files (gain ports handled as linear coefficients):
  Saturator, Crusher (bitcrusher), Compressor, De-Esser, 8-Band EQ, 5-Band EQ,
  Vintage Delay, Reverb, Limiter.
- Editors follow a shared design system ([`docs/fx-ui-design.md`](docs/fx-ui-design.md)):
  input/output VU rails, realistic 3D knobs (`ui/src/components/analog/`), and a
  category "screen":
  - **Compressor / Limiter** — draggable transfer curve, live operating-point
    dot + comet trail, gain-reduction drop-line driven by the real signal.
  - **EQ** — full-width log-frequency response, draggable band nodes, a
    colour-gradient RTA spectrum behind the curve.
  - **Saturator / Crusher** — waveshaper / bit-staircase transfer curve.
  - **Delay / Reverb** — tap-timeline / decay-envelope screens.
- Non-mapped plugins fall back to a generic parameter list.
- **Rack presets** — save a channel's chain to `rack_presets/`, load it onto
  any channel or bus.

### Metering & analysis

- ~40 Hz metering stream from the engine (gated to a fixed rate, quantum-
  independent).
- Per-strip peak VU for all 42 channels/buses.
- **Per-focused-plugin metering** — when a plugin editor is open the engine
  reports that slot's input/output peaks plus a 31-band Goertzel RTA, so the
  editor graphs react to the audio *at that point in the chain*.
- **BS.1770-4 loudness on the Master** — K-weighting biquads, Momentary
  (400 ms), Short-term (3 s), two-stage gated Integrated, 2× oversampled
  True-Peak. Shown on the BUS SENDS strip with a target line and an integrated
  reset.
- **Master analyser** — 31-band spectrum, L/R correlation, 45°-rotated
  goniometer scatter, from the post-master-FX mix.

### Mastering suite (Master / Monitor selected)

- `MasteringPanel` fills the sends area: master spectrum (gradient RTA),
  goniometer, correlation meter, full BS.1770 M/S/I/TP readout.
- **Preset browser** with 7 built-in mastering chains — Streaming −14,
  Broadcast R128 (−23), Club/Loud, Warm/Analog, Bright/Air, Punchy,
  Transparent — each a Calf EQ8 → Glue Comp → Limiter (± Saturator) chain.
  LOAD applies it to the selected bus's rack; SAVE captures the current rack.

### AES67 network I/O + Patchbay view

- **In-app AES67 daemon control** (`NetworkPanel`) — no need for the separate
  daemon WebUI: create/delete **receive Sinks** from discovered SAP/mDNS
  streams or pasted SDP, set the **PTP** domain / grandmaster preference, and
  enable / disable / rename the deck's **transmit Sources**. Full daemon state
  (config, PTP lock, sources, sinks, remote browse) is polled and streamed to
  the UI.
- **Receive** — up to **32 AES67 capture channels**; a subscribed Sink is
  auto-allocated a contiguous capture block and shows up in the source
  registry with its ports pre-filled, ready to drop onto a mixer channel.
- **Transmit** — the **20 mix-product channels** (Master, Monitor, Aux 1–8,
  all post-insert / post-fader) are pinned to fixed AES67 sink channels on
  every engine reconnect and published as auto-provisioned daemon Sources.
- **Patchbay** — map inputs to source ports and buses to hardware destination
  ("Output Endpoints"); mappings persist and re-sync to the engine on
  reconnect.

### Timeline / multitrack DAW (Timeline view)

- **Engine-owned transport** — sample-accurate frame clock (play / stop /
  locate / loop), position + state ride out on the metering frame; the UI
  playhead is predicted from the local clock and corrected each frame.
- **Multitrack capture** — arm N inputs, hit record, get N time-aligned
  32-bit-float **WavPack** takes per project
  (`projects/<name>/takes/<ts>/ch<NN>.wv` + `take.json`), written by a
  lock-free ring + disk thread. Tap point is the raw pre-insert channel input.
  Disk-overrun is surfaced in the UI.
- **Disk-streaming playback** — one reader voice per track sums the scheduled
  clips back into that channel *before* its insert chain, so channel FX,
  fader, pan, sends, metering and AES67 routing all apply to playback. Loop /
  locate re-seek all voices.
- **Canvas arrange surface** — one `<canvas>`, viewport-sized, imperative
  render loop; grid, lanes, clips, real waveforms (min/max + RMS peak tiles),
  playhead, markers and selection all drawn, hit-tested in canvas space.
  Track panel is height-adaptive.
- **Clip editing** — move, trim, slice at playhead, split, copy/paste, delete,
  marquee select, drag between lanes, double-click rename; **per-clip fade
  in/out** and **clip gain** with on-surface handles, rendered by the engine's
  fade envelope.
- **Markers** on the ruler — add at playhead (`M`), drag, jump prev/next
  (`,` / `.`), delete.
- **Projects** — a project is the arrangement (clips, markers, track layout),
  kept separate from a scene (a mixer snapshot). Scratch autosave lives in
  `projects/default/`; **SAVE PROJECT** consolidates the take media into a
  portable **REAPER `.rpp` bundle** under `records/<Name>/`, openable directly
  in REAPER. Recording while a project is open auto-consolidates each take.

### Virtual soundcheck (broadcast)

- **VSC ARM ALL** — one button arms every input that has an AES67 source
  mapped.
- **Per-channel monitor override** — `MON: TIMELINE ⇄ LIVE` master toggle plus
  a per-track `IN` / `TL` switch: pin any channel to its live input while the
  rest play back the recording, so the operator can rehearse or train the mix
  with the band gone.
- **Unattended recording** — auto-record on the first transport roll, split
  the take at each marker (contiguous), a disk-space guard that warns and
  hard-stops, and a daily scheduled start. Configured from the timeline
  toolbar.

### Scenes & full-session persistence

- **Scenes** — a full mixer + patchbay snapshot saved to `scenes/`, recalled
  or deleted from the toolbar. Loading a scene never touches the timeline.
- **Automatic session persistence** — the server mirrors and writes to disk
  (debounced), then restores on every UI connect **and** replays into a
  restarted engine:
  - fader / pan / mute / solo / **phase** / aux sends → `mixer_state.json`
  - every channel & bus **FX insert chain** → `fx_racks.json`
  - patchbay, output routing, talkback, AES67 sinks & sources → their own
    JSON configs
- No manual save needed for the live console — reload the page or restart the
  box and the deck comes back exactly as it was.

### Engine / system

- The engine exits by design whenever JACK/PipeWire drops under it; the
  systemd unit (`Restart=always`) or `run-dev.sh`'s supervisor brings it
  straight back, and the server re-drives every pw-link and replays mixer
  state, FX racks and the timeline on reconnect.
- **Appliance deployment** ([`deploy/`](deploy/)) — RT limits + sysctl + CPU
  governor, `linux-lowlatency`, PipeWire @ 48 kHz / quantum 128, RAVENNA ALSA
  DKMS module (MOK-signed), `linuxptp`, the stack as **lingering systemd user
  services**, and the built UI on nginx :80. Autostarts on boot.
- PipeWire / kernel latency tuning in [`docs/latency-tuning.md`](docs/latency-tuning.md)
  — measured **engine round-trip = one graph quantum (2.67 ms @ 128/48k)**, i.e.
  the DSP adds no measurable latency beyond PipeWire's own.

---

## Planned / not yet implemented

Timeline roadmap: [`plan/daw-timeline-roadmap.md`](plan/daw-timeline-roadmap.md).

**Broadcast / live (Phase 3):**
- Cue-list panel + as-run CSV export (ruler markers are in; the named cue
  list and export are not).
- **Loudness logging** — append M/S/I/TP to a CSV over time and export an
  EBU R128 / ATSC A/85 compliance report for a marked region.
- **Timecode & sync** — PTP time-of-day transport timecode, an **LTC
  generator** on a JACK/AES67 output, **MTC** over virtual MIDI, and chasing
  external LTC on an input.
- **Punch & pre-roll** — in/out points, auto-punch on armed tracks, pre-roll,
  loop-record takes into lanes.

**Editing polish (Phase 4):**
- **Undo / redo** (command stack).
- **Crossfades** (equal-power overlap).
- **Take comping** — stacked lanes, swipe-to-select, promote to a comp clip.
- **Bounce / export** — render a timeline region through the master chain;
  stem export from the per-track taps.
- Clip-gain automation, ripple edit, group / lock, nudge keys.

**Later / optional (Phase 5):**
- Bars + beats grid, tempo map, metronome.
- Video track / reference-video scrub for post work.
- Fader / pan / plugin-parameter **automation lanes** tied to the transport.
- Multi-project playlist for back-to-back playout.

**Other:**
- Hardware control-surface support (MIDI / OSC / Mackie).
- Per-channel **direct-out** AES67 broadcast (today only the mix products are
  transmitted — deliberate; every input is already its own stream upstream).
- The full **"19-inch rack"** visual re-skin
  ([`docs/ui-design.md`](docs/ui-design.md)) — the analog knob/fader/meter
  components exist; the rack-unit chrome is not yet applied app-wide.

### Known issues

- The first ~2 s of every multitrack take is distorted (a startup transient at
  the capture tap). A recorder-side 2 s head-discard workaround was tried and
  reverted — it did not clear it. Under investigation; notes in the roadmap.

---

## Setup

Reference dev platform: Arch Linux with PipeWire (JACK-compatible); the install
script also handles Debian/Ubuntu. For a dedicated appliance, follow
[`deploy/README.md`](deploy/README.md) instead.

1. **Dependencies** — `scripts/install-deps.sh`
   (build tools, `lilv`, `calf`, `lsp-plugins`, `pipewire-jack`, `libsndfile`,
   `libsamplerate`, `wavpack` / `libwavpack`, Node).
2. **Build the engine:**
   ```bash
   cmake -S engine -B engine/build -DCMAKE_BUILD_TYPE=Release
   cmake --build engine/build -j"$(nproc)"
   ```
3. **JS deps:** `(cd server && npm install) && (cd ui && npm install)`
4. **AES67 / realtime (optional):** apply `config/` and run
   `scripts/setup-aes67-daemon.sh`; the appliance path is fully scripted in
   `deploy/`.

## Running

```bash
scripts/run-dev.sh          # server + Vite UI + engine (under a restart supervisor)
```

Open **http://localhost:5173**. On the appliance the stack runs as systemd
user services and the built UI is served by nginx on port 80.

## Development

```bash
# UI
cd ui && npm run dev
npm run lint && npx tsc -p tsconfig.json --noEmit && npm run build

# Engine
cmake --build engine/build

# Server
cd server && npm run build && npm run start
```

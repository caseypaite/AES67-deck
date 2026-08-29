# Live-performance readiness review

_Code-level assessment (2026-08-28). Based on reading the engine RT path
(`engine/src/main.cpp`, `JackClient`, the recorders), the server command /
reconnect logic, the deploy units, and the timeline roadmap. Not a bench test
on the reference appliance._

## Verdict

**Usable for lower-stakes live work** (rehearsals, streaming, install playback,
virtual soundcheck) **— not yet fit for broadcast-critical or one-shot shows.**
The DSP core is well-built and genuinely low-latency, but recovery from failure
is a full audio dropout, solo is destructive, and there is no output safety net
or redundancy.

## What's solid

- **RT discipline is textbook.** The audio callback is lock-free with no
  allocation: plugin-chain edits marshalled through a `jack_ringbuffer`,
  instance destruction handed to a trash thread, vectors pre-`reserve()`d to
  `MAX_PLUGINS_PER_CHANNEL`, transport as relaxed atomics. FX rack edits during
  a show won't glitch the audio.
- **Latency claim is credible.** One graph quantum, no added buffering in the
  DSP path (2.67 ms @ 128/48k). Latency-reporting "studio" plugins are kept out
  of the live path by design.
- **Talkback correctness.** PTT and destination mask use acquire/release
  atomics with a real safety rationale; the Monitor bus is structurally
  excluded from talkback routing (no bit position, not just a runtime check).
- **Self-heal on restart.** systemd `Restart=always` + `run-dev.sh` supervisor;
  the server re-drives every `pw-link` and replays mixer state, FX racks,
  routing and the timeline on every engine reconnect. Reload the tablet or
  reboot the box and the console comes back as it was.
- **Autonomous engine.** UI / network loss doesn't stop audio — the engine runs
  headless and the browser is only a control surface.

## Real risks for live use (ranked)

### 1. Failure = total audio dropout, not a failover
Any PipeWire restart or engine crash calls `std::exit(1)` from the JACK
shutdown callback. Recovery is process restart + JACK reconnect + the server
re-driving `pw-link` — the server's own comment notes this "can lag by several
seconds." On the main mix that is a multi-second silence mid-show. No
redundancy, no second engine, no hardware bypass relay.

### 2. Solo is destructive solo-in-place
The `any_solo` path mutes every non-soloed input into *all* buses including
Master (`engine/src/main.cpp:883`). Hitting solo during a live show cuts the
audience mix. There is no PFL/AFL that routes only to the Monitor bus — which
is the entire point of solo on a live console.

### 3. No brickwall on the Master output
A runaway plugin, feedback loop, or bad gain staging goes straight to the AES67
transmit streams and the PA. There is no engine-level safety clamp; the
operator has to insert their own limiter.

### 4. Unresolved capture bug: first ~2 s of every multitrack take is distorted
The head-discard workaround was tried and reverted (commit `a6c2cb7`) because
the corruption is in the tap itself. Virtual soundcheck and any as-recorded
broadcast capture start with garbage. Does not affect the live mix path, but it
undercuts the headline DAW feature. See "Known issues (unresolved)" in
`plan/daw-timeline-roadmap.md`.

### 5. `aux_sends` is a `std::map` mutated from the IPC thread while the audio thread reads it
The *first* time an aux send is set for a channel during a show,
`channels[id].aux_sends[bus] = value` inserts a node and can rebalance the tree
mid-traversal on the RT thread — a genuine data race (torn read / rare crash).
Subsequent updates to an existing key are benign. Pre-seeding every channel's 8
aux entries at startup, or moving to a fixed array, closes this. (Faders / pans
/ mutes are also written unsynchronized, but a torn float there is harmless —
the map is the exception.)

### 6. No xrun visibility
The engine never registers `jack_set_xrun_callback`. Playback underruns are
reported (`pbUnderrun`), but live dropouts under CPU pressure are invisible
except via the toolbar CPU meter. On an i5-4570 with the RTA, LUFS, Goertzel
master analyser and 40 Hz `snprintf`-built metering JSON all on the RT thread,
the headroom question is real and currently unmeasured.

### 7. Loudness / true-peak numbers are approximate
True-peak is a "cheap 2x estimate," not the ITU 4x oversampled filter — fine
for guidance, not for a compliance report.

### 8. No test coverage
Zero engine or server tests. The recorder finalisation path is documented as
fragile and has broken twice.

## Recommendations before trusting it on a real show

- [x] **Surface xrun count / DSP load in the UI** — Added `jack_set_xrun_callback` to `JackClient`, publishing `transport.xruns` in the metering JSON frame (~40 Hz), and surfaced live in the UI (`<StatCell label="XR" ... />` in `LiveConsoleView`).
- [x] **Solo/Mute cue mode (PFL/AFL to Monitor bus only)** — New engine-wide `g_afl_pfl_mode` (0 = off / 1 = AFL / 2 = PFL), **off by default**, toggled from the `A`/`P` ("CUE MODE") buttons on the Monitor strip and persisted (`mixerState.aflPflMode`).
  - **Off (default):** a channel's Solo and Mute are live and hit every bus — Mute cuts the channel on Master/Aux/Monitor; Solo is destructive Solo-In-Place (non-soloed channels drop out of Master/Aux/Monitor). SIP channel-cutting keys off channel solos only, so a lone Aux-bus solo never starves the channels feeding it.
  - **AFL / PFL:** a channel's Solo and Mute only reshape the operator Monitor bus (`monitor_L`/`monitor_R`); the Master/Aux house mix always carries every channel at its fader/pan. AFL cues soloed channels post-fader/pan (muted ones drop); PFL cues them **pre-fader, pre-pan (mono sum), pre-mute, at unity** (so PFL is audibly distinct from AFL even at a unity fader). Master's own Mute (PA kill) and each Aux's own Mute always work regardless of mode.
  - Verified end-to-end (UI → engine → persist) + a metering matrix test (`scratchpad/test_cue.py`).
- [x] **Add output safety limiter / brickwall clip guard on Master / Aux / Monitor outputs** — `output_safety_clamp()` applies zero-latency transparent passthrough for nominal levels, smooth tanh soft-saturation knee above -0.45 dBFS, hard ceiling at 0.0 dBFS (+/- 1.0f), and sanitizes NaN/Inf values to prevent equipment or hearing damage.
- [x] **Atomic fixed array for `aux_sends`** — `ChannelState::aux_sends` converted to `std::atomic<float>[NUM_AUX + 1]` with atomic slots, eliminating `std::map` mutations and data races on the RT thread.
- [~] **Record-startup distortion — mitigation implemented, not yet hardware-verified** — Converted `MultitrackRecorder` to a persistent pool of 32 `WavpackWriter` instances with pre-faulted and `mlock`ed ringbuffers built at startup, removing the allocation + first-touch page-fault storm on take start (the prime suspect). A `jack_set_xrun_callback` now surfaces xrun bursts live in the UI so this can be confirmed. **Still a release blocker for the virtual-soundcheck workflow until a full-load take on the `ck-aes67` appliance shows a clean head and no xrun spike at record start.**
- [x] **Explicit dropout & restart recovery documentation** — Documented self-healing architecture: systemd / `run-dev.sh` supervisor auto-restarts the engine process; server's IPC connection handler automatically replays mixer state, routing matrices, patchbay links, and timeline state on reconnect. External dual-redundant stream failover or analog bypass relay recommended for broadcast-critical tier 1 deployments.


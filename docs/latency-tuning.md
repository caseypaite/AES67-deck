# Latency tuning (2026-08-26)

Investigation into round-trip audio latency for this machine's AES67-Deck
setup, and the live PipeWire/kernel tuning that came out of it. Baseline
was a *calculated* estimate (not measured); every number after "current
settings" below was verified live against real `pw-top`/`/proc/asound`
output, not just configured and assumed.

## Baseline: ~43–44ms round trip

At the original config (`default.clock.quantum = 1024`, RAVENNA ALSA
`period-size = 1024`), both the local monitoring path (input → engine →
Monitor bus → speakers) and the full AES67 network path (RAVENNA in →
engine → RAVENNA out) worked out to roughly two ALSA I/O periods
(~21.3ms each at 1024 samples/48kHz) plus a negligible ~1ms network hop —
**~43–44ms** either way.

## What we tried, in order

1. **Lowered the PipeWire graph quantum to 128** (`10-aes67-clock-48khz.conf`).
   Self-healed cleanly (engine auto-restarts, server re-applies routing —
   see [[aes67-deck-engine-jack-fragility]]) but `pw-top` showed the
   analog input `alsa_input...pro-input-0` (RME interface capture)
   xrunning continuously, even idle. Everything else — `AES67_Sink`,
   `AES67_Deck`, the Monitor output — stayed clean.
2. **Settled on quantum=256** as a safe middle ground. Confirmed clean
   across the board, including that same input. ~11–12ms round trip.
3. **Found the likely cause of the 128 xruns**: CPU governor was
   `powersave`, not `performance`. Verified RT scheduling itself was
   *not* the problem — PipeWire's real audio thread (`data-loop.0`) was
   already correctly running `SCHED_RR` priority 20 via rtkit.
4. **Switched to the `performance` power profile**
   (`powerprofilesctl set performance` — no root needed, reversible).
5. **Re-tested quantum=128** with the CPU locked at max frequency: clean
   for 20+ seconds of sustained sampling, including the previously
   xrunning input. Kept 128. ~5.3ms round trip for the local path.
6. **Turned to the AES67 network leg specifically.** Discovered — via
   `/proc/asound/card0/pcm0p/sub0/hw_params`, not just config files — that
   the RAVENNA card's *actual* negotiated ALSA period was a fixed **384
   samples (~8ms)**, completely unmoved by any of the graph-quantum
   changes above. `AES67_Sink`/`AES67_Source` were requesting
   `api.alsa.period-size = 1024` in `aes67-ravenna-bridge.conf`, but
   something in the driver was silently clamping that down to 384 every
   time.
7. **First hypothesis: tune the `jitter_buffer_multiplier` kernel module
   parameter** (`MergingRavennaALSA`, default `3`, "jitter buffer depth as
   multiple of TIC frame size"). It's runtime-writable via sysfs, but
   root-owned — this session had no passwordless `sudo` and no TTY for
   an interactive password, so a plain `sudo tee` failed. Worked around
   it with **`pkexec`**, which triggered a native GUI password prompt via
   the KDE polkit agent already running on the desktop session — no TTY
   needed. Set it to `1`, restarted PipeWire, checked hw_params again:
   **period_size and buffer_size were byte-for-byte unchanged.** Reading
   `audio_driver.c` explained why — the code path that would consume this
   parameter (`set_jitter_buffer_depth`) is explicitly commented
   `// future implementation` in this driver build. It's a stub. Reverted
   it back to `3` via the same `pkexec` route, since there was no benefit
   to keep, only foregone jitter tolerance.
8. **Traced the real constraint**, in the same file: a hardcoded list,
   `g_supported_period_sizes[] = {6, 12, 16, 48, 64, 128, 192, 384, 512}`
   in `mr_alsa_audio_hw_rule_period_size_by_rate()`, further bounded by a
   *runtime* `maxPTPFrameSize` (confirmed 384 via an earlier kernel log:
   `"minPTPFrameSize = 48, maxPTPFrameSize = 384"`). PipeWire's requested
   `1024` exceeded that ceiling, so the driver always clamped it down to
   384 regardless of what graph quantum we set.
9. **Fixed it in userspace, no kernel involvement**: lowered
   `api.alsa.period-size` in `aes67-ravenna-bridge.conf` from `1024` to
   `48` (matches the AES67 tic frame size exactly, 1ms, and is in the
   driver's allowed list). Restarted PipeWire, verified directly against
   `/proc/asound`: **`period_size: 48`, `buffer_size: 6144`** — an 8x
   reduction from 384, confirmed real, not just configured.
10. **Stability check**: 15+ seconds sustained. `AES67_Sink` and the
    Monitor path: 0 xruns. `AES67_Deck` showed one xrun right at the
    restart/renegotiation moment, then flat — the same one-time settling
    bump seen after *every* quantum change this session, not a sustained
    problem.

### A correction made along the way

Initially claimed the AES67 leg dropped to ~3ms round trip because its
ALSA period is now 48 samples. That was wrong — in PipeWire, an
individual node can have its own tight *hardware* period, but data only
moves between nodes in the graph once per shared *graph quantum*
(128 samples here). The 48-sample period buys xrun safety margin and
tighter hardware-level timing, not a latency win below what the
128-sample graph quantum already governs for node-to-node handoff. The
real corrected number is in the table below.

## Current settings (live, as of 2026-08-26)

| Setting | File | Value |
|---|---|---|
| PipeWire graph quantum | `~/.config/pipewire/pipewire.conf.d/10-aes67-clock-48khz.conf` | `128` (min `128`, max `2048`) |
| RAVENNA ALSA period (`AES67_Sink`/`AES67_Source`) | `~/.config/pipewire/pipewire.conf.d/aes67-ravenna-bridge.conf` | `api.alsa.period-size = 48` |
| CPU power profile | `powerprofilesctl` | `performance` (was `balanced`) |
| `MergingRavennaALSA` kernel module `jitter_buffer_multiplier` | sysfs (not persisted — see caveats) | `3` (stock default, unpatched) |

**No kernel module code was patched or rebuilt.** Everything above is a
userspace config change or a runtime CPU-profile switch, both fully
reversible.

## Current round-trip latency (calculated from verified live settings)

| Path | Basis | Round trip |
|---|---|---|
| Operator monitoring (local input → engine → Monitor → speakers) | 2 graph hops × 128-sample quantum (2.667ms) | **~5.3ms** |
| Full AES67 network (RAVENNA in → engine → RAVENNA out) | 2 graph hops × 2.667ms + ~1ms RTP packet time | **~6.3ms** |

Down from the ~43–44ms baseline — roughly **7–8x**. This is a calculated
estimate from confirmed live buffer/quantum values, not an
oscilloscope/loopback measurement.

## Caveats

- **CPU governor = `performance` increases power draw and heat** — a real
  tradeoff for the latency headroom. quantum=128 was only validated clean
  *with* this active; reverting the power profile could reintroduce the
  xruns seen in step 1.
- **The `jitter_buffer_multiplier` value is not persisted** — it's a
  runtime sysfs write, so it resets to the driver's compiled-in default
  (`3`) on next module load/reboot regardless. Since it's confirmed to be
  a no-op stub in this build anyway, that's fine — nothing to persist.
- **The 48-sample AES67 period was only tested on a quiet local setup**,
  not under real multi-device AES67 network load/jitter. A real
  network's jitter could behave differently than this local loopback-ish
  test. Worth a re-check before relying on this for a live show with
  real external AES67 devices on the wire.
- All of this is layered on top of the engine's self-healing fix (see
  [[aes67-deck-engine-jack-fragility]]) — every PipeWire restart during
  this investigation recovered automatically with no manual intervention,
  which is what made this kind of live iterative tuning practical at all.

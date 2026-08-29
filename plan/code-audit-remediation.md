# Code Audit Remediation Plan

**Source:** `docs/code-audit-report.md` (2026-08-29)
**Branch:** `audit-remediation-phase1`
**Status:** Phases 1–7 done, deployed to `ck-aes67` and verified there.
A self-audit of the branch (§11) turned up and fixed one HIGH (metering
buffer overflow) + three MEDIUM/LOW issues; redeployed + re-verified.

### Progress — Phase 1 (engine RT-safety)

- [x] **1.1** `ChannelState` → atomics (`fader/pan/mute/solo/phase` + `aux_sends[NUM_AUX+1]`);
  `aux_send_slot()` helper; in-place map construction; default seeding.
  Verified: 800-iteration aux-send/fader stress at 2 ms concurrent with 37 Hz
  metering — engine stable (was the A2 crash window).
- [x] **1.2** `IpcClient::send_json_async()` + mutex-guarded `async_tx_` deque,
  drained in `run()`; `send_json()` repointed; `tx_buffer_` is now RT-only.
  Verified: metering + LUFS frames flow normally after the split.
- [x] **1.3** `TimelinePlayer` `flush_gen_` / `render_seen_gen_[]`; reader bumps
  the generation, `render()` drains its own ring consumer-side; no more
  `jack_ringbuffer_reset` on the reader thread. Builds; needs a seek/loop
  listening test.
- [x] **1.4** `DiskWriter`: `interleave_buffer_` pre-allocated in ctor (no
  resize in `start_recording`); `channels_` + `sndfile_` → atomic; ring drain
  replaces `jack_ringbuffer_reset`; disk thread gates ring access on
  `is_recording_ || saw_recording`; bounded wait for a prior take to finish
  closing. Builds; needs a record + immediate re-record test.

#### Runtime test results (2026-08-29, dev stack)

- **1.1** aux-send/fader stress (800 msgs @ 2 ms across ch 1–8 / all bus ids)
  concurrent with 38 Hz metering — engine stable, no crash. The old
  std::map path was UB here.
- **1.2** metering + LUFS frames flow at ~38 Hz after the tx split.
- **1.3** Timeline playback of a real 20 s clip: **0 ring underruns over 5 s
  of steady playback**; 40 rapid `transport_locate` calls survived cleanly
  (each triggers the new `flush_gen_` drain), master meter tracking audio
  throughout (~-8 dBFS).
- **1.4** Master record: stop → **immediate** re-record → stop produced a
  valid, correctly-finalised second WAV (`RIFF/WAVE`, 2 ch, 48 kHz, 32-bit
  float, 1.00 s of data). This is the stop→start drain/wait window.

Not yet done: helgrind / TSan pass over a scripted session.

#### Pre-existing issue found during testing — DIAGNOSED + FIXED in §8

"Loop playback does not wrap." Root cause turned out to be **not** the
engine (its loop + wrap work — proven by a direct-IPC test and a Chrome
browser test). The UI's `reassertRegionToEngine()` ran every metering
frame and re-sent `transport_set_loop`/`punch` whenever the engine's echo
disagreed with that client's local `!!region && loopEnabled`; two clients
with different local intent (e.g. one with no region) fought over
`loop_enabled` at ~40 Hz, and any external/scripted loop command was
reverted in ~25 ms — which is what every earlier scripted test hit,
including the "A/B against `46d2e76`" one (a browser tab was connected).
Fixed in Phase 6 (§8).

---

## 1. Verified assessment of the audit

Every finding was re-checked against the source. Summary of where the audit
was right, wrong, or overstated:

| # | Audit claim | Audit sev | Verdict | Real sev |
|---|---|---|---|---|
| A1 | Multi-producer race on `IpcClient::tx_buffer_` | CRITICAL | Confirmed; "memory corruption" overstated (fixed-size ring, not heap) | **HIGH** |
| A2 | RT-thread data race on `ChannelState::aux_sends` `std::map` | CRITICAL | Confirmed, and broader — the plain scalar fields race too | **CRITICAL** |
| A3 | Non-atomic `jack_ringbuffer_reset` in `TimelinePlayer` | HIGH | Confirmed | **MEDIUM** (transient click on seek) |
| A4 | `DiskWriter::interleave_buffer_` realloc race | HIGH | Mechanism **wrong** — buffer is gated by `is_recording_`; smaller residual races exist | **LOW** |
| A5 | JSON `snprintf` on the RT callback | MEDIUM | Factual; no allocation, pure CPU; prod fine at q128 | **LOW–MEDIUM** |
| B1 | `execFileSync('wvunpack')` blocks Node loop | HIGH | Confirmed; `setImmediate` wrapper does not fix it; `.peaks.json` cache limits it to once per take | **MEDIUM–HIGH** |
| B3 | Non-atomic JSON persistence | LOW | Confirmed | **LOW–MEDIUM** |
| D1 | Stale port names in `audio-watchdog.sh` | MEDIUM | Factual (`in_1` vs `in_1_L`) but script is **not deployed** | **LOW** |
| C3 | Hardcoded `/home/ck` paths | LOW | Essentially unfounded — 2 cosmetic `Documentation=` lines only | **NON-ISSUE** |
| B2 | Subprocess / path-traversal / allow-list — PASS | PASS | Confirmed PASS | — |

### Evidence notes

- **A1:** RT producer — `main.cpp:917`, `:1692` (`send_multichannel_metering`).
  IPC producer — `main.cpp:577, 643, 685, 697, 710` (`send_json` inside
  `set_transport_callback`, invoked on the IPC thread by `IpcClient::run()`).
  Same SPSC `tx_buffer_`. Result: torn/lost JSON lines (`take_finished` can go
  missing), possible write-pointer wedge. Not heap corruption.
- **A2:** IPC writer — `main.cpp:498` (`aux_sends[bus_id] = value`, inserts +
  rebalances). RT reader — `main.cpp:1218–1222` (`count()` + `[]`). Concurrent
  tree traversal during rebalance = UB in the audio callback. `set_aux_send`
  fires on every aux-send drag. Also `fader/pan/mute/solo/phase` are plain
  `float`/`bool` written at `:487–496`, read at `:1092`, `:1209–1211`. Outer
  `std::map<int,ChannelState> channels` is safe (populated once at startup,
  never restructured).
- **A3:** `TimelinePlayer.cpp:308` reset on the reader thread vs. RT
  `render()` `read_space`/`read` at `:141, :143`.
- **A4:** `DiskWriter.cpp:61` early-returns while `is_recording_` (atomic) is
  false; it is set true only at `:47`, after the `:38` resize; `:22` blocks a
  restart. So the described race is unreachable. Residual: `jack_ringbuffer_reset`
  at `:39` vs. the disk thread's unconditional `read_space` at `:105`;
  non-atomic `channels_` (`:24` vs `:84`); non-atomic `sndfile_` publication.
- **B1:** `index.ts:2133` `get_clip_peaks` → `setImmediate` (`:2142`) →
  `ensurePeaks` runs sync on the main thread anyway
  (`wavPeaks.ts:29` `execFileSync` + `:39` `readFileSync` + `:110–118` per-sample
  loop). Cached to `<name>.peaks.json` (`wavPeaks.ts:133`).
- **D1:** `scripts/audio-watchdog.sh:44–45` links `AES67_Deck:in_1`/`in_2`;
  engine registers `in_1_L`/`in_1_R` (`main.cpp:452–453`). No systemd unit or
  `deploy/` asset references the script. Secondary: the `:40`
  `grep -q "AES67_System_Audio"` guard is too broad to detect a partial
  link loss.
- **B2:** `sanitizeProjectName` (`index.ts:106`) → `[a-zA-Z0-9_-]`, 64 cap.
  `get_clip_peaks` validates `file` `^[0-9A-Za-z_-]+\.(wav|wv)$`, strips
  `takeDir` of `.`/`/`. Video: `full.startsWith(projectVideoDir(...))` (`:1592`).
  All subprocess calls use arg arrays. Inbound WS filtered by `allowedTypes`.

### Not audited, worth a follow-up

`MultitrackRecorder` was never examined for concurrency — and that is the code
path behind the known open bug "first ~2 s of every multitrack take is
distorted". Schedule a dedicated concurrency review there (separate from this
plan).

---

## 2. Phase 1 — RT-safety (engine)

Ordered so the crash-prone one (1.1) lands first. 1.1 + 1.2 touch
`main.cpp` / `IpcClient` together — one build. 1.3 and 1.4 are isolated.

### 1.1 `ChannelState` → lock-free atomics

```cpp
struct ChannelState {
    std::atomic<float> fader{0.75f};
    std::atomic<float> pan{0.0f};
    std::atomic<bool>  mute{false};
    std::atomic<bool>  solo{false};
    std::atomic<bool>  phase{false};

    float current_peak_l = 0.0f;   // RT-thread-only, stays plain
    float current_peak_r = 0.0f;

    // [0] = Master send, [1..NUM_AUX] = Aux 101..108. Replaces std::map.
    std::atomic<float> aux_sends[NUM_AUX + 1];

    std::vector<std::unique_ptr<plugins::PluginInstance>> insert_chain;
};
```

- Init: `fader`/`pan`/etc. via member initialisers. `aux_sends`: seed
  `[0] = 0.75f` (Master default in the old `? : 0.75f` path), `[1..NUM_AUX] = 0.0f`.
  Done in the startup loop that currently builds `channels`.
- `bus_id` → index helper: `MASTER_ID` → 0, `AUX_BASE + b` → `b + 1`,
  anything else → reject.
- IPC handler `main.cpp:487–498`: `.store(v, std::memory_order_relaxed)`;
  `set_aux_send` maps `bus_id` and range-checks.
- RT reads: `main.cpp:1092–1093` (`solo`), `:1172` (`phase`), `:1209–1211`
  (`mute`/`fader`/`pan`), `:1218–1222` (aux sends — drop the
  `count()? : default` dance, the array slot always exists),
  `:1286–1345` (bus strip: `mute`/`fader`/`pan`), `:1349–1405` (monitor
  strip). All `.load(relaxed)`.
- `ChannelState` is no longer copyable/movable (atomics) — check the two
  places `channels` is populated (`channels[i] = ChannelState();`) and switch
  to `channels.try_emplace(i)` / `channels[i];` (default-construct in place).
- `<atomic>` already included in `main.cpp`.

### 1.2 Split the IPC tx path so `tx_buffer_` stays SPSC

`IpcClient`:
- Keep `tx_buffer_` as the **RT-only** metering ring. Rename the public entry
  the RT thread uses to make the contract explicit (`send_metering_rt`), keep
  `send_multichannel_metering` as an alias if churn is a concern.
- Add `send_json_async(const std::string&)`: push onto a
  `std::mutex`-guarded `std::deque<std::string>` (`async_tx_`).
- In `run()`, after draining `tx_buffer_` into `tx_pending`, also drain
  `async_tx_` under the lock into `tx_pending` (same partial-write flush path
  handles the rest). The mutex is only ever contended between the IPC thread
  and the (rare) IPC-thread callback caller — never the RT thread.
- `main.cpp:577, 643, 685, 697, 710`: `ipc.send_json(...)` →
  `ipc.send_json_async(...)`.
- `send_json()` (old alias to the RT path) — remove or repoint to
  `send_json_async`; audit callers first (`grep -n send_json`).

### 1.3 `TimelinePlayer` reset → RT-owned flush

- Remove `jack_ringbuffer_reset(tracks_[t]->ring)` from `reader_loop`
  (`TimelinePlayer.cpp:308`).
- Add `std::atomic<uint32_t> flush_gen_{0}` + per-track
  `uint32_t render_seen_gen_[MAX_CH+1]` (RT-thread-only).
- `reader_loop`, on the re-seek branch (`!was_playing_ || discontinuity ||
  playhead_ran_dry`): `flush_gen_.fetch_add(1, release)` instead of the reset.
- `render()` (RT): if `flush_gen_.load(acquire) != render_seen_gen_[track_id]`,
  `jack_ringbuffer_read_advance(ring, jack_ringbuffer_read_space(ring))` to
  drain, then update `render_seen_gen_`. Reader re-primes via `fill_pos_`
  (already does).
- Note: the reader writes into the ring right after bumping the gen; the RT
  drain and the reader write are still SPSC-clean (one producer, one
  consumer, `read_advance` is a consumer op).

### 1.4 `DiskWriter` hardening

- Constructor: `interleave_buffer_.assign(size_t(MAX_NFRAMES) * MAX_CH, 0.0f)`
  (define `MAX_NFRAMES = 8192`, `MAX_CH` = 2 for this writer — it only ever
  does master/bounce stereo; keep a generous `* 32` if we might reuse it).
  Remove the `resize` from `start_recording` (`:38`).
- `channels_` → `std::atomic<int>` (store in `start_recording`, load in
  `write_audio` / `drain_ringbuffer`).
- `sndfile_` → `std::atomic<SNDFILE*>` with release store at `:46` / acquire
  loads on the disk thread; OR gate the disk thread's ring access so
  `jack_ringbuffer_reset` at `:39` can't overlap `drain_ringbuffer` (guard the
  `:105` `read_space` on `is_recording_.load() || saw_recording`).
- Keep the existing `is_recording_` publish-ordering comment; it stays valid.

### Phase 1 test / verification

- Build engine (`cmake --build` in the engine build dir).
- `scripts/run-dev.sh` — confirm engine connects, metering flows, faders /
  aux sends / mute / solo / phase all respond.
- Aux-send stress: drag an aux send rapidly for ~30 s while the meters run —
  previously the crash window. Expect clean.
- Timeline: play, scrub/locate repeatedly, loop wrap — listen for the
  seek click; expect it gone or reduced.
- Record a short master take (`start_record`/`stop_record`) and a bounce;
  confirm the WAV is valid.
- `valgrind --tool=helgrind` or a TSan build over a scripted session if
  practical.

---

## 3. Phase 2 — server  ✅ DONE (commit `4f1d042`)

### 2.1 Async peaks — done
- New `server/src/wavPeaksWorker.ts`: a persistent worker thread that runs
  `ensurePeaks()` (wvunpack + full per-sample parse + 3-tier reduce) and
  posts back the `PeaksFile`.
- `index.ts`: single worker + FIFO queue (`pumpPeaksQueue` / `getPeaksAsync`)
  — peak requests are infrequent and disk-bound, so serialising keeps memory
  flat. Worker crash/exit fails the in-flight job with `null` and respawns on
  the next request. `worker.unref()` so a pending job can't hold the process
  open.
- `PEAKS_WORKER_PATH` + `execArgv` switch on `__filename` ext: `.ts` +
  `-r ts-node/register/transpile-only` under ts-node, `.js` under compiled
  `dist/`. Verified in both.
- `get_clip_peaks` handler: `setImmediate(… ensurePeaks …)` →
  `getPeaksAsync(srcPath).then(…)`. The `.peaks.json` cache is unchanged.

### 2.2 Atomic writes — done
`writeFileAtomicSync(file, data)` (temp file in the same dir → `renameSync`
over the target; cleans up the temp on failure). Applied to **all** persisted
state: `mixer_state`, `fx_racks`, `project.json` (×3 sites), `.active` (×3),
patchbay / output-routing / talkback configs, vsc / loudness / timecode
configs, playlists, scenes, rack presets, `take.json` + manifest,
`tx_sources` / `rx_sinks`, the three `.rpp` exports, and the bounce-WAV
head-trim. Left as-is: the append-only loudness CSV log + one-time CSV header.

#### Runtime test results (2026-08-29, dev stack)

- **2.2** 30 rapid `set_fader` + 30 `set_aux_send` + a mute, then read back
  `mixer_state.json` → valid JSON, `ch5.mute === true`, **no `.tmp` litter**
  anywhere. Server restart reloaded 42 channels + 3 FX racks cleanly.
- **2.1** forced peaks recompute (cache cleared) on a 24 s take: `clip_peaks`
  returned valid v2 peaks; **server WS ping RTT stayed avg 0.7 ms / max 6 ms**
  through the whole compute (a blocked event loop would spike into the 100s of
  ms). Isolated worker test on the same file: 132 ms compute, main thread
  ticked 25/26 times → event loop free. 2nd request served from cache in 2 ms.

---

## 4. Phase 3 — cleanup + verification

### 3.1 `audio-watchdog.sh` — DONE (commit `0bb4c56`): **deleted**
Untouched since the initial commit, referenced nowhere, superseded by the
server's `handlePatchbaySync` + routing re-apply on engine reconnect. Beyond
the port suffix (`in_1` vs `in_1_L`) it targeted the wrong source node and
channel — fixing the names would give a script that fights the server.
`route-system-audio.sh` and `aes67-audio-fix.sh` (correct port names, genuine
manual helpers) were left alone.

### 3.2 RT metering serialisation off-thread — **not done (deferred by design)**
Optional; A5 re-rated LOW–MEDIUM. Production runs fine at q128 with headroom.
Only worth the churn + risk if the rig moves to q64 or adds channels.

### 3.3 ThreadSanitizer pass — DONE (commit `09ecb7d`)
Added an opt-in `-DSANITIZE=thread` CMake build + `engine/tsan.supp`, and a
scripted driver (`engine/test/tsan_driver.py`, not committed) that stands in
for the server and hammers every Phase-1 path — aux sends, faders,
mute/solo/phase, plugin add/remove/load_rack, transport locate/play, record
start/stop, timeline set — for ~25 s while draining metering.

- **Phase 1 primitives: zero races.** `aux_sends` atomic array, `async_tx_`
  mutex path, `TimelinePlayer::flush_gen_`, `DiskWriter` atomics — all clean.
- **Fixed one real pre-existing race:** `IpcClient` started its worker from
  the constructor, before `main()` installed the callbacks → unsynchronised
  read of the `std::function`s in `run()`. Now `ipc.start()` is explicit,
  called after every `set_*_callback`; `running_` → atomic. Verified the
  server's post-connect state restore still lands in full.
- **Remaining TSan noise (92 → 2):** the 2 are 100 % inside `ld-linux` /
  `libpipewire-module-protocol-native` (no app frames). The ~55 suppressed
  reports are all `PluginInstance` / `Lv2Host::instantiate_plugin` accesses
  synchronised through `jack_ringbuffer` (plugin_cmd_ring / plugin_trash_ring)
  — real acquire/release ordering TSan can't see inside uninstrumented libjack.

## 5. Phase 4 — plugin-chain thread safety  ✅ DONE (commit `318c668`)

Both from the Phase 3 TSan pass; **not in the original audit**.

- **`PluginInstance::bypassed`** `bool` → `std::atomic<bool>` (IPC writes it
  during add/seed, the audio thread reads it every block; the SetBypass
  command applies it too).
- **`set_plugin_param` / `set_plugin_bypass` no longer run off the IPC
  thread.** They dereferenced `channels[ch].insert_chain[idx].get()` — a
  `std::vector` the audio thread mutates and a `PluginInstance` the trash
  thread may `delete` (real cross-thread vector access + UAF on a live
  control path). Now queued onto `plugin_cmd_ring` as
  `PluginCmd{SetParam, SetBypass}` and applied by the audio thread. The
  modern UI sends real LV2 symbols so no per-URI remap is needed on this path
  (`seed_params`, on a fresh not-yet-shared instance, keeps its remap).
- **`set_control_value_by_symbol` is now RT-safe** — `symbol → port index`
  resolved against a map built once in `instantiate()`, no lilv calls, no
  allocation. Unknown symbol = harmless no-op.
- **`src/util/tsan_annotations.h`** — `AES67_TSAN_RELEASE/ACQUIRE` around the
  `plugin_cmd_ring` / `plugin_trash_ring` hand-offs, so TSan sees the
  happens-before edge that lives inside libjack. This **replaced** the
  `PluginInstance` / `Lv2Host` suppressions — a real future plugin race now
  surfaces instead of being masked. `tsan.supp` is now third-party only.

### Verification
Release + TSan + ASan builds clean. ASan-clean under the real persisted
`fx_racks.json` restore (Compressor+Reverb+EQ8Band on ch1) plus param/bypass
churn. TSan data-race-clean (2 remaining findings are 100 % `ld-linux` /
`libpipewire-module-protocol-native` mutex-tracking artifacts, present from
the first run). Dev-stack functional check: add / param / bypass / remove +
300 rapid param changes — effects apply, engine stable, `fxN` telemetry
tracks the chain.

**Explicitly not doing:** C3 (hardcoded paths — non-issue); Phase 3.2 RT
metering rework (unless the latency target changes).

---

## 6. Phase 5 — MultitrackRecorder / WavpackWriter lifetime  ✅ DONE (commit `2b97e1a`)

The audit's "not audited, worth a follow-up" item.

- **`MultitrackRecorder::start()` reaped the previous take's `WavpackWriter`s
  inline** (`for (auto& w : writers_) w.reset()`). On a `stop()` + immediate
  `start()` (auto-punch, vsc split, operator mashing record) the audio thread
  can still be one block deep in `write()` on one — and `~WavpackWriter`
  frees its `jack_ringbuffer` under it. **Use-after-free on the RT thread.**
- Fix: `writers_` (owning, IPC) + `writer_ptr_[]`
  (`std::array<std::atomic<WavpackWriter*>>`, the audio thread's view — atomic
  acquire load, so a raced in-flight `write()` sees the still-live outgoing
  writer or `nullptr`, never a torn pointer). `start()` **retires** the old
  writers into `retired_` tagged with the current `audio_block_seq_`; a
  **reaper thread** destroys them once `end_audio_block()` (called once per
  process callback) has advanced the sequence ≥2 past the retire — a real
  happens-before that any in-flight `write()` has completed.
- `armed_` (`std::vector`, rebuilt every `start()`) removed from the audio
  thread — the metering builder iterates `armed_mask_` (`atomic<uint32_t>`).
  `is_recording()` → acquire.
- **Verified:** Release + TSan + ASan clean; the driver now also hammers
  `start`/`stop_multitrack_record` (start → stop 9 ms later → immediate
  re-arm) — 59+ takes finalised, no races, no ASan errors; dev-stack real
  multitrack record + immediate re-arm, both takes recorded and committed.
- The **"first ~2 s distorted"** bug was **not reproduced** — no consistent
  concurrency cause found in this code; likely input-signal or WavPack
  encoder/decoder, still open.

---

## 8. Phase 6 — loop/punch region ownership  ✅ DONE (commit `86834e8`)

The "loop doesn't wrap" report (see §1). **The engine was never the
problem** — a direct-IPC test and a Chrome browser test both wrap
correctly at the loop-out point.

- **Root cause:** the UI's `reassertRegionToEngine()` fired every metering
  frame (~40 Hz) from `useMixerStore` and re-sent
  `transport_set_loop`/`punch` whenever the engine's echoed `loopOn`/`punchOn`
  disagreed with that client's local `!!region && loopEnabled`. Two clients
  with different local intent (typically one with no region drawn) then
  fought over `loop_enabled` at metering rate, and any external / scripted
  loop command was reverted in ~25 ms. Every earlier "confirmed pre-existing"
  scripted test hit this because a browser tab was connected.
- **Fix (server):** record the last `transport_set_loop` / `transport_set_punch`
  (`lastLoop` / `lastPunch`, frames) and replay both on engine reconnect —
  the same self-heal the region was missing while routing / mixer /
  metronome / timecode all had it. Seeded from the active project's
  persisted `loop` slot at startup and on `setActiveProject`.
- **Fix (ui):** removed the per-frame `reassertRegionToEngine()` call.
  `syncRegionToEngine` still fires on real user edits.
- **Verified in Chrome, live:** draw region → click LOOP → `loopOn:1` holds,
  0 flips over 4 s; play across the loop-out → playhead wraps 22.9 s → 15.0 s
  and stays in the region. An already-open browser tab must reload for the
  UI half.

---

## 9. Phase 7 — record-startup distortion  ✅ addressed (commit `f56661e`), appliance check pending

The "first ~2 s of every multitrack take is distorted" bug.

- **Does not reproduce on the dev workstation** — recorded takes are clean
  (no clipping / gaps / NaN, `overrun:false`, steady gain). It's
  appliance-specific (RT scheduling + real ALSA capture + disk on the
  ThinkCentre).
- **New diagnosis:** `jack_set_xrun_callback` → an atomic counter echoed as
  `transport.xruns` on the metering frame (also audit finding "no xrun
  visibility") shows `start_multitrack_record` causing a JACK xrun **even on
  the workstation**. Cause: `mtr.start()` built N × (16 MB
  `jack_ringbuffer_create` + disk-thread spawn) on the IPC thread the instant
  the transport flipped to recording. The reverted head-discard "didn't help"
  because it only delayed the first ring write, moving the xrun storm with it.
- **Fix:** the `WavpackWriter`s are now a **persistent pool of 32**, built
  once in the `MultitrackRecorder` constructor; `start()` only opens files.
  No per-take ring alloc / thread spawn / destruction — which also let the
  Phase-5 reaper/retired/atomic-pointer machinery be deleted (nothing to race
  when writers never move or die). Per-writer ring 16 MB → 4 MB. `WavpackWriter`
  made reopen-safe (bounded wait, drain-not-reset, gated disk thread, atomic
  `wpc_`/`channels_`, `close_file` publishes null last). Ring pages faulted in
  + `mlock`ed in the ctor — same for `DiskWriter` and `TimelinePlayer`.
- **Verified:** Release/TSan/ASan clean. Dev stack: 4 consecutive 6-channel
  takes add **3 xruns total** (takes 2 & 4 add zero) vs. ~1 per take before;
  all takes valid + lossless. The new **XR** toolbar cell shows the count live.
- **Deployed + verified on `ck-aes67` (2026-08-29):** `start_multitrack_record`
  causes **zero** xruns on the appliance (delta 0 over a full record cycle),
  vs. the burst that was distorting take heads. Idle xruns also 0. Take
  length correct (3 s record → `frames` 144000 = 3.00 s). Post-deploy fix
  `8c15e5e` (persistent pool made `write()` skip its armed check → 32× frame
  overcount → minutes of silent tail) also verified there.

---

## 11. Branch self-audit  ✅ DONE (commit `e274b46`)

Reviewed the whole diff before trusting it on the appliance.

- **HIGH — metering JSON buffer overflow (`main.cpp`).** Every append was
  `offset += snprintf(meter_json.data()+offset, meter_json.size()-offset, …)`.
  snprintf returns the length it *would* have written, so a truncated write
  lets `offset` run past the 32 KB buffer; `size()-offset` is `size_t` and
  underflows, and the next call writes out of bounds → heap corruption on
  the RT thread. Reachable with ~10+ armed multitrack channels streaming
  peak envelopes through a slow metering frame — i.e. right in the workflow
  Phases 5/7 hardened. **Pre-existing**, not introduced by this branch, but
  now deployed. Fix: `mj()` clamp helper + 64 KB buffer.
- **MEDIUM — `WavpackWriter::start_recording` bounded-wait fell through.**
  Waited 400 ms for the prior take's disk thread, then raced it on
  `file_`/`first_block_`/`path_`/the ring. Now waits 3 s and refuses rather
  than racing (real closes are <50 ms).
- **MEDIUM — RT-thread `std::string` alloc per metering frame.**
  `send_multichannel_metering(char*)` → `std::string(char*) + "\n"`, ~40 Hz
  on the audio thread. New `send_metering_rt(const char*, size_t)`, zero
  alloc. Pre-existing.
- **LOW — `set_control_value_by_symbol(const std::string&)`** → the RT
  thread built a string from the command ring's `char[48]`. Now
  `std::string_view` + heterogeneous map lookup.
- **LOW — `clear_timeline`** now refuses while a REAPER recording project
  is open.

Redeployed to `ck-aes67` and re-verified: metering stays valid JSON (2-write
payload+newline reassembles), 8-channel record → 0 xruns, take length
correct, ASan clean recording all 32 channels.

## 12. Outstanding

- Full **helgrind** run (TSan covered the same ground; a second opinion,
  lower priority now).
- Appliance soak test with the full plugin load + all analysers, watching
  the new XR counter (audit recommendation).

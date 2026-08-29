# Code Audit Remediation Plan

**Source:** `docs/code-audit-report.md` (2026-08-29)
**Branch:** `audit-remediation-phase1`
**Status:** Phase 1 implemented + builds; 1.1/1.2 runtime-verified, 1.3/1.4 need targeted tests

### Progress

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

Remaining verification: timeline seek/loop audio, master record + bounce,
ideally a TSan or helgrind pass over a scripted session.

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

## 3. Phase 2 — server (after Phase 1 lands)

### 2.1 Async peaks
Move `computePeaks` / `readAudio` to a `worker_threads` pool (or async
`child_process.execFile` + streaming WAV parse). Keep the `.peaks.json`
cache. `get_clip_peaks` enqueues, replies on completion.

### 2.2 Atomic writes
One helper, applied to every state-persistence site (`index.ts:377, 431, 540,
638, 805, 976, 1205, 1355, 1779, 1782, 1801, 1912, 2294, ...`):

```ts
function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
```
Leave `.rpp` export and CSV log writes as-is (not recovery-critical).

---

## 4. Phase 3 — cleanup

- **3.1** Fix `audio-watchdog.sh:44–45` → `in_1_L` / `in_1_R`; tighten the
  `:40` guard. Or delete the script if `route-system-audio.sh` + the server's
  routing convergence have superseded it (decide first).
- **3.2** *(optional, low priority)* Move metering serialisation off the RT
  thread: RT writes a packed binary frame to a ring, a telemetry worker emits
  JSON. Only justified if we go to quantum 64 or add channels.

**Explicitly not doing:** C3 (hardcoded paths — non-issue).

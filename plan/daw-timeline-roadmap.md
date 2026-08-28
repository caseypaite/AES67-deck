# DAW / Timeline — development roadmap

## Context — what the "DAW" is today

The TIMELINE view (`ui/src/views/DawView.tsx`, store `ui/src/stores/useDawStore.ts`)
is a **visual prototype**. Everything a user can do in it is UI-only:

- **Clips are fabricated objects.** `useDawStore` seeds five mock clips
  (`useDawStore.ts:57-63`). "Recording" doesn't create audio — on transport
  stop, `DawView.tsx:44-69` invents a fixed-length coloured rectangle on every
  armed track with a random name. The waveform drawn in each clip is a static
  hand-written SVG squiggle (`DawView.tsx:338-340`).
- **The playhead is a JavaScript stopwatch.** `DawView.tsx:71-85` accumulates
  `requestAnimationFrame` deltas into `playheadPosition`. It is not tied to the
  audio clock, JACK frame count, or engine transport — it drifts, pauses when
  the tab is backgrounded, and resets on reload.
- **Timecode is cosmetic.** `formatTime` (`DawView.tsx:87-93`) hard-codes 30 fps
  non-drop and derives HH:MM:SS:FF from the JS playhead, then writes it into
  `useMixerStore.timecode` for the toolbar.
- **Nothing persists.** `useDawStore` is a plain `create()` — no `persist`
  middleware (unlike `usePatchbayStore`), and scenes only snapshot
  `{ mixer, patchbay }` (`LiveConsoleView.tsx:317-321`). Close the tab and the
  arrangement is gone.
- **Recording is master-stereo only.** `start_record` /`stop_record`
  (`useMixerStore.ts:456-459` → allow-list `server/src/index.ts:225-226` →
  `engine/src/main.cpp:407-410`) opens **one** hard-coded file
  `/tmp/aes67_deck_master.wav`, 2 ch, via `recorder.write_audio(out_bufs,…)` at
  `main.cpp:898` — the post-master-FX mix. Per-track record-arm exists in the UI
  and engine state but is never read by the recorder.
- **There is no playback path.** The engine cannot read a file from disk into a
  channel. Nothing plays clips back.

So the console half of the app is real and wired end-to-end; the timeline half
is a façade in front of a single stereo tape machine.

## The central gap

A DAW needs three things the engine does not have:

1. **A transport clock** the engine owns and everyone else follows (sample
   position, running/stopped, loop, punch).
2. **Multitrack capture** — arm N channels, get N time-aligned files.
3. **Disk playback** — schedule clips and stream them off disk into the mixing
   graph, sample-accurately, without allocating or blocking on the RT thread.

Everything else (waveforms, fades, comping, bounce, markers) sits on top of
those three. The roadmap below builds them in dependency order, then layers on
features aimed at this box's actual users — live broadcast / streaming / event
mixing over AES67.

---

## Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Record **tap point** per channel | **Pre-insert (raw input)** — tap the JACK input buffers before the insert chain (`main.cpp:656-664`). Pure archive; playback re-processes through the live channel. A global post-insert switch can be added later if a soundcheck workflow needs the captured channel tone. |
| D2 | File layout | **N mono float WAVs** per take: `projects/<name>/takes/<timestamp>/ch<NN>.wav` + `take.json` (project-frame origin, SR, armed mask). Simpler partial-arm handling, standard stem interchange, one file per playback voice. |
| D3 | Timeline time base | **Seconds/timecode primary**; optional bars+beats grid deferred to Phase 5. |
| D4 | Project model | **Separate `projects/<name>/` dir** (`project.json` = clips, markers, track layout, take index; `takes/` alongside). A scene is a live mixer snapshot; a project is the arrangement. Scene recall must not wipe the timeline. |
| D5 | Disk format | Follow JACK SR (`jack.get_sample_rate()`), 32-bit float WAV (matches current `DiskWriter` `SF_FORMAT_FLOAT`). 24-bit on export only. |

---

## Phase 1 — Make the timeline real (capture + clock + persistence)

No new audio features for the user; this is the foundation. Three parallel tracks.

### 1a. Engine — transport clock (`engine/src/main.cpp`)

- A `struct Transport { std::atomic<uint64_t> frame; std::atomic<int> state; //
  0 stop 1 play 2 rec\n  std::atomic<uint64_t> loop_start, loop_end; }`
  global, mirroring the `TalkbackState` atomic pattern (`main.cpp:242-251`).
- IPC commands (extend the `set_command_callback` switch at `main.cpp:386-425`
  and the server allow-list `server/src/index.ts:225`):
  `transport_play`, `transport_stop`, `transport_locate {frame}`,
  `transport_set_loop {start,end,enabled}`, `transport_arm_record`.
- In the process callback, advance `transport.frame` by `nframes` only while
  `state != stop`; wrap at `loop_end` when looping.
- **Publish position on the existing metering frame.** Add a `"transport"` key
  (`{frame, state, sr}`) to the JSON built at `main.cpp:973-1075` — it already
  ships ~40 Hz to every UI. No new channel.

### 1b. Engine — multitrack recorder (`engine/src/recorder/`)

- Generalise `DiskWriter` (currently one `SNDFILE*`, `DiskWriter.h:34`) into a
  `MultitrackRecorder` owning up to 32 mono writers + one ring buffer, or keep
  `DiskWriter` per-track and hold a `std::array<DiskWriter,32>`. Reuse the
  lock-free ring + disk-thread design as-is (`DiskWriter.cpp:67-96`) — it's
  already correct, just single-file.
- `start_recording(dir, armedMask, sr)` opens one file per armed input into
  `dir/ch<NN>.wav`; the audio thread calls `write_audio` with each armed
  channel's tap buffer (tap point per D1 — the channel loop already has
  `tmp_L/tmp_R` post-insert at `main.cpp:692-696`, capture there).
- Record start is **quantised to `transport.frame`** so every take folder has a
  known project-time origin; write that origin into `takes/<ts>/take.json`.
- Overflow already handled (`DiskWriter.cpp:61-64`) — surface it: set an
  atomic flag, report it on the metering frame as `transport.diskOverrun` so
  the UI can flash a warning (the `// In a pro DAW we would flag this` TODO).

### 1c. Server — project persistence (`server/src/index.ts`)

- New `PROJECTS_DIR` next to `SCENES_DIR` (`index.ts:9`). WS types
  (server-handled, **not** forwarded to engine, same as `sync_patchbay_matrix`):
  `save_project`, `load_project`, `list_projects`, `new_project`.
- Project JSON: `{ clips: DawClip[], markers: Marker[], trackHeights,
  transport: {loopStart,loopEnd}, takeIndex: [...] }`.
- Debounced autosave of the active project on every clip mutation, mirroring the
  `mixer_state.json` pattern (`index.ts:36`, 500 ms).
- Relay `transport` from the engine metering frame straight through (it already
  rebroadcasts all engine→UI messages).

### 1d. UI — follow the engine, stop faking

- `useDawStore`: add `persist` (localStorage) as a crash-safety net **and**
  server round-trip via the Phase 1c WS types. Drop the seeded mock clips
  (`useDawStore.ts:57-63`) — start empty.
- `DawView.tsx`: delete the rAF integrator (`:71-85`) and the on-stop clip
  fabricator (`:44-69`). `playheadPosition` becomes derived from the engine
  `transport.frame / sr`, interpolated between frames for smooth 60 fps
  (predict from local clock, correct on each metering frame).
- Transport buttons (`useMixerStore.toggleTransport` `:449-462`) send the new
  `transport_*` commands instead of only `start_record`/`stop_record`.
- On record stop, the server sends the new take manifest; the store creates real
  clips at the take's project-time origin, one per recorded file, carrying the
  file path.
- Timecode: compute from engine `frame`/`sr`, add a 25 / 30 / 30-DF selector.

**Phase 1 verification**

- `scripts/run-dev.sh`; arm CH 1–4, record 20 s, stop.
  `takes/<ts>/ch01..04.wav` exist, equal length, `soxi` shows SR = JACK SR.
- Clips appear on the four lanes at the right start offset; reload the page —
  clips and playhead origin survive (project autosave).
- Scrub the ruler while stopped → engine `transport_locate` fires,
  `transport.frame` in the metering frame tracks.
- Kill and restart the engine mid-project — server replays nothing audio-wise
  yet, but the UI project is intact.

---

## Phase 2 — Playback & real waveforms

### 2a. Engine — disk-streaming playback voice

- One `PlaybackVoice` per input channel: an mmap/`sf_readf` reader feeding a
  small per-voice ring filled by the existing disk thread; the audio thread
  pulls `nframes` and sums into that channel's `tmp_L/tmp_R` **before** the
  insert chain (`main.cpp:663`), so channel FX, fader, pan, aux sends, metering
  and routing all apply unchanged.
- Clip schedule pushed from the server over a lock-free ring (same mechanism as
  `plugin_cmd_ring`, `main.cpp:286`): `{trackId, fileId, fileStartFrame,
  timelineStartFrame, lengthFrames, gainDb, fadeInFrames, fadeOutFrames}`.
  The voice seeks when `transport.frame` enters a clip, applies the fade
  envelope, goes silent in gaps.
- Locate / loop handled by re-seeking all voices off `transport.frame`.
- "Input vs timeline" per track: when stopped-at-input or record-armed, pass the
  live JACK input; when playing, sum the live input + playback (or
  playback-only — a per-track monitor mode, standard DAW behaviour).

### 2b. Server — clip schedule + peak files

- On project load / clip edit, diff and push the clip schedule to the engine.
- **Peak-file generation**: when a take closes (or a file is imported), spawn an
  offline scan → `takes/<ts>/ch<NN>.peaks` (min/max pairs at a few zoom tiers,
  e.g. 256/1024/8192 spp). Small binary or JSON. Serve over HTTP or push over WS.
- Optional: have the engine's disk thread emit coarse peaks *while recording*
  so the clip fills in live (nice-to-have, not required).

### 2c. UI — waveform rendering

Done as part of the arrange-surface rewrite in **"UI architecture"** below, not
as DOM-per-clip. In short:

- The whole arrange area (lanes, grid, clips, waveforms, playhead, selection,
  markers) is **one `<canvas>`**, not the current div-per-clip tree
  (`DawView.tsx:258-401`) over a `w-[100000px]` spacer (`:247`).
- Waveforms draw from `.peaks` at the tier closest to the current `zoom` (px/s);
  the canvas only repaints on change (edit / zoom / scroll / playhead tick).
- Clip gain line + fade-in/out corner handles are drawn on the surface and
  hit-tested in canvas space; drags write back to the schedule.
- Framed by the `<Scope>` recessed-display chrome from `docs/ui-design.md` §2.6
  (bezel, glass, vignette) — but the chrome is static; only the screen interior
  redraws.

**Phase 2 verification**

- Record a take, stop, hit play → audio plays back through each channel strip;
  muting CH 2 or adding an EQ to it affects playback in real time.
- Loop a region → seamless wrap, no click at the loop point.
- Real waveforms match the audio; trimming a clip edge changes what you hear.
- Drag a clip later in time → it plays at the new position after a locate.

---

## Known issues (unresolved)

- **Record startup distortion** — the first ~2 s of every multitrack take
  (`MultitrackRecorder`) is distorted/noisy. A recorder-side 2 s head-discard
  workaround was tried and reverted (commit a6c2cb7) — it did *not* clear the
  distortion, so the bad audio is coming from the tap itself, not just a
  transient in the written file. Investigate the pre-insert JACK input buffers
  right after `start_multitrack_record`, WavpackWriter/DiskWriter ring priming,
  and whether the single-file master recorder shows the same head glitch.

## Phase 3 — Broadcast / live features (the reason this box exists)

### 3a. Virtual soundcheck  ★ headline feature — DONE 2026-08-28

Record every AES67 network input during a live show, then rehearse or train the
mix against the recording with the band gone. This is the single highest-value
DAW feature for this hardware and it composes directly with the AES67 receive
work in `plan/unified-aes67-network-control.md`.

- [x] "VSC ARM ALL" — arms every input with an AES67 source mapped in the
  patchbay (`useMixerStore.armAllMappedInputs`); arm state is now persisted
  server-side (`mixer_state.json`, `set_arm`) so the server knows the armed set.
- [x] Per-channel monitor override — engine `g_monitor_input_mask`
  (`set_monitor_input_mask` IPC, `monInMask` on the metering frame). TrackPanel
  IN/TL toggle per track, `MON: TIMELINE⇄LIVE` master button in the VSC toolbar.
  The old global play/stop swap still applies to channels not pinned live.
- [x] Unattended whole-show record (server `vsc_config.json`): auto-record on
  first `transport_play`, `vsc_split` (button + auto on marker drop while
  recording — reopens contiguously in `handleTakeFinished`), disk-space guard
  (`fs.statfsSync` on `RECORDS_DIR`, `vsc_status` broadcasts, hard-floor
  auto-stop at 1 GB), and a single daily scheduled start.
- Markers: minimal ruler rendering + `M` / `,` / `.` keys landed here (full cue
  list still Phase 3b).
- Not done: recurring/calendar schedules (daily HH:MM only); post-insert VSC
  capture tap (open question 4).

### 3b. Markers & cue list — DONE 2026-08-28

- [x] Named markers on the ruler, add-at-playhead (`M`), jump-to (`,`/`.`),
  drag — landed in 3a; split-take-on-marker uses these.
- [x] Cue-list side panel (`ui/src/components/daw/CueListPanel.tsx`, toggled
  from the timeline toolbar): markers sorted by time, inline rename, colour
  cycle, jump, delete, current-cue highlight, add-at-playhead.
- [x] As-run CSV export (`Cue,Name,Timecode,Seconds,WallClock`) — client-side
  via `ui/src/lib/download.ts`; `WallClock` derived from the active take's
  wall-clock anchor (`useDawStore._takeStartedAtMs` / `_takeOriginSec`).

### 3c. Loudness logging (compliance) — DONE 2026-08-28

The engine already computes BS.1770 M/S/I + true-peak on the master
(`main.cpp:1200+`, README "Metering & analysis"). Logged over time:

- [x] Server parses the loudness fields off the metering frame in the IPC
  handler (`maybeLogLoudness`), appends
  `wallClock,projectFrame,sec,M,S,I,TP` to `logs/loudness-<date>.csv` at ~1 Hz
  while the transport is rolling (settings toggle for always-on). In-memory
  ring backs the UI strip.
- [x] `loudness_config.json` — target (−14 / −23 / −24) + `logWhileStopped`;
  WS `get`/`set_loudness_config`.
- [x] UI loudness-history strip (`ui/src/components/daw/LoudnessHistory.tsx`):
  Short-term area + Integrated line vs the target band, live M/S/I/TP readout,
  target selector.
- [x] Compliance-report export for the region bracketing the playhead
  (`export_loudness_report` → `logs/report-<name>-<ts>.csv` with a summary
  header: integrated, short-term max/mean, true-peak max, PASS/FAIL). Metrics
  derived from the 1 Hz samples — noted in the report, not a sample-accurate
  re-measure (that needs the Phase 4 bounce path).

### 3d. Timecode & sync — DONE 2026-08-28

The box runs `ptp4l` as an AES67 **grandmaster** + `phc2sys -O 0` disciplining
`CLOCK_REALTIME` off the media PHC (`deploy/systemd/phc2sys-crystal.service`),
so the system wall clock *is* the network reference.

- [x] **PTP time-of-day timecode** — engine samples `CLOCK_REALTIME` per audio
  block (`g_tod_sec`, echoed on the metering `tc` key). A `SOURCE: PROJECT ⇄
  TIME-OF-DAY` selector (+ `HH:MM:SS:FF` start offset in project mode) in the
  timeline `TC` panel; the transport readout and both generators follow it.
- [x] **LTC generator** — hand-rolled SMPTE encoder (`engine/src/timecode/
  Timecode.cpp`, 24/25/30/29.97-DF, biphase-mark, fractional sample accumulator)
  on a dedicated `ltc_out` JACK audio port (patchbay-routable to any AES67 sink
  channel). Free-runs while parked so a downstream device can be jammed.
- [x] **MTC** — quarter-frame + full-frame SysEx on a `mtc_out` JACK MIDI port
  (`MtcEncoder`).
- [x] **Chase external LTC** — hand-rolled `LtcDecoder` (zero-cross bit-clock
  recovery + 80-bit sync detect + flywheel) on a dedicated `ltc_in` port;
  drives `transport_locate` + play while locked, stops on ~250 ms signal loss.
  `LOCKED / SIGNAL, NO LOCK / NO SIGNAL` lamp + incoming-TC readout in the panel;
  a `CHASE` badge on the taskbar.
- Server: `timecode_config.json` (persist + replay to engine on reconnect, like
  the metronome); `take.json` gains `ptpWallClock` + `startTimecode`.
- Verified real-engine end to end (`scratchpad/tc-test.mjs`, 18/18 — two engine
  instances, `TC_A:ltc_out → TC_B:ltc_in`; LTC round-trip at all rates incl. DF,
  chase drift ≤ 0.2 TC frames, ToD decode = wall clock, MTC cadence + SysEx) and
  offline unit test (`scratchpad/tc_unit.cpp`).
- [x] **Flywheel chase — DONE 2026-08-28.** Replaced the repeated-locate model:
  one jam-sync on the first clean decode, a ~2 s fast-converge window, then a
  bounded ±6 samples/block servo (`ltc_corr`) rides the JACK clock (the same PTP
  media clock the LTC carries on this box). Gross re-cue only on `>0.5 s` error
  with a 5-decode vote; dropouts are ridden through — the transport never stops.
  `err` (ms) + `fly` echoed on `tc`; `FLYWHEEL` lamp in the panel. Verified
  `scratchpad/tc-test.mjs` 23/23 (2 s feed-cut → transport keeps rolling within
  0.7 TC frames, re-syncs cleanly).
- [x] **Transport lock-out — DONE.** Console play/stop/record are disabled with
  a `CHASE` badge while `ltcChaseLocked`.
- [x] **`ltc_out` AES67 stream — DONE (needs a deploy step).** `TX_SOURCE_PLAN`
  gains a mono `ltc` group (`map:[20]`, `enginePorts:['ltc_out']`); everything
  downstream is already channel-count-generic. **Deploy**: widen `AES67_Sink`
  20→21 ch in `deploy/pipewire/20-aes67-ravenna-bridge.conf` (done in-repo) and
  reload PipeWire/RAVENNA, then enable "Deck LTC" in NetworkPanel. Disabled by
  default — no daemon calls until both are done.

### 3e. Punch & pre-roll — DONE 2026-08-28

- [x] **One shared loop/punch region** (a time selection) — `useDawStore`
  `region` / `loopEnabled` / `punchEnabled` / `preRollSec`, drawn as a band on
  the ruler + a lane tint (`SurfaceModel.drawRegion`), Alt-drag the ruler to
  create, drag the in/out handles. Persisted in `project.json` (the server's
  `DawProject.loop` slot) and localStorage.
- [x] **Loop** — the engine's `transport_set_loop` (dead code until now) is
  wired; the region drives it, wrap already handled in the process callback.
- [x] **Engine** — `Transport` punch fields + `transport_set_punch` IPC;
  `loopOn/In/Out` + `punchOn/In/Out` echoed on the metering `transport` key.
- [x] **Server-timed auto-punch** (`maybePunch` in the IPC metering handler):
  crosses the in-point with armed tracks → `startTake`; crosses the out-point
  → `stopTake`. Metering-rate accuracy (~±25 ms) — fine for broadcast with
  pre-roll; sample-accurate would need engine file-open-ahead.
- [x] **Pre-roll** — `toggleTransport` locates `preRollSec` before the
  in-point and rolls; the take still opens only at the in-point.
- [x] **Loop-record** — a loop wrap while a take is open → `maybePunch`
  triggers the existing VSC split, one take per pass.
- [x] **Loop-record → one lane per pass — DONE.** The server tags each loop
  pass (`loopPass` + `passIndex` on `take_committed`, tracked via
  `loopRecordPass` / `pendingLoopPassIndex`); `addCommittedClips` stacks every
  pass on its own take lane, never the comp lane, ready to comp.

---

## Phase 4 — Editing polish

- **Undo/redo — DONE 2026-08-28.** Manual snapshot stack in `useDawStore`
  (`{clips, markers, trackHeights}`, cap 60) with 250 ms time-coalescing so a
  pointer gesture = one step; `pushHistory()` at the head of every mutator,
  `undo` / `redo` / `historyBegin` / `historyEnd`, `canUndo` / `canRedo` for
  the toolbar, `Ctrl/⌘+Z` · `Ctrl+Shift+Z` · `Ctrl+Y`. Cleared on project
  load. Region / transport modes are excluded by design.
- **Clip gain + fades — DONE.** Per-clip linear `gain` / `fadeIn` / `fadeOut`
  (`ClipSpec`, `DawClip`): engine per-frame envelope in `produce_track`, server
  persists + forwards on `set_timeline`, `SurfaceModel` draws ramps + a gain
  line with drag grips (`clip-fade-in` / `clip-fade-out` / `clip-gain` hit
  kinds), context-menu reset/clear.
- **Crossfades — DONE 2026-08-28.** Two clips overlapping on a track →
  equal-power (cos/sin) crossfade across the overlap span. `TimelinePlayer`
  gained a second file reader per track (`tracks_b_`); `produce_track` gathers
  up to two covering clips, reads both, mixes with `cos/sin` gains over
  `[c1.start, c0.end]` (each clip's own linear fades ignored inside the
  overlap). Server unchanged — overlap is pure geometry. `SurfaceModel`
  `drawCrossfade` paints the X. Containment (one clip fully inside another) is
  not a supported crossfade shape. **Not yet run end-to-end.**
- **Take comping — first cut DONE 2026-08-28.** `DawClip.lane` (0/undefined =
  the comp lane that plays + persists to the engine; ≥1 = alternates stacked
  below). A new take that lands on existing audio auto-stacks onto a fresh lane
  (`addCommittedClips`). Track expands to show take lanes (`laneExpand`,
  chevron + `⧉N` badge in `TrackPanel`, lane bands in `SurfaceModel` with
  matched panel/canvas heights). Swipe horizontally across a take lane →
  `compPick` splices that take's audio into the comp lane over the swiped span
  (splitting the comp clips around it, short seam fades), with a live green
  preview (`compPreview`). Context menu: promote lane / move to comp / send to
  new take lane. Server sends comp-lane-only to the engine + `.rpp`.
  Verified end-to-end in a headless browser (`scratchpad/comp-test.mjs`).
- **Comping polish DONE 2026-08-28.** Drag a take clip between lanes / tracks
  (gesture picks swipe-vs-move from the first drag direction — horizontal =
  swipe-to-comp, vertical = move), lane-aware drop highlight (`dragOverLane`),
  and a per-segment "active comp" marker on each take lane (green wash + top
  accent where that take currently feeds the comp lane, matched by
  source-offset). Empty take-lane auto-collapses.
  **Still to do**: comp crossfade length control, loop-record stacking each
  pass onto its own lane (currently only `addCommittedClips` auto-stacks).
- **Bounce / export** — render a timeline region through the master chain to a
  file. Realtime (route master to a `DiskWriter`, run transport over the region)
  first; offline/faster-than-realtime later. Stem export = the per-track taps.
- **Nudge / ripple / group / lock — DONE 2026-08-28.** Arrow keys nudge the
  selection by the grid (Alt = one frame, Shift = ×5). `rippleEdit` toggle
  (`RIPPLE` in the toolbar) makes delete close the gap and paste open one on
  the affected tracks; `rippleDelete` (`✂ CUT`, region-gated) cuts the region
  out of every comp-lane track and closes the gap (markers ripple too, locked
  clips are left alone). `clip.locked` (context menu) blocks move / trim /
  fade / gain / slice, with a hatch + padlock overlay. `clip.group` (context
  menu, 2+ selected) — grouped clips select and move together;
  `expandGroups` folds the group into every selection. Verified end to end
  (`scratchpad/edit-test.mjs`, 12/12).
- **Comp crossfade-length control — DONE 2026-08-28.** `compPick`'s hard-coded
  8 ms seam is now a project field `compCrossfadeSec` (taskbar `XF ms` input,
  0–100 ms, persisted). True overlapping-clip comp crossfades (the engine
  already renders track overlaps equal-power) = noted follow-up.
- **Clip fx** — deferred. Clip-gain automation is covered by the automation
  lanes below.
- **Render virtualisation — DONE 2026-08-28.** The arrange surface is already
  one viewport-sized `<canvas>` with off-screen tracks/clips culled in `draw()`.
  Split into two stacked canvases: the **scene** (grid / tracks / clips /
  waveforms / region / markers) repaints only on an edit or view change — a
  `sceneSig` diff in `ArrangeSurface` ignores playhead-only ticks — and the
  transparent **overlay** carries just the playhead, repainted every frame
  while rolling. Clips are bucketed by track once per scene paint instead of a
  per-track `filter`. `SurfaceModel.sceneDraws` / `overlayDraws` counters +
  `window.__arrangeModel` (DEV) for perf visibility. Measured: 2 s of playback
  = ~130 overlay paints, **0 scene paints** (`scratchpad/edit-test.mjs`).
  Recording still repaints the scene continuously (live-take waveform grows).

---

## Phase 5 — Optional / later

- **Bars+beats + metronome — first cut DONE 2026-08-28.** A single project
  `tempo` + `timeSig` (full tempo map deferred). `gridMode` toggles the ruler +
  grid + snap between seconds and musical time (`snapTime`, `musicalGrid`,
  `secToBBT`/`formatBBT`); the transport readout follows. Engine metronome:
  `set_metronome` IPC → a cos-burst click on each beat while rolling (downbeat
  1760 Hz / off-beat 1245 Hz), summed post-fader onto the monitor bus, master,
  or both (`metroDest`). Server remembers the config + replays on engine
  reconnect; UI re-sends on ws open. Taskbar: `TIME/BARS`, `♩` tempo, time-sig,
  `METRO`, dest toggle. Verified end to end with the real engine
  (`scratchpad/metro-test.mjs`, 8/8 — bounced click track: 8 beats/4 s at
  120 bpm, correct downbeat pitch).
- **Bars/beats tails — DONE 2026-08-28.**
  - [x] `beatDiv` UI — taskbar `1/x` button (1/4·1/8·1/16), already fed `snapTime`.
  - [x] Musical-snap for the arrow-key nudge — `fine` uses `beatSec/beatDiv` in
    bars mode.
  - [x] Musical settings persisted in `project.json` + the `.rpp` `TEMPO` line
    (tempo, timeSig, beatDiv, countInBars, compCrossfadeSec, metroDest) —
    `DawProject` + `musicalFields()` + `serializeProject`/`loadProjectData`,
    `timelineToRpp`/`parseRpp` carry tempo + time-sig.
  - [x] **Count-in** — engine `g_countin_frames`: N frames of metronome-only
    with the transport frozen + recorder tap gated, before the roll. Rides the
    `transport_play` / `start_multitrack_record` payload (`countinFrames`),
    echoed on the metering `tc.countin` key, `CI n` taskbar button + a
    `COUNT-IN` overlay. Verified `scratchpad/countin-test.mjs` 5/5.
  - **Still deferred**: tempo *map* (ramps / mid-project changes).
- **Automation lanes — DONE 2026-08-28.** Fader / pan / plugin-param breakpoint
  envelopes per channel. `AutoLane` in `useDawStore` (`automation`, `autoExpand`,
  `automationMode`), drawn as `AUTO_LANE_H` bands under the take lanes
  (`SurfaceModel.autoBands` / `drawAutomationLane`, `auto-point` / `auto-lane`
  hit kinds, `ArrangeSurface` point drag/add/delete), `TrackPanel` `+`/`⌁`
  toggles + `AutoLanePicker` (ranges from `availablePlugins.controlPorts`).
  **Playback = a server-side runner** (`maybeRunAutomation` on the metering
  clock, next to `maybePunch`) that emits `set_fader`/`set_pan`/
  `set_plugin_param` (+ broadcast so UI faders move) — no engine change.
  **WRITE mode** captures armed-lane moves in the mixer-intercept branch,
  thins + pushes back (`auto_lane_updated`) on stop. `DawProject.automation`
  persisted; `set_automation_state` feeds the runner; taskbar `AUTO R/W`.
  Verified `scratchpad/auto-test.mjs` 5/5 (live stack: fader ramps 0.1→0.9,
  write-capture round-trips). **Follow-up**: sample-accurate engine-side
  automation ring if 40 Hz proves steppy; `.rpp` `<TRACK>` envelope export.
- **Video reference track — DONE 2026-08-28.** Operator copies an `.mp4` /
  `.webm` into `projects/<name>/video/`; the server grows a Range-aware HTTP
  endpoint (`GET /video/<project>/<file>`, sharing the WS port via
  `http.createServer` + `{ server }`). `useDawStore.video` (`{file, offsetSec}`,
  persisted in the project) + `VideoPanel` — a bottom strip with the `<video>`
  kept in sync with the transport (plays while rolling, scrubs while stopped,
  drift-corrected), a source dropdown, an offset nudge (`±1f` / `±1s`) and
  "align start → playhead". Taskbar `VIDEO` button. **Follow-up**: a thumbnail
  filmstrip lane on the timeline (offscreen seeking is heavy — deferred).
- MIDI — out of character for this box; skip unless a real need appears.
- **Multi-project playlist — DONE 2026-08-28.** `playlists/<name>.json`
  (`{name, segments:[{project, recProject?, gapSec?}]}`). Server sequencer
  (`maybeAdvancePlaylist` on the metering clock, `startPlaylist` /
  `loadSegmentAndPlay` / `stopPlaylist`): loads a segment's project (fan-out
  `project_data` → the timeline follows), locates 0, plays; advances at the
  clip-end frame (`projectEndSec`), with an `armed` guard so a lagging metering
  frame can't skip a segment, optional per-segment `gapSec`. WS
  `list/load/save/new_playlist` + `playlist_transport`; `PlaylistPanel` (right
  rail) + a `PLAYLIST` taskbar button + `playlist_status` badge. Verified
  `scratchpad/playlist-test.mjs` 5/5 (2-segment run, boundary at the 2 s clip
  end). **Follow-up**: gapless preloading of the next segment.

---

## UI architecture — dense, responsive, cheap (Reaper as reference)

The timeline must feel like REAPER: **maximum information per pixel, zero input
latency, no wasted motion** — and it has to do that on the appliance's i5-4570
driving a 1080p touchscreen while the engine has the CPU it needs. The current
`DawView.tsx` is the opposite on the perf axis: it re-renders the whole React
tree every animation frame (`setPlayheadPosition` in the rAF loop `:79`),
mounts every clip as a nested div + inline SVG (`:280-396`) over a
`w-[100000px]` spacer (`:247`), animates the playhead via `left:` (layout, not
transform, `:252`), and paints three stacked `repeating-linear-gradient` grid
layers across 100 000 px (`:231-232`, `:265`). That doesn't scale to a real
project and it steals frames from meters and FX graphs.

### What to take from REAPER

- **One custom-drawn surface, not widgets.** REAPER's arrange view is a single
  drawn canvas; tracks/items/waveforms/grid/markers/playhead are all painted,
  not composed from OS controls. Do the same: the arrange area is **one
  `<canvas>`**, DOM is reserved for chrome (toolbar, track-panel controls,
  dialogs).
- **Track-height-adaptive controls (the TCP).** REAPER's track panel reflows —
  a tall track shows name + record/mon/mute/solo/pan/volume/FX; a short track
  collapses to just name + arm. Our track header (`DawView.tsx:179-216`) is
  fixed; make its layout a function of `trackHeights[id]` with 3–4 breakpoints.
- **Mouse-context editing.** Position in the item decides the verb: middle =
  move, top-edge = fade handle, bottom-corners = clip gain, near-end = trim,
  Shift/Alt/Ctrl modify. One pointer handler, hit-zone lookup — no per-edge
  invisible divs (`:347-395` today).
- **Multi-format ruler.** REAPER shows timecode + minutes:seconds + (optionally)
  bars simultaneously. Our ruler is grid lines only (`:224-234`).
- **Everything has a key.** An actions map (locate, split at cursor, toggle
  snap, zoom to selection, nudge, marker add/next/prev, set loop from
  selection…) with a single keydown dispatcher, extending the four keys wired
  today (`:100-124`). One place, data-driven, later user-rebindable.
- **Instant feedback, no easing.** Drags, trims and zoom track the pointer
  1:1 — no transitions on interactive geometry. Reserve motion for scene-recall
  fader moves (per `ui-design.md` §2.2), never timeline edits.
- **Dark, flat, functional interior.** REAPER's arrange is low-contrast greys,
  thin lines, small type. This does **not** fight `docs/ui-design.md`: the
  timeline is explicitly a *recessed screen* (§2.6) — rack chrome frames it, the
  screen interior is flat and dense. Add that carve-out to `ui-design.md`.

### Rendering architecture

- **Arrange surface = `<canvas>`** sized to the viewport (not the content).
  Scroll/zoom are a view transform `{scrollX, pxPerSec, scrollY}`, not a giant
  scrolled element. A `SurfaceModel` (plain module, no React) holds view state +
  clip geometry and exposes `hitTest(x,y)` and `draw(ctx, dirtyRect)`.
- **Imperative render loop, decoupled from React.** One `requestAnimationFrame`
  loop owned by the surface. React renders the surface container **once**;
  playhead/selection/drag updates mutate `SurfaceModel` and mark a dirty rect —
  they never call `setState`. The store is read once on mount and subscribed
  via `useDawStore.subscribe` (transient updates), so a clip edit repaints the
  canvas without re-rendering the component.
- **Playhead** = a 1px line drawn on the surface (or a separate 1px overlay
  canvas translated with `transform: translate3d`), position predicted from the
  local clock between engine `transport` frames (1a) and corrected on each
  metering frame. No layout, no React, one compositor-only property.
- **Dirty-rect repaint.** Playhead tick repaints only the two thin columns it
  vacated/entered. A clip drag repaints the affected lanes. Full repaint only on
  zoom/scroll/resize.
- **Peak tiles, cached.** Load `.peaks` (2b) per take once; keep the tier for
  the current zoom in memory; draw waveforms straight from the min/max arrays.
  Recompute nothing on scroll.
- **Web Worker for anything O(samples).** Client-side peak scans for imported
  files, waveform tile downsampling → a worker, transferable `ArrayBuffer`s
  back. The main thread never touches raw audio.
- **Virtualise by construction.** Because the surface is viewport-sized, only
  visible lanes × visible time-range are ever drawn or hit-tested. 32 tracks ×
  a 2-hour show costs the same as one screen.
- **Cheap CSS elsewhere.** No `box-shadow`/`filter: blur`/`backdrop-filter` on
  anything inside a scroll or drag path (the `.metal-*` kit in `index.css`
  stays on static chrome only). `content-visibility: auto` on off-screen
  panels. `transform`/`opacity` are the only animated properties.
- **Touch + density.** Visual density stays REAPER-tight; hit zones are padded
  to ≥ 32 px in canvas hit-testing (invisible slop, not bigger graphics), and a
  press-and-hold = right-click-menu equivalent. Test every interaction on the
  actual touchscreen, not a mouse.

### Performance budget (appliance: i5-4570, 1080p, engine running)

- Idle timeline (transport stopped): **0 rAF work**, 0 repaints.
- Rolling transport: ≤ 1 ms/frame on the main thread for the surface; steady
  60 fps with meters + an open FX graph also animating.
- Clip drag / trim: pointer-to-paint ≤ 1 frame.
- Zoom to a 2-hour, 32-track project: full repaint ≤ 8 ms.
- No main-thread task > 16 ms during record or playback (watch with the
  Performance panel on the target box, not the dev laptop).

### Build order (slots into the phases above)

1. **Phase 1d**: while removing the fake playhead/clips, stand up the
   `SurfaceModel` + canvas shell and the rAF loop; port the existing grid,
   lanes, clips, playhead and drag/trim/slice onto it (visual parity, no new
   features). Fixes the perf problems before they get bigger.
2. **Phase 2c**: waveforms + fades + clip gain drawn on the surface; peak
   worker.
3. **Phase 3b/3d**: markers and the multi-format ruler on the surface.
4. **Phase 4**: mouse-context verb model + full actions/keymap once the
   surface owns all interaction.

---

## Integration options — how the pieces talk

**Transport clock ownership.** The engine must own it (sample-accurate, drives
capture + playback). UI and server are followers. Ride position on the existing
metering frame (1a) — do **not** add a second high-rate channel. Locate/play/
stop go the other way as normal IPC commands on the existing allow-list.

**Where playback audio enters the graph.** Sum into the per-channel `tmp_L/R`
pre-insert (2a) — reuses the entire existing channel path (FX, fader, sends,
metering, AES67 routing) for free. The alternative (dedicated playback channels)
doubles the channel count and the UI.

**Capture tap point** is the one real design choice (D1) — it changes what a
virtual soundcheck feels like. Pre-insert = pure archive; post-insert/pre-fader
= channel-processed, mix-independent (recommended default for VSC).

**Persistence split.** Scene = live mixer snapshot (unchanged). Project =
arrangement (new, D4). Keep them orthogonal; loading a scene inside a project
must not touch clips. Both are server-side JSON with debounced autosave, the
pattern `mixer_state.json` already uses.

**Waveforms** come from offline peak files the server builds per take (2b), not
from streaming sample data to the browser. Serve them over the existing HTTP
port or as a WS blob.

**AES67 tie-ins.** Virtual soundcheck (3a) is the meeting point of this plan and
`plan/unified-aes67-network-control.md`: once many network inputs land on mixer
channels automatically, "arm all + record" captures the whole networked stage.
LTC (3d) is just another engine output port → another AES67 source via the same
mechanism as the mix-product streams in that plan's Phase 2c.

**No engine change is impossible here** — unlike the network plan, this one is
engine-first. Phases 1a/1b/2a are C++ RT work and need the same care the plugin
ring and metering already show (lock-free, no alloc, no locks on the audio
thread).

---

## Files touched (by phase)

**Phase 1**
- `engine/src/main.cpp` — Transport struct, `transport_*` IPC, advance in
  process callback, `transport` key on metering frame, per-armed-channel tap
- `engine/src/recorder/DiskWriter.{h,cpp}` → multitrack (or new
  `MultitrackRecorder.{h,cpp}`, `engine/CMakeLists.txt`)
- `server/src/index.ts` — `PROJECTS_DIR`, `save/load/list/new_project`,
  `transport_*` in `allowedTypes`, take-manifest relay, project autosave
- `ui/src/stores/useDawStore.ts` — persist + server sync, drop mock clips
- `ui/src/stores/useMixerStore.ts` — `toggleTransport` sends `transport_*`,
  consume `transport` from metering frame
- `ui/src/views/DawView.tsx` — remove rAF/clip-fake; mount the canvas shell
- new `ui/src/daw/SurfaceModel.ts` — view transform, clip geometry, hit-test,
  dirty-rect draw; the rAF loop; engine-clock playhead
- new `ui/src/daw/ArrangeSurface.tsx` — canvas container, pointer dispatch
- new `ui/src/daw/TrackPanel.tsx` — height-adaptive TCP (replaces the track
  headers in `DawView.tsx:179-216`)
- `docs/ui-design.md` — carve-out: timeline screen interior is flat/dense

**Phase 2**
- `engine/src/main.cpp` + new `engine/src/playback/PlaybackVoice.{h,cpp}` —
  disk-streaming voices, clip-schedule ring
- `server/src/index.ts` — clip-schedule diff/push, peak-file generator, take
  peak serving
- new `server/src/peaks.ts` (offline scan)
- `ui/src/daw/SurfaceModel.ts` — waveform tiles, fade/clip-gain geometry
- new `ui/src/daw/peakWorker.ts` — client-side peak scan / tile downsample
- new `ui/src/components/analog/Scope.tsx` — static bezel/glass chrome frame

**Phase 3**
- `engine/` — LTC gen/decode, PTP-ToD timecode source
- `server/src/index.ts` — loudness CSV logger, marker export, VSC arm-all,
  scheduled/unattended record
- `ui/` — marker lane, cue-list panel, loudness-history strip, VSC controls,
  timecode/sync settings

**Phase 4+**
- `ui/src/stores/useDawStore.ts` — undo stack, comping model
- `engine/` — crossfade envelope, realtime bounce route
- `ui/src/daw/` — mouse-context verb model, actions/keymap, comping lanes,
  ripple/group, automation lanes (all on the surface)

---

## Open questions

1. Max simultaneous record tracks — all 32, or a lower guaranteed number given
   the i5-4570 + software PTP headroom noted in the network plan?
2. Take storage location and retention — `/tmp` (lost on reboot, matches the
   current master WAV) vs a real project directory with cleanup policy.
3. Is faster-than-realtime bounce worth an offline plugin-processing path, or is
   realtime bounce (route master → recorder, run transport) enough for the
   show-length material this box handles?
4. Does virtual soundcheck need per-channel *pre and post* insert captured
   (double disk load) so the operator can re-EQ, or is one tap enough?
5. Should scene recall be blocked / warned while a project transport is rolling?
6. Canvas arrange surface: hand-rolled 2D context (fine for lines + waveforms,
   no deps, matches "light on the system"), or a thin retained-mode helper?
   Recommendation: raw `2d` context — WebGL/PixiJS is overkill for this and adds
   weight. Revisit only if profiling on the appliance says otherwise.
7. Accessibility / fallback: the canvas surface needs a keyboard path for every
   action (it has no DOM tree to tab through). The actions/keymap (Phase 4)
   covers operators; is anything else required for the kiosk?

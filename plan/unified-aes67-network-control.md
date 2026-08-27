# Unified AES67 network control + full console broadcast

## Context

Today the appliance runs two web UIs. AES67-Deck (the console) can only *read*
the daemon's configured Sources (a 5-second poll of `GET /api/sources` in
`server/src/index.ts:480`); to create a Sink to receive a stream, adjust PTP, or
add a transmit Source the operator has to open the separate `aes67-linux-daemon`
WebUI on port 8080. The daemon is control-plane only — it configures the RAVENNA
kernel module over netlink and does SAP/mDNS discovery; it is never in the audio
path — so everything it does is reachable through its REST API and can be driven
from inside the deck.

Second need: the deck's mix buses and channels never reach the network. Only a
2-channel `AES67_Sink` PipeWire node exists (`deploy/pipewire/20-aes67-ravenna-bridge.conf`).
The operator wants every channel and bus transmitted as AES67 so other devices
(IEMs, OB truck, recorders, distribution) can subscribe.

**Decisions taken** (from planning Q&A):
- Channel direct-outs are **post-insert-FX, post-fader/mute, pre-pan**.
- **Stereo** everything: 32×2 channels + 8×2 Aux + Master + Monitor = **84 network channels**.
- Daemon TX Sources are **auto-provisioned** by the server on a fixed multicast
  plan; the new UI lets the operator enable/disable and rename each group.
- Delivered in two phases; **Phase 1 (config UI) ships and is verified before Phase 2**.

RAVENNA driver limits are fine: the DKMS build does **not** define
`AES67_LIMITED_BUILD`, so `MAX_NUMBEROFOUTPUTS = 128`
(`3rdparty/ravenna-alsa-lkm/common/MergingRAVENNACommon.h:70`) and the ALSA PCM
advertises `channels_max = 128` (`driver/audio_driver.c:1240`). Each RTP stream is
capped at 64 channels (`RTP_stream_info.h:49`); we use ≤8-channel Sources.

---

## Phase 1 — Unified daemon control in the deck UI

### 1a. Server: generic daemon REST proxy (`server/src/index.ts`)

Replace the single-purpose `fetchDaemonSources()` with a small helper and a
fuller poll:

- `daemonRequest(method, path, body?): Promise<{ok, status, json}>` — wraps
  `http.request` to `DAEMON_BASE_URL` (unchanged default `http://localhost:8080`,
  env `AES67_DAEMON_URL`), 2 s timeout, never throws.
- `pollDaemonState()` (replaces `pollDaemonDestinations`, same 5 s interval):
  fetch `GET /api/config`, `/api/ptp/status`, `/api/sources`, `/api/sinks`,
  `/api/browse/sources/all` in parallel; broadcast one
  `{ type: 'daemon_state', reachable, config, ptp, sources, sinks, remote }`
  message to all WS clients and cache it as `lastDaemonState` for the
  `wss.on('connection')` greeting (replaces the `daemon_destinations_loaded`
  send at `server/src/index.ts:197`).
- Keep emitting `daemon_destinations_loaded` too (derived from
  `daemon_state.sources`) so the existing Output-Endpoints code in
  `usePatchbayStore` / `PatchbayView` keeps working untouched.

New inbound WS message types, handled in `ws.on('message')` **next to**
`sync_patchbay_matrix` (server-handled, **not** added to `allowedTypes`, never
forwarded to the engine). Each performs the daemon call then calls
`pollDaemonState()` immediately so the UI refreshes:

| WS type | Daemon call |
|---|---|
| `daemon_create_sink` `{name, sdp \| source, delay?, map}` | `PUT /api/sink/{nextFreeId}` (`use_sdp:true`, `ignore_refclk_gmid:false`, `delay: 384` default) |
| `daemon_delete_sink` `{id}` | `DELETE /api/sink/{id}` |
| `daemon_create_source` `{name, map, address?}` | `PUT /api/source/{id}` (`enabled:true`, `io:"Audio Device"`, `codec:"L24"`, `max_samples_per_packet:48`, `ttl:15`, `payload_type:98`, `dscp:34`, `refclk_ptp_traceable:false`) |
| `daemon_update_source` `{id, ...patch}` | `PUT /api/source/{id}` with merged current + patch |
| `daemon_delete_source` `{id}` | `DELETE /api/source/{id}` |
| `daemon_set_ptp` `{domain, dscp}` | `POST /api/ptp/config` |

Sink/source id allocation: pick the lowest integer 0..63 not present in the
current `sources`/`sinks` list.

Source/sink JSON shapes verified against `daemon/json.cpp:445` (`json_to_source`)
and `:497` (`json_to_sink`) — `map` is a list of 0-indexed ALSA channels.

### 1b. UI store (`ui/src/stores/usePatchbayStore.ts`)

Add fields + a setter, populated from the new `daemon_state` message:
`daemonConfig`, `ptpStatus`, `daemonSinks: DaemonSink[]`, `daemonSources: DaemonSource[]`,
`daemonRemoteSources: RemoteSource[]`. Add `setDaemonState(payload)`.
These are live server state — exclude them from the `persist` partialize (add a
`partialize` that drops them) so stale daemon data never survives a reload.

### 1c. UI dispatch (`ui/src/stores/useMixerStore.ts`)

In the `onmessage` if/else chain (around `:609`), add
`else if (data.type === 'daemon_state')` → dynamic-import `usePatchbayStore`,
call `setDaemonState(data)`. Keep the existing `daemon_destinations_loaded`
branch.

### 1d. UI component — new `components/patchbay/NetworkPanel.tsx`

Rendered as a new collapsible section at the top of `PatchbayView` (matches the
existing SOURCES / DESTINATIONS / TALKBACK section pattern, same
`text-[10px] font-black tracking-widest uppercase` headers). Three blocks:

1. **PTP / CLOCK** (read-only): grandmaster id, lock state, offset from
   `ptpStatus`; daemon `interface_name` + `playout_delay` from `daemonConfig`.
   Amber banner when unlocked ("no grandmaster — streams will not run").
2. **RECEIVE (SINKS)**: table of `daemonSinks` (name, address, channels, sink
   status via existing `/api/sink/status/{id}` if we choose to fetch it, delete
   button). "Add" row: pick from `daemonRemoteSources` dropdown (SAP/mDNS
   discovered) → sends `daemon_create_sink` with that remote's `sdp`; or manual
   SDP paste.
3. **TRANSMIT (SOURCES)**: table of `daemonSources` (name, address, channels,
   enabled, delete). Manual "Add source" form in Phase 1; the fixed-plan toggle
   grid is added in Phase 2.

No engine involvement, no new IPC. WSS/store wiring only.

### Phase 1 verification

- Dev box has no daemon running by default. Either run the daemon locally with
  `-DFAKE_DRIVER=ON` build, or point `AES67_DAEMON_URL` at `http://192.168.1.6:8080`
  (the `ck-aes67` appliance) and test against it.
- `scripts/run-dev.sh`, open the UI, PATCHBAY tab → new AES67 NETWORK section:
  - PTP block shows the Dante GM lock (`00-1D-C1-…`) / offset.
  - `daemonRemoteSources` lists the Dante `239.69.35.226` stream; add it as a
    Sink from the UI; confirm with `curl $DAEMON/api/sinks` and that audio
    arrives at `AES67_Source` (`pw-record --target=AES67_Source`).
  - Add + delete a dummy TX source from the UI; confirm via `curl`.
- Confirm the existing Output-Endpoints panel + patchbay matrix still work
  (regression — `daemon_destinations_loaded` still emitted).

---

## Phase 2 — Broadcast all 84 channels

### 2a. Engine (`engine/src/main.cpp`) — 32 stereo direct-out ports

- After the `monitor_L/R` registration (`main.cpp:381`), append 64 output ports
  `direct_1_L`,`direct_1_R` … `direct_32_L`,`direct_32_R`. Appending keeps every
  existing output index (`MONITOR_PORT_L/R` etc.) unchanged.
- Record `const int DIRECT_BASE = 2 + 2*NUM_AUX + 2;` (= 20).
- In the per-channel loop (`main.cpp:655`), after `gain`/`muted` are computed and
  **before** the pan multiply, write the post-fader/pre-pan signal:
  `direct_L[s] = tmp_L[s] * gain; direct_R[s] = tmp_R[s] * gain;`
  (`tmp_L/R` at that point is already post-insert-FX). Fetch the two buffers via
  `jack.get_buffer(outputs[DIRECT_BASE + (i-1)*2 + {0,1}], nframes)`; `memset`
  them when the channel is skipped.
- Update the `outputs.size()` guard (`main.cpp:530`) to expect
  `2 + 2*NUM_AUX + 2 + 2*NUM_CHANNELS`.
- No new IPC command — the ports simply exist and the server links them.

### 2b. PipeWire — widen the sink (`deploy/pipewire/20-aes67-ravenna-bridge.conf`)

`hw:RAVENNA` is a single PCM, so the 2-ch `AES67_Sink` becomes **one 84-ch
node**:
- `audio.channels = 84`, `audio.position = [ AUX0 AUX1 … AUX83 ]`
  (ports `AES67_Sink:playback_AUX0..83`).
- Keep `period-size = 48`, `period-num = 2`, `disable-tsched` (driver requires
  period == tic frame size — see the file's own comment and
  `docs/latency-tuning.md`).
- `AES67_Source` (capture) stays 2-ch — RX is unchanged this phase.
- **Verify** the driver accepts an 84-ch playback `hw_params` while capture runs
  2-ch (`cat /proc/asound/card0/pcm0p/sub0/hw_params` after start). This is the
  main technical risk; fall back to fewer channels / mono if it rejects.

### 2c. Server — fixed engine→RAVENNA link map + Source auto-provision

Fixed playback-channel layout (0-indexed):

| RAVENNA ch | Engine port | Daemon Source (`map`) |
|---|---|---|
| 0–63 | `direct_{1..32}_L/R` | `Deck CH 1-4` [0–7], `CH 5-8` [8–15], … `CH 29-32` [56–63] — 8 Sources |
| 64–79 | `bus_{101..108}_L/R` | `Deck AUX 1-4` [64–71], `AUX 5-8` [72–79] — 2 Sources |
| 80–81 | `out_L/out_R` | `Deck Master` [80,81] |
| 82–83 | `monitor_L/monitor_R` | `Deck Monitor` [82,83] |

- New `applyBroadcastRouting()` in `server/src/index.ts`, called from the
  `ipcServer` "C++ Engine connected via IPC" block (`:392`) alongside
  `applyOutputRouting` etc. `pw-link`s each engine port to its fixed
  `AES67_Sink:playback_AUX{n}` (reuses the existing `pwLink()` /
  `disconnectAllOutputsOf()` helpers). Idempotent, same self-heal contract as
  the rest of that block.
- New `tx_sources.json` persistence + `reconcileTxSources()`: desired state is
  the 12-entry plan above, each `{ enabled, name }` operator-overridable.
  Whenever `pollDaemonState()` sees the daemon reachable, diff desired vs actual
  and `PUT`/`DELETE` `/api/source/{id}` to converge. Let the daemon auto-assign
  multicast addresses from `rtp_mcast_base`; read them back for display.
- WS: `set_tx_source` `{key, enabled?, name?}` → update `tx_sources.json` +
  reconcile. Broadcast a `tx_sources` message with desired+resolved state.

### 2d. UI — TX toggle grid in `NetworkPanel.tsx`

Replace the Phase-1 manual TX list with a grid of the 12 groups: checkbox
(enabled), editable name, resolved multicast address + channel count, live
"running / no-clock" indicator derived from `ptpStatus`. Sends `set_tx_source`.

### 2e. Consolidation note

The existing per-bus **Output Endpoints** feature (`output_routing.json`,
`applyOutputRouting`, DESTINATIONS panel) overlaps Phase 2 for Master/Aux. Leave
it in place (it can still route to non-AES67 hardware endpoints), but the
NetworkPanel doc/tooltip should note that Master/Aux now always have a dedicated
AES67 stream regardless of Output-Endpoint assignment.

### Phase 2 caveats (operational, call out in the UI + `deploy/README.md`)

- **PTP lock required to transmit** — same dependency as receiving; needs the
  external Dante grandmaster (`192.168.1.8`) present. No GM ⇒ Sources exist but
  don't run.
- **Bandwidth / CPU**: 84 ch L24 @ 48 k @ 1 ms ≈ 100 Mbit/s multicast + ~12 000
  pkt/s TX across 12 streams, with software PTP timestamping on the i5-4570.
  Enable groups incrementally; watch `/var/log/aes67-watch.log`, PTP offset, and
  engine xruns. Reducing to mono or fewer active groups is the pressure valve.

### Phase 2 verification

- Rebuild engine (`deploy/build-deck.sh` or `cmake --build engine/build`),
  reinstall the pipewire drop-in, restart PipeWire, restart the engine.
- `pw-link -o | grep AES67_Deck:direct_` shows 64 ports; `pw-link -l` shows them
  linked to `AES67_Sink:playback_AUX*`.
- `curl $DAEMON/api/sources` shows the 12 Sources with assigned addresses.
- From another AES67 device (or a second daemon / `gst`+SDP), subscribe to
  `Deck Master` and confirm audio; move a channel fader and confirm its
  `Deck CH n` stream follows (post-fader tap).
- Toggle a group off in the UI → `curl` shows it `enabled:false` / removed and
  its multicast traffic stops (`tcpdump`).
- Regression: local monitoring, patchbay matrix, Output Endpoints, LUFS metering
  all still work.

---

## Files touched

**Phase 1**: `server/src/index.ts` (proxy + WS handlers), `ui/src/stores/usePatchbayStore.ts`,
`ui/src/stores/useMixerStore.ts` (one dispatch branch), `ui/src/components/patchbay/NetworkPanel.tsx` (new),
`ui/src/components/patchbay/PatchbayView.tsx` (mount the section).

**Phase 2**: `engine/src/main.cpp`, `server/src/index.ts` (broadcast routing + TX reconcile),
`deploy/pipewire/20-aes67-ravenna-bridge.conf`, `ui/src/components/patchbay/NetworkPanel.tsx`,
`server/src/index.ts` NUM/topology constants mirror, `deploy/README.md` (caveats).

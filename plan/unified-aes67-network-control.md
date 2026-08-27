# Unified AES67 network control + mix-bus broadcast

## Context

Today the appliance runs two web UIs. AES67-Deck (the console) can only *read*
the daemon's configured Sources (a 5-second poll of `GET /api/sources` in
`server/src/index.ts:480`); to create a Sink to receive a stream, adjust PTP, or
add a transmit Source the operator has to open the separate `aes67-linux-daemon`
WebUI on port 8080. The daemon is control-plane only — it configures the RAVENNA
kernel module over netlink and does SAP/mDNS discovery; it is never in the audio
path — so everything it does is reachable through its REST API and can be driven
from inside the deck.

Second need — two halves, and the original plan over-weighted one of them:

- **Receiving is starved.** Both the `AES67_Sink` *and* `AES67_Source` PipeWire
  nodes are 2-channel (`deploy/pipewire/20-aes67-ravenna-bridge.conf:22,42`), so
  the console can pull exactly one stereo stream off the network. Each discovered
  stream also needs its PipeWire `ports[]` typed in by hand
  (`ui/src/stores/usePatchbayStore.ts:14`). For a 32-input deck over AES67 this
  is the real bottleneck.
- **Transmitting only needs the mix products.** Every input the deck mixes is
  already an independent AES67 stream published by the device that originates it;
  anything downstream that wants a channel subscribes to that *upstream* source
  directly through its own controller. The deck does not need to re-transmit a
  post-fader copy of each channel. What only the deck can originate is its mix
  products — the 8 Aux buses, Master, and Monitor (post-insert-FX, post-fader) —
  and the engine **already exposes every one of them** as a JACK output port
  (`out_L/R`, `bus_101..108_L/R`, `monitor_L/R` — `engine/src/main.cpp:374`).

**Decisions taken** (from planning Q&A + this re-analysis):
- Transmit the **20 mix-product channels only** (8×2 Aux + Master + Monitor).
  No per-channel direct-out broadcast — it duplicates data already on the wire
  and is the single most invasive/expensive part of the design (RT per-sample tap
  in the channel loop, engine rebuild, 84-ch playout, ~100 Mbit/s + ~12 000 pkt/s
  with software PTP on the i5-4570). Deferred as an opt-in group (see 2e).
- **Phase 2 needs no engine change** — all 20 ports already exist.
- Widen the **receive** side and auto-wire subscribed sinks into mixer channels.
- Daemon TX Sources are **auto-provisioned** by the server on a fixed multicast
  plan; the new UI lets the operator enable/disable and rename each group.
- Delivered in two phases; **Phase 1 (config UI) ships and is verified before Phase 2**.

RAVENNA driver limits are comfortable: the DKMS build does **not** define
`AES67_LIMITED_BUILD`, so the ALSA PCM advertises `channels_max = 128` each way
(`3rdparty/ravenna-alsa-lkm/common/MergingRAVENNACommon.h:70`,
`driver/audio_driver.c:1240`). A 20-ch playout + 32-ch capture on the shared
`hw:RAVENNA` PCM is well within that and far below the original 84. Each RTP
stream is capped at 64 channels (`RTP_stream_info.h:49`); we use ≤8-ch Sources.

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
| `daemon_create_sink` `{name, sdp \| source, delay?, map}` | `PUT /api/sink/{nextFreeId}` (`use_sdp:true`, `ignore_refclk_gmid:true`, `delay: 384` default) |
| `daemon_delete_sink` `{id}` | `DELETE /api/sink/{id}` |
| `daemon_create_source` `{name, map, address?}` | `PUT /api/source/{id}` (`enabled:true`, `io:"Audio Device"`, `codec:"L24"`, `max_samples_per_packet:48`, `ttl:15`, `payload_type:98`, `dscp:34`, `refclk_ptp_traceable:false`) |
| `daemon_update_source` `{id, ...patch}` | `PUT /api/source/{id}` with merged current + patch |
| `daemon_delete_source` `{id}` | `DELETE /api/source/{id}` |
| `daemon_set_ptp` `{domain, dscp}` | `POST /api/ptp/config` |

Sink/source id allocation: pick the lowest integer 0..63 not present in the
current `sources`/`sinks` list.

Source/sink JSON shapes verified against `daemon/json.cpp:445` (`json_to_source`)
and `:497` (`json_to_sink`) — `map` is a list of 0-indexed ALSA channels. The
daemon has no PATCH: every field must be present on each `PUT`, so
`daemon_update_source` re-sends the cached live config merged under the patch.
`ignore_refclk_gmid` must be `true` — the SDP parser
(`daemon/session_manager.cpp:216`) returns 400 "cannot parse SDP" for any
stream whose `a=ts-refclk` gmid differs from the daemon's current PTP
grandmaster, which is every stream while we're unlocked or on a different GM
(the existing appliance sink is configured the same way).

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

## Phase 2 — Network I/O for the mix (no per-channel re-broadcast)

Two independent pieces, neither touching the engine: widen **receive** so the
console can subscribe to many input streams and have them land on mixer
channels automatically, and transmit the **20 mix-product channels** as AES67.

### 2a. PipeWire — widen both directions (`deploy/pipewire/20-aes67-ravenna-bridge.conf`)

Both nodes open the same `hw:RAVENNA` PCM (one playback substream, one capture):

- `AES67_Sink` (playout): `audio.channels = 20`,
  `audio.position = [ AUX0 … AUX19 ]` → ports `AES67_Sink:playback_AUX0..19`.
- `AES67_Source` (capture): `audio.channels = 32`,
  `audio.position = [ AUX0 … AUX31 ]` → ports `AES67_Source:capture_AUX0..31`.
  (Fall back to 16 if the driver balks; 32 is the target.)
- Keep `period-size = 48`, `period-num = 2`, `disable-batch`, `disable-tsched`,
  `S32LE` — driver requires period == tic frame size (see the file's own comment
  and `docs/latency-tuning.md`).
- **Verify** the driver accepts a 20-ch playback + 32-ch capture `hw_params`
  (`cat /proc/asound/card0/pcm0p/sub0/hw_params` and `pcm0c/sub0/hw_params`
  after start). Lower risk than the original 84-ch — both are well under
  `channels_max = 128` — but still the one thing to confirm on the appliance
  before the rest of Phase 2 lands.

### 2b. Server — receive: Sink → capture-channel auto-mapping (`server/src/index.ts`)

Extends the Phase 1 `daemon_create_sink` handler:

- Allocate a contiguous free block of `AES67_Source` capture channels (0..31)
  sized to the new Sink's channel count; use that as the Sink's `map`.
- Persist the assignment in `rx_sinks.json`:
  `{ sinkId, streamName, address, captureBase, channels }`.
- `reconcileRxSinks()` — on each `pollDaemonState()` where the daemon is
  reachable, re-`PUT` any Sink whose live `map` drifted from the persisted plan
  (covers a daemon restart).
- In the `daemon_state` broadcast, add per-Sink `capturePorts: string[]`
  (`AES67_Source:capture_AUX{n}` for each mapped channel).

UI side (`usePatchbayStore.ts`): fold each Sink's `capturePorts` straight into
the stream registry as an `Aes67Stream` with `ports[]` pre-filled, so a
subscribed stream is immediately selectable in the existing SOURCES patchbay —
the manual "type in the PipeWire port names" step disappears. Registry entries
derived from Sinks are read-only and excluded from `persist` (live server state).

### 2c. Server — transmit: fixed 20-ch link map + Source auto-provision

Fixed playout-channel layout (0-indexed `AES67_Sink` channels):

| RAVENNA ch | Engine port | Daemon Source (`map`) |
|---|---|---|
| 0–1 | `out_L` / `out_R` | `Deck Master` [0,1] |
| 2–3 | `monitor_L` / `monitor_R` | `Deck Monitor` [2,3] |
| 4–11 | `bus_101..104_L/R` | `Deck AUX 1-4` [4–11] |
| 12–19 | `bus_105..108_L/R` | `Deck AUX 5-8` [12–19] |

- New `applyBroadcastRouting()` in `server/src/index.ts`, called from the
  `ipcServer` "C++ Engine connected via IPC" block (`~:392`) alongside
  `applyOutputRouting` etc. `pw-link`s each engine output port to its fixed
  `AES67_Sink:playback_AUX{n}` (reuses `pwLink()` / `disconnectAllOutputsOf()`).
  Idempotent, same self-heal contract as the rest of that block.
- New `tx_sources.json` + `reconcileTxSources()`: desired state is the 4 entries
  above, each `{ enabled, name }` operator-overridable. Whenever
  `pollDaemonState()` sees the daemon reachable, diff desired vs actual and
  `PUT`/`DELETE` `/api/source/{id}` to converge. Daemon auto-assigns multicast
  from `rtp_mcast_base`; read the addresses back for display.
- WS: `set_tx_source` `{key, enabled?, name?}` → update `tx_sources.json` +
  reconcile. Broadcast a `tx_sources` message with desired+resolved state.

### 2d. UI — `NetworkPanel.tsx`

- **RECEIVE (SINKS)**: each row shows its resolved capture-port range and a
  "mapped to CH n" hint (cross-referenced with `usePatchbayStore` mappings).
  "Add" unchanged from Phase 1 (pick a discovered remote / paste SDP).
- **TRANSMIT (SOURCES)**: replace the Phase 1 manual list with a 4-group grid
  (Master, Monitor, AUX 1-4, AUX 5-8): enabled checkbox, editable name, resolved
  multicast + channel count, live "running / no-clock" indicator from
  `ptpStatus`. Sends `set_tx_source`.

### 2e. Deferred — opt-in, not built now

- **Per-channel post-FX direct outs.** If a virtual-soundcheck / outboard-matrix
  workflow ever needs the console-processed channel signal, add it then as an
  opt-in Source group. This is the *only* piece that needs the engine change
  (64 `direct_n_L/R` ports + an RT tap in the channel loop, post-fader/pre-pan)
  and a wider playout config. Kept out of the baseline because every input is
  already independently on the network for a downstream device to subscribe to.
- **System-audio / talkback as clean network sources.** One stereo Source each,
  opt-in, if a downstream device ever needs them un-mixed (talkback already
  reaches the network via the bus streams when PTT is active).

### 2f. Consolidation note

The per-bus **Output Endpoints** feature (`output_routing.json`,
`applyOutputRouting`, DESTINATIONS panel) overlaps 2c for Master/Aux. Leave it in
place (it still routes to non-AES67 hardware endpoints), but the NetworkPanel
doc/tooltip should note Master/Aux/Monitor now always have a dedicated AES67
stream regardless of Output-Endpoint assignment.

### Phase 2 caveats (operational, call out in the UI + `deploy/README.md`)

- **PTP lock required to transmit *and* receive** — needs the external Dante
  grandmaster (`192.168.1.8`) present. No GM ⇒ Sources/Sinks exist but don't run.
- **No engine rebuild** — Phase 2 is PipeWire config + server + UI only, same
  change class as Phase 1.
- **Bandwidth / CPU**: 20 ch TX L24 @ 48 k @ 1 ms ≈ 24 Mbit/s + ~4 000 pkt/s
  across 4 streams, plus the subscribed RX flows, with software PTP on the
  i5-4570 — comfortable, but still enable TX groups incrementally and watch
  `/var/log/aes67-watch.log`, PTP offset, and engine xruns.

### Phase 2 verification

- Reinstall the pipewire drop-in, restart PipeWire (no engine restart needed).
- `pw-cli ls Node` shows `AES67_Sink` 20-ch / `AES67_Source` 32-ch;
  `hw_params` for `pcm0p` and `pcm0c` confirm the driver accepted both.
- `pw-link -l` shows `out_L/R`, `bus_101..108_L/R`, `monitor_L/R` linked to
  `AES67_Sink:playback_AUX0..19`.
- `curl $DAEMON/api/sources` shows the 4 Deck Sources with assigned addresses.
  From another AES67 device subscribe to `Deck Master`, move the Master fader,
  confirm audio follows (post-fader).
- Create a Sink from a discovered multichannel remote → its channels appear as
  `AES67_Source:capture_AUX*`, auto-populate the stream registry, and map to a
  mixer channel with audio (`pw-record --target=AES67_Source`).
- Toggle a TX group off → `curl` shows it removed, `tcpdump` shows its multicast
  stop.
- Regression: local monitoring, patchbay matrix, Output Endpoints, LUFS
  metering, talkback all still work.

---

## Files touched

**Phase 1**: `server/src/index.ts` (proxy + WS handlers), `ui/src/stores/usePatchbayStore.ts`,
`ui/src/stores/useMixerStore.ts` (one dispatch branch), `ui/src/components/patchbay/NetworkPanel.tsx` (new),
`ui/src/components/patchbay/PatchbayView.tsx` (mount the section).

**Phase 2** (no engine change): `deploy/pipewire/20-aes67-ravenna-bridge.conf` (widen both nodes),
`server/src/index.ts` (RX sink→capture mapping + `reconcileRxSinks`, broadcast link map + `reconcileTxSources`),
`ui/src/stores/usePatchbayStore.ts` (Sink-derived registry entries),
`ui/src/components/patchbay/NetworkPanel.tsx` (RX port hints + 4-group TX grid),
`deploy/README.md` (caveats).

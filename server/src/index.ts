import { WebSocketServer, WebSocket } from 'ws';
import * as net from 'net';
import * as fs from 'fs';
import * as dgram from 'dgram';
import * as http from 'http';
import { execFile } from 'child_process';
import * as path from 'path';

const SCENES_DIR = path.join(process.cwd(), '..', 'scenes');
if (!fs.existsSync(SCENES_DIR)) {
  fs.mkdirSync(SCENES_DIR);
}

// FX chain presets — a named, reusable "rack": the plugin list (uri, name,
// enabled, params) for one channel's insert chain, save/loadable onto any
// other channel. Separate from scenes (which snapshot the whole mixer).
const RACK_PRESETS_DIR = path.join(process.cwd(), '..', 'rack_presets');
if (!fs.existsSync(RACK_PRESETS_DIR)) {
  fs.mkdirSync(RACK_PRESETS_DIR);
}

const SOCKET_PATH = '/tmp/aes67_deck.sock';
const WSS_PORT = parseInt(process.env.PORT || '8081', 10);

const PATCHBAY_CONFIG_PATH = 'patchbay_config.json';
const OUTPUT_ROUTING_PATH = 'output_routing.json';
const TALKBACK_CONFIG_PATH = 'talkback_config.json';
const MIXER_STATE_PATH = 'mixer_state.json';
// Phase 2 (plan/unified-aes67-network-control.md): operator overrides for the
// 4 fixed transmit-Source groups, and the AES67_Source capture-channel block
// allocated to each subscribed receive Sink.
const TX_SOURCES_PATH = 'tx_sources.json';
const RX_SINKS_PATH = 'rx_sinks.json';

// In-memory snapshot of all fader-level mixer state. Written to
// mixer_state.json on every change (debounced 500ms) and replayed to the
// engine on reconnect and to each UI client on connect, so all clients stay
// in sync and the console resumes correctly after any restart.
interface ChannelMixerState {
  fader?: number;   // normalised UI position 0..1
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  auxSends?: Record<string, number>;
}
type MixerStateMap = Record<string, ChannelMixerState>;

let mixerState: MixerStateMap = {};
let mixerStateSaveTimer: ReturnType<typeof setTimeout> | null = null;

function loadMixerState() {
  try {
    if (fs.existsSync(MIXER_STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(MIXER_STATE_PATH, 'utf8'));
      if (raw && typeof raw === 'object') mixerState = raw;
      console.log(`Loaded mixer state for ${Object.keys(mixerState).length} channels from disk.`);
    }
  } catch (e) {
    console.error('Error loading mixer_state.json, starting fresh', e);
  }
}

function saveMixerState() {
  if (mixerStateSaveTimer) clearTimeout(mixerStateSaveTimer);
  mixerStateSaveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(MIXER_STATE_PATH, JSON.stringify(mixerState, null, 2));
    } catch (e) {
      console.error('Error saving mixer_state.json', e);
    }
  }, 500);
}

// Build IPC command lines to replay the full persisted mixer state to the
// engine (faders, pans, mutes, solos, aux sends). Called on every engine
// (re)connect so the live audio matches what was last saved.
function buildEngineRestoreCommands(): string[] {
  const lines: string[] = [];
  for (const [chId, ch] of Object.entries(mixerState)) {
    const channel = Number(chId);
    if (!Number.isFinite(channel)) continue;
    if (typeof ch.fader === 'number') {
      // Replicate positionToAmplitude from the UI store.
      const y = ch.fader;
      let db: number;
      if (y >= 0.75)      db = 0    + ((y - 0.75) / 0.25) * 10;
      else if (y >= 0.50) db = -10  + ((y - 0.50) / 0.25) * 10;
      else if (y >= 0.30) db = -20  + ((y - 0.30) / 0.20) * 10;
      else if (y >= 0.15) db = -40  + ((y - 0.15) / 0.15) * 20;
      else if (y > 0)     db = -100 + (y  / 0.15)  * 60;
      else                db = -Infinity;
      const gain = db === -Infinity ? 0 : Math.pow(10, db / 20);
      lines.push(JSON.stringify({ type: 'set_fader', channel, value: gain / 2.0 }));
    }
    if (typeof ch.pan === 'number')
      lines.push(JSON.stringify({ type: 'set_pan', channel, value: ch.pan }));
    if (typeof ch.mute === 'boolean')
      lines.push(JSON.stringify({ type: 'set_mute', channel, value: ch.mute ? 1 : 0 }));
    if (typeof ch.solo === 'boolean')
      lines.push(JSON.stringify({ type: 'set_solo', channel, value: ch.solo ? 1 : 0 }));
    if (ch.auxSends)
      for (const [busId, level] of Object.entries(ch.auxSends))
        lines.push(JSON.stringify({ type: 'set_aux_send', channel, busId: Number(busId), value: level }));
  }
  return lines;
}

loadMixerState();

// Fixed console topology (mirrors engine/src/main.cpp's constants exactly —
// this is not runtime-configurable, since the engine only registers JACK
// ports once at startup): 32 source-only inputs, a Master output, 8 Aux
// output buses, one dedicated operator Monitor bus, and a dedicated
// push-to-talk Talkback mic input.
const NUM_CHANNELS = 32;
const NUM_AUX = 8;
const MASTER_ID = 100;
const AUX_BASE = 101; // 101..108
const MONITOR_ID = 109;
const TALKBACK_ID = 110;

function isValidTalkbackDest(busId: any): boolean {
  return busId === MASTER_ID || (Number.isInteger(busId) && busId >= AUX_BASE && busId < AUX_BASE + NUM_AUX);
}

// Packs a set of destination bus ids into the bitmask the engine's
// TalkbackState::dest_bus_mask expects: bit 0 = Master (100), bit i
// (1..NUM_AUX) = Aux (100+i). Invalid ids are dropped rather than rejecting
// the whole set.
function talkbackDestMask(destBusIds: number[]): number {
  let mask = 0;
  for (const id of destBusIds) {
    if (id === MASTER_ID) mask |= 1;
    else if (isValidTalkbackDest(id)) mask |= (1 << (id - AUX_BASE + 1));
  }
  return mask;
}

interface TalkbackConfig {
  sourcePorts: string[];
  // Master and/or any of the 8 Aux buses — talkback can fan out to several
  // at once. Never Monitor.
  destBusIds: number[];
  // Set when sourcePorts came from picking a device in the mic dropdown
  // rather than typing ports by hand. micAlsaPortName, when present, is an
  // ALSA port id (e.g. an external mic-jack input) that needs to be made
  // ALSA's active port on micSourceName — the PipeWire graph ports are the
  // same regardless of which physical jack is selected, so without this the
  // capture would keep coming from whatever ALSA already had active.
  micSourceName: string | null;
  micAlsaPortName: string | null;
}

function getTalkbackConfig(): TalkbackConfig {
  let sourcePorts: string[] = [];
  let destBusIds = [MASTER_ID];
  let micSourceName: string | null = null;
  let micAlsaPortName: string | null = null;
  try {
    if (fs.existsSync(TALKBACK_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TALKBACK_CONFIG_PATH, 'utf8'));
      if (Array.isArray(raw.sourcePorts) && raw.sourcePorts.every((p: any) => typeof p === 'string')) {
        sourcePorts = raw.sourcePorts;
      }
      if (Array.isArray(raw.destBusIds)) {
        // Current (multi-destination) shape.
        const filtered = raw.destBusIds.filter((id: any) => isValidTalkbackDest(id));
        if (filtered.length > 0) destBusIds = filtered;
      } else if (isValidTalkbackDest(raw.destBusId)) {
        // Config written before multi-destination talkback existed.
        destBusIds = [raw.destBusId];
      }
      if (typeof raw.micSourceName === 'string') micSourceName = raw.micSourceName;
      if (typeof raw.micAlsaPortName === 'string') micAlsaPortName = raw.micAlsaPortName;
    }
  } catch (e) {
    console.error('Error reading talkback config, using defaults', e);
  }
  return { sourcePorts, destBusIds, micSourceName, micAlsaPortName };
}

// Set up WebSocket server
const wss = new WebSocketServer({ port: WSS_PORT });
console.log(`WebSocket Server listening on ws://localhost:${WSS_PORT}`);

let connectedWsClients: WebSocket[] = [];
wss.on('connection', (ws) => {
  console.log('UI Client connected to WebSocket');
  connectedWsClients.push(ws);

  if (fs.existsSync(PATCHBAY_CONFIG_PATH)) {
     try {
       const savedMappings = fs.readFileSync(PATCHBAY_CONFIG_PATH, 'utf8');
       ws.send(JSON.stringify({ type: 'patchbay_config_loaded', mappings: JSON.parse(savedMappings) }));
     } catch (e) {
       console.error('Error sending saved patchbay config', e);
     }
  }

  ws.send(JSON.stringify({ type: 'output_routing_loaded', outputs: getOutputRouting() }));
  ws.send(JSON.stringify({ type: 'talkback_config_loaded', ...getTalkbackConfig() }));
  ws.send(JSON.stringify({ type: 'daemon_destinations_loaded', destinations: lastDaemonDestinations, daemonReachable }));
  ws.send(JSON.stringify(daemonStateMessage()));
  ws.send(JSON.stringify({ type: 'mic_devices_loaded', devices: lastMicDevices }));
  if (lastPluginCatalog.length > 0) {
    ws.send(JSON.stringify({ type: 'plugin_list_loaded', plugins: lastPluginCatalog }));
  }

  // Send current mixer state so this client starts in sync with all others.
  if (Object.keys(mixerState).length > 0) {
    ws.send(JSON.stringify({ type: 'mixer_state_loaded', state: mixerState }));
  }

  ws.on('close', () => {
    connectedWsClients = connectedWsClients.filter(client => client !== ws);
    console.log('UI Client disconnected');
  });

  // Forward UI commands to C++ Engine with basic validation
  ws.on('message', (message) => {
    try {
      const payloadStr = message.toString();
      const data = JSON.parse(payloadStr);
      // Only forward allowed types to prevent arbitrary data injection
      const allowedTypes = [
        'set_fader', 'set_pan', 'set_mute', 'set_solo', 'set_aux_send', 'start_record', 'stop_record',
        'set_plugin_param', 'set_plugin_bypass', 'set_talkback_active',
        // Which plugin editor the UI has open — drives the engine's
        // per-plugin in/out metering (the `fx` key on `metering`).
        'fx_focus',
        // Restart the Master integrated-loudness measurement.
        'lufs_reset',
        // Plugin-chain structure — engine applies these to the live
        // insert_chain (see engine/src/main.cpp's PluginCmd); the server
        // just forwards, same trust model as the params/bypass types above.
        'add_plugin', 'remove_plugin', 'reorder_plugin', 'replace_plugin', 'load_rack'
      ];
      if (data.type === 'save_scene') {
        const safeName = data.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        fs.writeFileSync(path.join(SCENES_DIR, `${safeName}.json`), JSON.stringify(data.state, null, 2));
        const scenes = fs.readdirSync(SCENES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        connectedWsClients.forEach(c => {
           if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'scenes_list', scenes }));
        });
      } else if (data.type === 'list_scenes') {
        const scenes = fs.readdirSync(SCENES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        ws.send(JSON.stringify({ type: 'scenes_list', scenes }));
      } else if (data.type === 'load_scene') {
        const safeName = data.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const p = path.join(SCENES_DIR, `${safeName}.json`);
        if (fs.existsSync(p)) {
          const state = JSON.parse(fs.readFileSync(p, 'utf8'));
          ws.send(JSON.stringify({ type: 'scene_data', state, name: data.name }));
        }
      } else if (data.type === 'save_rack_preset') {
        if (!Array.isArray(data.plugins)) {
          console.error('Rejected save_rack_preset: plugins is not an array');
        } else {
          const safeName = String(data.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
          // Only the fields a rack preset actually needs — never the
          // per-instance runtime `id` (a fresh UUID gets assigned wherever
          // this preset is loaded next).
          const plugins = data.plugins.map((p: any) => ({
            uri: p.uri,
            name: p.name,
            enabled: p.enabled !== false,
            params: (p.params && typeof p.params === 'object') ? p.params : {}
          }));
          fs.writeFileSync(path.join(RACK_PRESETS_DIR, `${safeName}.json`), JSON.stringify(plugins, null, 2));
          const presets = fs.readdirSync(RACK_PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
          connectedWsClients.forEach(c => {
             if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'rack_presets_list', presets }));
          });
        }
      } else if (data.type === 'list_rack_presets') {
        const presets = fs.readdirSync(RACK_PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        ws.send(JSON.stringify({ type: 'rack_presets_list', presets }));
      } else if (data.type === 'delete_rack_preset') {
        const safeName = String(data.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        const p = path.join(RACK_PRESETS_DIR, `${safeName}.json`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        const presets = fs.readdirSync(RACK_PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        connectedWsClients.forEach(c => {
           if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'rack_presets_list', presets }));
        });
      } else if (data.type === 'load_rack_preset') {
        const safeName = String(data.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        const p = path.join(RACK_PRESETS_DIR, `${safeName}.json`);
        if (fs.existsSync(p)) {
          const plugins = JSON.parse(fs.readFileSync(p, 'utf8'));
          ws.send(JSON.stringify({ type: 'rack_preset_data', plugins, name: data.name }));
        }
      } else if (data.type === 'sync_patchbay_matrix') {
        const merged = mergePatchbayMappings(data.mappings);
        fs.writeFileSync(PATCHBAY_CONFIG_PATH, JSON.stringify(merged));

        const mergedOutputs = mergeOutputRouting(data.outputs);
        fs.writeFileSync(OUTPUT_ROUTING_PATH, JSON.stringify(mergedOutputs));

        // Sequenced, not concurrent: both touch AES67_Deck ports via
        // pw-link, and an output endpoint could in principle coincide with
        // one of the engine's own input ports, so run them one at a time
        // rather than racing two independent pw-link sweeps.
        (async () => {
          await handlePatchbaySync(merged);
          await applyOutputRouting(mergedOutputs);
          await applyMonitorRouting();
          await applyBroadcastRouting();
        })();
      } else if (data.type === 'sync_talkback_config') {
        const sourcePorts = Array.isArray(data.sourcePorts) ? data.sourcePorts.filter((p: any) => typeof p === 'string') : [];
        const filteredDestBusIds = Array.isArray(data.destBusIds) ? data.destBusIds.filter((id: any) => isValidTalkbackDest(id)) : [];
        const destBusIds = filteredDestBusIds.length > 0 ? filteredDestBusIds : getTalkbackConfig().destBusIds;
        const micSourceName = typeof data.micSourceName === 'string' ? data.micSourceName : null;
        const micAlsaPortName = typeof data.micAlsaPortName === 'string' ? data.micAlsaPortName : null;
        const cfg: TalkbackConfig = { sourcePorts, destBusIds, micSourceName, micAlsaPortName };
        fs.writeFileSync(TALKBACK_CONFIG_PATH, JSON.stringify(cfg));

        (async () => {
          await applyTalkbackRouting(cfg);
          if (engineSocket) {
            engineSocket.write(JSON.stringify({ type: 'set_talkback_dest', channel: TALKBACK_ID, busId: talkbackDestMask(destBusIds) }) + '\n');
          }
        })();

        const loadedMsg = JSON.stringify({ type: 'talkback_config_loaded', ...cfg });
        connectedWsClients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) c.send(loadedMsg);
        });
      } else if (data.type === 'daemon_create_sink') {
        // Receive an AES67 stream: create a daemon Sink from a discovered
        // remote's SDP (or a pasted one), and hand it a contiguous block of
        // AES67_Source capture channels (0..31) sized to the stream's channel
        // count. reconcileRxSinks() re-asserts the block after a daemon
        // restart; the block is persisted in rx_sinks.json.
        runDaemonOp(async () => {
          const sinkId = lowestFreeDaemonId(lastDaemonState.sinks);
          if (sinkId < 0) { console.error('daemon_create_sink: no free sink id'); return; }
          const sdp = typeof data.sdp === 'string' ? data.sdp : '';
          const source = typeof data.source === 'string' ? data.source : '';
          const channels = Array.isArray(data.map) && data.map.length > 0
            ? data.map.length : sdpChannelCount(sdp);
          const assignments = getRxSinkAssignments();
          const base = allocateCaptureBlock(channels, assignments, lastDaemonState.sinks);
          if (base < 0) {
            console.error(`daemon_create_sink: no ${channels}-ch capture block free (0..${RX_CAPTURE_CHANNELS - 1})`);
            return;
          }
          const map = Array.from({ length: channels }, (_, i) => base + i);
          const name = String(data.name || `Deck Sink ${sinkId}`);
          // ignore_refclk_gmid defaults true: the daemon's SDP parser rejects
          // (400 "cannot parse SDP") any stream whose a=ts-refclk gmid doesn't
          // match the daemon's current PTP grandmaster — which is every stream
          // whenever we're not yet locked to the same GM. The existing
          // appliance sink is configured the same way.
          const body = {
            name,
            io: 'Audio Device',
            use_sdp: true,
            source,
            sdp,
            delay: typeof data.delay === 'number' ? data.delay : 384,
            ignore_refclk_gmid: data.ignore_refclk_gmid !== false,
            map
          };
          const res = await daemonRequest('PUT', `/api/sink/${sinkId}`, body);
          if (!res.ok) { console.error(`daemon_create_sink failed (${res.status})`, res.json); return; }
          assignments.push({ sinkId, streamName: name, address: sdpAddress(sdp), captureBase: base, channels });
          saveRxSinkAssignments(assignments);
          await refreshDaemonState();
        });
      } else if (data.type === 'daemon_delete_sink') {
        runDaemonOp(async () => {
          const id = Number(data.id);
          if (!Number.isInteger(id)) return;
          const res = await daemonRequest('DELETE', `/api/sink/${id}`);
          if (!res.ok) console.error(`daemon_delete_sink failed (${res.status})`, res.json);
          saveRxSinkAssignments(getRxSinkAssignments().filter((a) => a.sinkId !== id));
          await refreshDaemonState();
        });
      } else if (data.type === 'set_tx_source') {
        // Phase 2: enable/disable/rename one of the 4 fixed transmit groups.
        // Persist the override then converge the daemon.
        runDaemonOp(async () => {
          const key = String(data.key || '');
          if (!TX_SOURCE_PLAN.some((g) => g.key === key)) {
            console.error(`set_tx_source: unknown group ${JSON.stringify(data.key)}`);
            return;
          }
          const prefs = getTxSourcePrefs();
          if (typeof data.enabled === 'boolean') prefs[key].enabled = data.enabled;
          if (typeof data.name === 'string' && data.name.trim()) prefs[key].name = data.name.trim();
          saveTxSourcePrefs(prefs);
          if (lastDaemonState.reachable) await reconcileTxSources(lastDaemonState.sources);
          await refreshDaemonState();
        });
      } else if (data.type === 'daemon_create_source') {
        // Transmit: create a daemon Source that reads `map` ALSA playback
        // channels (fed by the engine via pw-link in Phase 2) and sends RTP.
        runDaemonOp(async () => {
          const id = lowestFreeDaemonId(lastDaemonState.sources);
          if (id < 0) { console.error('daemon_create_source: no free source id'); return; }
          const map = Array.isArray(data.map) && data.map.length > 0
            ? data.map.map((n: any) => Number(n)) : [0, 1];
          const body = {
            enabled: true,
            name: String(data.name || `Deck Source ${id}`),
            io: 'Audio Device',
            map,
            max_samples_per_packet: 48,
            codec: 'L24',
            address: typeof data.address === 'string' ? data.address : '',
            ttl: 15,
            payload_type: 98,
            dscp: 34,
            refclk_ptp_traceable: false
          };
          const res = await daemonRequest('PUT', `/api/source/${id}`, body);
          if (!res.ok) console.error(`daemon_create_source failed (${res.status})`, res.json);
          await refreshDaemonState();
        });
      } else if (data.type === 'daemon_update_source') {
        // Re-PUT an existing Source with the live config merged over the patch
        // (the daemon has no PATCH — every field must be present).
        runDaemonOp(async () => {
          const id = Number(data.id);
          if (!Number.isInteger(id)) return;
          const current = lastDaemonState.sources.find((s: any) => Number(s.id) === id);
          if (!current) { console.error(`daemon_update_source: unknown source ${id}`); return; }
          const { type: _t, id: _i, ...patch } = data;
          const body = {
            enabled: current.enabled,
            name: current.name,
            io: current.io || 'Audio Device',
            map: current.map,
            max_samples_per_packet: current.max_samples_per_packet ?? 48,
            codec: current.codec || 'L24',
            address: current.address || '',
            ttl: current.ttl ?? 15,
            payload_type: current.payload_type ?? 98,
            dscp: current.dscp ?? 34,
            refclk_ptp_traceable: current.refclk_ptp_traceable ?? false,
            ...patch
          };
          const res = await daemonRequest('PUT', `/api/source/${id}`, body);
          if (!res.ok) console.error(`daemon_update_source failed (${res.status})`, res.json);
          await refreshDaemonState();
        });
      } else if (data.type === 'daemon_delete_source') {
        runDaemonOp(async () => {
          const id = Number(data.id);
          if (!Number.isInteger(id)) return;
          const res = await daemonRequest('DELETE', `/api/source/${id}`);
          if (!res.ok) console.error(`daemon_delete_source failed (${res.status})`, res.json);
          await refreshDaemonState();
        });
      } else if (data.type === 'daemon_set_ptp') {
        runDaemonOp(async () => {
          const domain = Number(data.domain);
          const dscp = Number(data.dscp);
          if (!Number.isInteger(domain) || !Number.isInteger(dscp)) return;
          const res = await daemonRequest('POST', '/api/ptp/config', { domain, dscp });
          if (!res.ok) console.error(`daemon_set_ptp failed (${res.status})`, res.json);
          await refreshDaemonState();
        });
      } else if (data.type && allowedTypes.includes(data.type)) {
        // Intercept mixer state changes: update in-memory snapshot, persist
        // to disk (debounced), and fan-out to all other connected clients.
        const ch = String(data.channel);
        if (data.type === 'set_fader' && typeof data.channel === 'number') {
          if (!mixerState[ch]) mixerState[ch] = {};
          // Prefer faderPosition (normalised 0..1 UI value) added by the
          // UI store; fall back to raw amplitude value if absent.
          mixerState[ch].fader = typeof data.faderPosition === 'number' ? data.faderPosition : data.value;
          saveMixerState();
        } else if (data.type === 'set_pan' && typeof data.channel === 'number') {
          if (!mixerState[ch]) mixerState[ch] = {};
          mixerState[ch].pan = data.value;
          saveMixerState();
        } else if (data.type === 'set_mute' && typeof data.channel === 'number') {
          if (!mixerState[ch]) mixerState[ch] = {};
          mixerState[ch].mute = !!data.value;
          saveMixerState();
        } else if (data.type === 'set_solo' && typeof data.channel === 'number') {
          if (!mixerState[ch]) mixerState[ch] = {};
          mixerState[ch].solo = !!data.value;
          saveMixerState();
        } else if (data.type === 'set_aux_send' && typeof data.channel === 'number') {
          if (!mixerState[ch]) mixerState[ch] = {};
          if (!mixerState[ch].auxSends) mixerState[ch].auxSends = {};
          mixerState[ch].auxSends![String(data.busId)] = data.value;
          saveMixerState();
          console.log('Forwarding set_aux_send to IPC:', payloadStr);
        }
        // Forward to engine
        if (engineSocket) {
          engineSocket.write(payloadStr + '\n');
        }
        // Broadcast to all OTHER clients for live multi-client sync.
        connectedWsClients.forEach(other => {
          if (other !== ws && other.readyState === WebSocket.OPEN) {
            other.send(payloadStr);
          }
        });
      }
    } catch (e) {
      // Invalid JSON or format, drop it
    }
  });
});

// Set up Unix Domain Socket Server for C++ Engine
if (fs.existsSync(SOCKET_PATH)) {
  fs.unlinkSync(SOCKET_PATH);
}

let engineSocket: net.Socket | null = null;

const ipcServer = net.createServer((socket) => {
  if (engineSocket) {
    console.log('Replacing existing C++ Engine IPC connection');
    engineSocket.destroy();
  }
  console.log('C++ Engine connected via IPC');
  engineSocket = socket;

  // The engine is a JACK client: anything that restarts the JACK server out
  // from under it (e.g. `systemctl restart pipewire`) kills its process
  // (JackClient's shutdown callback calls std::exit) and every pw-link it
  // held. A fresh engine process comes back with a blank port graph, and
  // nothing was re-driving pw-link against it — the UI's "Apply" is what
  // normally does that, but only on demand. Re-apply everything persisted
  // to disk on every (re)connect so the signal chain self-heals whether
  // this is the first boot or a recovery, with no manual step required.
  (async () => {
    await handlePatchbaySync(getPatchbayMappings());
    await applyOutputRouting(getOutputRouting());
    await applyMonitorRouting();
    await applyBroadcastRouting();
    const talkbackCfg = getTalkbackConfig();
    await applyTalkbackRouting(talkbackCfg);
    // applyTalkbackRouting only wires the mic source side (pw-link); the
    // destination mask lives in the engine's own TalkbackState and defaults
    // to Master-only on a fresh process, so it needs resending explicitly
    // or a recovered engine would silently diverge from what's persisted.
    if (engineSocket) {
      engineSocket.write(JSON.stringify({ type: 'set_talkback_dest', channel: TALKBACK_ID, busId: talkbackDestMask(talkbackCfg.destBusIds) }) + '\n');
    }
    // Restore fader/pan/mute/solo/aux positions to the engine from the
    // persisted mixer_state.json so it resumes at the right levels.
    const restoreLines = buildEngineRestoreCommands();
    for (const line of restoreLines) {
      if (engineSocket) engineSocket.write(line + '\n');
    }
    if (restoreLines.length > 0) {
      console.log(`Mixer state restored to engine: ${restoreLines.length} commands sent.`);
    }
    console.log('Routing re-applied after engine (re)connect');
  })();

  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim().length > 0) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'plugin_list' && Array.isArray(parsed.plugins)) {
            lastPluginCatalog = parsed.plugins;
          }
        } catch {
          // Not JSON or not a message we care about caching; still forward below.
        }
        connectedWsClients.forEach(ws => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(line);
          }
        });
      }
    }
  });

  socket.on('end', () => {
    if (engineSocket === socket) {
      console.log('C++ Engine disconnected');
      engineSocket = null;
    }
  });

  socket.on('error', (err) => {
    console.error('IPC Socket error:', err.message);
    if (engineSocket === socket) engineSocket = null;
  });
});

ipcServer.listen(SOCKET_PATH, () => {
  console.log(`IPC Server listening on ${SOCKET_PATH}`);
});

// Full routing (patchbay + output endpoints + Monitor + Talkback) is now
// re-applied from the "C++ Engine connected via IPC" handler above on every
// engine (re)connect, which covers both first boot and recovery after the
// engine restarts — see the comment there.

// --- aes67-linux-daemon control proxy ---
// The daemon is control-plane only: it configures the RAVENNA kernel module
// over netlink and does SAP/mDNS discovery, and is never in the audio path.
// Everything it does is reachable through its REST API, so the deck drives it
// directly (PTP, Sinks to receive streams, transmit Sources) instead of the
// operator opening the separate daemon WebUI on :8080. We poll a full snapshot
// of daemon state every 5s and broadcast it as `daemon_state`; a handful of
// write commands come back over the same WS the UI already uses.
//
// The pre-existing Output-Endpoints feature ("AES67 destinations" — feed a bus
// into a configured Source to transmit it) still consumes a derived
// `daemon_destinations_loaded` message, kept emitted below unchanged.
const DAEMON_BASE_URL = process.env.AES67_DAEMON_URL || 'http://localhost:8080';
const DAEMON_POLL_INTERVAL_MS = 5000;

interface DaemonDestination {
  name: string;
  address: string;
}

interface DaemonRequestResult {
  ok: boolean;
  status: number;
  json: any;
}

// Generic daemon REST call. Never throws — a dead daemon, a timeout, or a
// non-JSON body all resolve to { ok:false, status:0, json:null } so callers
// stay branch-free.
function daemonRequest(method: string, apiPath: string, body?: unknown): Promise<DaemonRequestResult> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let url: URL;
    try {
      url = new URL(apiPath, DAEMON_BASE_URL);
    } catch {
      resolve({ ok: false, status: 0, json: null });
      return;
    }
    const req = http.request(url, {
      method,
      timeout: 2000,
      headers: payload === undefined ? undefined : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        const ok = status >= 200 && status < 300;
        let json: any = null;
        if (raw.trim().length > 0) {
          try { json = JSON.parse(raw); } catch { json = null; }
        }
        resolve({ ok, status, json });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, json: null }); });
    req.on('error', () => resolve({ ok: false, status: 0, json: null }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

interface DaemonState {
  reachable: boolean;
  config: any;
  ptp: any;
  sources: any[];
  sinks: any[];
  remote: any[];
}

let lastDaemonState: DaemonState = {
  reachable: false, config: null, ptp: null, sources: [], sinks: [], remote: []
};
let lastDaemonDestinations: DaemonDestination[] = [];
let daemonReachable = false;

// Lowest integer id in 0..63 not already taken by an existing source/sink,
// matching how the daemon WebUI allocates them. -1 if all 64 are in use.
function lowestFreeDaemonId(items: any[]): number {
  const used = new Set((items || []).map((i) => Number(i.id)));
  for (let i = 0; i <= 63; i++) {
    if (!used.has(i)) return i;
  }
  return -1;
}

function broadcastToClients(msg: string) {
  connectedWsClients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// Multicast address from an SDP connection line, for display / persistence.
function sdpAddress(sdp: string): string {
  const m = /c=IN IP4 ([0-9.]+)/.exec(sdp || '');
  return m ? m[1] : '';
}

// ===========================================================================
// Phase 2 — network I/O for the mix (plan/unified-aes67-network-control.md).
// No engine change: the 20 mix-product ports already exist; this pins the
// engine->AES67_Sink link map, auto-provisions the transmit Sources, and
// auto-allocates AES67_Source capture channels to subscribed Sinks.
// ===========================================================================

// --- Transmit: 4 fixed Source groups, each reading a block of AES67_Sink
//     playout channels the engine is pinned to (see applyBroadcastRouting). ---
interface TxSourceGroup {
  key: string;
  defaultName: string;
  map: number[];          // 0-indexed AES67_Sink playout channels
  enginePorts: string[];  // AES67_Deck output ports feeding those channels, in order
}

const TX_SOURCE_PLAN: TxSourceGroup[] = [
  { key: 'master',  defaultName: 'Deck Master',  map: [0, 1],
    enginePorts: ['out_L', 'out_R'] },
  { key: 'monitor', defaultName: 'Deck Monitor', map: [2, 3],
    enginePorts: ['monitor_L', 'monitor_R'] },
  { key: 'aux1-4',  defaultName: 'Deck AUX 1-4', map: [4, 5, 6, 7, 8, 9, 10, 11],
    enginePorts: ['bus_101_L', 'bus_101_R', 'bus_102_L', 'bus_102_R',
                  'bus_103_L', 'bus_103_R', 'bus_104_L', 'bus_104_R'] },
  { key: 'aux5-8',  defaultName: 'Deck AUX 5-8', map: [12, 13, 14, 15, 16, 17, 18, 19],
    enginePorts: ['bus_105_L', 'bus_105_R', 'bus_106_L', 'bus_106_R',
                  'bus_107_L', 'bus_107_R', 'bus_108_L', 'bus_108_R'] }
];

// sourceId: the daemon Source id this group currently owns (null = none). It's
// the identity used for reconcile so a rename PUTs in place instead of
// orphaning the old-named Source. Name is only a fallback match (adopts a
// Source left over from a daemon restart / an earlier server version).
interface TxSourcePref { enabled: boolean; name: string; sourceId: number | null; }
type TxSourcePrefs = Record<string, TxSourcePref>;

// Operator overrides, per group. Default: every group disabled — the operator
// enables them incrementally (Phase 2 caveat: watch PTP offset / xruns).
function getTxSourcePrefs(): TxSourcePrefs {
  const prefs: TxSourcePrefs = {};
  for (const g of TX_SOURCE_PLAN) prefs[g.key] = { enabled: false, name: g.defaultName, sourceId: null };
  try {
    if (fs.existsSync(TX_SOURCES_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TX_SOURCES_PATH, 'utf8'));
      for (const g of TX_SOURCE_PLAN) {
        const v = raw?.[g.key];
        if (v && typeof v === 'object') {
          if (typeof v.enabled === 'boolean') prefs[g.key].enabled = v.enabled;
          if (typeof v.name === 'string' && v.name.trim()) prefs[g.key].name = v.name.trim();
          if (Number.isInteger(v.sourceId)) prefs[g.key].sourceId = v.sourceId;
        }
      }
    }
  } catch (e) {
    console.error('Error reading tx_sources.json, using defaults', e);
  }
  return prefs;
}

function saveTxSourcePrefs(prefs: TxSourcePrefs) {
  fs.writeFileSync(TX_SOURCES_PATH, JSON.stringify(prefs, null, 2));
}

// Converge the daemon's transmit Sources to the enabled TX groups. Each group
// owns one Source, tracked by id (name is a fallback for adoption). Returns
// true if it issued any PUT/DELETE (so the caller re-fetches before broadcast).
async function reconcileTxSources(daemonSources: any[]): Promise<boolean> {
  const prefs = getTxSourcePrefs();
  let changed = false;
  let prefsDirty = false;

  for (const g of TX_SOURCE_PLAN) {
    const pref = prefs[g.key];
    let existing = pref.sourceId != null
      ? daemonSources.find((s: any) => Number(s.id) === pref.sourceId)
      : undefined;
    if (!existing) existing = daemonSources.find((s: any) => s.name === pref.name);

    if (pref.enabled) {
      const mapOk = existing && Array.isArray(existing.map) &&
        existing.map.length === g.map.length &&
        existing.map.every((v: number, i: number) => v === g.map[i]);
      const ok = existing && mapOk && existing.enabled === true && existing.name === pref.name;
      const id = existing ? Number(existing.id)
        : (pref.sourceId != null && !daemonSources.some((s: any) => Number(s.id) === pref.sourceId)
          ? pref.sourceId : lowestFreeDaemonId(daemonSources));
      if (id !== pref.sourceId) { pref.sourceId = id; prefsDirty = true; }
      if (ok) continue;
      if (id < 0) { console.error(`reconcileTxSources: no free source id for ${g.key}`); continue; }
      const body = {
        enabled: true, name: pref.name, io: 'Audio Device', map: g.map,
        max_samples_per_packet: 48, codec: 'L24', address: existing?.address || '',
        ttl: 15, payload_type: 98, dscp: 34, refclk_ptp_traceable: false
      };
      const res = await daemonRequest('PUT', `/api/source/${id}`, body);
      if (res.ok) changed = true;
      else console.error(`reconcileTxSources PUT ${g.key} failed (${res.status})`, res.json);
    } else {
      if (existing) {
        const res = await daemonRequest('DELETE', `/api/source/${existing.id}`);
        if (res.ok) changed = true;
        else console.error(`reconcileTxSources DELETE ${g.key} failed (${res.status})`, res.json);
      }
      if (pref.sourceId != null) { pref.sourceId = null; prefsDirty = true; }
    }
  }

  if (prefsDirty) saveTxSourcePrefs(prefs);
  return changed;
}

// Resolved per-group TX state for the UI.
function resolveTxSources(daemonSources: any[], ptpLocked: boolean) {
  const prefs = getTxSourcePrefs();
  return TX_SOURCE_PLAN.map((g) => {
    const pref = prefs[g.key];
    const live = (pref.sourceId != null && daemonSources.find((s: any) => Number(s.id) === pref.sourceId))
      || daemonSources.find((s: any) => s.name === pref.name);
    return {
      key: g.key,
      name: pref.name,
      enabled: pref.enabled,
      channels: g.map.length,
      address: live?.address || '',
      present: !!live,
      running: !!live && live.enabled === true && ptpLocked
    };
  });
}

// --- Receive: allocate a contiguous AES67_Source capture-channel block to
//     each subscribed Sink, and keep the daemon's sink `map` matching it. ---
const RX_CAPTURE_CHANNELS = 32;

interface RxSinkAssignment {
  sinkId: number;
  streamName: string;
  address: string;
  captureBase: number;
  channels: number;
}

function getRxSinkAssignments(): RxSinkAssignment[] {
  try {
    if (fs.existsSync(RX_SINKS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(RX_SINKS_PATH, 'utf8'));
      if (Array.isArray(raw)) {
        return raw.filter((a: any) =>
          a && Number.isInteger(a.sinkId) && Number.isInteger(a.captureBase) &&
          Number.isInteger(a.channels) && a.channels > 0);
      }
    }
  } catch (e) {
    console.error('Error reading rx_sinks.json, starting fresh', e);
  }
  return [];
}

function saveRxSinkAssignments(list: RxSinkAssignment[]) {
  fs.writeFileSync(RX_SINKS_PATH, JSON.stringify(list, null, 2));
}

// Lowest capture channel where `count` contiguous channels are free. Counts
// both our persisted blocks and the live `map` of every current daemon sink
// (a sink configured outside the deck, e.g. the pre-existing appliance sink,
// still occupies capture channels). -1 if it won't fit in 0..N-1.
function allocateCaptureBlock(count: number, assignments: RxSinkAssignment[], daemonSinks: any[]): number {
  const used = new Array(RX_CAPTURE_CHANNELS).fill(false);
  const mark = (start: number, len: number) => {
    for (let i = start; i < start + len && i < RX_CAPTURE_CHANNELS; i++) used[i] = true;
  };
  for (const a of assignments) mark(a.captureBase, a.channels);
  for (const s of daemonSinks || []) {
    if (Array.isArray(s.map)) for (const ch of s.map) if (Number.isInteger(ch)) used[ch] = true;
  }
  for (let base = 0; base + count <= RX_CAPTURE_CHANNELS; base++) {
    if (!used.slice(base, base + count).some(Boolean)) return base;
  }
  return -1;
}

// Channel count from an SDP's first audio rtpmap ("...L24/48000/8").
function sdpChannelCount(sdp: string): number {
  const m = /a=rtpmap:\d+\s+[A-Za-z0-9]+\/\d+\/(\d+)/.exec(sdp || '');
  return m ? Math.max(1, Number(m[1])) : 2;
}

// AES67_Source capture ports a sink's live map resolves to, for the UI.
function sinkCapturePorts(sink: any): string[] {
  if (!Array.isArray(sink.map)) return [];
  return sink.map.map((n: number) => `AES67_Source:capture_AUX${n}`);
}

// After each poll: drop assignments whose sink is gone, and re-PUT any sink
// whose live `map` drifted from its persisted block (covers a daemon restart
// that reloaded sinks with different maps). Returns true if it issued a PUT.
async function reconcileRxSinks(daemonSinks: any[]): Promise<boolean> {
  const assignments = getRxSinkAssignments();
  const liveIds = new Set(daemonSinks.map((s: any) => Number(s.id)));
  const kept = assignments.filter((a) => liveIds.has(a.sinkId));
  if (kept.length !== assignments.length) saveRxSinkAssignments(kept);

  let changed = false;
  for (const a of kept) {
    const live = daemonSinks.find((s: any) => Number(s.id) === a.sinkId);
    if (!live) continue;
    const want = Array.from({ length: a.channels }, (_, i) => a.captureBase + i);
    const mapOk = Array.isArray(live.map) && live.map.length === want.length &&
      live.map.every((v: number, i: number) => v === want[i]);
    if (mapOk) continue;
    const body = {
      name: live.name, io: live.io || 'Audio Device', use_sdp: !!live.use_sdp,
      source: live.source || '', sdp: live.sdp || '',
      delay: typeof live.delay === 'number' ? live.delay : 384,
      ignore_refclk_gmid: live.ignore_refclk_gmid !== false, map: want
    };
    const res = await daemonRequest('PUT', `/api/sink/${a.sinkId}`, body);
    if (res.ok) changed = true;
    else console.error(`reconcileRxSinks PUT sink ${a.sinkId} failed (${res.status})`, res.json);
  }
  return changed;
}

// All daemon-mutating work (WS handlers + the periodic reconcile) runs through
// this single promise chain, so two commands — or a command racing the 5s
// poll — can never both allocate the same source id / capture block off a
// stale snapshot.
let daemonOpChain: Promise<unknown> = Promise.resolve();
function runDaemonOp<T>(fn: () => Promise<T>): Promise<T> {
  const result = daemonOpChain.then(fn, fn);
  daemonOpChain = result.catch(() => undefined);
  return result;
}

// The enriched `daemon_state` payload — daemon snapshot plus per-Sink
// capturePorts and resolved txSources. Used by the poll and the WS greeting.
function daemonStateMessage() {
  const ptpLocked = lastDaemonState.ptp?.status === 'locked';
  return {
    type: 'daemon_state',
    ...lastDaemonState,
    sinks: lastDaemonState.sinks.map((s: any) => ({ ...s, capturePorts: sinkCapturePorts(s) })),
    txSources: resolveTxSources(lastDaemonState.sources, ptpLocked)
  };
}

// Fetch a fresh daemon snapshot, converge it to persisted intent, and
// broadcast. NOT self-locking — always call via pollDaemonState() (interval)
// or inside a runDaemonOp() block (WS handlers), never bare.
async function refreshDaemonState() {
  const [configRes, ptpRes, sourcesRes, sinksRes, remoteRes] = await Promise.all([
    daemonRequest('GET', '/api/config'),
    daemonRequest('GET', '/api/ptp/status'),
    daemonRequest('GET', '/api/sources'),
    daemonRequest('GET', '/api/sinks'),
    daemonRequest('GET', '/api/browse/sources/all')
  ]);

  const reachable = configRes.ok || sourcesRes.ok;
  if (reachable !== daemonReachable) {
    console.log(reachable
      ? `Connected to aes67-linux-daemon at ${DAEMON_BASE_URL}`
      : `aes67-linux-daemon unreachable at ${DAEMON_BASE_URL} (daemon control paused)`);
    daemonReachable = reachable;
  }

  if (reachable) {
    lastDaemonState = {
      reachable: true,
      config: configRes.json ?? lastDaemonState.config,
      ptp: ptpRes.json ?? null,
      sources: Array.isArray(sourcesRes.json?.sources) ? sourcesRes.json.sources : [],
      sinks: Array.isArray(sinksRes.json?.sinks) ? sinksRes.json.sinks : [],
      remote: Array.isArray(remoteRes.json?.remote_sources) ? remoteRes.json.remote_sources : []
    };

    // Phase 2: converge the daemon to persisted intent (enabled TX groups,
    // per-Sink capture blocks). Re-fetch if anything moved so the broadcast
    // below reflects the converged state, not the pre-reconcile snapshot.
    const txChanged = await reconcileTxSources(lastDaemonState.sources);
    const rxChanged = await reconcileRxSinks(lastDaemonState.sinks);
    if (txChanged || rxChanged) {
      const [s2, k2] = await Promise.all([
        daemonRequest('GET', '/api/sources'),
        daemonRequest('GET', '/api/sinks')
      ]);
      if (Array.isArray(s2.json?.sources)) lastDaemonState.sources = s2.json.sources;
      if (Array.isArray(k2.json?.sinks)) lastDaemonState.sinks = k2.json.sinks;
    }

    lastDaemonDestinations = lastDaemonState.sources.map((s: any) => ({
      name: typeof s.name === 'string' && s.name ? s.name : `Source ${s.id}`,
      address: typeof s.address === 'string' ? s.address : ''
    }));
  } else {
    lastDaemonState = { ...lastDaemonState, reachable: false };
  }

  broadcastToClients(JSON.stringify(daemonStateMessage()));
  broadcastToClients(JSON.stringify({ type: 'daemon_destinations_loaded', destinations: lastDaemonDestinations, daemonReachable: reachable }));
}

function pollDaemonState() {
  return runDaemonOp(refreshDaemonState);
}

setInterval(pollDaemonState, DAEMON_POLL_INTERVAL_MS);
pollDaemonState();

// --- Local microphone discovery (Talkback source dropdown) ---
// Polls `pactl list sources` for real capture devices (not sink monitors),
// classified as builtin/USB/jack by device.bus / device.form_factor and,
// where a device exposes ALSA port-level jack sensing, an "available"
// external mic-jack port. Polling on an interval — rather than a one-shot
// scan — is what makes a USB mic "automatically" show up: PipeWire creates
// its node the moment it's plugged in, so the next cycle just sees it.
const MIC_POLL_INTERVAL_MS = 3000;

interface MicDevice {
  id: string;
  sourceName: string;
  // ALSA port id to activate via `pactl set-source-port` when this entry
  // represents a specific jack rather than "whatever ALSA already has
  // active" — see applyTalkbackRouting.
  alsaPortName: string | null;
  label: string;
  kind: 'builtin' | 'usb' | 'jack' | 'other';
  channels: number;
  ports: string[];
}

function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

async function listAllOutputPorts(): Promise<string[]> {
  const stdout = await runCmd('pw-link', ['-o']);
  return stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

interface PactlSource {
  name: string;
  description: string;
  props: Record<string, string>;
  channelMap: string[];
  ports: Array<{ id: string; desc: string; available: boolean | null }>;
}

// Parses the classic (non-JSON) `pactl list sources` text format. Written
// defensively: this box's only capture device runs ALSA's "pro audio"
// profile, which exposes no Ports:/jack-sensing block at all, so the
// per-port parsing here is unverified against real jack-sensing output — if
// it doesn't match a given system's exact wording, sources still come
// through with a base builtin/USB entry (see fetchMicDevices), only the
// extra jack-specific entries are lost.
function parsePactlSources(text: string): PactlSource[] {
  const chunks = text.split(/\nSource #\d+/).slice(1);
  const out: PactlSource[] = [];

  for (const block of chunks) {
    const nameM = block.match(/\n\tName: (.+)/);
    if (!nameM) continue;
    const descM = block.match(/\n\tDescription: (.+)/);
    const chMapM = block.match(/\n\tChannel Map: (.+)/);

    const props: Record<string, string> = {};
    const propsBlockM = block.match(/\n\tProperties:\n([\s\S]*?)(\n\t[A-Z][a-zA-Z ]*:|$)/);
    if (propsBlockM) {
      const re = /\n\t\t([\w.-]+) = "(.*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(propsBlockM[1]))) props[m[1]] = m[2];
    }

    const ports: PactlSource['ports'] = [];
    const portsBlockM = block.match(/\n\tPorts:\n([\s\S]*?)(\n\tActive Port:|\n\t[A-Z][a-zA-Z ]*:|$)/);
    if (portsBlockM) {
      const re = /\n\t\t([\w-]+): (.+?) \(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(portsBlockM[1]))) {
        const paren = m[3];
        let available: boolean | null = null;
        if (/not available/i.test(paren)) available = false;
        else if (/\bavailable\b/i.test(paren)) available = true;
        ports.push({ id: m[1], desc: m[2], available });
      }
    }

    out.push({
      name: nameM[1].trim(),
      description: descM ? descM[1].trim() : nameM[1].trim(),
      props,
      channelMap: chMapM ? chMapM[1].split(',').map(s => s.trim()).filter(Boolean) : [],
      ports
    });
  }

  return out;
}

async function fetchMicDevices(): Promise<MicDevice[]> {
  const [sourcesText, allOutputPorts] = await Promise.all([
    runCmd('pactl', ['list', 'sources']),
    listAllOutputPorts()
  ]);
  if (!sourcesText) return [];

  const sources = parsePactlSources(sourcesText);
  const devices: MicDevice[] = [];

  for (const s of sources) {
    if (s.props['device.class'] === 'monitor') continue;
    if (s.props['media.class'] !== 'Audio/Source') continue;

    const ports = allOutputPorts.filter(p => p.startsWith(`${s.name}:`));
    if (ports.length === 0) continue; // not actually wired into the PipeWire graph

    const bus = s.props['device.bus'];
    const formFactor = s.props['device.form_factor'];
    const isUsb = bus === 'usb';
    const isBuiltin = !isUsb && (formFactor === 'internal' || !bus || bus === 'pci' || bus === 'platform' || bus === 'isa');

    devices.push({
      id: s.name,
      sourceName: s.name,
      alsaPortName: null,
      label: isUsb ? `USB Microphone — ${s.description}` : `Built-in Microphone — ${s.description}`,
      kind: isUsb ? 'usb' : (isBuiltin ? 'builtin' : 'other'),
      channels: s.channelMap.length || 2,
      ports
    });

    // Any external mic-jack ALSA port this device exposes that's currently
    // sensed as plugged in becomes its own selectable entry — same
    // PipeWire graph ports, but picking it also switches ALSA's active
    // port (see applyTalkbackRouting).
    for (const p of s.ports) {
      const looksLikeMic = /mic/i.test(p.id) || /mic/i.test(p.desc);
      const looksInternal = /internal/i.test(p.id) || /internal/i.test(p.desc);
      if (looksLikeMic && !looksInternal && p.available === true) {
        devices.push({
          id: `${s.name}::${p.id}`,
          sourceName: s.name,
          alsaPortName: p.id,
          label: `Mic Jack — ${p.desc} (${s.description})`,
          kind: 'jack',
          channels: s.channelMap.length || 2,
          ports
        });
      }
    }
  }

  return devices;
}

let lastMicDevices: MicDevice[] = [];
// System LV2 plugin catalog, sent once by the engine at startup and cached
// here so it can be replayed to any UI client that connects afterward.
let lastPluginCatalog: any[] = [];

async function pollMicDevices() {
  lastMicDevices = await fetchMicDevices();
  const msg = JSON.stringify({ type: 'mic_devices_loaded', devices: lastMicDevices });
  connectedWsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

setInterval(pollMicDevices, MIC_POLL_INTERVAL_MS);
pollMicDevices();

// --- AES67 SAP Discovery ---
const SAP_PORT = 9875;
const SAP_MCAST_ADDR = '239.255.255.255';

const sapClient = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const sapDedupe = new Map<string, number>();

sapClient.on('listening', () => {
  try {
    sapClient.addMembership(SAP_MCAST_ADDR);
    console.log(`AES67 SAP Listener bound to ${SAP_MCAST_ADDR}:${SAP_PORT}`);
  } catch (err) {
    console.error(`Failed to add multicast membership. You may need a route for multicast traffic: ${err}`);
  }
});

sapClient.on('message', (message, rinfo) => {
  if (message.length < 4) return;

  // RFC 2974 SAP header parsing
  const v = message[0] >> 5;
  if (v !== 1) return; // Only SAP v1

  const a = (message[0] >> 4) & 1; // 0 = IPv4, 1 = IPv6
  const authLen = message[1];
  const ipLen = a === 0 ? 4 : 16;
  const headerLen = 4 + ipLen + (authLen * 4);

  if (message.length <= headerLen) return;

  const payload = message.toString('utf8', headerLen);
  const lines = payload.split(/[\r\n]+/);

  let streamName = 'Unknown Stream';
  const sLine = lines.find(l => l.startsWith('s='));
  if (sLine) streamName = sLine.substring(2).trim();

  // Deduplicate discovery updates (throttle to 1 update per 10s per stream)
  const dedupKey = `${rinfo.address}-${streamName}`;
  const now = Date.now();
  if (sapDedupe.has(dedupKey) && (now - (sapDedupe.get(dedupKey) || 0)) < 10000) {
    return;
  }
  sapDedupe.set(dedupKey, now);

  const discoveryMsg = JSON.stringify({
    type: 'aes67_discovery',
    name: streamName,
    address: rinfo.address
  });

  connectedWsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(discoveryMsg);
    }
  });
});

try {
  sapClient.bind(SAP_PORT);
} catch (e) {
  console.error("Failed to bind SAP port (might require root or cap_net_admin):", e);
}


// Merges an incoming (possibly partial) mapping payload on top of whatever is
// currently persisted, so a client that only touched one channel can never
// wipe out every other channel's routing. Also rejects any channel id that
// isn't a real channel number before it's written to disk.
function mergePatchbayMappings(incoming: any): Record<string, any> {
  let merged: Record<string, any> = {};
  try {
    if (fs.existsSync(PATCHBAY_CONFIG_PATH)) {
      merged = JSON.parse(fs.readFileSync(PATCHBAY_CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading existing patchbay config, starting fresh', e);
    merged = {};
  }

  if (!incoming || typeof incoming !== 'object') return merged;

  for (const rawChId in incoming) {
    const chId = Number(rawChId);
    if (!Number.isInteger(chId) || chId < 1 || chId > NUM_CHANNELS) {
      console.error(`Rejected invalid patchbay channel id in sync: ${JSON.stringify(rawChId)}`);
      continue;
    }
    merged[String(chId)] = incoming[rawChId];
  }

  return merged;
}

// The Monitor bus's fixed destination — "the system's audio out device" for
// the operator to hear locally. Not user-editable (Monitor never appears in
// output_routing.json); Master and the Aux buses have no forced default of
// their own and are freely mapped to any destination via Output Endpoints.
const HARDWARE_OUT_L = 'alsa_output.pci-0000_06_00.6.pro-output-0:playback_AUX0';
const HARDWARE_OUT_R = 'alsa_output.pci-0000_06_00.6.pro-output-0:playback_AUX1';

// A bus's output-endpoint assignment: the destination ports plus whether
// they carry an identical mono downmix rather than a distinct L/R pair.
// `mono` only means something when there are 2+ ports — a single-port
// endpoint is inherently mono either way, `mono` or not.
interface OutputEndpoint {
  ports: string[];
  mono?: boolean;
}

function isOutputEndpoint(v: any): v is OutputEndpoint {
  return v && typeof v === 'object' && Array.isArray(v.ports) && v.ports.every((p: any) => typeof p === 'string');
}

// Merges an incoming (possibly partial) output-endpoint payload for Master
// (100) and the 8 Aux buses (101..108) on top of whatever is currently
// persisted, so a client that only touched one bus can't wipe the rest.
function mergeOutputRouting(incoming: any): Record<string, OutputEndpoint> {
  let merged: Record<string, OutputEndpoint> = {};
  try {
    if (fs.existsSync(OUTPUT_ROUTING_PATH)) {
      const raw = JSON.parse(fs.readFileSync(OUTPUT_ROUTING_PATH, 'utf8'));
      for (const busId in raw) {
        const v = raw[busId];
        if (Array.isArray(v) && v.every((p: any) => typeof p === 'string')) {
          // Config written before mono output support existed — a bare
          // port list was always the stereo pairing.
          merged[busId] = { ports: v };
        } else if (isOutputEndpoint(v)) {
          merged[busId] = { ports: v.ports, mono: !!v.mono };
        }
      }
    }
  } catch (e) {
    console.error('Error reading existing output routing config, starting fresh', e);
    merged = {};
  }

  if (incoming && typeof incoming === 'object') {
    for (const rawBusId in incoming) {
      const busId = Number(rawBusId);
      if (!Number.isInteger(busId) || busId < MASTER_ID || busId > MASTER_ID + NUM_AUX) {
        console.error(`Rejected invalid output bus id in sync: ${JSON.stringify(rawBusId)}`);
        continue;
      }
      const entry = incoming[rawBusId];
      if (!isOutputEndpoint(entry)) {
        console.error(`Rejected invalid output endpoint for bus ${busId}`);
        continue;
      }
      if (entry.ports.length === 0) {
        // Explicit empty list clears this bus's assignment.
        delete merged[String(busId)];
      } else {
        merged[String(busId)] = { ports: entry.ports, mono: !!entry.mono };
      }
    }
  }

  return merged;
}

function getOutputRouting(): Record<string, OutputEndpoint> {
  return mergeOutputRouting(null);
}

function getPatchbayMappings(): Record<string, any> {
  return mergePatchbayMappings(null);
}

// Runs pw-link with an argv array (never a shell string) so no piece of a
// mapping can ever be interpreted as shell syntax. Failures (e.g. "link
// already exists" / "no such link") are expected and ignored.
function pwLink(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile('pw-link', args, () => resolve());
  });
}

function listPwLinks(): Promise<string> {
  return new Promise((resolve) => {
    execFile('pw-link', ['-l'], (err, stdout) => resolve(err ? '' : stdout));
  });
}

// Parses `pw-link -l` output (each output port listed as a bare line,
// followed by indented "|-> <input port>" lines for each of its current
// connections) to find who is currently feeding a given input port.
async function findLinksTo(inputPort: string): Promise<string[]> {
  const stdout = await listPwLinks();
  const sources: string[] = [];
  let currentOutput: string | null = null;
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    if (!/^\s/.test(rawLine)) {
      currentOutput = rawLine.trim();
    } else {
      const m = rawLine.match(/\|->\s*(.+)$/);
      if (m && currentOutput && m[1].trim() === inputPort) {
        sources.push(currentOutput);
      }
    }
  }
  return sources;
}

// Same idea in the other direction: finds what a given output port currently
// feeds.
async function findLinksFrom(outputPort: string): Promise<string[]> {
  const stdout = await listPwLinks();
  const dests: string[] = [];
  let capturing = false;
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    if (!/^\s/.test(rawLine)) {
      capturing = rawLine.trim() === outputPort;
    } else if (capturing) {
      const m = rawLine.match(/\|->\s*(.+)$/);
      if (m) dests.push(m[1].trim());
    }
  }
  return dests;
}

async function disconnectAllInputsOf(inputPort: string) {
  const sources = await findLinksTo(inputPort);
  for (const src of sources) {
    await pwLink(['-d', src, inputPort]);
  }
}

async function disconnectAllOutputsOf(outputPort: string) {
  const dests = await findLinksFrom(outputPort);
  for (const dest of dests) {
    await pwLink(['-d', outputPort, dest]);
  }
}

// Resolves which real PipeWire ports feed a channel mapping. Prefers the
// explicit `sourcePorts` the UI resolved from its stream registry (so any
// discovered/manual AES67 stream can be routed, not just one hardcoded
// name); falls back to the original hardcoded loopback for mapping entries
// persisted before per-stream ports existed.
function resolveSourcePorts(m: any): string[] | null {
  if (Array.isArray(m.sourcePorts) && m.sourcePorts.length > 0 && m.sourcePorts.every((p: any) => typeof p === 'string')) {
    return m.sourcePorts;
  }
  if (m.sourceStreamId === 'system-audio-loopback') {
    return ['AES67_System_Audio_Loopback:output_FL', 'AES67_System_Audio_Loopback:output_FR'];
  }
  return null;
}

async function handlePatchbaySync(mappings: any) {
  if (!mappings || typeof mappings !== 'object') return;

  for (let i = 1; i <= NUM_CHANNELS; i++) {
    await disconnectAllInputsOf(`AES67_Deck:in_${i}_L`);
    await disconnectAllInputsOf(`AES67_Deck:in_${i}_R`);
  }

  for (const rawChId in mappings) {
    // Channel ids are only ever used to build JACK/PipeWire port names
    // below, so reject anything that isn't a real channel number before
    // it touches a subprocess argument.
    const chId = Number(rawChId);
    if (!Number.isInteger(chId) || chId < 1 || chId > NUM_CHANNELS) {
      console.error(`Rejected invalid patchbay channel id: ${JSON.stringify(rawChId)}`);
      continue;
    }

    const m = mappings[rawChId];
    if (!m) continue;
    const ports = resolveSourcePorts(m);
    if (!ports) continue;

    const targetL = `AES67_Deck:in_${chId}_L`;
    const targetR = `AES67_Deck:in_${chId}_R`;

    if (m.sourceChannel === 0 && ports.length >= 2) {
      // Stereo mapping
      await pwLink([ports[0], targetL]);
      await pwLink([ports[1], targetR]);
    } else if (typeof m.sourceChannel === 'number' && m.sourceChannel >= 1) {
      const port = ports[m.sourceChannel - 1];
      if (port) {
        await pwLink([port, targetL]);
        await pwLink([port, targetR]); // mono to both
      }
    }
  }

  console.log('Patchbay matrix applied successfully');
}

// Applies Master (100) and each of the 8 Aux buses' (101..108) output
// endpoint assignment. Unlike Monitor, neither has a forced default — if
// nothing is assigned, that bus just isn't routed anywhere.
async function applyOutputRouting(routing: Record<string, OutputEndpoint>) {
  for (let busId = MASTER_ID; busId <= MASTER_ID + NUM_AUX; busId++) {
    const outL = busId === MASTER_ID ? 'AES67_Deck:out_L' : `AES67_Deck:bus_${busId}_L`;
    const outR = busId === MASTER_ID ? 'AES67_Deck:out_R' : `AES67_Deck:bus_${busId}_R`;

    await disconnectAllOutputsOf(outL);
    await disconnectAllOutputsOf(outR);

    const entry = routing[String(busId)];
    if (!entry || entry.ports.length === 0) continue;

    if (entry.mono) {
      // Mono: every destination port gets the identical downmix — both bus
      // channels feed each port, rather than a distinct L/R pairing.
      for (const p of entry.ports) {
        await pwLink([outL, p]);
        await pwLink([outR, p]);
      }
    } else if (entry.ports.length >= 2) {
      await pwLink([outL, entry.ports[0]]);
      await pwLink([outR, entry.ports[1]]);
    } else {
      await pwLink([outL, entry.ports[0]]);
      await pwLink([outR, entry.ports[0]]);
    }
  }

  console.log('Output routing applied successfully');
}

// Monitor's destination is fixed, not user-editable: it always goes to the
// system's local audio out device so the operator can hear the mix.
async function applyMonitorRouting() {
  await disconnectAllOutputsOf('AES67_Deck:monitor_L');
  await disconnectAllOutputsOf('AES67_Deck:monitor_R');
  await pwLink(['AES67_Deck:monitor_L', HARDWARE_OUT_L]);
  await pwLink(['AES67_Deck:monitor_R', HARDWARE_OUT_R]);
  console.log('Monitor routing applied successfully');
}

// Phase 2: pin each engine mix-product output port to its fixed AES67_Sink
// playout channel (TX_SOURCE_PLAN). Idempotent; only removes stale links from
// those engine ports to a *different* AES67_Sink channel — Output-Endpoint
// links target other nodes and are left alone. MUST run after
// applyOutputRouting / applyMonitorRouting in any block that also touches
// these ports: those do a blanket disconnectAllOutputsOf on out_/bus_/monitor_
// and would otherwise tear this map down.
async function applyBroadcastRouting() {
  for (const g of TX_SOURCE_PLAN) {
    for (let i = 0; i < g.enginePorts.length; i++) {
      const src = `AES67_Deck:${g.enginePorts[i]}`;
      const dst = `AES67_Sink:playback_AUX${g.map[i]}`;
      for (const d of await findLinksFrom(src)) {
        if (d.startsWith('AES67_Sink:') && d !== dst) await pwLink(['-d', src, d]);
      }
      await pwLink([src, dst]);
    }
  }
  console.log('Broadcast routing applied successfully');
}

// Wires the talkback mic's configured source ports to the engine's dedicated
// talkback_L/R input. This is the source side only — where the resulting
// audio goes (Master or an Aux bus, never Monitor) is the engine's own
// `talkback.dest_bus_id`, set via the `set_talkback_dest` IPC command.
async function applyTalkbackRouting(cfg: TalkbackConfig) {
  if (cfg.micSourceName && cfg.micAlsaPortName) {
    // The PipeWire graph ports (cfg.sourcePorts) are the same regardless of
    // which physical input is selected — switching to e.g. an external mic
    // jack instead of the internal mic is an ALSA-level routing choice on
    // the source itself, so it needs its own command.
    await new Promise<void>((resolve) => {
      execFile('pactl', ['set-source-port', cfg.micSourceName as string, cfg.micAlsaPortName as string], () => resolve());
    });
  }

  await disconnectAllInputsOf('AES67_Deck:talkback_L');
  await disconnectAllInputsOf('AES67_Deck:talkback_R');

  if (cfg.sourcePorts.length >= 2) {
    await pwLink([cfg.sourcePorts[0], 'AES67_Deck:talkback_L']);
    await pwLink([cfg.sourcePorts[1], 'AES67_Deck:talkback_R']);
  } else if (cfg.sourcePorts.length === 1) {
    await pwLink([cfg.sourcePorts[0], 'AES67_Deck:talkback_L']);
    await pwLink([cfg.sourcePorts[0], 'AES67_Deck:talkback_R']);
  }

  console.log('Talkback routing applied successfully');
}

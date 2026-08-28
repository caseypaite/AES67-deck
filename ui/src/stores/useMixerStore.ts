import { create } from 'zustand';
import { usePatchbayStore } from './usePatchbayStore';
import { useDawStore } from './useDawStore';
import { useLoudnessStore } from './useLoudnessStore';
import { calfDefaultParams } from '../data/calfPlugins';
import { uuid } from '../lib/uuid';
import { setWs } from '../lib/wsBus';
import { downloadText } from '../lib/download';

export interface PluginNode {
  id: string;
  name: string;
  uri: string;
  enabled: boolean;
  params: Record<string, number>;
}

export interface Channel {
  id: number;
  name: string;
  // 'monitor' is the dedicated operator Monitor bus: every input feeds it
  // automatically post-fader with no adjustable per-channel send (so it
  // never appears as a target in AuxSendsPanel, which only lists 'bus' +
  // Master), and its destination is fixed server-side, not user-editable.
  type: 'input' | 'master' | 'bus' | 'monitor';
  fader: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  arm: boolean;
  phase?: boolean;
  meterL: number;
  meterR: number;
  plugins: PluginNode[];
  auxSends: Record<number, number>;
}

// Fixed console topology (mirrors engine/src/main.cpp and server/src/index.ts
// exactly — see the Patchbay Talkback section for rationale): 32 source-only
// input channels, a Master output, 8 Aux output buses, and one dedicated
// Monitor bus. Not user-configurable.
export const NUM_CHANNELS = 32;
export const NUM_AUX = 8;
export const MASTER_ID = 100;
export const AUX_BASE = 101; // 101..108
export const MONITOR_ID = 109;
export const TALKBACK_ID = 110;

interface MixerState {
  channels: Record<number, Channel>;
  activeView: 'mixer' | 'daw' | 'patchbay';
  transportState: 'playing' | 'recording' | 'stopped';
  ws: WebSocket | null;
  selectedChannelId: number | null;

  setActiveView: (view: 'mixer' | 'daw' | 'patchbay') => void;
  setChannelValue: <K extends keyof Channel>(id: number, key: K, value: Channel[K]) => void;
  renameChannel: (id: number, name: string) => void;
  setAuxSend: (channelId: number, busId: number, level: number) => void;
  toggleTransport: (action: 'play' | 'stop' | 'record') => void;
  setSelectedChannel: (id: number | null) => void;

  addPlugin: (channelId: number, plugin: Omit<PluginNode, 'id' | 'params'> & Partial<Pick<PluginNode, 'params'>>) => void;
  removePlugin: (channelId: number, pluginId: string) => void;
  replacePlugin: (channelId: number, pluginId: string, newUri: string) => void;
  reorderPlugin: (channelId: number, startIndex: number, endIndex: number) => void;
  setPluginParam: (channelId: number, pluginId: string, paramKey: string, value: number) => void;
  setPluginEnabled: (channelId: number, pluginId: string, enabled: boolean) => void;

  // Per-plugin in/out level for the FX editor the operator currently has
  // open. The engine only meters the focused slot (announced via fx_focus),
  // and rides the result out on the `fx` key of the `metering` message.
  fxMeter: { channel: number; pluginIndex: number; inL: number; inR: number; outL: number; outR: number; rta?: number[] } | null;
  setFxFocus: (channelId: number | null, pluginIndex: number | null) => void;

  // ITU-R BS.1770 loudness on the Master output (engine `lufs` key):
  // momentary (400 ms), short-term (3 s), integrated (gated), true peak — LUFS/dBTP.
  lufs: { m: number; s: number; i: number; tp: number } | null;
  resetLufs: () => void;

  // Master-bus analyser for the mastering panel (engine `master` key):
  // log-spaced spectrum (dBFS), L/R correlation [-1,1], goniometer scatter.
  masterAnalysis: { rta: number[]; corr: number; gonio: number[] } | null;

  // Toolbar telemetry: box CPU/RAM (server `server_stats`), audio round-trip
  // latency (2 × engine block size / sample rate, from the metering frame).
  serverStats: { cpu: number | null; memUsedMB: number | null; memTotalMB: number | null } | null;
  audioLatencyMs: number | null;

  // Replace a channel's whole plugin chain (used by mastering presets).
  applyRack: (channelId: number, plugins: { uri: string; enabled?: boolean; params?: Record<string, number> }[]) => void;

  // Rack Manager: named, reusable FX chain presets — save the currently
  // selected channel's plugin list under a name, or load one onto it
  // (replacing whatever's there now, in both the UI and the live engine).
  rackPresets: string[];
  saveRackPreset: (channelId: number, name: string) => void;
  loadRackPreset: (name: string) => void;
  deleteRackPreset: (name: string) => void;
  listRackPresets: () => void;

  connectWebSocket: () => void;
  scenes: string[];
  deleteScene: (name: string) => void;

  // --- Virtual soundcheck (plan/daw-timeline-roadmap.md Phase 3a) ---
  // Per-channel monitor override: bit (id-1) set => channel id monitors its
  // LIVE input even while the timeline plays. Mirrors the engine's
  // g_monitor_input_mask; 0 = every channel follows the transport.
  monitorInputMask: number;
  setChannelMonitorInput: (id: number, live: boolean) => void;
  setAllMonitorInput: (live: boolean) => void;

  // One-button arming for a virtual soundcheck: arm every input channel that
  // has an AES67 source mapped in the patchbay (or disarm all inputs).
  armAllMappedInputs: () => void;
  disarmAllInputs: () => void;

  vscConfig: {
    autoRecord: boolean; splitOnMarker: boolean; minFreeGb: number;
    schedule: { enabled: boolean; at: string };
  };
  vscStatus: { diskLow: boolean; freeGb: number | null; message: string | null };
  setVscConfig: (patch: Partial<Omit<MixerState['vscConfig'], 'schedule'>> & { schedule?: Partial<MixerState['vscConfig']['schedule']> }) => void;
  vscSplit: () => void;

  // Full system LV2 plugin catalog for the FX Rack's "Add Effect" browser,
  // populated once from the engine's startup scan (plugin_list/plugin_list_loaded).
  availablePlugins: SystemPluginInfo[];
}

export const positionToDb = (y: number): number => {
  if (y >= 0.75) return 0 + ((y - 0.75) / 0.25) * 10;
  if (y >= 0.50) return -10 + ((y - 0.50) / 0.25) * 10;
  if (y >= 0.30) return -20 + ((y - 0.30) / 0.20) * 10;
  if (y >= 0.15) return -40 + ((y - 0.15) / 0.15) * 20;
  if (y > 0) return -100 + (y / 0.15) * 60;
  return -Infinity;
};

export const positionToAmplitude = (y: number): number => {
  if (y <= 0) return 0;
  const db = positionToDb(y);
  return Math.pow(10, db / 20);
};

export type PluginCategory = 'Saturation' | 'Dynamics' | 'De-Esser' | 'Equalizer' | 'Delay' | 'Reverb' | 'Limiter';

export interface PluginRegistryEntry {
  name: string;
  uri: string;
  category: PluginCategory;
  defaultParams: Record<string, number>;
}

// One plugin from the engine's full system LV2 scan (engine/src/plugins/Lv2Host,
// relayed via server's plugin_list/plugin_list_loaded messages). Distinct from
// PluginRegistryEntry: control ports come from the plugin's real LV2 metadata
// rather than a hand-curated param map, so symbols are used as param keys
// directly instead of going through the curated remap table.
export interface SystemPluginControlPort {
  symbol: string;
  name: string;
  min: number;
  max: number;
  default: number;
}

export interface SystemPluginInfo {
  uri: string;
  name: string;
  author: string;
  reportsLatency: boolean;
  controlPorts: SystemPluginControlPort[];
}

// Calf entries seed their full, real LV2 port set from data/calfPlugins.ts
// (symbols + defaults straight from the .ttl). LSP entries keep a rough
// hand map until they get the same treatment.
const calf = (name: string, uri: string, category: PluginCategory): PluginRegistryEntry => ({
  name, uri, category, defaultParams: calfDefaultParams(uri),
});

export const PLUGIN_REGISTRY: PluginRegistryEntry[] = [
  // Saturation
  calf('Calf Saturator', 'http://calf.sourceforge.net/plugins/Saturator', 'Saturation'),
  calf('Calf Crusher', 'http://calf.sourceforge.net/plugins/Crusher', 'Saturation'),
  { name: 'LSP Articulator', uri: 'http://lsp-plug.in/plugins/lv2/articulator_stereo', category: 'Saturation', defaultParams: { drive: 5, blend: 5, out: 5 } },

  // Dynamics
  { name: 'LSP Compressor', uri: 'http://lsp-plug.in/plugins/lv2/compressor_stereo', category: 'Dynamics', defaultParams: { threshold: -20, ratio: 4, attack: 20, release: 200, makeup: 0, mix: 100 } },
  calf('Calf Compressor', 'http://calf.sourceforge.net/plugins/Compressor', 'Dynamics'),

  // De-Esser
  calf('Calf De-Esser', 'http://calf.sourceforge.net/plugins/Deesser', 'De-Esser'),
  { name: 'LSP De-Esser', uri: 'http://lsp-plug.in/plugins/lv2/de_esser_stereo', category: 'De-Esser', defaultParams: { threshold: -20, freq: 6000, ratio: 3, out: 0 } },

  // Equalizer
  { name: 'LSP 8-Band EQ', uri: 'http://lsp-plug.in/plugins/lv2/para_equalizer_x8_stereo', category: 'Equalizer', defaultParams: { b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0, b7: 0, b8: 0 } },
  calf('Calf 8-Band EQ', 'http://calf.sourceforge.net/plugins/Equalizer8Band', 'Equalizer'),
  calf('Calf 5-Band EQ', 'http://calf.sourceforge.net/plugins/Equalizer5Band', 'Equalizer'),

  // Delay
  { name: 'LSP Delay', uri: 'http://lsp-plug.in/plugins/lv2/delay_stereo', category: 'Delay', defaultParams: { time_l: 250, time_r: 250, feedback: 30, mix: 20 } },
  calf('Calf Vintage Delay', 'http://calf.sourceforge.net/plugins/VintageDelay', 'Delay'),

  // Reverb
  calf('Calf Reverb', 'http://calf.sourceforge.net/plugins/Reverb', 'Reverb'),
  { name: 'LSP Room Builder', uri: 'http://lsp-plug.in/plugins/lv2/room_builder_stereo', category: 'Reverb', defaultParams: { decay: 2, high_cut: 5000, mix: 20, out: 0 } },

  // Limiter
  { name: 'LSP Limiter', uri: 'http://lsp-plug.in/plugins/lv2/limiter_stereo', category: 'Limiter', defaultParams: { limit: -0.1, threshold: -3, release: 50, gain: 0 } },
  calf('Calf Limiter', 'http://calf.sourceforge.net/plugins/Limiter', 'Limiter'),
];

// Channels, buses, and master all start with an empty effect rack. Users
// add plugins explicitly from the UI (PLUGIN_REGISTRY above).
const DEFAULT_RACK: Omit<PluginNode, 'id'>[] = [];

const generateDefaultRack = (): PluginNode[] => {
  return DEFAULT_RACK.map(p => ({
    ...p,
    id: uuid(),
    params: { ...p.params }
  }));
};

function newChannel(id: number, name: string, type: Channel['type'], auxSends: Record<number, number>): Channel {
  return {
    id, name, type,
    fader: 0.75, pan: 0, mute: false, solo: false, arm: false, phase: false, meterL: -100, meterR: -100,
    plugins: generateDefaultRack(), auxSends
  };
}

// Builds the fixed channel set: inputs 1..32, Master (100), Aux 101..108,
// Monitor (109).
function buildChannels(): Record<number, Channel> {
  const busIds: number[] = [];
  for (let b = 0; b < NUM_AUX; b++) busIds.push(AUX_BASE + b);

  const defaultAuxSends: Record<number, number> = { [MASTER_ID]: 0.75 };
  busIds.forEach(id => { defaultAuxSends[id] = 0; });

  const channels: Record<number, Channel> = {};

  for (let i = 1; i <= NUM_CHANNELS; i++) {
    channels[i] = newChannel(i, `IN ${i}`, 'input', { ...defaultAuxSends });
  }

  channels[MASTER_ID] = newChannel(MASTER_ID, 'MASTER', 'master', {});

  busIds.forEach((id, idx) => {
    channels[id] = newChannel(id, `AUX ${idx + 1}`, 'bus', {});
  });

  channels[MONITOR_ID] = newChannel(MONITOR_ID, 'MONITOR', 'monitor', {});

  return channels;
}

export const useMixerStore = create<MixerState>((set, get) => ({
  scenes: [],
  rackPresets: [],
  availablePlugins: [],
  fxMeter: null,
  lufs: null,
  masterAnalysis: null,
  serverStats: null,
  audioLatencyMs: null,
  channels: buildChannels(),
  activeView: 'mixer',
  transportState: 'stopped',
  ws: null,
  selectedChannelId: null,

  monitorInputMask: 0,
  vscConfig: { autoRecord: false, splitOnMarker: true, minFreeGb: 5, schedule: { enabled: false, at: '19:00' } },
  vscStatus: { diskLow: false, freeGb: null, message: null },

  setChannelMonitorInput: (id, live) => {
    const bit = 1 << (id - 1);
    const mask = live ? (get().monitorInputMask | bit) : (get().monitorInputMask & ~bit);
    set({ monitorInputMask: mask >>> 0 });
    const ws = get().ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'set_monitor_input_mask', mask: mask >>> 0 }));
  },
  setAllMonitorInput: (live) => {
    let mask = 0;
    if (live) {
      for (const c of Object.values(get().channels)) if (c.type === 'input') mask |= (1 << (c.id - 1));
    }
    mask = mask >>> 0;
    set({ monitorInputMask: mask });
    const ws = get().ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'set_monitor_input_mask', mask }));
  },

  armAllMappedInputs: () => {
    import('./usePatchbayStore').then(({ usePatchbayStore }) => {
      const mappings = usePatchbayStore.getState().mappings;
      for (const c of Object.values(get().channels)) {
        if (c.type !== 'input') continue;
        const mapped = !!mappings[c.id]?.sourceStreamId;
        if (mapped && !c.arm) get().setChannelValue(c.id, 'arm', true);
      }
    });
  },
  disarmAllInputs: () => {
    for (const c of Object.values(get().channels)) {
      if (c.type === 'input' && c.arm) get().setChannelValue(c.id, 'arm', false);
    }
  },

  setVscConfig: (patch) => {
    set((s) => ({
      vscConfig: {
        autoRecord: patch.autoRecord ?? s.vscConfig.autoRecord,
        splitOnMarker: patch.splitOnMarker ?? s.vscConfig.splitOnMarker,
        minFreeGb: patch.minFreeGb ?? s.vscConfig.minFreeGb,
        schedule: { ...s.vscConfig.schedule, ...(patch.schedule || {}) },
      },
    }));
    const ws = get().ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'vsc_set_config', ...get().vscConfig }));
  },
  vscSplit: () => {
    const ws = get().ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'vsc_split' }));
  },

  setActiveView: (view) => set({ activeView: view }),
  setSelectedChannel: (id) => set({ selectedChannelId: id }),
  
  setChannelValue: (id, key, value) => {
    set((state) => ({ channels: { ...state.channels, [id]: { ...state.channels[id], [key]: value } } }));
    const ws = get().ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (key === 'fader') {
         const gain = positionToAmplitude(value as number);
         // Include faderPosition (normalised 0..1) so the server can persist
         // the UI-side value accurately without a lossy amplitude inversion.
         ws.send(JSON.stringify({ type: 'set_fader', channel: id, value: gain / 2.0, faderPosition: value }));
      }
      if (key === 'pan') ws.send(JSON.stringify({ type: 'set_pan', channel: id, value }));
      if (key === 'mute') ws.send(JSON.stringify({ type: 'set_mute', channel: id, value: value ? 1 : 0 }));
      if (key === 'solo') ws.send(JSON.stringify({ type: 'set_solo', channel: id, value: value ? 1 : 0 }));
      // arm is persisted server-side (mixer_state.json) so the server knows the
      // armed set for VSC auto-record; the engine ignores it (it gets the armed
      // list at start_multitrack_record).
      if (key === 'arm') ws.send(JSON.stringify({ type: 'set_arm', channel: id, value: value ? 1 : 0 }));
      if (key === 'phase') ws.send(JSON.stringify({ type: 'set_phase', channel: id, value: value ? 1 : 0 }));
    }
  },

  renameChannel: (id, name) => {
    set((state) => ({ channels: { ...state.channels, [id]: { ...state.channels[id], name } } }));
  },

  setAuxSend: (channelId, busId, level) => {
    set((state) => {
      const channel = state.channels[channelId];
      if (!channel || channel.type !== 'input') return state;
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
         state.ws.send(JSON.stringify({ type: 'set_aux_send', channel: channelId, busId, value: level }));
      }
      return { channels: { ...state.channels, [channelId]: { ...channel, auxSends: { ...channel.auxSends, [busId]: level } } } };
    });
  },

  addPlugin: (channelId, pluginDef) => {
    set((state) => {
      // Find default params if not provided
      let params = pluginDef.params;
      if (!params) {
        const entry = PLUGIN_REGISTRY.find(e => e.uri === pluginDef.uri);
        params = entry ? { ...entry.defaultParams } : {};
      }
      const plugin: PluginNode = { ...pluginDef, id: uuid(), params };
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        // No index sent — the engine appends when it's omitted, matching
        // where this new plugin lands in the array below.
        state.ws.send(JSON.stringify({ type: 'add_plugin', channel: channelId, uri: plugin.uri, name: plugin.name, enabled: plugin.enabled, params: plugin.params }));
      }
      return { channels: { ...state.channels, [channelId]: { ...state.channels[channelId], plugins: [...state.channels[channelId].plugins, plugin] } } };
    });
  },

  removePlugin: (channelId, pluginId) => {
    set((state) => {
      const channel = state.channels[channelId];
      const pluginIndex = channel.plugins.findIndex(p => p.id === pluginId);
      if (state.ws && state.ws.readyState === WebSocket.OPEN && pluginIndex !== -1) {
        state.ws.send(JSON.stringify({ type: 'remove_plugin', channel: channelId, pluginIndex }));
      }
      return { channels: { ...state.channels, [channelId]: { ...channel, plugins: channel.plugins.filter(p => p.id !== pluginId) } } };
    });
  },

  replacePlugin: (channelId, pluginId, newUri) => {
    set((state) => {
      const channel = state.channels[channelId];
      const entry = PLUGIN_REGISTRY.find(e => e.uri === newUri);
      if (!entry) return state;

      const pluginIndex = channel.plugins.findIndex(p => p.id === pluginId);
      if (state.ws && state.ws.readyState === WebSocket.OPEN && pluginIndex !== -1) {
        state.ws.send(JSON.stringify({ type: 'replace_plugin', channel: channelId, pluginIndex, uri: entry.uri, name: entry.name.split(' ')[1] || entry.name, params: entry.defaultParams }));
      }

      const plugins = channel.plugins.map(p => {
        if (p.id === pluginId) {
          return {
            ...p,
            uri: entry.uri,
            name: entry.name.split(' ')[1] || entry.name, // Keep short name if possible
            enabled: true,
            params: { ...entry.defaultParams }
          };
        }
        return p;
      });
      return { channels: { ...state.channels, [channelId]: { ...channel, plugins } } };
    });
  },

  reorderPlugin: (channelId, startIndex, endIndex) => {
    set((state) => {
      const channel = state.channels[channelId];
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'reorder_plugin', channel: channelId, fromIndex: startIndex, toIndex: endIndex }));
      }
      const result = Array.from(channel.plugins);
      const [removed] = result.splice(startIndex, 1);
      result.splice(endIndex, 0, removed);
      return { channels: { ...state.channels, [channelId]: { ...channel, plugins: result } } };
    });
  },

  saveRackPreset: (channelId, name) => {
    const ws = get().ws;
    const channel = get().channels[channelId];
    if (!ws || ws.readyState !== WebSocket.OPEN || !channel) return;
    ws.send(JSON.stringify({ type: 'save_rack_preset', name, plugins: channel.plugins }));
  },

  loadRackPreset: (name) => {
    const ws = get().ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Server replies with rack_preset_data; the handler in connectWebSocket
    // applies it to whichever channel is selected at that moment.
    ws.send(JSON.stringify({ type: 'load_rack_preset', name }));
  },

  deleteRackPreset: (name) => {
    const ws = get().ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'delete_rack_preset', name }));
  },

  deleteScene: (name) => {
    const ws = get().ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !name) return;
    ws.send(JSON.stringify({ type: 'delete_scene', name }));
  },

  listRackPresets: () => {
    const ws = get().ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'list_rack_presets' }));
  },

  setPluginParam: (channelId, pluginId, paramKey, value) => {
    set((state) => {
      const channel = state.channels[channelId];
      const pluginIndex = channel.plugins.findIndex(p => p.id === pluginId);
      if (state.ws && state.ws.readyState === WebSocket.OPEN && pluginIndex !== -1) {
         state.ws.send(JSON.stringify({ type: 'set_plugin_param', channel: channelId, pluginIndex, paramId: paramKey, value }));
      }
      const plugins = channel.plugins.map(p => {
        if (p.id === pluginId) return { ...p, params: { ...p.params, [paramKey]: value } };
        return p;
      });
      return { channels: { ...state.channels, [channelId]: { ...channel, plugins } } };
    });
  },

  setPluginEnabled: (channelId, pluginId, enabled) => {
    set((state) => {
      const channel = state.channels[channelId];
      const pluginIndex = channel.plugins.findIndex(p => p.id === pluginId);
      if (state.ws && state.ws.readyState === WebSocket.OPEN && pluginIndex !== -1) {
         // Note: UI uses 'enabled', C++ uses 'bypassed'. So bypassed = !enabled
         state.ws.send(JSON.stringify({ type: 'set_plugin_bypass', channel: channelId, pluginIndex, value: enabled ? 0.0 : 1.0 }));
      }
      const plugins = channel.plugins.map(p => {
        if (p.id === pluginId) return { ...p, enabled };
        return p;
      });
      return { channels: { ...state.channels, [channelId]: { ...channel, plugins } } };
    });
  },

  setFxFocus: (channelId, pluginIndex) => {
    // Clear any stale reading immediately; the engine's next metering frame
    // (or lack of an `fx` key) refreshes it.
    set({ fxMeter: null });
    const ws = get().ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'fx_focus',
        channel: channelId ?? -1,
        pluginIndex: pluginIndex ?? -1,
      }));
    }
  },

  resetLufs: () => {
    const ws = get().ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'lufs_reset' }));
  },

  applyRack: (channelId, plugins) => {
    const nodes: PluginNode[] = plugins
      .filter(p => typeof p.uri === 'string')
      .map(p => ({
        id: uuid(),
        name: PLUGIN_REGISTRY.find(e => e.uri === p.uri)?.name || 'Plugin',
        uri: p.uri,
        enabled: p.enabled !== false,
        params: p.params || {},
      }));
    set(state => ({
      channels: { ...state.channels, [channelId]: { ...state.channels[channelId], plugins: nodes } },
    }));
    const ws = get().ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'load_rack',
        channel: channelId,
        plugins: nodes.map(p => ({ uri: p.uri, name: p.name, enabled: p.enabled, params: p.params })),
      }));
    }
  },

  toggleTransport: (action) => {
    const s = get();
    const ws = s.ws;
    const send = (m: unknown) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
    const cur = s.transportState;

    // Phase 3e — pre-roll: when arming a punch, roll from N seconds before the
    // in-point so the operator hears the lead-in. The server auto-punches the
    // take exactly at the in-point, so the pre-roll audio isn't recorded.
    const preRollLocate = () => {
      const daw = useDawStore.getState();
      if ((action === 'play' && cur !== 'playing') || action === 'record') {
        if (daw.punchEnabled && daw.region && daw.preRollSec > 0) {
          const sr = daw.sampleRate > 0 ? daw.sampleRate : 48000;
          send({ type: 'transport_locate', frame: Math.max(0, Math.round((daw.region.inSec - daw.preRollSec) * sr)) });
        }
      }
    };
    preRollLocate();

    // The engine owns the transport clock and reports the authoritative state
    // back on every metering frame (see the `metering` handler). We set an
    // optimistic transportState here so the buttons feel instant; the engine
    // frame corrects it within ~10 ms.
    // Phase 5 tail — count-in: N bars of metronome before the transport rolls /
    // recording opens. Engine freezes the transport + tap until it elapses.
    const countinFrames = useDawStore.getState().countInFrames();

    if (action === 'play') {
      if (cur === 'playing') { send({ type: 'transport_stop' }); set({ transportState: 'stopped' }); }
      else { send({ type: 'transport_play', countinFrames }); set({ transportState: 'playing' }); }
    } else if (action === 'stop') {
      send({ type: 'transport_stop' });
      set({ transportState: 'stopped' });
    } else if (action === 'record') {
      if (cur === 'recording') {
        send({ type: 'stop_multitrack_record' });
        set({ transportState: 'playing' }); // engine keeps rolling after a take
      } else {
        const armed = Object.values(s.channels)
          .filter((c) => c.type === 'input' && c.arm)
          .map((c) => c.id);
        if (armed.length === 0) {
          console.warn('record: no armed tracks — arm a track in the Timeline first');
          return;
        }
        // Phase 3e — with punch armed, just roll: the server drops the take in
        // at the in-point and out at the out-point (and re-drops each loop pass).
        if (useDawStore.getState().punchEnabled && useDawStore.getState().region) {
          send({ type: 'transport_play', countinFrames });
          set({ transportState: 'playing' });
        } else {
          send({ type: 'start_multitrack_record', armed, countinFrames });
          set({ transportState: 'recording' });
        }
      }
    }
  },

  connectWebSocket: () => {
    if (get().ws) return; // Prevent double-connection

    // Derive the server host from the page origin so the UI works when
    // served from the appliance to a remote browser (tablet/laptop), not
    // just from localhost. Overridable via VITE_WS_URL at build time.
    const wsUrl =
      import.meta.env.VITE_WS_URL ||
      `ws://${typeof window !== 'undefined' && window.location.hostname ? window.location.hostname : 'localhost'}:8081`;
    const ws = new WebSocket(wsUrl);
    set({ ws });
    setWs(ws);

    ws.onopen = () => {
      // The server pushes most state on connect, but re-request the lists and
      // re-assert transient engine state here too so a reconnect (or a race
      // where a component's effect fired before the socket opened) converges.
      ws.send(JSON.stringify({ type: 'list_scenes' }));
      ws.send(JSON.stringify({ type: 'list_recording_projects' }));
      ws.send(JSON.stringify({ type: 'list_rack_presets' }));
      ws.send(JSON.stringify({ type: 'get_loudness_config' }));
      ws.send(JSON.stringify({ type: 'get_loudness_history' }));
      ws.send(JSON.stringify({ type: 'list_bounces' }));
      const daw = useDawStore.getState();
      ws.send(JSON.stringify({ type: 'set_metronome', enabled: daw.metronomeOn, bpm: daw.tempo, sigNum: daw.timeSig.num, sigDen: daw.timeSig.den, dest: daw.metroDest }));
      ws.send(JSON.stringify({ type: 'set_automation_state', mode: daw.automationMode, lanes: Object.values(daw.automation) }));
      const mask = get().monitorInputMask;
      if (mask !== 0) ws.send(JSON.stringify({ type: 'set_monitor_input_mask', mask }));
    };

    // Metering arrives faster than the screen refreshes and the pure-viz
    // parts (channel meters, FX in/out + RTA, LUFS, Master analyser) are
    // last-value-wins — coalesce them onto one animation frame so a burst
    // can't drive a render storm. Transport and live-record peaks are applied
    // immediately below: the playhead must stay smooth and every recPeaks
    // batch is unique data that must not be dropped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pendingMeter: any = null;
    let meterRaf = 0;
    const raf: (cb: () => void) => number =
      typeof requestAnimationFrame === 'function'
        ? (cb) => requestAnimationFrame(cb)
        : (cb) => setTimeout(cb, 16) as unknown as number;
    const flushMeter = () => {
      meterRaf = 0;
      const data = pendingMeter;
      pendingMeter = null;
      if (!data) return;
      if (data.channels) {
        set((state) => {
          const nextChannels = { ...state.channels };
          const levelsMap = data.channels as Record<string, { l: number; r: number }>;
          Object.keys(levelsMap).forEach((key) => {
            const cid = parseInt(key, 10);
            if (nextChannels[cid]) {
              const levels = levelsMap[key];
              nextChannels[cid] = { ...nextChannels[cid], meterL: levels.l, meterR: levels.r };
            }
          });
          return { channels: nextChannels };
        });
      }
      // `fx` is present only while the engine has a focused plugin slot
      // (fx_focus). Absent ⇒ nothing focused ⇒ clear so the editor falls
      // back to the host channel meter.
      set({ fxMeter: data.fx ?? null });
      if (data.lufs) set({ lufs: data.lufs });
      if (data.master) set({ masterAnalysis: data.master });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'mixer_state_loaded') {
          // Server sends this on connect with the full persisted mixer state.
          // Apply it to all known channels without sending back to WS or engine.
          const incoming = data.state as Record<string, {
            fader?: number; pan?: number; mute?: boolean; solo?: boolean; arm?: boolean; phase?: boolean;
            auxSends?: Record<string, number>;
          }>;
          set(state => {
            const channels = { ...state.channels };
            for (const [chIdStr, ch] of Object.entries(incoming)) {
              const cid = Number(chIdStr);
              if (!channels[cid]) continue;
              const updated = { ...channels[cid] };
              if (typeof ch.fader === 'number') updated.fader = ch.fader;
              if (typeof ch.pan   === 'number') updated.pan   = ch.pan;
              if (typeof ch.mute  === 'boolean') updated.mute  = ch.mute;
              if (typeof ch.solo  === 'boolean') updated.solo  = ch.solo;
              if (typeof ch.arm   === 'boolean') updated.arm   = ch.arm;
              if (typeof ch.phase === 'boolean') updated.phase = ch.phase;
              if (ch.auxSends) {
                const sends = { ...updated.auxSends };
                for (const [busId, val] of Object.entries(ch.auxSends)) {
                  sends[Number(busId)] = val;
                }
                updated.auxSends = sends;
              }
              channels[cid] = updated;
            }
            return { channels };
          });
        } else if (data.type === 'scenes_list') {
          set({ scenes: data.scenes });
        } else if (data.type === 'scene_data') {
          const { mixer, patchbay } = data.state || {};
          if (!mixer || !mixer.channels) {
            console.warn('scene_data: malformed scene, ignoring', data.name);
          } else {
          // Normalise the persisted channel map (JSON keys are strings) back
          // onto the live channel objects, keeping current meter values.
          set((state) => {
            const channels = { ...state.channels };
            for (const raw of Object.values(mixer.channels as Record<string, Channel>)) {
              const cid = Number(raw.id);
              if (!channels[cid]) continue;
              channels[cid] = {
                ...channels[cid], ...raw,
                meterL: channels[cid].meterL, meterR: channels[cid].meterR,
              };
            }
            return { channels };
          });

          import('./usePatchbayStore').then(({ usePatchbayStore }) => {
            if (patchbay?.mappings) usePatchbayStore.setState({ mappings: patchbay.mappings });
            const ws = get().ws;
            if (ws && ws.readyState === WebSocket.OPEN) {
               if (patchbay?.mappings) ws.send(JSON.stringify({ type: 'sync_patchbay_matrix', mappings: patchbay.mappings }));

               // Push levels to the engine the same way setChannelValue does:
               // set_fader wants amplitude/2, not the 0..1 fader position.
               Object.values(mixer.channels as Record<string, Channel>).forEach((ch) => {
                 const id = Number(ch.id);
                 const gain = positionToAmplitude(ch.fader ?? 0.75);
                 ws.send(JSON.stringify({ type: 'set_fader', channel: id, value: gain / 2.0, faderPosition: ch.fader }));
                 ws.send(JSON.stringify({ type: 'set_pan', channel: id, value: ch.pan ?? 0 }));
                 ws.send(JSON.stringify({ type: 'set_mute', channel: id, value: ch.mute ? 1 : 0 }));
                 ws.send(JSON.stringify({ type: 'set_solo', channel: id, value: ch.solo ? 1 : 0 }));
                 if (typeof ch.arm === 'boolean') ws.send(JSON.stringify({ type: 'set_arm', channel: id, value: ch.arm ? 1 : 0 }));
                 for (const [busId, level] of Object.entries(ch.auxSends || {})) {
                   ws.send(JSON.stringify({ type: 'set_aux_send', channel: id, busId: Number(busId), value: level }));
                 }

                 // load_rack actually instantiates each plugin in the live
                 // engine (see engine/src/main.cpp's PluginCmd) — sending
                 // per-index set_plugin_bypass/set_plugin_param here instead
                 // would silently no-op, since the engine wouldn't have any
                 // plugin slots at those indices yet.
                 ws.send(JSON.stringify({
                   type: 'load_rack',
                   channel: id,
                   plugins: (ch.plugins || []).map(p => ({ uri: p.uri, name: p.name, enabled: p.enabled, params: p.params }))
                 }));
               });
            }
          });
          console.log(`Scene ${data.name} loaded and applied.`);
          }
        } else if (data.type === 'rack_presets_list') {
          set({ rackPresets: data.presets || [] });
        } else if (data.type === 'rack_preset_data') {
          // The server only echoes back the preset's name + plugin list, not
          // which channel asked for it — apply to whatever's selected right
          // now, which is the only channel the Rack Manager UI could have
          // been driven from.
          const targetChannelId = get().selectedChannelId;
          if (targetChannelId === null) return;
          const rawPlugins: Partial<PluginNode>[] = Array.isArray(data.plugins) ? data.plugins : [];
          const plugins: PluginNode[] = rawPlugins
            .filter((p): p is Partial<PluginNode> & { uri: string } => typeof p.uri === 'string')
            .map((p) => ({
              id: uuid(),
              name: p.name || PLUGIN_REGISTRY.find(e => e.uri === p.uri)?.name || 'Plugin',
              uri: p.uri,
              enabled: p.enabled !== false,
              params: (p.params && typeof p.params === 'object') ? p.params : {}
            }));
          set((state) => ({
            channels: { ...state.channels, [targetChannelId]: { ...state.channels[targetChannelId], plugins } }
          }));
          const ws = get().ws;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'load_rack',
              channel: targetChannelId,
              plugins: plugins.map(p => ({ uri: p.uri, name: p.name, enabled: p.enabled, params: p.params }))
            }));
          }
          console.log(`Rack preset "${data.name}" loaded onto channel ${targetChannelId}.`);
        } else if (data.type === 'fx_racks_loaded') {
          // Server-persisted insert chains — restore the rack UI on reload.
          // The engine already holds these (or is fed them on its own
          // reconnect), so this only repopulates the store — nothing is sent.
          const racks = (data.racks || {}) as Record<string, Partial<PluginNode>[]>;
          const avail = get().availablePlugins;
          set((state) => {
            const channels = { ...state.channels };
            for (const [chId, list] of Object.entries(racks)) {
              const cid = Number(chId);
              if (!channels[cid] || !Array.isArray(list)) continue;
              channels[cid] = {
                ...channels[cid],
                plugins: list
                  .filter((p): p is Partial<PluginNode> & { uri: string } => typeof p.uri === 'string')
                  .map((p) => ({
                    id: uuid(),
                    name: p.name
                      || PLUGIN_REGISTRY.find((e) => e.uri === p.uri)?.name
                      || avail.find((e) => e.uri === p.uri)?.name
                      || 'Plugin',
                    uri: p.uri,
                    enabled: p.enabled !== false,
                    params: (p.params && typeof p.params === 'object') ? p.params : {},
                  })),
              };
            }
            return { channels };
          });
        } else if (data.type === 'patchbay_config_loaded') {
          import('./usePatchbayStore').then(({ usePatchbayStore }) => {
             usePatchbayStore.setState({ mappings: data.mappings });
          });
        } else if (data.type === 'output_routing_loaded') {
          // The server only ever stores resolved ports, not which
          // destination-registry entry they came from. Best-effort match
          // them back to a registry entry (by exact ports) so a fresh
          // client's dropdowns come in pre-selected when possible; a normal
          // same-browser reload already gets this right via localStorage
          // persistence regardless.
          import('./usePatchbayStore').then(({ usePatchbayStore }) => {
            const outputs = (data.outputs || {}) as Record<string, { ports: string[]; mono?: boolean }>;
            const state = usePatchbayStore.getState();
            const allDestinations = [...state.discoveredDestinations, ...state.manualDestinations];
            Object.entries(outputs).forEach(([busIdStr, entry]) => {
              if (!entry || !Array.isArray(entry.ports) || entry.ports.length === 0) return;
              const { ports, mono } = entry;
              const busId = Number(busIdStr);
              const match = allDestinations.find(d =>
                d.ports.length > 0 && (
                  mono
                    ? ports.length === d.ports.length && ports.every((p, i) => d.ports[i] === p)
                    : (ports.length >= 2 && d.ports[0] === ports[0] && d.ports[1] === ports[1]) ||
                      (ports.length === 1 && d.ports.includes(ports[0]))
                )
              );
              if (match) {
                const destChannel = mono ? -1 : (ports.length >= 2 ? 0 : match.ports.indexOf(ports[0]) + 1);
                state.setOutputMapping(busId, match.id, destChannel);
              }
            });
          });
        } else if (data.type === 'daemon_destinations_loaded') {
          import('./usePatchbayStore').then(({ usePatchbayStore }) => {
            const state = usePatchbayStore.getState();
            state.setDiscoveredDestinations(data.destinations || []);
            state.setDaemonReachable(!!data.daemonReachable);
          });
        } else if (data.type === 'daemon_state') {
          import('./usePatchbayStore').then(({ usePatchbayStore }) => {
            usePatchbayStore.getState().setDaemonState(data);
          });
        } else if (data.type === 'talkback_config_loaded') {
          import('./usePatchbayStore').then(({ usePatchbayStore }) => {
             usePatchbayStore.setState({
               talkbackSourcePorts: data.sourcePorts || [],
               talkbackDestBusIds: Array.isArray(data.destBusIds) && data.destBusIds.length > 0 ? data.destBusIds : [100],
               talkbackMicSourceName: typeof data.micSourceName === 'string' ? data.micSourceName : null,
               talkbackMicAlsaPortName: typeof data.micAlsaPortName === 'string' ? data.micAlsaPortName : null
             });
          });
        } else if (data.type === 'mic_devices_loaded') {
          import('./usePatchbayStore').then(({ usePatchbayStore }) => {
            usePatchbayStore.getState().setMicDevices(data.devices || []);
          });
        } else if (data.type === 'plugin_list' || data.type === 'plugin_list_loaded') {
          set({ availablePlugins: Array.isArray(data.plugins) ? data.plugins : [] });
        } else if (data.type === 'set_fader' && typeof data.channel === 'number') {
          // Broadcast from another client — apply locally only, no WS echo.
          const faderVal = typeof data.faderPosition === 'number' ? data.faderPosition : data.value;
          set(state => {
            if (!state.channels[data.channel]) return state;
            return { channels: { ...state.channels, [data.channel]: { ...state.channels[data.channel], fader: faderVal } } };
          });
        } else if (data.type === 'set_pan' && typeof data.channel === 'number') {
          set(state => {
            if (!state.channels[data.channel]) return state;
            return { channels: { ...state.channels, [data.channel]: { ...state.channels[data.channel], pan: data.value } } };
          });
        } else if (data.type === 'set_mute' && typeof data.channel === 'number') {
          set(state => {
            if (!state.channels[data.channel]) return state;
            return { channels: { ...state.channels, [data.channel]: { ...state.channels[data.channel], mute: !!data.value } } };
          });
        } else if (data.type === 'set_solo' && typeof data.channel === 'number') {
          set(state => {
            if (!state.channels[data.channel]) return state;
            return { channels: { ...state.channels, [data.channel]: { ...state.channels[data.channel], solo: !!data.value } } };
          });
        } else if (data.type === 'set_arm' && typeof data.channel === 'number') {
          set(state => {
            if (!state.channels[data.channel]) return state;
            return { channels: { ...state.channels, [data.channel]: { ...state.channels[data.channel], arm: !!data.value } } };
          });
        } else if (data.type === 'set_monitor_input_mask' && typeof data.mask === 'number') {
          set({ monitorInputMask: data.mask >>> 0 });
        } else if (data.type === 'vsc_config_loaded' && data.config) {
          set({ vscConfig: {
            autoRecord: !!data.config.autoRecord,
            splitOnMarker: !!data.config.splitOnMarker,
            minFreeGb: Number(data.config.minFreeGb) || 0,
            schedule: {
              enabled: !!data.config.schedule?.enabled,
              at: typeof data.config.schedule?.at === 'string' ? data.config.schedule.at : '19:00',
            },
          } });
        } else if (data.type === 'vsc_status') {
          set(state => ({ vscStatus: {
            diskLow: typeof data.diskLow === 'boolean' ? data.diskLow : state.vscStatus.diskLow,
            freeGb: typeof data.freeGb === 'number' ? data.freeGb : state.vscStatus.freeGb,
            message:
              data.autoStopped ? 'Recording stopped — disk full'
              : data.scheduleError ? `Scheduled start failed: ${data.scheduleError}`
              : data.autoRecordError ? `Auto-record failed: ${data.autoRecordError}`
              : data.splitError ? `Split failed: ${data.splitError}`
              : data.diskLow ? `Disk low${typeof data.freeGb === 'number' ? ` — ${data.freeGb} GB free` : ''}`
              : data.scheduledStarted ? 'Scheduled recording started'
              : data.autoRecordStarted ? 'Auto-record started'
              : data.splitDone ? 'Take split'
              : null,
          } }));
        } else if (data.type === 'set_aux_send' && typeof data.channel === 'number' && typeof data.busId === 'number') {
          set(state => {
            const ch = state.channels[data.channel];
            if (!ch) return state;
            return { channels: { ...state.channels, [data.channel]: { ...ch, auxSends: { ...ch.auxSends, [data.busId]: data.value } } } };
          });
        } else if (data.type === 'metering') {
          // Pure-viz state: coalesce onto the next animation frame.
          pendingMeter = data;
          if (!meterRaf) meterRaf = raf(flushMeter);
          // Everything below is applied immediately — not throttled.
          if (data.recPeaks) useDawStore.getState().pushRecPeaks(data.recPeaks);
          if (data.transport?.buf && data.transport?.sr) {
            const ms = Math.round((2 * data.transport.buf / data.transport.sr) * 1000 * 10) / 10;
            if (get().audioLatencyMs !== ms) set({ audioLatencyMs: ms });
          }
          if (data.tc) useDawStore.getState().applyTcTelemetry(data.tc);
          if (data.transport) {
            const t = data.transport;
            // Engine transport is authoritative for both position and state.
            useDawStore.getState().applyTransport(t.frame, t.state, t.sr);
            if (t.pbUnderrun) useDawStore.getState().flagPlaybackUnderrun();
            const st = t.state === 2 ? 'recording' : t.state === 1 ? 'playing' : 'stopped';
            if (get().transportState !== st) set({ transportState: st });
            // Phase 3c: feed the timeline loudness-history strip (in-store 1 Hz
            // throttle; only accumulates while rolling, matching the server log).
            if (data.lufs && t.sr) {
              useLoudnessStore.getState().push(
                { sec: t.frame / t.sr, m: data.lufs.m, s: data.lufs.s, i: data.lufs.i, tp: data.lufs.tp },
                t.state !== 0,
              );
            }
            // Engine restarts back to mask 0; re-assert our VSC monitor override
            // so per-channel live/timeline choices survive an engine recovery.
            const want = get().monitorInputMask;
            if (want !== 0 && typeof t.monInMask === 'number' && (t.monInMask >>> 0) !== want) {
              get().ws?.send(JSON.stringify({ type: 'set_monitor_input_mask', mask: want }));
            }
            // Phase 3e: same self-heal for the loop/punch region (not part of
            // the server's timeline replay on engine reconnect).
            if (typeof t.loopOn === 'number' && typeof t.punchOn === 'number') {
              useDawStore.getState().reassertRegionToEngine(!!t.loopOn, !!t.punchOn);
            }
          }
        } else if (data.type === 'aes67_discovery') {
          const { upsertStream } = usePatchbayStore.getState();
          upsertStream(data.name, data.address);
        } else if (data.type === 'project_data') {
          useDawStore.getState().loadProjectData(data.name, data.project);
        } else if (data.type === 'projects_list') {
          useDawStore.getState().setProjectList(data.projects || [], data.active);
        } else if (data.type === 'server_stats') {
          set({ serverStats: { cpu: data.cpu ?? null, memUsedMB: data.memUsedMB ?? null, memTotalMB: data.memTotalMB ?? null } });
        } else if (data.type === 'recording_projects_list') {
          useDawStore.getState().setRecordingProjects(data.projects || [], data.active ?? null);
        } else if (data.type === 'recording_project_error') {
          useDawStore.getState().setRecordingProjectError(data.reason || 'error');
        } else if (data.type === 'take_started') {
          const sr = Number(data.sampleRate) || 48000;
          useDawStore.getState().beginRecordingClips(
            Array.isArray(data.armed) ? data.armed : [],
            (Number(data.originFrame) || 0) / sr, sr);
        } else if (data.type === 'take_committed') {
          useDawStore.getState().endRecordingClips();
          useDawStore.getState().addCommittedClips(data.clips || [], !!data.overrun, {
            loopPass: !!data.loopPass, passIndex: Number(data.passIndex) || 0,
          });
        } else if (data.type === 'clip_peaks') {
          if (data.peaks && data.takeDir && data.file) {
            useDawStore.getState().setPeaks(`${data.takeDir}/${data.file}`, data.peaks);
          }
        } else if (data.type === 'take_failed') {
          console.warn('multitrack take failed:', data.reason || 'unknown');
          useDawStore.getState().endRecordingClips();
          set({ transportState: 'stopped' });
        } else if (data.type === 'bounce_status') {
          useDawStore.getState().applyBounceStatus(data);
        } else if (data.type === 'bounce_done') {
          useDawStore.getState().applyBounceDone(data);
        } else if (data.type === 'bounces_list') {
          useDawStore.getState().setBounces(data.bounces || []);
        } else if (data.type === 'loudness_config_loaded') {
          useLoudnessStore.getState().applyConfig(data.config || {});
        } else if (data.type === 'timecode_config_loaded') {
          useDawStore.getState().applyTimecodeConfig(data.config || {});
        } else if (data.type === 'auto_lane_updated' && data.lane) {
          useDawStore.getState().applyAutoLaneUpdate(data.lane);
        } else if (data.type === 'project_videos') {
          useDawStore.getState().setProjectVideos(data.videos || []);
        } else if (data.type === 'playlists_list') {
          useDawStore.getState().setPlaylists(data.playlists || []);
        } else if (data.type === 'playlist_data') {
          useDawStore.getState().applyPlaylistData(data.playlist || null);
        } else if (data.type === 'playlist_status') {
          useDawStore.getState().applyPlaylistStatus(data);
        } else if (data.type === 'loudness_history') {
          useLoudnessStore.getState().seed(data.points || [], data.target);
        } else if (data.type === 'loudness_report') {
          if (data.error) console.warn('loudness report:', data.error);
          else if (data.csv) downloadText(String(data.name || 'loudness-report.csv'), data.csv);
        }
      } catch (e) {
        // Malformed or partial WebSocket frame — drop it, matching the
        // server's own "invalid JSON, drop it" handling on its side.
      }
    };
    ws.onclose = () => {
      if (meterRaf) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(meterRaf);
        else clearTimeout(meterRaf);
        meterRaf = 0;
      }
      pendingMeter = null;
      set({ ws: null });
      setWs(null);
      setTimeout(() => get().connectWebSocket(), 1000);
    };
  }
}));

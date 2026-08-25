import { create } from 'zustand';
import { usePatchbayStore } from './usePatchbayStore';

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
  timecode: string;
  ws: WebSocket | null;
  selectedChannelId: number | null;

  setActiveView: (view: 'mixer' | 'daw' | 'patchbay') => void;
  setChannelValue: (id: number, key: keyof Channel, value: any) => void;
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

  connectWebSocket: () => void;
  scenes: string[];
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

export const PLUGIN_REGISTRY: PluginRegistryEntry[] = [
  // Saturation
  { name: 'Calf Saturator', uri: 'http://calf.sourceforge.net/plugins/Saturator', category: 'Saturation', defaultParams: { drive: 5, blend: 5, out: 5 } },
  { name: 'Calf Crusher', uri: 'http://calf.sourceforge.net/plugins/Crusher', category: 'Saturation', defaultParams: { drive: 5, blend: 5, out: 5 } }, // using same mapped params for UI compat
  { name: 'LSP Articulator', uri: 'http://lsp-plug.in/plugins/lv2/articulator_stereo', category: 'Saturation', defaultParams: { drive: 5, blend: 5, out: 5 } },
  
  // Dynamics
  { name: 'LSP Compressor', uri: 'http://lsp-plug.in/plugins/lv2/compressor_stereo', category: 'Dynamics', defaultParams: { threshold: -20, ratio: 4, attack: 20, release: 200, makeup: 0, mix: 100 } },
  { name: 'Calf Compressor', uri: 'http://calf.sourceforge.net/plugins/Compressor', category: 'Dynamics', defaultParams: { threshold: -20, ratio: 4, attack: 20, release: 200, makeup: 0, mix: 100 } },
  
  // De-Esser
  { name: 'Calf De-Esser', uri: 'http://calf.sourceforge.net/plugins/Deesser', category: 'De-Esser', defaultParams: { threshold: -20, freq: 6000, ratio: 3, out: 0 } },
  { name: 'LSP De-Esser', uri: 'http://lsp-plug.in/plugins/lv2/de_esser_stereo', category: 'De-Esser', defaultParams: { threshold: -20, freq: 6000, ratio: 3, out: 0 } },
  
  // Equalizer
  { name: 'LSP 8-Band EQ', uri: 'http://lsp-plug.in/plugins/lv2/para_equalizer_x8_stereo', category: 'Equalizer', defaultParams: { b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0, b7: 0, b8: 0 } },
  { name: 'Calf 8-Band EQ', uri: 'http://calf.sourceforge.net/plugins/Equalizer8Band', category: 'Equalizer', defaultParams: { b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0, b7: 0, b8: 0 } },
  { name: 'Calf 5-Band EQ', uri: 'http://calf.sourceforge.net/plugins/Equalizer5Band', category: 'Equalizer', defaultParams: { b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0, b7: 0, b8: 0 } },

  // Delay
  { name: 'LSP Delay', uri: 'http://lsp-plug.in/plugins/lv2/delay_stereo', category: 'Delay', defaultParams: { time_l: 250, time_r: 250, feedback: 30, mix: 20 } },
  { name: 'Calf Vintage Delay', uri: 'http://calf.sourceforge.net/plugins/VintageDelay', category: 'Delay', defaultParams: { time_l: 250, time_r: 250, feedback: 30, mix: 20 } },

  // Reverb
  { name: 'Calf Reverb', uri: 'http://calf.sourceforge.net/plugins/Reverb', category: 'Reverb', defaultParams: { decay: 2, high_cut: 5000, mix: 20, out: 0 } },
  { name: 'LSP Room Builder', uri: 'http://lsp-plug.in/plugins/lv2/room_builder_stereo', category: 'Reverb', defaultParams: { decay: 2, high_cut: 5000, mix: 20, out: 0 } },
  
  // Limiter
  { name: 'LSP Limiter', uri: 'http://lsp-plug.in/plugins/lv2/limiter_stereo', category: 'Limiter', defaultParams: { limit: -0.1, threshold: -3, release: 50, gain: 0 } },
  { name: 'Calf Limiter', uri: 'http://calf.sourceforge.net/plugins/Limiter', category: 'Limiter', defaultParams: { limit: -0.1, threshold: -3, release: 50, gain: 0 } },
];

// Channels, buses, and master all start with an empty effect rack. Users
// add plugins explicitly from the UI (PLUGIN_REGISTRY above).
const DEFAULT_RACK: Omit<PluginNode, 'id'>[] = [];

const generateDefaultRack = (): PluginNode[] => {
  return DEFAULT_RACK.map(p => ({
    ...p,
    id: crypto.randomUUID(),
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
  channels: buildChannels(),
  activeView: 'mixer',
  transportState: 'stopped',
  timecode: '00:00:00:00',
  ws: null,
  selectedChannelId: null,
  
  setActiveView: (view) => set({ activeView: view }),
  setSelectedChannel: (id) => set({ selectedChannelId: id }),
  
  setChannelValue: (id, key, value) => {
    set((state) => ({ channels: { ...state.channels, [id]: { ...state.channels[id], [key]: value } } }));
    const ws = get().ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (key === 'fader') {
         const gain = positionToAmplitude(value);
         ws.send(JSON.stringify({ type: 'set_fader', channel: id, value: gain / 2.0 }));
      }
      if (key === 'pan') ws.send(JSON.stringify({ type: 'set_pan', channel: id, value }));
      if (key === 'mute') ws.send(JSON.stringify({ type: 'set_mute', channel: id, value: value ? 1 : 0 }));
      if (key === 'solo') ws.send(JSON.stringify({ type: 'set_solo', channel: id, value: value ? 1 : 0 }));
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
      const plugin: PluginNode = { ...pluginDef, id: crypto.randomUUID(), params };
      return { channels: { ...state.channels, [channelId]: { ...state.channels[channelId], plugins: [...state.channels[channelId].plugins, plugin] } } };
    });
  },

  removePlugin: (channelId, pluginId) => {
    set((state) => ({ channels: { ...state.channels, [channelId]: { ...state.channels[channelId], plugins: state.channels[channelId].plugins.filter(p => p.id !== pluginId) } } }));
  },

  replacePlugin: (channelId, pluginId, newUri) => {
    set((state) => {
      const channel = state.channels[channelId];
      const entry = PLUGIN_REGISTRY.find(e => e.uri === newUri);
      if (!entry) return state;

      const plugins = channel.plugins.map(p => {
        if (p.id === pluginId) {
          return {
            ...p,
            uri: entry.uri,
            name: entry.name.split(' ')[1] || entry.name, // Keep short name if possible
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
      const result = Array.from(channel.plugins);
      const [removed] = result.splice(startIndex, 1);
      result.splice(endIndex, 0, removed);
      return { channels: { ...state.channels, [channelId]: { ...channel, plugins: result } } };
    });
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

  toggleTransport: (action) => {
    const currentState = get().transportState;
    let nextState = currentState;
    const ws = get().ws;

    if (action === 'play') nextState = currentState === 'playing' ? 'stopped' : 'playing';
    if (action === 'stop') nextState = 'stopped';
    if (action === 'record') {
        nextState = currentState === 'recording' ? 'stopped' : 'recording';
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: nextState === 'recording' ? 'start_record' : 'stop_record' }));
        }
    }
    set({ transportState: nextState });
  },

  connectWebSocket: () => {
    if (get().ws) return; // Prevent double-connection

    const ws = new WebSocket('ws://localhost:8081');
    set({ ws });
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'scenes_list') {
          set({ scenes: data.scenes });
        } else if (data.type === 'scene_data') {
          const { mixer, patchbay } = data.state;
          set({ channels: mixer.channels });
          
          import('./usePatchbayStore').then(({ usePatchbayStore }) => {
            usePatchbayStore.setState({ mappings: patchbay.mappings });
            if (get().ws && get().ws?.readyState === WebSocket.OPEN) {
               get().ws?.send(JSON.stringify({ type: 'sync_patchbay_matrix', mappings: patchbay.mappings }));
               
               // Apply mixer states
               Object.values(mixer.channels).forEach((ch: any) => {
                 get().ws?.send(JSON.stringify({ type: 'set_fader', channelId: ch.id, value: ch.fader }));
                 get().ws?.send(JSON.stringify({ type: 'set_pan', channelId: ch.id, value: ch.pan }));
                 get().ws?.send(JSON.stringify({ type: 'set_mute', channelId: ch.id, value: ch.mute }));
                 get().ws?.send(JSON.stringify({ type: 'set_solo', channelId: ch.id, value: ch.solo }));
                 
                 ch.plugins?.forEach((p: any) => {
                    get().ws?.send(JSON.stringify({ type: 'set_plugin_bypass', channelId: ch.id, pluginId: p.id, bypassed: p.bypassed }));
                    Object.entries(p.params || {}).forEach(([pId, pVal]) => {
                       get().ws?.send(JSON.stringify({ type: 'set_plugin_param', channelId: ch.id, pluginId: p.id, paramId: pId, value: pVal }));
                    });
                 });
               });
            }
          });
          console.log(`Scene ${data.name} loaded and applied.`);
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
            const outputs = (data.outputs || {}) as Record<string, string[]>;
            const state = usePatchbayStore.getState();
            const allDestinations = [...state.discoveredDestinations, ...state.manualDestinations];
            Object.entries(outputs).forEach(([busIdStr, ports]) => {
              if (!Array.isArray(ports) || ports.length === 0) return;
              const busId = Number(busIdStr);
              const match = allDestinations.find(d =>
                d.ports.length > 0 && (
                  (ports.length >= 2 && d.ports[0] === ports[0] && d.ports[1] === ports[1]) ||
                  (ports.length === 1 && d.ports.includes(ports[0]))
                )
              );
              if (match) {
                const destChannel = ports.length >= 2 ? 0 : match.ports.indexOf(ports[0]) + 1;
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
        } else if (data.type === 'talkback_config_loaded') {
          import('./usePatchbayStore').then(({ usePatchbayStore }) => {
             usePatchbayStore.setState({
               talkbackSourcePorts: data.sourcePorts || [],
               talkbackDestBusId: typeof data.destBusId === 'number' ? data.destBusId : 100,
               talkbackMicSourceName: typeof data.micSourceName === 'string' ? data.micSourceName : null,
               talkbackMicAlsaPortName: typeof data.micAlsaPortName === 'string' ? data.micAlsaPortName : null
             });
          });
        } else if (data.type === 'mic_devices_loaded') {
          import('./usePatchbayStore').then(({ usePatchbayStore }) => {
            usePatchbayStore.getState().setMicDevices(data.devices || []);
          });
        } else if (data.type === 'metering') {
          if (data.channels) {
             set((state) => {
                const nextChannels = { ...state.channels };
                const levelsMap = data.channels as Record<string, { l: number; r: number }>;
                Object.keys(levelsMap).forEach(key => {
                   const cid = parseInt(key, 10);
                   if (nextChannels[cid]) {
                      const levels = levelsMap[key];
                      nextChannels[cid] = { ...nextChannels[cid], meterL: levels.l, meterR: levels.r };
                   }
                });
                return { channels: nextChannels };
             });
          }
        } else if (data.type === 'aes67_discovery') {
          const { upsertStream } = usePatchbayStore.getState();
          upsertStream(data.name, data.address);
        }
      } catch (e) {}
    };
    ws.onclose = () => {
      set({ ws: null });
      setTimeout(() => get().connectWebSocket(), 1000);
    };
  }
}));

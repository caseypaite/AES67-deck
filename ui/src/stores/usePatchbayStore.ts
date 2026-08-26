import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { uuid } from '../lib/uuid';

const NUM_CHANNELS = 32;
const OUTPUT_BUS_IDS = [100, 101, 102, 103, 104, 105, 106, 107, 108];

export interface Aes67Stream {
  id: string;
  name: string;
  address: string;
  channels: number;
  // Full PipeWire/JACK port identifiers ("client:port") for this stream's
  // audio channels, in order. Index 0/1 are used for a stereo pick; index
  // N-1 is used when a single sub-channel N is picked. Left blank until the
  // user fills them in (SAP discovery only gives us a name + IP, not a
  // PipeWire node).
  ports: string[];
  lastSeen: number;
}

// Input channels are source-only: they can be mapped to an AES67/PipeWire
// source, never to a destination.
export interface ChannelMapping {
  channelId: number;
  sourceStreamId: string | null;
  sourceChannel: number;
}

// Master/Aux buses are destination-only, mirroring ChannelMapping exactly —
// same shape as picking a source, just picking a destination instead.
export interface OutputMapping {
  busId: number;
  destStreamId: string | null;
  destChannel: number;
}

// A local capture device the server found via `pactl list sources` — for
// the Talkback microphone dropdown. Auto-refreshed by the server every few
// seconds, so a USB mic shows up on its own shortly after being plugged in.
export interface MicDevice {
  id: string;
  sourceName: string;
  // Set when this entry is a specific external mic-jack port rather than
  // "whatever ALSA already has active" — selecting it also switches ALSA's
  // active port server-side (see sync_talkback_config).
  alsaPortName: string | null;
  label: string;
  kind: 'builtin' | 'usb' | 'jack' | 'other';
  channels: number;
  ports: string[];
}

interface PatchbayState {
  streams: Aes67Stream[];
  manualStreams: Aes67Stream[];
  mappings: Record<number, ChannelMapping>;

  // Destination registry for Master + the 8 Aux buses, mirroring
  // streams/manualStreams: `discoveredDestinations` comes from polling
  // aes67-linux-daemon's configured Sources (the real "feed audio in here
  // to transmit it as AES67" points), `manualDestinations` are
  // operator-added. The Monitor bus is intentionally not part of this — its
  // destination is fixed to the system's audio out device.
  discoveredDestinations: Aes67Stream[];
  manualDestinations: Aes67Stream[];
  outputMappings: Record<number, OutputMapping>;
  // Whether the server's last poll of aes67-linux-daemon's REST API
  // succeeded — lets the UI explain an empty discovered-destinations list.
  daemonReachable: boolean;

  // Live-detected local capture devices, for the Talkback mic dropdown.
  micDevices: MicDevice[];

  // Talkback mic: source is the system's audio input (mic), destination is
  // any combination of Master and the 8 Aux buses — never Monitor — so it
  // can fan out to several at once. micSourceName/micAlsaPortName are set
  // together with talkbackSourcePorts when the operator picks a mic from
  // the dropdown (null if they typed ports by hand instead) — see
  // setTalkbackMic.
  talkbackSourcePorts: string[];
  talkbackDestBusIds: number[];
  talkbackMicSourceName: string | null;
  talkbackMicAlsaPortName: string | null;

  upsertStream: (name: string, address: string) => void;
  addManualStream: (name: string, address: string, channels: number, ports: string[]) => void;
  removeManualStream: (id: string) => void;
  setSourceMapping: (channelId: number, streamId: string | null, streamChannel: number) => void;
  setStreamChannels: (id: string, channels: number, isManual: boolean) => void;
  setStreamPorts: (id: string, ports: string[], isManual: boolean) => void;
  clearMapping: (channelId: number) => void;

  // Replaces the whole discovered-destinations list (each poll of the
  // daemon is a full snapshot, not an incremental event like SAP), matching
  // by name+address to keep any ports/channel-count the operator already
  // set for a destination that's still present.
  setDiscoveredDestinations: (found: { name: string; address: string }[]) => void;
  addManualDestination: (name: string, address: string, channels: number, ports: string[]) => void;
  removeManualDestination: (id: string) => void;
  setDestinationChannels: (id: string, channels: number, isManual: boolean) => void;
  setDestinationPorts: (id: string, ports: string[], isManual: boolean) => void;
  setOutputMapping: (busId: number, destStreamId: string | null, destChannel: number) => void;
  clearOutputMapping: (busId: number) => void;
  setDaemonReachable: (reachable: boolean) => void;

  setMicDevices: (devices: MicDevice[]) => void;
  setTalkbackSourcePorts: (ports: string[]) => void;
  // Adds/removes one bus from the destination set (checkbox-style), rather
  // than replacing it — talkback can be sent to several buses at once.
  toggleTalkbackDestBusId: (busId: number) => void;
  // Picks a device from the mic dropdown: fills in ports + the ALSA
  // source/port pair together, replacing whatever was there (dropdown vs.
  // manually-typed ports are mutually exclusive at any moment).
  setTalkbackMic: (device: MicDevice) => void;
}

function buildMappings(existing?: Record<number, ChannelMapping>): Record<number, ChannelMapping> {
  const next: Record<number, ChannelMapping> = {};
  for (let i = 1; i <= NUM_CHANNELS; i++) {
    next[i] = existing?.[i] || {
      channelId: i,
      sourceStreamId: null,
      sourceChannel: 1
    };
  }
  return next;
}

function buildOutputMappings(existing?: Record<number, OutputMapping>): Record<number, OutputMapping> {
  const next: Record<number, OutputMapping> = {};
  for (const busId of OUTPUT_BUS_IDS) {
    next[busId] = existing?.[busId] || {
      busId,
      destStreamId: null,
      destChannel: 0
    };
  }
  return next;
}

const initialMappings = buildMappings();
// Default mapping for System Audio
initialMappings[1].sourceStreamId = 'system-audio-loopback';
initialMappings[1].sourceChannel = 0;

export const usePatchbayStore = create<PatchbayState>()(
  persist(
    (set) => ({
  streams: [],
  manualStreams: [{
    id: 'system-audio-loopback',
    name: 'System Audio',
    address: 'localhost (PipeWire)',
    channels: 2,
    ports: ['AES67_System_Audio_Loopback:output_FL', 'AES67_System_Audio_Loopback:output_FR'],
    lastSeen: Date.now()
  }],
  mappings: initialMappings,

  discoveredDestinations: [],
  manualDestinations: [],
  outputMappings: buildOutputMappings(),
  daemonReachable: true,

  micDevices: [],

  talkbackSourcePorts: [],
  talkbackDestBusIds: [100],
  talkbackMicSourceName: null,
  talkbackMicAlsaPortName: null,

  upsertStream: (name, address) => {
    set(state => {
      const existingIndex = state.streams.findIndex(s => s.address === address && s.name === name);
      if (existingIndex >= 0) {
        const newStreams = [...state.streams];
        newStreams[existingIndex] = { ...newStreams[existingIndex], lastSeen: Date.now() };
        return { streams: newStreams };
      }
      const newStream: Aes67Stream = {
        id: uuid(),
        name,
        address,
        channels: 2,
        ports: [],
        lastSeen: Date.now()
      };
      return { streams: [...state.streams, newStream] };
    });
  },

  addManualStream: (name, address, channels, ports) => {
    set(state => ({
      manualStreams: [...state.manualStreams, {
        id: uuid(),
        name,
        address,
        channels,
        ports,
        lastSeen: Date.now()
      }]
    }));
  },

  removeManualStream: (id) => {
    set(state => ({
      manualStreams: state.manualStreams.filter(s => s.id !== id)
    }));
  },

  setSourceMapping: (channelId, streamId, streamChannel) => {
    set(state => ({
      mappings: {
        ...state.mappings,
        [channelId]: { ...state.mappings[channelId], sourceStreamId: streamId, sourceChannel: streamChannel }
      }
    }));
  },

  setStreamChannels: (id, channels, isManual) => {
    set(state => {
      if (isManual) {
        return { manualStreams: state.manualStreams.map(s => s.id === id ? { ...s, channels } : s) };
      } else {
        return { streams: state.streams.map(s => s.id === id ? { ...s, channels } : s) };
      }
    });
  },

  setStreamPorts: (id, ports, isManual) => {
    set(state => {
      if (isManual) {
        return { manualStreams: state.manualStreams.map(s => s.id === id ? { ...s, ports } : s) };
      } else {
        return { streams: state.streams.map(s => s.id === id ? { ...s, ports } : s) };
      }
    });
  },

  clearMapping: (channelId) => {
    set(state => {
      const m = state.mappings[channelId];
      return { mappings: { ...state.mappings, [channelId]: { ...m, sourceStreamId: null, sourceChannel: 1 } } };
    });
  },

  setDiscoveredDestinations: (found) => {
    set(state => {
      const next: Aes67Stream[] = found.map(f => {
        const existing = state.discoveredDestinations.find(d => d.name === f.name && d.address === f.address);
        return existing
          ? { ...existing, lastSeen: Date.now() }
          : { id: uuid(), name: f.name, address: f.address, channels: 2, ports: [], lastSeen: Date.now() };
      });
      return { discoveredDestinations: next };
    });
  },

  addManualDestination: (name, address, channels, ports) => {
    set(state => ({
      manualDestinations: [...state.manualDestinations, {
        id: uuid(),
        name,
        address,
        channels,
        ports,
        lastSeen: Date.now()
      }]
    }));
  },

  removeManualDestination: (id) => {
    set(state => ({
      manualDestinations: state.manualDestinations.filter(d => d.id !== id)
    }));
  },

  setDestinationChannels: (id, channels, isManual) => {
    set(state => {
      if (isManual) {
        return { manualDestinations: state.manualDestinations.map(d => d.id === id ? { ...d, channels } : d) };
      } else {
        return { discoveredDestinations: state.discoveredDestinations.map(d => d.id === id ? { ...d, channels } : d) };
      }
    });
  },

  setDestinationPorts: (id, ports, isManual) => {
    set(state => {
      if (isManual) {
        return { manualDestinations: state.manualDestinations.map(d => d.id === id ? { ...d, ports } : d) };
      } else {
        return { discoveredDestinations: state.discoveredDestinations.map(d => d.id === id ? { ...d, ports } : d) };
      }
    });
  },

  setOutputMapping: (busId, destStreamId, destChannel) => {
    set(state => ({
      outputMappings: {
        ...state.outputMappings,
        [busId]: { ...state.outputMappings[busId], destStreamId, destChannel }
      }
    }));
  },

  clearOutputMapping: (busId) => {
    set(state => {
      const m = state.outputMappings[busId];
      return { outputMappings: { ...state.outputMappings, [busId]: { ...m, destStreamId: null, destChannel: 0 } } };
    });
  },

  setDaemonReachable: (reachable) => {
    set({ daemonReachable: reachable });
  },

  setMicDevices: (devices) => set({ micDevices: devices }),
  setTalkbackSourcePorts: (ports) => set({ talkbackSourcePorts: ports, talkbackMicSourceName: null, talkbackMicAlsaPortName: null }),
  toggleTalkbackDestBusId: (busId) => set(state => ({
    talkbackDestBusIds: state.talkbackDestBusIds.includes(busId)
      ? state.talkbackDestBusIds.filter(id => id !== busId)
      : [...state.talkbackDestBusIds, busId]
  })),
  setTalkbackMic: (device) => set({
    talkbackSourcePorts: device.ports,
    talkbackMicSourceName: device.sourceName,
    talkbackMicAlsaPortName: device.alsaPortName
  })
    }),
    {
      name: 'aes67-patchbay-storage',
      // Fields added after this store was first persisted won't exist in
      // older saved state; without backfilling here, code that assumes
      // they're present (e.g. `s.ports.join(...)`) throws on load and the
      // whole page fails to render.
      merge: (persisted, current) => {
        const state = { ...current, ...(persisted as Partial<PatchbayState>) };
        const withPorts = (s: Partial<Aes67Stream>): Aes67Stream =>
          ({ ...s, ports: Array.isArray(s.ports) ? s.ports : [] } as Aes67Stream);
        state.streams = (state.streams || []).map(withPorts);
        state.manualStreams = (state.manualStreams || []).map(withPorts);
        state.discoveredDestinations = (state.discoveredDestinations || []).map(withPorts);
        state.manualDestinations = (state.manualDestinations || []).map(withPorts);
        state.outputMappings = buildOutputMappings(state.outputMappings);
        state.talkbackSourcePorts = Array.isArray(state.talkbackSourcePorts) ? state.talkbackSourcePorts : [];
        // Backfill from the pre-multi-destination single `talkbackDestBusId`
        // field for state persisted before this existed.
        const legacyState = state as unknown as Record<string, unknown>;
        const legacyDestBusId = legacyState.talkbackDestBusId;
        state.talkbackDestBusIds = Array.isArray(state.talkbackDestBusIds) && state.talkbackDestBusIds.length > 0
          ? state.talkbackDestBusIds
          : (typeof legacyDestBusId === 'number' ? [legacyDestBusId] : [100]);
        delete legacyState.talkbackDestBusId;
        state.talkbackMicSourceName = typeof state.talkbackMicSourceName === 'string' ? state.talkbackMicSourceName : null;
        state.talkbackMicAlsaPortName = typeof state.talkbackMicAlsaPortName === 'string' ? state.talkbackMicAlsaPortName : null;
        state.micDevices = Array.isArray(state.micDevices) ? state.micDevices : [];
        return state;
      }
    }
  )
);

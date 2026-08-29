import React, { useState } from 'react';
import { usePatchbayStore, Aes67Stream } from '../stores/usePatchbayStore';
import { NetworkPanel } from '../components/patchbay/NetworkPanel';

const parsePorts = (text: string): string[] => text.split(',').map(p => p.trim()).filter(Boolean);

// The detailed editor for one endpoint (address, channel count, PipeWire
// ports, remove) — surfaced as a modal.
const EndpointDetailModal = ({
  item, isManual, discoveredLabel, onSetChannels, onSetPorts, onRemove, onClose
}: {
  item: Aes67Stream;
  isManual: boolean;
  discoveredLabel: string;
  onSetChannels: (id: string, channels: number, isManual: boolean) => void;
  onSetPorts: (id: string, ports: string[], isManual: boolean) => void;
  onRemove?: (id: string) => void;
  onClose: () => void;
}) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
    <div
      className="bg-[#1a1c22] border border-[#2a2d33] rounded-sm p-4 w-[360px] shrink-0 flex flex-col gap-3 shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex justify-between items-center">
        <div className="font-bold text-white text-sm truncate pr-2">{item.name}</div>
        <div className="flex items-center gap-1 shrink-0">
          <div className={`w-2 h-2 rounded-full ${isManual ? 'bg-gray-500' : 'bg-green-500 animate-pulse'}`} />
          <div className="text-[9px] font-black tracking-widest uppercase text-gray-400">{isManual ? 'MANUAL' : discoveredLabel}</div>
        </div>
      </div>
      <div className="font-mono text-cyan-400 text-xs">{item.address}</div>
      <div className="flex items-center justify-between mt-1">
        <div className="text-[10px] font-black tracking-widest uppercase text-gray-500">CHANNELS</div>
        <div className="flex items-center gap-2 bg-[#0b0c10] px-2 py-0.5 rounded border border-[#2a2d33]">
          <button onClick={() => onSetChannels(item.id, Math.max(1, item.channels - 1), isManual)} className="text-gray-400 hover:text-white pb-0.5">◀</button>
          <span className="font-mono text-white text-xs w-4 text-center">{item.channels}</span>
          <button onClick={() => onSetChannels(item.id, Math.min(64, item.channels + 1), isManual)} className="text-gray-400 hover:text-white pb-0.5">▶</button>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="text-[10px] font-black tracking-widest uppercase text-gray-500">PIPEWIRE PORTS</div>
        <input
          defaultValue={(item.ports || []).join(', ')}
          onBlur={(e) => onSetPorts(item.id, parsePorts(e.target.value), isManual)}
          placeholder="client:port_a, client:port_b"
          className="bg-[#0b0c10] border border-[#2a2d33] text-gray-300 font-mono text-xs px-2 py-1.5 rounded-sm outline-none focus:border-blue-500"
        />
        {(item.ports || []).length === 0 && (
          <div className="text-[10px] text-amber-500">No ports set — can't be routed in Patchbay yet.</div>
        )}
      </div>
      <div className="flex justify-between items-center mt-2">
        {isManual && onRemove ? (
          <button
            onClick={() => { onRemove(item.id); onClose(); }}
            className="bg-red-900 hover:bg-red-700 text-white text-[10px] font-black tracking-widest uppercase px-3 py-1.5 rounded-sm transition-colors"
          >
            REMOVE
          </button>
        ) : <div />}
        <button onClick={onClose} className="bg-gray-700 hover:bg-gray-600 text-white text-[10px] font-black tracking-widest uppercase px-3 py-1.5 rounded-sm transition-colors">
          DONE
        </button>
      </div>
    </div>
  </div>
);

// One registry card, shared by the Sources and Destinations registries.
const EndpointCard = ({
  item, isManual, discoveredLabel, onSetChannels, onSetPorts, onRemove
}: {
  item: Aes67Stream;
  isManual: boolean;
  discoveredLabel: string;
  onSetChannels: (id: string, channels: number, isManual: boolean) => void;
  onSetPorts: (id: string, ports: string[], isManual: boolean) => void;
  onRemove?: (id: string) => void;
}) => {
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <div className="bg-[#1a1c22] border border-[#2a2d33] rounded-sm px-3 py-2.5 w-[180px] shrink-0 flex items-center gap-2 shadow-sm">
      <div className={`w-2 h-2 rounded-full shrink-0 ${isManual ? 'bg-gray-500' : 'bg-green-500 animate-pulse'}`} />
      <button
        onClick={() => setDetailOpen(true)}
        className="font-bold text-white text-xs truncate hover:text-blue-400 hover:underline text-left min-w-0 flex-1"
        title="Click for advanced configuration"
      >
        {item.name}
      </button>
      <div className="ml-auto shrink-0 font-mono text-[9px] text-gray-400 bg-[#0b0c10] border border-[#2a2d33] rounded px-1.5 py-0.5">
        {item.channels}CH
      </div>

      {detailOpen && (
        <EndpointDetailModal
          item={item}
          isManual={isManual}
          discoveredLabel={discoveredLabel}
          onSetChannels={onSetChannels}
          onSetPorts={onSetPorts}
          onRemove={onRemove}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </div>
  );
};

// The "+ ADD ..." popover form.
const AddEndpointForm = ({ onAdd, onCancel, type }: {
  onAdd: (name: string, address: string, channels: number, ports: string[]) => void;
  onCancel: () => void;
  type: 'stream' | 'destination';
}) => {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [channels, setChannels] = useState(2);
  const [ports, setPorts] = useState('');

  return (
    <div className="bg-[#1a1c22] border-t border-[#2a2d33] p-3 flex items-end gap-4 flex-wrap">
      <div className="flex flex-col gap-1">
        <label className="text-[9px] font-black tracking-widest uppercase text-gray-400">NAME</label>
        <input value={name} onChange={e => setName(e.target.value)} className="bg-[#0b0c10] border border-[#2a2d33] text-white text-xs px-2 py-1.5 rounded-sm w-44 outline-none focus:border-blue-500" placeholder={type === 'stream' ? 'Stage Mic 1-2' : 'PA System'} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[9px] font-black tracking-widest uppercase text-gray-400">MULTICAST IP</label>
        <input value={address} onChange={e => setAddress(e.target.value)} className="bg-[#0b0c10] border border-[#2a2d33] text-white font-mono text-xs px-2 py-1.5 rounded-sm w-36 outline-none focus:border-blue-500" placeholder="239.69.0.1:5004" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[9px] font-black tracking-widest uppercase text-gray-400">CHANNELS</label>
        <div className="flex items-center gap-2 bg-[#0b0c10] px-2 py-1 rounded border border-[#2a2d33]">
          <button onClick={() => setChannels(Math.max(1, channels - 1))} className="text-gray-400 hover:text-white pb-0.5">◀</button>
          <span className="font-mono text-white text-xs w-4 text-center">{channels}</span>
          <button onClick={() => setChannels(Math.min(64, channels + 1))} className="text-gray-400 hover:text-white pb-0.5">▶</button>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[9px] font-black tracking-widest uppercase text-gray-400">PIPEWIRE PORTS</label>
        <input value={ports} onChange={e => setPorts(e.target.value)} className="bg-[#0b0c10] border border-[#2a2d33] text-white font-mono text-xs px-2 py-1.5 rounded-sm w-64 outline-none focus:border-blue-500" placeholder="AES67_Source:capture_AUX0, ..." />
      </div>
      <button
        onClick={() => { if (name && address) { onAdd(name, address, channels, parsePorts(ports)); } }}
        className="bg-green-600 hover:bg-green-500 text-white text-[10px] font-black tracking-widest uppercase px-4 py-2 rounded-sm transition-colors mb-0.5"
      >
        ADD {type === 'stream' ? 'SOURCE' : 'DESTINATION'}
      </button>
      <button onClick={onCancel} className="bg-gray-700 hover:bg-gray-600 text-white text-[10px] font-black tracking-widest uppercase px-4 py-2 rounded-sm transition-colors mb-0.5">CANCEL</button>
    </div>
  );
};

export const Aes67NetworkView: React.FC = () => {
  const {
    streams, manualStreams, daemonSinkStreams,
    discoveredDestinations, manualDestinations, daemonReachable,
    addManualStream, removeManualStream,
    setStreamChannels, setStreamPorts,
    addManualDestination, removeManualDestination,
    setDestinationChannels, setDestinationPorts
  } = usePatchbayStore();

  const [showAddSourceForm, setShowAddSourceForm] = useState(false);
  const [showAddDestForm, setShowAddDestForm] = useState(false);

  // Filter streams to only active ones (seen in last 60s)
  const now = Date.now();
  const activeStreams = (streams || []).filter(s => (now - (s.lastSeen || 0)) < 60000);

  // Deduplicate discovered streams against subscribed sinks and manual streams
  const uniqueDiscoveredStreams = activeStreams.filter(ds =>
    !daemonSinkStreams.some(ss => ss.name === ds.name || ss.address === ds.address) &&
    !manualStreams.some(ms => ms.name === ds.name || ms.address === ds.address)
  );

  const allStreams = [...daemonSinkStreams, ...uniqueDiscoveredStreams, ...manualStreams];
  const allDestinations = [...discoveredDestinations, ...manualDestinations];

  return (
    <div className="h-full flex flex-col bg-[#0b0c10] text-white overflow-y-auto custom-scrollbar">
      {/* Top Header */}
      <div className="shrink-0 flex justify-between items-center px-6 py-2.5 border-b border-gray-800 bg-[#111318]">
        <div className="flex items-center gap-3">
          <div className="text-xs font-black tracking-widest uppercase text-white">AES67 NETWORK CONFIGURATION</div>
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#1a1c22] border border-[#2a2d33]">
            <div className={`w-2 h-2 rounded-full ${daemonReachable ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`} />
            <span className="text-[10px] font-mono text-gray-300">{daemonReachable ? 'DAEMON ONLINE' : 'DAEMON OFFLINE'}</span>
          </div>
        </div>
      </div>

      {/* Main Unified Network Panel (PTP clock, Receive Sinks, Transmit Sources) */}
      <div className="shrink-0 border-b border-gray-800">
        <NetworkPanel />
      </div>

      {/* Sources and Destinations Registries */}
      <div className="flex flex-col md:flex-row border-b border-gray-800 shrink-0">
        {/* SOURCES / STREAMS (Left) */}
        <div className="flex-1 flex flex-col border-b md:border-b-0 md:border-r-2 border-black relative min-w-0 bg-[#0f1015]">
          <div className="shrink-0 flex justify-between items-center px-6 py-2.5 border-b border-[#1a1c22] bg-[#111318]">
            <div className="flex items-center gap-2">
              <div className="text-[10px] font-black tracking-widest uppercase text-gray-400">SOURCES &amp; INPUT STREAMS ({allStreams.length})</div>
            </div>
            <button
              onClick={() => setShowAddSourceForm(!showAddSourceForm)}
              className="bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black tracking-widest uppercase px-3 py-1 rounded-sm transition-colors"
            >
              + ADD STREAM
            </button>
          </div>

          <div className="p-4 flex flex-wrap gap-3 items-start bg-[#111318] min-h-[120px]">
            {allStreams.length === 0 ? (
              <div className="text-gray-500 text-xs italic m-auto py-6">
                No AES67 streams discovered yet. Add streams manually or subscribe to network streams in the panel above.
              </div>
            ) : (
              <>
                {daemonSinkStreams.map(s => (
                  <EndpointCard key={s.id} item={s} isManual={false} discoveredLabel="SINK" onSetChannels={setStreamChannels} onSetPorts={setStreamPorts} />
                ))}
                {uniqueDiscoveredStreams.map(s => (
                  <EndpointCard key={s.id} item={s} isManual={false} discoveredLabel="DISC." onSetChannels={setStreamChannels} onSetPorts={setStreamPorts} />
                ))}
                {manualStreams.map(s => (
                  <EndpointCard key={s.id} item={s} isManual={true} discoveredLabel="MANUAL" onSetChannels={setStreamChannels} onSetPorts={setStreamPorts} onRemove={removeManualStream} />
                ))}
              </>
            )}
          </div>

          {showAddSourceForm && (
            <AddEndpointForm
              type="stream"
              onAdd={(name, address, ch, ports) => { addManualStream(name, address, ch, ports); setShowAddSourceForm(false); }}
              onCancel={() => setShowAddSourceForm(false)}
            />
          )}

          <div className="shrink-0 bg-[#111318] border-t border-[#1a1c22] p-2 text-center text-[10px] text-gray-500">
            "SINK" cards are active subscribed receivers mapped to PipeWire capture ports. Route them to channels in the Patchbay.
          </div>
        </div>

        {/* DESTINATIONS (Right) */}
        <div className="flex-1 flex flex-col relative min-w-0 bg-[#0f1015]">
          <div className="shrink-0 flex justify-between items-center px-6 py-2.5 border-b border-[#1a1c22] bg-[#111318]">
            <div className="flex items-center gap-2">
              <div className="text-[10px] font-black tracking-widest uppercase text-gray-400">DESTINATIONS &amp; TRANSMIT TARGETS ({allDestinations.length})</div>
            </div>
            <button
              onClick={() => setShowAddDestForm(!showAddDestForm)}
              className="bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black tracking-widest uppercase px-3 py-1 rounded-sm transition-colors"
            >
              + ADD DESTINATION
            </button>
          </div>

          <div className="p-4 flex flex-wrap gap-3 items-start bg-[#111318] min-h-[120px]">
            {allDestinations.length === 0 ? (
              <div className="text-gray-500 text-xs italic m-auto py-6">
                No AES67 destinations configured. Add one manually or create transmit sources above.
              </div>
            ) : (
              <>
                {discoveredDestinations.map(d => (
                  <EndpointCard key={d.id} item={d} isManual={false} discoveredLabel="DAEMON" onSetChannels={setDestinationChannels} onSetPorts={setDestinationPorts} />
                ))}
                {manualDestinations.map(d => (
                  <EndpointCard key={d.id} item={d} isManual={true} discoveredLabel="MANUAL" onSetChannels={setDestinationChannels} onSetPorts={setDestinationPorts} onRemove={removeManualDestination} />
                ))}
              </>
            )}
          </div>

          {showAddDestForm && (
            <AddEndpointForm
              type="destination"
              onAdd={(name, address, ch, ports) => { addManualDestination(name, address, ch, ports); setShowAddDestForm(false); }}
              onCancel={() => setShowAddDestForm(false)}
            />
          )}

          <div className="shrink-0 bg-[#111318] border-t border-[#1a1c22] p-2 text-center text-[10px] text-gray-500">
            "DAEMON" cards are configured Sources polled from aes67-linux-daemon — feed Master/Aux buses to them in Patchbay.
          </div>
        </div>
      </div>
    </div>
  );
};

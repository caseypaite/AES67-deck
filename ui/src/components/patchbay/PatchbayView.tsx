import React, { useEffect, useRef, useState } from 'react';
import { usePatchbayStore, Aes67Stream, ChannelMapping, MicDevice } from '../../stores/usePatchbayStore';
import { useMixerStore, MONITOR_ID } from '../../stores/useMixerStore';

const MIC_KIND_LABEL: Record<MicDevice['kind'], string> = {
  builtin: 'Built-in',
  usb: 'USB',
  jack: 'Mic Jack',
  other: 'Other'
};

const parsePorts = (text: string): string[] => text.split(',').map(p => p.trim()).filter(Boolean);

// Fixed topology: Master (100) + 8 Aux buses (101..108). Kept local rather
// than imported so this file's meaning is self-evident; must match
// engine/src/main.cpp and server/src/index.ts.
const OUTPUT_BUS_IDS = [100, 101, 102, 103, 104, 105, 106, 107, 108];
const TALKBACK_DEST_OPTIONS = [
  { id: 100, label: 'MASTER' },
  ...Array.from({ length: 8 }, (_, i) => ({ id: 101 + i, label: `AUX ${i + 1}` }))
];

// Shares a row with Signal Monitor, so this stays compact: everything
// stacked in two tight rows rather than one wide flex-wrap strip.
const MIC_KIND_ORDER: MicDevice['kind'][] = ['builtin', 'jack', 'usb', 'other'];

// Talkback's destination buses as a row of toggle buttons — no dropdown, no
// popover, nothing that can get clipped by TalkbackSection's own scroll
// container. Each button is its own checkbox-equivalent (pressed = selected)
// and wraps onto a second line if the panel's too narrow to fit all 9.
const TalkbackDestButtons = ({ selected, onToggle }: {
  selected: number[];
  onToggle: (busId: number) => void;
}) => (
  <div className="flex flex-wrap gap-1">
    {TALKBACK_DEST_OPTIONS.map(o => {
      const active = selected.includes(o.id);
      return (
        <button
          key={o.id}
          type="button"
          aria-pressed={active}
          onClick={() => onToggle(o.id)}
          className={`px-2 py-1 rounded-sm text-[10px] font-black tracking-widest uppercase border transition-colors
            ${active ? 'bg-blue-600 border-blue-500 text-white' : 'bg-[#0b0c10] border-[#2a2d33] text-gray-400 hover:bg-[#1a1c22] hover:text-white'}`}
        >
          {o.label}
        </button>
      );
    })}
  </div>
);

const TalkbackSection = () => {
  const talkbackSourcePorts = usePatchbayStore(state => state.talkbackSourcePorts);
  const talkbackDestBusIds = usePatchbayStore(state => state.talkbackDestBusIds);
  const talkbackMicSourceName = usePatchbayStore(state => state.talkbackMicSourceName);
  const talkbackMicAlsaPortName = usePatchbayStore(state => state.talkbackMicAlsaPortName);
  const micDevices = usePatchbayStore(state => state.micDevices);
  const setTalkbackSourcePorts = usePatchbayStore(state => state.setTalkbackSourcePorts);
  const toggleTalkbackDestBusId = usePatchbayStore(state => state.toggleTalkbackDestBusId);
  const setTalkbackMic = usePatchbayStore(state => state.setTalkbackMic);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const selectedMicId = micDevices.find(d =>
    d.sourceName === talkbackMicSourceName && d.alsaPortName === talkbackMicAlsaPortName
  )?.id || '';

  const [pressed, setPressed] = useState(false);
  const pressedRef = useRef(false);

  const sendTalkbackActive = (active: boolean) => {
    const ws = useMixerStore.getState().ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // channel:110 is the engine's fixed Talkback id (TALKBACK_ID) — not a
      // real mixer channel, just how this command addresses the engine.
      ws.send(JSON.stringify({ type: 'set_talkback_active', channel: 110, value: active ? 1 : 0 }));
    }
  };

  const start = () => {
    if (pressedRef.current) return;
    pressedRef.current = true;
    setPressed(true);
    sendTalkbackActive(true);
  };

  const stop = () => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    setPressed(false);
    sendTalkbackActive(false);
  };

  useEffect(() => {
    // Safety net beyond the button's own handlers: release on a window-level
    // mouseup/touchend (covers the pointer leaving the button before
    // release) and on losing focus/visibility entirely, so the mic can never
    // stay open by accident.
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchend', stop);
    window.addEventListener('touchcancel', stop);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', stop);
    return () => {
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('touchend', stop);
      window.removeEventListener('touchcancel', stop);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', stop);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyTalkbackConfig = () => {
    const ws = useMixerStore.getState().ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'sync_talkback_config',
        sourcePorts: talkbackSourcePorts,
        destBusIds: talkbackDestBusIds,
        micSourceName: talkbackMicSourceName,
        micAlsaPortName: talkbackMicAlsaPortName
      }));
    }
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden h-[210px]">
      <div className="shrink-0 px-3 py-2 border-b border-[#1a1c22] bg-[#111318] flex items-center justify-between">
        <div className="text-[10px] font-black tracking-widest uppercase text-gray-400">TALKBACK</div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowAdvanced(a => !a)}
            className={`text-[9px] font-black tracking-widest uppercase px-2 py-1 rounded-sm transition-colors ${showAdvanced ? 'bg-[#2a2d33] text-white' : 'bg-[#1a1c22] text-gray-400 hover:bg-[#242832]'}`}
          >
            ADVANCED
          </button>
          <button onClick={applyTalkbackConfig} className="bg-blue-600 hover:bg-blue-500 text-white text-[9px] font-black tracking-widest uppercase px-2 py-1 rounded-sm transition-colors">
            SAVE
          </button>
        </div>
      </div>
      <div className="flex-1 p-3 flex flex-col gap-2 overflow-y-auto custom-scrollbar bg-[#0a0a0c]">
        <div className="flex flex-col gap-1">
          <label className="text-[9px] font-black tracking-widest uppercase text-gray-500">MICROPHONE</label>
          <select
            value={selectedMicId}
            onChange={(e) => {
              const dev = micDevices.find(d => d.id === e.target.value);
              if (dev) setTalkbackMic(dev);
            }}
            className="bg-[#0b0c10] border border-[#2a2d33] text-white text-xs px-2 py-1.5 rounded-sm w-full outline-none focus:border-blue-500"
          >
            <option value="">-- MANUAL PORTS BELOW --</option>
            {MIC_KIND_ORDER.map(kind => {
              const inKind = micDevices.filter(d => d.kind === kind);
              if (inKind.length === 0) return null;
              return (
                <optgroup key={kind} label={MIC_KIND_LABEL[kind]}>
                  {inKind.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                </optgroup>
              );
            })}
          </select>
          {micDevices.length === 0 && (
            <div className="text-[9px] text-gray-500">No local capture devices detected yet.</div>
          )}
        </div>
        {showAdvanced && (
          <div className="flex flex-col gap-1">
            <label className="text-[9px] font-black tracking-widest uppercase text-gray-500">SYSTEM AUDIO INPUT (MIC) PORTS</label>
            <input
              key={talkbackSourcePorts.join(',')}
              defaultValue={talkbackSourcePorts.join(', ')}
              onBlur={(e) => setTalkbackSourcePorts(parsePorts(e.target.value))}
              placeholder="client:capture_MONO or client:capture_FL, client:capture_FR"
              className="bg-[#0b0c10] border border-[#2a2d33] text-gray-300 font-mono text-xs px-2 py-1.5 rounded-sm w-full outline-none focus:border-blue-500"
            />
          </div>
        )}
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1 min-w-0">
            <label className="text-[9px] font-black tracking-widest uppercase text-gray-500">SEND TO</label>
            <TalkbackDestButtons selected={talkbackDestBusIds} onToggle={toggleTalkbackDestBusId} />
          </div>
          <button
            onMouseDown={start}
            onMouseUp={stop}
            onMouseLeave={stop}
            onTouchStart={(e) => { e.preventDefault(); start(); }}
            onTouchEnd={stop}
            onTouchCancel={stop}
            className={`shrink-0 w-24 h-10 rounded-[10px] border-2 flex items-center justify-center font-black text-[10px] uppercase tracking-widest select-none transition-all
              ${pressed
                ? 'bg-red-600 border-red-400 text-white translate-y-[2px] shadow-[0_1px_0_#7f1d1d,0_0_12px_rgba(255,0,0,0.7)] animate-pulse'
                : 'bg-gradient-to-b from-amber-500 to-amber-700 border-amber-400 text-amber-950 shadow-[0_4px_0_#78350f,0_6px_8px_rgba(0,0,0,0.5)] hover:from-amber-400 hover:to-amber-600'}`}
          >
            {pressed ? 'ON AIR' : 'HOLD TO TALK'}
          </button>
        </div>
        <div className="text-[9px] text-gray-500">
          Not one of the 32 channels. Silent unless held. Never reaches Monitor.
        </div>
      </div>
    </div>
  );
};

// dB peak -> 0..100 display percentage, matching the SIGNAL MONITOR strip
// below exactly (same -60..+10dB window) so an operator reads the same
// level the same way in both places.
const meterPercentage = (peak: number) => Math.max(0, Math.min(100, (peak + 60) * (100 / 70)));

const METER_GRADIENT = {
  background: 'linear-gradient(to right, #00cc99 0%, #00cc99 71%, #eab308 71%, #eab308 86%, #f97316 86%, #f97316 93%, #ef4444 93%, #ef4444 100%)',
};

// Compact stereo bar meter for a single bus row (Master/Aux/Monitor) — the
// horizontal counterpart to SIGNAL MONITOR's vertical per-channel bars,
// sized to sit inline in a table row instead of its own wide strip. Same
// "fixed gradient + a covering mask that shrinks with level" technique so
// color-at-position stays tied to the absolute dB scale, not the bar's own
// current length.
const BusLevelMeter = ({ meterL, meterR }: { meterL: number; meterR: number }) => {
  const bar = (peak: number, key: 'L' | 'R') => (
    <div key={key} className="h-[5px] bg-[#111] rounded-[1px] overflow-hidden relative">
      <div className="absolute inset-0" style={METER_GRADIENT} />
      <div
        className="absolute top-0 bottom-0 right-0 bg-[#111] transition-all duration-150 ease-out"
        style={{ width: `${100 - meterPercentage(peak)}%` }}
      />
    </div>
  );
  return (
    <div className="flex flex-col gap-[2px] w-20 bg-[#050505] border border-[#222] rounded-sm p-[3px] shadow-[inset_0_1px_4px_rgba(0,0,0,0.8)]">
      {bar(meterL, 'L')}
      {bar(meterR, 'R')}
    </div>
  );
};

export const PatchbayView = () => {
  const channels = useMixerStore(state => state.channels);
  const channelsArray = Object.values(channels).filter(ch => ch.type === 'input').sort((a, b) => a.id - b.id);

  const {
    streams, manualStreams, mappings, daemonSinkStreams,
    discoveredDestinations, manualDestinations, outputMappings,
    setSourceMapping, setOutputMapping
  } = usePatchbayStore();

  // Filter streams to only active ones (seen in the last 60 seconds)
  const now = Date.now();
  const activeStreams = (streams || []).filter(s => (now - (s.lastSeen || 0)) < 60000);

  // If a stream is already subscribed as a daemon sink, or exists as a manual stream with same name/address,
  // do not duplicate it as an unrouted discovered stream.
  const uniqueDiscoveredStreams = activeStreams.filter(ds =>
    !daemonSinkStreams.some(ss => ss.name === ds.name || ss.address === ds.address) &&
    !manualStreams.some(ms => ms.name === ds.name || ms.address === ds.address)
  );

  // daemonSinkStreams: subscribed AES67 receive Sinks, ports pre-filled by the
  // server. Read-only here — created/removed from the NETWORK panel above.
  const allStreams = [...daemonSinkStreams, ...uniqueDiscoveredStreams, ...manualStreams];
  const allDestinations = [...discoveredDestinations, ...manualDestinations];

  const applyPatchbayMatrix = () => {
    const ws = useMixerStore.getState().ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Resolve each mapping's chosen stream/destination into the real
    // PipeWire ports to link, so the server doesn't need to know about
    // either registry.
    const resolvedMappings: Record<number, ChannelMapping & { sourcePorts?: string[] }> = {};
    Object.entries(mappings).forEach(([chId, m]) => {
      const stream = m.sourceStreamId ? allStreams.find(s => s.id === m.sourceStreamId) : null;
      resolvedMappings[Number(chId)] = { ...m, sourcePorts: stream ? stream.ports : undefined };
    });

    // destChannel: 0 = Stereo (distinct L/R pairing), -1 = Mono (identical
    // downmix duplicated across every destination port), >=1 = a single
    // specific destination channel picked by hand.
    const resolvedOutputs: Record<number, { ports: string[]; mono?: boolean }> = {};
    Object.entries(outputMappings).forEach(([busId, om]) => {
      const dest = om.destStreamId ? allDestinations.find(d => d.id === om.destStreamId) : null;
      if (!dest || dest.ports.length === 0) return;
      if (om.destChannel === 0 && dest.ports.length >= 2) {
        resolvedOutputs[Number(busId)] = { ports: [dest.ports[0], dest.ports[1]] };
      } else if (om.destChannel === -1) {
        resolvedOutputs[Number(busId)] = { ports: dest.ports, mono: true };
      } else if (om.destChannel >= 1) {
        const p = dest.ports[om.destChannel - 1];
        if (p) resolvedOutputs[Number(busId)] = { ports: [p] };
      }
    });

    ws.send(JSON.stringify({ type: 'sync_patchbay_matrix', mappings: resolvedMappings, outputs: resolvedOutputs }));
  };

  return (
    <div className="h-full flex flex-col bg-[#0b0c10] text-white overflow-hidden">
      {/* Shared header: applies both sources and destinations at once */}
      <div className="shrink-0 flex justify-between items-center px-6 py-2.5 border-b border-gray-800 bg-[#111318]">
        <div className="flex items-center gap-3">
          <div className="text-[10px] font-black tracking-widest uppercase text-gray-400">AUDIO PATCHBAY &amp; MATRIX ROUTING</div>
        </div>
        <button onClick={applyPatchbayMatrix} className="bg-green-600 hover:bg-green-500 text-white text-[10px] font-black tracking-widest uppercase px-4 py-1.5 rounded-sm transition-colors shadow-sm">
          APPLY ROUTING
        </button>
      </div>

      {/* Row: Signal Monitor | Talkback, side by side */}
      <div className="shrink-0 flex border-b border-gray-800">
        <div className="flex-1 min-w-0 border-r-2 border-black bg-[#0a0a0c] p-3 flex flex-col h-[210px]">
          <div className="text-[10px] font-black tracking-widest uppercase text-gray-400 mb-1.5">SIGNAL MONITOR</div>
          <div className="flex-1 flex gap-[2px] items-end w-full overflow-x-auto border border-[#222] p-1.5 rounded-sm shadow-[inset_0_2px_10px_rgba(0,0,0,1)] bg-[#050505]">
            {channelsArray.map(ch => {
              const m = mappings[ch.id];
              const stream = m?.sourceStreamId ? allStreams.find(s => s.id === m.sourceStreamId) : null;

              const getPercentage = (peak: number) => Math.max(0, Math.min(100, (peak + 60) * (100/70)));
              const gradientStyle = {
                 background: 'linear-gradient(to top, #00cc99 0%, #00cc99 71%, #eab308 71%, #eab308 86%, #f97316 86%, #f97316 93%, #ef4444 93%, #ef4444 100%)',
                 opacity: 0.9
              };

              return (
                <div key={ch.id} className="flex flex-col items-center justify-end h-full min-w-[10px] flex-1 gap-1">
                  <div className="w-full flex items-end justify-center bg-[#111] h-full rounded-[1px] overflow-hidden relative">
                    {(!stream) && (
                      <div className="w-full bg-gray-800 absolute bottom-0" style={{ height: '2%', opacity: 0.2 }} />
                    )}
                    {(stream && stream.channels === 1) && (
                      <div className="w-full h-full relative">
                        <div className="absolute inset-0" style={gradientStyle} />
                        <div className="absolute top-0 left-0 right-0 bg-[#111] transition-all duration-[150ms] ease-out" style={{ height: `${100 - getPercentage(Math.max(ch.meterL, ch.meterR))}%` }} />
                      </div>
                    )}
                    {(stream && stream.channels >= 2) && (
                      <div className="w-full h-full flex gap-[1px]">
                        {/* Left Half */}
                        <div className="flex-1 h-full relative">
                          {(m.sourceChannel === 0 || m.sourceChannel === 1) && (
                             <>
                               <div className="absolute inset-0" style={gradientStyle} />
                               <div className="absolute top-0 left-0 right-0 bg-[#111] transition-all duration-[150ms] ease-out" style={{ height: `${100 - getPercentage(ch.meterL)}%` }} />
                             </>
                          )}
                        </div>
                        {/* Right Half */}
                        <div className="flex-1 h-full relative">
                          {(m.sourceChannel === 0 || m.sourceChannel === 2) && (
                             <>
                               <div className="absolute inset-0" style={gradientStyle} />
                               <div className="absolute top-0 left-0 right-0 bg-[#111] transition-all duration-[150ms] ease-out" style={{ height: `${100 - getPercentage(m.sourceChannel === 2 ? ch.meterL : ch.meterR)}%` }} />
                             </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className={`text-[9px] font-bold tracking-tighter leading-none select-none ${stream ? 'text-gray-300' : 'text-gray-600'}`}>{ch.id}</div>
                </div>
              );
            })}
          </div>
        </div>

        <TalkbackSection />
      </div>

      {/* Row: Input sources configuration | Output - Master & Aux configuration, side by side */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className="flex-1 flex flex-col overflow-hidden border-r-2 border-black min-w-0">
          <div className="shrink-0 px-4 py-2 border-b border-[#1a1c22] bg-[#111318]">
            <div className="text-[10px] font-black tracking-widest uppercase text-gray-400">INPUT SOURCES CONFIGURATION</div>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0">
            <table className="w-full text-left border-collapse">
              <thead className="bg-[#1a1c22] sticky top-0 z-10 border-b border-[#2a2d33]">
                <tr>
                  <th className="py-2 px-3 text-[10px] font-black tracking-widest uppercase text-gray-500 w-14">CH</th>
                  <th className="py-2 px-3 text-[10px] font-black tracking-widest uppercase text-gray-500 w-32">NAME</th>
                  <th className="py-2 px-3 text-[10px] font-black tracking-widest uppercase text-gray-500">SOURCE (AES67 IN)</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(mappings).map(k => Number(k)).sort((a,b) => a-b).map((chId, idx) => {
                  const m = mappings[chId];
                  const chName = channels[chId]?.name || `IN ${chId}`;
                  const sourceStream = allStreams.find(s => s.id === m.sourceStreamId);

                  return (
                    <tr key={chId} className={`${idx % 2 === 0 ? 'bg-[#0f1015]' : 'bg-[#111318]'} border-b border-[#1a1c22] hover:bg-[#1a1c22] transition-colors`}>
                      <td className="py-2 px-3">
                        <div className="bg-[#111] border border-[#222] text-gray-400 text-[10px] font-black uppercase tracking-widest text-center py-0.5 rounded shadow-sm w-8">
                          {chId}
                        </div>
                      </td>
                      <td className="py-2 px-3 text-xs font-bold text-gray-300 truncate">{chName}</td>
                      <td className="py-2 px-3">
                        <div className="flex gap-2">
                          <select
                            value={m.sourceStreamId || ''}
                            onChange={(e) => setSourceMapping(chId, e.target.value || null, 1)}
                            className="bg-[#1a1c22] border border-[#2a2d33] text-white rounded-sm px-2 py-1 text-xs w-40 focus:outline-none focus:border-blue-500"
                          >
                            <option value="">-- NONE --</option>
                            {allStreams.map(s => (
                              <option key={s.id} value={s.id}>{s.name} ({s.address})</option>
                            ))}
                          </select>
                          {sourceStream && (
                            <select
                              value={m.sourceChannel}
                              onChange={(e) => setSourceMapping(chId, m.sourceStreamId, Number(e.target.value))}
                              className="bg-[#1a1c22] border border-[#2a2d33] text-cyan-400 rounded-sm px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
                            >
                              {sourceStream.channels >= 2 && <option value={0}>Stereo</option>}
                              {Array.from({length: sourceStream.channels}).map((_, i) => (
                                <option key={i+1} value={i+1}>ch.{i+1}</option>
                              ))}
                            </select>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* OUTPUT — mirrors INPUT SOURCES CONFIGURATION: the Master & Aux
            routing table, now with a LEVEL meter per bus, plus a dedicated
            Monitor meter row below (Monitor has no destination selector
            here — its destination is fixed to the system's audio out
            device — but the operator still needs to see it's live). Its
            Destination Registry lives in the combined DESTINATIONS/SOURCES
            panel above. */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <div className="shrink-0 px-4 py-2 border-b border-[#1a1c22] bg-[#111318]">
            <div className="text-[10px] font-black tracking-widest uppercase text-gray-400">OUTPUT — MASTER &amp; AUX</div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0">
            <table className="w-full text-left border-collapse">
              <thead className="bg-[#1a1c22] sticky top-0 z-10 border-b border-[#2a2d33]">
                <tr>
                  <th className="py-2 px-3 text-[10px] font-black tracking-widest uppercase text-gray-500 w-14">BUS</th>
                  <th className="py-2 px-3 text-[10px] font-black tracking-widest uppercase text-gray-500 w-32">NAME</th>
                  <th className="py-2 px-3 text-[10px] font-black tracking-widest uppercase text-gray-500 w-24">LEVEL</th>
                  <th className="py-2 px-3 text-[10px] font-black tracking-widest uppercase text-gray-500">DESTINATION (AES67 OUT)</th>
                </tr>
              </thead>
              <tbody>
                {OUTPUT_BUS_IDS.map((busId, idx) => {
                  const om = outputMappings[busId];
                  const busName = channels[busId]?.name || (busId === 100 ? 'MASTER' : `AUX ${busId - 100}`);
                  const destStream = allDestinations.find(d => d.id === om.destStreamId);

                  return (
                    <tr key={busId} className={`${idx % 2 === 0 ? 'bg-[#0f1015]' : 'bg-[#111318]'} border-b border-[#1a1c22] hover:bg-[#1a1c22] transition-colors`}>
                      <td className="py-2 px-3">
                        <div className="bg-[#111] border border-[#222] text-gray-400 text-[10px] font-black uppercase tracking-widest text-center py-0.5 rounded shadow-sm w-10">
                          {busId === 100 ? 'MST' : `A${busId - 100}`}
                        </div>
                      </td>
                      <td className="py-2 px-3 text-xs font-bold text-gray-300 truncate">{busName}</td>
                      <td className="py-2 px-3">
                        <BusLevelMeter meterL={channels[busId]?.meterL ?? -100} meterR={channels[busId]?.meterR ?? -100} />
                      </td>
                      <td className="py-2 px-3">
                        <div className="flex gap-2">
                          <select
                            value={om.destStreamId || ''}
                            onChange={(e) => {
                              const newDest = allDestinations.find(d => d.id === e.target.value);
                              // 2+ channels defaults to Stereo; a mono
                              // destination defaults to Mono — the operator
                              // can still pick a specific ch.1/ch.2 by hand.
                              const defaultChannel = newDest && newDest.channels >= 2 ? 0 : -1;
                              setOutputMapping(busId, e.target.value || null, defaultChannel);
                            }}
                            className="bg-[#1a1c22] border border-[#2a2d33] text-white rounded-sm px-2 py-1 text-xs w-40 focus:outline-none focus:border-blue-500"
                          >
                            <option value="">-- NONE --</option>
                            {allDestinations.map(d => (
                              <option key={d.id} value={d.id}>{d.name} ({d.address})</option>
                            ))}
                          </select>
                          {destStream && (
                            <select
                              value={om.destChannel}
                              onChange={(e) => setOutputMapping(busId, om.destStreamId, Number(e.target.value))}
                              className="bg-[#1a1c22] border border-[#2a2d33] text-cyan-400 rounded-sm px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
                            >
                              {destStream.channels >= 2 && <option value={0}>Stereo</option>}
                              <option value={-1}>Mono</option>
                              {Array.from({length: destStream.channels}).map((_, i) => (
                                <option key={i+1} value={i+1}>ch.{i+1}</option>
                              ))}
                            </select>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Monitor isn't one of the routable buses above (no destination
              to pick — it always goes to the system's audio out device),
              but the operator still needs to see it's carrying signal. */}
          <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-t border-[#1a1c22] bg-[#0f1015]">
            <div className="bg-[#111] border border-[#222] text-gray-400 text-[10px] font-black uppercase tracking-widest text-center py-0.5 rounded shadow-sm w-10">MON</div>
            <div className="text-xs font-bold text-gray-300 w-32 truncate">{channels[MONITOR_ID]?.name || 'MONITOR'}</div>
            <BusLevelMeter meterL={channels[MONITOR_ID]?.meterL ?? -100} meterR={channels[MONITOR_ID]?.meterR ?? -100} />
            <div className="text-[9px] text-gray-500 flex-1 min-w-0">Fixed to the system's audio out device.</div>
          </div>
        </div>
      </div>
    </div>
  );
};

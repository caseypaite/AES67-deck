import React, { useState } from 'react';
import { usePatchbayStore } from '../../stores/usePatchbayStore';
import { useMixerStore } from '../../stores/useMixerStore';

// Unified aes67-linux-daemon control, surfaced inside the deck so the operator
// never has to open the separate daemon WebUI on :8080. Read-only PTP/clock
// status, create/delete for receive Sinks (auto-mapped onto mixer input
// channels), and the fixed transmit groups (Master / Monitor / AUX 1..8, each
// its own stereo stream). All state comes from the server's `daemon_state`
// broadcast; every mutation is a WS message the server proxies to the daemon.

const send = (msg: Record<string, unknown>) => {
  const ws = useMixerStore.getState().ws;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

// Pull the multicast address out of an SDP's connection line, for display.
const sdpAddress = (sdp: string): string => {
  const m = /c=IN IP4 ([0-9.]+)/.exec(sdp || '');
  return m ? m[1] : '';
};

// "AES67_Source:capture_AUX4" -> 4
const captureIndex = (port: string): number | null => {
  const m = /capture_AUX(\d+)$/.exec(port);
  return m ? Number(m[1]) : null;
};

// Compact "AUX4–AUX7" (or "AUX4" for one) from a capturePorts list.
const captureRange = (ports: string[] | undefined): string => {
  if (!ports || ports.length === 0) return '—';
  const idx = ports.map(captureIndex).filter((n): n is number => n != null);
  if (idx.length === 0) return '—';
  const lo = Math.min(...idx);
  const hi = Math.max(...idx);
  return lo === hi ? `AUX${lo}` : `AUX${lo}–AUX${hi}`;
};

const HEADER = 'text-[10px] font-black tracking-widest uppercase text-gray-400';
const SUBHEAD = 'text-[10px] font-black tracking-widest uppercase text-gray-500';
const INPUT =
  'bg-[#0b0c10] border border-[#2a2d33] text-white text-xs px-2 py-1 rounded-sm outline-none focus:border-blue-500';

const PtpBlock = () => {
  const ptp = usePatchbayStore((s) => s.ptpStatus);
  const config = usePatchbayStore((s) => s.daemonConfig);
  const reachable = usePatchbayStore((s) => s.daemonReachable);

  const locked = ptp?.status === 'locked';
  const iface = (config?.interface_name as string) || '—';
  const playout = config?.playout_delay != null ? String(config.playout_delay) : '—';

  return (
    <div className="flex flex-col gap-2">
      <div className={SUBHEAD}>PTP / CLOCK</div>
      {!reachable ? (
        <div className="text-[11px] text-amber-500 bg-amber-950/40 border border-amber-800 rounded-sm px-2 py-1.5">
          aes67-linux-daemon unreachable — clock and stream control unavailable.
        </div>
      ) : (
        <>
          {!locked && (
            <div className="text-[11px] text-amber-500 bg-amber-950/40 border border-amber-800 rounded-sm px-2 py-1.5">
              No PTP lock ({ptp?.status || 'unknown'}) — streams will not run without a grandmaster.
            </div>
          )}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">LOCK</span>
              <span className={locked ? 'text-green-400' : 'text-amber-400'}>{ptp?.status || '—'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">GRANDMASTER</span>
              <span className="text-gray-300 truncate">{ptp?.gmid || '—'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">JITTER</span>
              <span className="text-gray-300">{ptp?.jitter != null ? `${ptp.jitter} ns` : '—'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">INTERFACE</span>
              <span className="text-gray-300">{iface}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">PLAYOUT DELAY</span>
              <span className="text-gray-300">{playout}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const ReceiveBlock = () => {
  const sinks = usePatchbayStore((s) => s.daemonSinks);
  const remotes = usePatchbayStore((s) => s.daemonRemoteSources);
  const mappings = usePatchbayStore((s) => s.mappings);
  const reachable = usePatchbayStore((s) => s.daemonReachable);

  const [pickRemoteId, setPickRemoteId] = useState('');
  const [manualSdp, setManualSdp] = useState('');
  const [showManual, setShowManual] = useState(false);

  // Which input channels currently select a given sink's derived stream.
  const mappedChannels = (sinkId: number): number[] =>
    Object.values(mappings)
      .filter((m) => m.sourceStreamId === `daemon-sink-${sinkId}`)
      .map((m) => m.channelId)
      .sort((a, b) => a - b);

  const addFromRemote = () => {
    const r = remotes.find((x) => x.id === pickRemoteId);
    if (!r) return;
    send({ type: 'daemon_create_sink', name: r.name || 'Sink', sdp: r.sdp });
    setPickRemoteId('');
  };

  const addFromSdp = () => {
    if (!manualSdp.trim()) return;
    send({ type: 'daemon_create_sink', name: 'Manual SDP', sdp: manualSdp.trim() });
    setManualSdp('');
    setShowManual(false);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className={SUBHEAD}>RECEIVE (SINKS)</div>

      {sinks.length === 0 ? (
        <div className="text-[11px] text-gray-500 italic">No receive streams configured.</div>
      ) : (
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="text-[9px] font-black tracking-widest uppercase text-gray-600">
              <th className="py-1 pr-3 font-black">ID</th>
              <th className="py-1 pr-3 font-black">NAME</th>
              <th className="py-1 pr-3 font-black">ADDRESS</th>
              <th className="py-1 pr-3 font-black">CAPTURE</th>
              <th className="py-1 pr-3 font-black">MAPPED</th>
              <th className="py-1"></th>
            </tr>
          </thead>
          <tbody>
            {sinks.map((sk) => {
              const chans = mappedChannels(sk.id);
              return (
                <tr key={sk.id} className="border-t border-[#1a1c22]">
                  <td className="py-1 pr-3 font-mono text-gray-500">{sk.id}</td>
                  <td className="py-1 pr-3 text-gray-200 truncate max-w-[140px]">{sk.name}</td>
                  <td className="py-1 pr-3 font-mono text-cyan-400">{sdpAddress(sk.sdp) || '—'}</td>
                  <td className="py-1 pr-3 font-mono text-gray-400">{captureRange(sk.capturePorts)}</td>
                  <td className="py-1 pr-3 font-mono text-gray-400">
                    {chans.length ? chans.map((c) => `CH ${c}`).join(', ') : <span className="text-gray-600">unmapped</span>}
                  </td>
                  <td className="py-1">
                    <button
                      onClick={() => send({ type: 'daemon_delete_sink', id: sk.id })}
                      className="text-[9px] font-black tracking-widest uppercase text-red-400 hover:text-red-300"
                    >
                      DELETE
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="text-[9px] text-gray-600">
        Subscribed streams appear in the SOURCES registry below with ports pre-filled — assign one to a channel there.
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={pickRemoteId}
          onChange={(e) => setPickRemoteId(e.target.value)}
          disabled={!reachable}
          className={`${INPUT} w-56 disabled:opacity-40`}
        >
          <option value="">
            {remotes.length === 0 ? '-- no streams discovered --' : '-- pick a discovered stream --'}
          </option>
          {remotes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.address || sdpAddress(r.sdp)}) · {r.source}
            </option>
          ))}
        </select>
        <button
          onClick={addFromRemote}
          disabled={!pickRemoteId}
          className="bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-[10px] font-black tracking-widest uppercase px-3 py-1.5 rounded-sm transition-colors"
        >
          ADD SINK
        </button>
        <button
          onClick={() => setShowManual((v) => !v)}
          className="text-[9px] font-black tracking-widest uppercase text-gray-400 hover:text-white px-2 py-1.5"
        >
          {showManual ? 'CANCEL' : 'PASTE SDP'}
        </button>
      </div>

      {showManual && (
        <div className="flex flex-col gap-1">
          <textarea
            value={manualSdp}
            onChange={(e) => setManualSdp(e.target.value)}
            rows={4}
            placeholder={'v=0\no=- ... IN IP4 ...\ns=...\nc=IN IP4 239.x.x.x/32\nm=audio 5004 RTP/AVP 98\n...'}
            className={`${INPUT} font-mono text-[10px] w-full resize-y`}
          />
          <button
            onClick={addFromSdp}
            className="self-start bg-green-600 hover:bg-green-500 text-white text-[10px] font-black tracking-widest uppercase px-3 py-1.5 rounded-sm transition-colors"
          >
            ADD FROM SDP
          </button>
        </div>
      )}
    </div>
  );
};

const TransmitBlock = () => {
  const txSources = usePatchbayStore((s) => s.txSources);
  const ptp = usePatchbayStore((s) => s.ptpStatus);
  const locked = ptp?.status === 'locked';

  return (
    <div className="flex flex-col gap-2">
      <div className={SUBHEAD}>TRANSMIT (SOURCES)</div>

      <table className="w-full text-left border-collapse text-xs">
        <thead>
          <tr className="text-[9px] font-black tracking-widest uppercase text-gray-600">
            <th className="py-1 pr-2 font-black">ON</th>
            <th className="py-1 pr-3 font-black">NAME</th>
            <th className="py-1 pr-3 font-black">ADDRESS</th>
            <th className="py-1 pr-3 font-black">CH</th>
            <th className="py-1 font-black">STATE</th>
          </tr>
        </thead>
        <tbody>
          {txSources.map((g) => (
            <tr key={g.key} className="border-t border-[#1a1c22]">
              <td className="py-1 pr-2">
                <input
                  type="checkbox"
                  checked={g.enabled}
                  onChange={(e) => send({ type: 'set_tx_source', key: g.key, enabled: e.target.checked })}
                  className="accent-green-500"
                />
              </td>
              <td className="py-1 pr-3">
                <input
                  key={g.name}
                  defaultValue={g.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== g.name) send({ type: 'set_tx_source', key: g.key, name: v });
                  }}
                  className={`${INPUT} w-36 py-0.5`}
                />
              </td>
              <td className="py-1 pr-3 font-mono text-cyan-400">{g.address || '—'}</td>
              <td className="py-1 pr-3 font-mono text-gray-400">{g.channels}</td>
              <td className="py-1 font-mono">
                {!g.enabled ? (
                  <span className="text-gray-600">off</span>
                ) : !g.present ? (
                  <span className="text-amber-400">pending</span>
                ) : locked ? (
                  <span className="text-green-400">running</span>
                ) : (
                  <span className="text-amber-400">no clock</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="text-[9px] text-gray-600">
        Master/Monitor/Aux always have a dedicated AES67 stream here regardless of any Output-Endpoint (DESTINATIONS) assignment.
      </div>
    </div>
  );
};

export const NetworkPanel = () => {
  const [open, setOpen] = useState(true);
  const reachable = usePatchbayStore((s) => s.daemonReachable);

  return (
    <div className="shrink-0 border-b border-gray-800 bg-[#0d0e12]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex justify-between items-center px-6 py-2 bg-[#111318] hover:bg-[#15171d] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={HEADER}>AES67 NETWORK</span>
          <span
            className={`w-2 h-2 rounded-full ${reachable ? 'bg-green-500 animate-pulse' : 'bg-red-600'}`}
            title={reachable ? 'daemon reachable' : 'daemon unreachable'}
          />
        </div>
        <span className="text-gray-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-6 py-3 grid grid-cols-1 lg:grid-cols-3 gap-x-8 gap-y-4 bg-[#0d0e12]">
          <PtpBlock />
          <ReceiveBlock />
          <TransmitBlock />
        </div>
      )}
    </div>
  );
};

import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMixerStore } from '../../stores/useMixerStore';
import { usePatchbayStore } from '../../stores/usePatchbayStore';

// Virtual-soundcheck controls for the TIMELINE toolbar (plan/daw-timeline-
// roadmap.md Phase 3a): one-button arm of every AES67-mapped input, a master
// live/timeline monitor toggle, a take-split button, and a settings popover
// for unattended recording (auto-record, split-on-marker, disk guard, schedule).
export function VscToolbar() {
  const channels = useMixerStore((s) => s.channels);
  const monitorInputMask = useMixerStore((s) => s.monitorInputMask);
  const setAllMonitorInput = useMixerStore((s) => s.setAllMonitorInput);
  const armAllMappedInputs = useMixerStore((s) => s.armAllMappedInputs);
  const disarmAllInputs = useMixerStore((s) => s.disarmAllInputs);
  const transportState = useMixerStore((s) => s.transportState);
  const vscSplit = useMixerStore((s) => s.vscSplit);
  const mappings = usePatchbayStore((s) => s.mappings);

  const inputs = Object.values(channels).filter((c) => c.type === 'input');
  const armedCount = inputs.filter((c) => c.arm).length;
  const mappedCount = inputs.filter((c) => !!mappings[c.id]?.sourceStreamId).length;
  const anyLive = monitorInputMask !== 0;

  const [cfgOpen, setCfgOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex items-center gap-1 bg-[#0d0f13] border border-[#242832] rounded px-1.5 py-1">
      <span className="text-[9px] font-black tracking-widest text-gray-500 px-1">VSC</span>

      <button
        onClick={armAllMappedInputs}
        title={`Arm every input with an AES67 source mapped (${mappedCount} mapped)`}
        className="px-2 py-1 text-[10px] font-bold rounded bg-[#1a1c22] text-gray-200 hover:bg-red-700"
      >
        ARM ALL
      </button>
      <button
        onClick={disarmAllInputs}
        title="Disarm every input"
        className="px-2 py-1 text-[10px] font-bold rounded bg-[#1a1c22] text-gray-400 hover:bg-[#26282f]"
      >
        DISARM
      </button>
      <span
        className={`text-[10px] font-mono px-1.5 py-1 rounded ${armedCount > 0 ? 'text-red-400' : 'text-gray-600'}`}
        title={`${armedCount} armed`}
      >
        {armedCount} ●
      </span>

      <div className="w-px h-5 bg-[#242832] mx-0.5" />

      <button
        onClick={() => setAllMonitorInput(!anyLive)}
        title="Monitor all channels: live input vs timeline playback"
        className={`px-2 py-1 text-[10px] font-bold rounded ${anyLive ? 'bg-amber-500 text-black' : 'bg-[#1a1c22] text-gray-300 hover:bg-[#26282f]'}`}
      >
        MON: {anyLive ? 'LIVE' : 'TIMELINE'}
      </button>

      <button
        onClick={vscSplit}
        disabled={transportState !== 'recording'}
        title="Split the running take here (new take from this point)"
        className="px-2 py-1 text-[10px] font-bold rounded bg-[#1a1c22] text-gray-300 enabled:hover:bg-[#26282f] disabled:opacity-40"
      >
        SPLIT
      </button>

      <button
        ref={gearRef}
        onClick={() => setCfgOpen((v) => !v)}
        title="Unattended-recording settings"
        className={`px-2 py-1 text-[11px] rounded ${cfgOpen ? 'bg-blue-700 text-white' : 'bg-[#1a1c22] text-gray-300 hover:bg-[#26282f]'}`}
      >
        ⚙
      </button>

      {cfgOpen && gearRef.current && <VscConfigPopover anchor={gearRef.current} onClose={() => setCfgOpen(false)} />}
    </div>
  );
}

function VscConfigPopover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const cfg = useMixerStore((s) => s.vscConfig);
  const setVscConfig = useMixerStore((s) => s.setVscConfig);

  const WIDTH = 264;
  const [pos, setPos] = useState(() => {
    const r = anchor.getBoundingClientRect();
    return { left: Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8)), top: r.bottom + 6 };
  });
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8)), top: r.bottom + 6 });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  return createPortal(
    <div className="fixed inset-0 z-[100]" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'fixed', left: pos.left, top: pos.top, width: WIDTH }}
        className="bg-[#15171c] border border-[#333] rounded-md shadow-2xl p-3 text-xs text-gray-300 flex flex-col gap-2.5"
      >
        <div className="text-[10px] font-black tracking-widest text-gray-500">UNATTENDED RECORDING</div>

        <label className="flex items-center justify-between gap-2">
          <span>Auto-record on first play</span>
          <input type="checkbox" checked={cfg.autoRecord} onChange={(e) => setVscConfig({ autoRecord: e.target.checked })} />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Split take on marker</span>
          <input type="checkbox" checked={cfg.splitOnMarker} onChange={(e) => setVscConfig({ splitOnMarker: e.target.checked })} />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Warn below (GB free)</span>
          <input
            type="number" min={0} step={1} value={cfg.minFreeGb}
            onChange={(e) => setVscConfig({ minFreeGb: Number(e.target.value) })}
            className="w-16 bg-[#0d0f13] border border-[#333] rounded px-1.5 py-0.5 text-right outline-none"
          />
        </label>

        <div className="h-px bg-[#2a2d35]" />

        <label className="flex items-center justify-between gap-2">
          <span>Scheduled start</span>
          <input
            type="checkbox" checked={cfg.schedule.enabled}
            onChange={(e) => setVscConfig({ schedule: { enabled: e.target.checked } })}
          />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Start time (daily)</span>
          <input
            type="time" value={cfg.schedule.at}
            onChange={(e) => setVscConfig({ schedule: { at: e.target.value } })}
            className="bg-[#0d0f13] border border-[#333] rounded px-1.5 py-0.5 outline-none"
          />
        </label>
      </div>
    </div>,
    document.body,
  );
}

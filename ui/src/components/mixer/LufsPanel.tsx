import React from 'react';
import { useMixerStore } from '../../stores/useMixerStore';

// ITU-R BS.1770 loudness readout for the Master output — fills the empty
// right end of the BUS SENDS panel. Vertical short-term bar (with a fast
// momentary tick and a −14 LUFS target line), M / S / I / TP numerics, and
// an integrated reset.

const LU_TOP = 0;
const LU_BOT = -42;
const TARGET = -14;
const TICKS = [0, -6, -14, -23, -32, -40];

const pct = (lu: number) => Math.max(0, Math.min(100, ((lu - LU_BOT) / (LU_TOP - LU_BOT)) * 100));
const fmt = (v: number | undefined) => (v === undefined || v < -100 ? '––.–' : v.toFixed(1));

const Row = ({ label, value, unit, warn }: { label: string; value: string; unit: string; warn?: boolean }) => (
  <div className="flex items-baseline gap-1.5 leading-none">
    <span className="text-[9px] font-black tracking-widest text-gray-500 w-4">{label}</span>
    <span className={`font-mono tabular-nums text-[15px] flex-1 text-right ${warn ? 'text-red-400' : 'text-gray-100'}`}>{value}</span>
    <span className="text-[7px] text-gray-600 w-7">{unit}</span>
  </div>
);

export const LufsPanel = () => {
  const lufs = useMixerStore(s => s.lufs);
  const resetLufs = useMixerStore(s => s.resetLufs);

  const s = lufs?.s ?? -120;
  const m = lufs?.m ?? -120;
  const tpWarn = (lufs?.tp ?? -120) > -1;
  const overTarget = s > TARGET + 0.5;

  return (
    <div className="flex-1 min-w-[190px] h-full flex flex-col bg-[#0d0f13] border-l border-black/60 px-2.5 py-1.5 gap-2 z-10">
      <div className="text-[8px] font-black tracking-[0.2em] text-[#a0a5aa] uppercase text-center border-b border-black/50 pb-1">
        LUFS · Master
      </div>

      <div className="flex-1 flex gap-2.5 min-h-0">
        {/* scale + vertical short-term bar */}
        <div className="flex gap-1 shrink-0">
          <div className="relative w-[16px] text-[6px] font-mono text-gray-500 leading-none">
            {TICKS.map(v => (
              <div key={v} className="absolute right-0 tabular-nums" style={{ bottom: `calc(${pct(v)}% - 3px)` }}>
                {v}
              </div>
            ))}
          </div>
          <div className="relative w-[26px] rounded-sm bg-[#050505] border border-black/60 overflow-hidden">
            <div
              className={`absolute inset-x-0 bottom-0 transition-[height] duration-150 ${
                overTarget
                  ? 'bg-gradient-to-t from-emerald-500 via-amber-400 to-red-500'
                  : 'bg-gradient-to-t from-emerald-600 to-emerald-400'
              }`}
              style={{ height: `${pct(s)}%` }}
            />
            {TICKS.map(v => (
              <div key={v} className="absolute inset-x-0 h-px bg-white/10" style={{ bottom: `${pct(v)}%` }} />
            ))}
            {/* target line */}
            <div className="absolute inset-x-[-1px] border-t border-dashed border-cyan-300/80" style={{ bottom: `${pct(TARGET)}%` }} />
            {/* momentary tick */}
            <div
              className="absolute inset-x-0 h-[2px] bg-white shadow-[0_0_5px_#fff] transition-[bottom] duration-75"
              style={{ bottom: `calc(${pct(m)}% - 1px)` }}
            />
          </div>
        </div>

        {/* numerics */}
        <div className="flex-1 flex flex-col justify-center gap-2 min-w-0">
          <Row label="M" value={fmt(lufs?.m)} unit="LUFS" />
          <Row label="S" value={fmt(lufs?.s)} unit="LUFS" warn={overTarget} />
          <Row label="I" value={fmt(lufs?.i)} unit="LUFS" />
          <Row label="TP" value={fmt(lufs?.tp)} unit="dBTP" warn={tpWarn} />
          <div className="text-[7px] text-cyan-300/70 font-mono mt-1 flex items-center gap-1">
            <span className="w-2 border-t border-dashed border-cyan-300/80" />
            target {TARGET}
          </div>
        </div>
      </div>

      <button
        onClick={resetLufs}
        className="shrink-0 text-[8px] font-black tracking-widest text-gray-400 hover:text-white border border-black/60 rounded-sm py-1 bg-[#16181d] hover:bg-[#20232a] transition-colors"
      >
        RESET INTEGRATED
      </button>
    </div>
  );
};

import React from 'react';

// Horizontal gain-reduction / attenuation meter — amber bar with tick marks
// and a dB readout. Sits above the knob bay (compressor, de-esser, limiter).

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const GrBar = ({
  label = 'Gain Reduction',
  value,
  max = 24,
  ticks = [6, 12, 18],
}: {
  label?: string;
  value: number;
  max?: number;
  ticks?: number[];
}) => (
  <div className="shrink-0">
    <div className="flex justify-between items-baseline text-[8px] font-black tracking-widest text-gray-400 uppercase mb-0.5 text-engrave leading-none">
      <span>{label}</span>
      <span className="font-mono text-amber-300 tabular-nums text-[9px]">
        {value > 0.05 ? `−${value.toFixed(1)}` : '0.0'} dB
      </span>
    </div>
    <div className="relative h-2.5 rounded-sm bg-[#0a0a0a] border border-black/70 overflow-hidden shadow-[inset_0_1px_3px_rgba(0,0,0,0.8)]">
      <div
        className="absolute inset-y-0 left-0 bg-gradient-to-r from-amber-600 via-amber-400 to-amber-200 transition-[width] duration-75"
        style={{ width: `${clamp((value / max) * 100, 0, 100)}%` }}
      />
      {ticks.map(d => (
        <div key={d} className="absolute inset-y-0 w-px bg-black/50" style={{ left: `${(d / max) * 100}%` }} />
      ))}
    </div>
  </div>
);

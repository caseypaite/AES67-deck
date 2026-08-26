import React from 'react';

// Vertical VU rail for the FX editor's input / output columns
// (docs/fx-ui-design.md §2, §5). Scale −60…+6 dBFS, colour stops matching
// VuMeter. Two hairline bars (L/R) sharing one track.
//
// NOTE: per-plugin metering (`fx_meter`) is not plumbed yet — callers pass
// the host channel's meter as a stand-in, which is why the rail is labelled.

const MIN_DB = -60;
const MAX_DB = 6;
const GRAD =
  'linear-gradient(to top, #00cc99 0%, #00cc99 63%, #eab308 63%, #eab308 82%, #f97316 82%, #f97316 91%, #ef4444 91%, #ef4444 100%)';

const pct = (db: number) => ((Math.max(MIN_DB, Math.min(MAX_DB, db)) - MIN_DB) / (MAX_DB - MIN_DB)) * 100;

const Bar = ({ db }: { db: number }) => (
  <div className="relative flex-1 h-full bg-[#0a0a0a] rounded-[1px] overflow-hidden">
    <div className="absolute inset-0" style={{ background: GRAD, opacity: 0.9 }} />
    <div
      className="absolute top-0 left-0 right-0 bg-[#0a0a0a] transition-[height] duration-150 ease-out"
      style={{ height: `${100 - pct(db)}%` }}
    />
  </div>
);

export const MeterRail = ({
  label,
  l,
  r,
}: {
  label: string;
  l: number;
  r: number;
}) => (
  <div className="flex flex-col items-center gap-1 h-full w-[30px] shrink-0 py-1">
    <div className="text-[7px] font-black tracking-widest text-gray-600 [writing-mode:vertical-rl] rotate-180 flex-1 flex items-center">
      {label}
    </div>
    <div className="flex gap-[2px] w-full flex-[6] min-h-0 border border-[#1a1a1a] rounded-[2px] p-[2px] bg-[#050505]">
      <Bar db={l} />
      <Bar db={r} />
    </div>
  </div>
);

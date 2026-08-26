import React from 'react';
import { ParamSpec } from '../../data/calfPlugins';

// Compact hardware-style toggle and segmented selector for `toggle` / `enum`
// params. Live in the switch row under the knob bay.

export const ToggleControl = ({
  spec,
  value,
  onChange,
  accent,
}: {
  spec: ParamSpec;
  value: number;
  onChange: (v: number) => void;
  accent: string;
}) => {
  const on = value > 0.5;
  return (
    <div className="flex flex-col items-center select-none w-[54px] shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); onChange(on ? 0 : 1); }}
        className="relative w-[34px] h-[30px] rounded-[3px] border border-black/80"
        style={{
          background: 'linear-gradient(#26282e, #16171b)',
          boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.15), 0 3px 6px rgba(0,0,0,0.6)',
        }}
        title={spec.label}
      >
        <span
          className="absolute left-1/2 -translate-x-1/2 w-[22px] h-[12px] rounded-[2px] transition-all duration-100"
          style={{
            top: on ? 3 : 14,
            background: on ? 'linear-gradient(#e9edf1, #b9bec6)' : 'linear-gradient(#3a3c42, #26282d)',
            boxShadow: on
              ? '0 2px 3px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.9)'
              : '0 2px 3px rgba(0,0,0,0.7), inset 0 1px 1px rgba(255,255,255,0.25)',
          }}
        />
        <span
          className="absolute bottom-[2px] right-[3px] w-[5px] h-[5px] rounded-full transition-colors"
          style={{ background: on ? accent : '#3a3c42', boxShadow: on ? `0 0 5px ${accent}` : 'none' }}
        />
      </button>
      <div className="mt-1 text-[8px] font-black tracking-wide text-gray-400 uppercase text-center leading-none w-full whitespace-nowrap">
        {spec.label}
      </div>
    </div>
  );
};

export const SegmentedControl = ({
  spec,
  value,
  onChange,
  accent,
}: {
  spec: ParamSpec;
  value: number;
  onChange: (v: number) => void;
  accent: string;
}) => {
  const labels = spec.enumLabels ?? [];
  const idx = Math.round(value - spec.min);
  return (
    <div className="flex flex-col items-center select-none min-w-[54px] shrink-0">
      <div
        className="flex rounded-[3px] overflow-hidden border border-black/80"
        style={{ background: '#0e0f12', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.8)' }}
      >
        {labels.map((l, i) => {
          const active = i === idx;
          return (
            <button
              key={l + i}
              onClick={(e) => { e.stopPropagation(); onChange(spec.min + i); }}
              className="px-1.5 py-[3px] text-[8px] font-black tracking-wide uppercase transition-colors"
              style={{
                background: active ? accent : 'transparent',
                color: active ? '#0b0c10' : '#8b8f98',
                textShadow: active ? 'none' : '0 1px 0 rgba(0,0,0,0.6)',
              }}
            >
              {l}
            </button>
          );
        })}
      </div>
      <div className="mt-1 text-[8px] font-black tracking-wide text-gray-400 uppercase text-center leading-none w-full whitespace-nowrap">
        {spec.label}
      </div>
    </div>
  );
};

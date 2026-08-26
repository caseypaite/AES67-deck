import React, { useRef, useState } from 'react';
import { ParamSpec, paramToPos, posToParam, formatParam } from '../../data/calfPlugins';

// Realistic rotary knob — the "standard" size tier from docs/ui-design.md §2.1.
// Layers, bottom → top: engraved tick ring · accent value arc · chamfered
// skirt · knurled grip band · brushed top cap · pointer (with its own cast
// shadow). 270° sweep, zero at −135°. Vertical drag = value, double-click =
// default, slow-drag / Shift = fine.

const SWEEP = 270;
const START = -135;

export const AnalogKnob = ({
  spec,
  value,
  onChange,
  accent,
  size = 54,
}: {
  spec: ParamSpec;
  value: number;
  onChange: (v: number) => void;
  accent: string;
  size?: number;
}) => {
  const startY = useRef(0);
  const startPos = useRef(0);
  const [turning, setTurning] = useState(false);

  const pos = paramToPos(spec, value);
  const angle = START + pos * SWEEP;

  const beginDrag = (clientY: number, fine: boolean) => {
    setTurning(true);
    startY.current = clientY;
    startPos.current = pos;
    const speed = fine ? 0.0016 : 0.006; // pos units per px
    const move = (cy: number) => {
      const next = startPos.current - (cy - startY.current) * speed;
      onChange(posToParam(spec, next));
    };
    const mm = (e: MouseEvent) => move(e.clientY);
    const tm = (e: TouchEvent) => { if (e.touches[0]) { e.preventDefault(); move(e.touches[0].clientY); } };
    const end = () => {
      setTurning(false);
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('touchmove', tm);
      window.removeEventListener('touchend', end);
    };
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', end);
    window.addEventListener('touchmove', tm, { passive: false });
    window.addEventListener('touchend', end);
  };

  const skirt = size;
  const cap = size * 0.66;
  const tickW = Math.max(2, Math.round(size * 0.035));
  const tickH = Math.max(4, Math.round(size * 0.075));

  return (
    <div className="relative flex flex-col items-center select-none shrink-0" style={{ width: size + 6 }}>
      {/* value readout — floats above the knob while it is being turned
          (mouse: until button release; touch: for the whole gesture) */}
      {turning && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-30 px-1.5 py-0.5 rounded-[3px] font-mono font-bold tabular-nums whitespace-nowrap leading-none text-[10px] pointer-events-none"
          style={{
            background: 'linear-gradient(#12161b, #0a0d11)',
            border: `1px solid ${accent}`,
            color: accent,
            boxShadow: `0 2px 6px rgba(0,0,0,0.6), 0 0 8px ${accent}55`,
          }}
        >
          {formatParam(spec, value)}
        </div>
      )}

      <div
        className="relative cursor-ns-resize active:cursor-grabbing touch-none rounded-full"
        style={{ width: skirt, height: skirt }}
        onMouseDown={(e) => { e.stopPropagation(); beginDrag(e.clientY, e.shiftKey); }}
        onTouchStart={(e) => { if (e.touches[0]) beginDrag(e.touches[0].clientY, false); }}
        onDoubleClick={(e) => { e.stopPropagation(); onChange(spec.default); }}
        title={spec.label}
      >
        {/* engraved tick ring */}
        <div className="absolute inset-0 pointer-events-none">
          {Array.from({ length: 11 }).map((_, i) => (
            <div key={i} className="absolute inset-0" style={{ transform: `rotate(${START + (i / 10) * SWEEP}deg)` }}>
              <div
                className="mx-auto rounded-full bg-black/70 shadow-[0_1px_0_rgba(255,255,255,0.12)]"
                style={{ width: tickW, height: tickH }}
              />
            </div>
          ))}
        </div>

        {/* accent value arc — brightens while turning */}
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 100 100">
          <circle
            cx="50" cy="50" r="46" fill="none" stroke={accent} strokeWidth={turning ? 4 : 3} strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${(pos * SWEEP / 360) * 100} 100`}
            transform="rotate(135 50 50)"
            style={{ filter: `drop-shadow(0 0 ${turning ? 5 : 3}px ${accent})`, opacity: turning ? 1 : 0.85 }}
          />
        </svg>

        {/* chamfered skirt */}
        <div
          className="absolute rounded-full border border-black/80"
          style={{
            inset: skirt * 0.11,
            background: `radial-gradient(circle at 34% 30%, #4a4d55, #23252b 62%, #17181c 100%)`,
            boxShadow: '0 5px 9px rgba(0,0,0,0.75), inset 0 1px 2px rgba(255,255,255,0.35), inset 0 -3px 6px rgba(0,0,0,0.6)',
          }}
        />

        {/* knurled grip band */}
        <div
          className="absolute rounded-full"
          style={{
            inset: skirt * 0.17,
            background: 'repeating-conic-gradient(from 0deg, #3a3c42 0deg 6deg, #24262b 6deg 12deg)',
            boxShadow: 'inset 0 0 4px rgba(0,0,0,0.8)',
          }}
        />

        {/* brushed top cap + pointer, rotates */}
        <div
          className="absolute rounded-full flex items-start justify-center"
          style={{
            width: cap, height: cap,
            left: '50%', top: '50%',
            transform: `translate(-50%, -50%) rotate(${angle}deg)`,
            background: 'radial-gradient(circle at 38% 32%, #d7dade, #9a9ea6 55%, #6c6f77 100%)',
            boxShadow: '0 2px 4px rgba(0,0,0,0.9), inset 0 1px 2px rgba(255,255,255,0.8), inset 0 -2px 4px rgba(0,0,0,0.45)',
          }}
        >
          <div
            className="rounded-full mt-[3px]"
            style={{ width: Math.max(3, cap * 0.11), height: Math.max(3, cap * 0.11), background: '#111', boxShadow: '0 1px 1px rgba(255,255,255,0.6), inset 0 1px 1px rgba(0,0,0,0.8)' }}
          />
        </div>

        {/* centre detent mark for bipolar params */}
        {spec.bipolar && (
          <div className="absolute inset-0 pointer-events-none" style={{ transform: `rotate(0deg)` }}>
            <div className="mx-auto w-[2px] h-[5px] bg-red-500/80 rounded-full" />
          </div>
        )}
      </div>

      <div
        className={`mt-1 text-[8px] font-black tracking-wide uppercase text-center leading-none w-full whitespace-nowrap ${turning ? 'text-gray-200' : 'text-gray-400'}`}
      >
        {spec.label}
      </div>
    </div>
  );
};

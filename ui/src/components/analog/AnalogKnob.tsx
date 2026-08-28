import React, { useRef, useState, useCallback, useEffect } from 'react';
import { ParamSpec, paramToPos, posToParam, formatParam } from '../../data/calfPlugins';

// Rotary knob — LED level ring + chromed cap. Ported from the Claude Design
// canvas study "Rotary Knob · LED Level Ring"
// (claude.ai/design/p/8dcc512d…). 270° sweep, zero at −135°.
//
// Concentric layers, outer → inner:
//   LED bloom · ring track · ring fill · bezel well · metal collar ·
//   cap base (rotates) · static sheen · cap top + accent pointer (rotates).
//
// Vertical drag = value · wheel = 3% steps · double-click = default ·
// Shift = fine · ↑/↓/←/→ nudge once focused.
//
// The knob keeps the ParamSpec API (paramToPos / posToParam / formatParam)
// so every Calf editor and the generic PluginDetail list drive it unchanged.

const SWEEP = 270;
const START = -135;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

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
  const knobRef = useRef<HTMLDivElement>(null);
  const [turning, setTurning] = useState(false);
  const [focused, setFocused] = useState(false);

  const pos = clamp01(paramToPos(spec, value));
  const angle = START + pos * SWEEP;

  // Ring scales with the knob so the chromed cap stays the visual focus at
  // any size (the canvas study was drawn at 100–200 px; the FX bays use 56).
  const ring = Math.max(3, Math.round(size * 0.065));
  const fillPct = `${(pos * 75).toFixed(2)}%`; // 270° sweep == 75% of the circle

  // Latest props behind a ref so the wheel handler can stay a stable listener.
  const live = useRef({ spec, value, onChange });
  live.current = { spec, value, onChange };
  const nudge = useCallback((delta: number) => {
    const s = live.current;
    s.onChange(posToParam(s.spec, clamp01(paramToPos(s.spec, s.value) + delta)));
  }, []);

  useEffect(() => {
    const el = knobRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      nudge((e.deltaY > 0 ? -1 : 1) * 0.03);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [nudge]);

  const beginDrag = (clientY: number, fine: boolean) => {
    setTurning(true);
    startY.current = clientY;
    startPos.current = pos;
    const speed = fine ? 1 / 900 : 1 / 240; // pos units per px (≈ canvas study's dy/220)
    const move = (cy: number) => onChange(posToParam(spec, startPos.current + (startY.current - cy) * speed));
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

  // The lit ring is recessed 1px from the edge with a dark channel behind it,
  // so the accent arc reads even against the blue faceplate at 56 px.
  const ringMask =
    `radial-gradient(circle at 50% 50%, transparent 0 calc(50% - ${ring + 1}px), #000 calc(50% - ${ring + 1}px) calc(50% - 1px), transparent calc(50% - 1px))`;
  const channelMask =
    `radial-gradient(circle at 50% 50%, transparent 0 calc(50% - ${ring + 2}px), #000 calc(50% - ${ring + 2}px) 50%, transparent 50%)`;
  const L: React.CSSProperties = { position: 'absolute', borderRadius: '50%', pointerEvents: 'none' };
  const spin: React.CSSProperties = { transform: `rotate(${angle}deg)`, transition: 'transform 40ms linear' };

  return (
    <div className="relative flex flex-col items-center select-none shrink-0" style={{ width: size + 6 }}>
      {/* value readout — floats above the knob while it is being turned */}
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
        ref={knobRef}
        role="slider"
        tabIndex={0}
        aria-label={spec.label}
        aria-valuenow={Number.isFinite(value) ? Number(value.toFixed(4)) : undefined}
        aria-valuetext={formatParam(spec, value)}
        className="relative cursor-ns-resize active:cursor-grabbing touch-none rounded-full outline-none"
        style={{ width: size, height: size }}
        onMouseDown={(e) => { e.stopPropagation(); beginDrag(e.clientY, e.shiftKey); }}
        onTouchStart={(e) => { if (e.touches[0]) beginDrag(e.touches[0].clientY, false); }}
        onDoubleClick={(e) => { e.stopPropagation(); onChange(spec.default); }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.005 : 0.02;
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); nudge(step); }
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); nudge(-step); }
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        title={spec.label}
      >
        {/* LED glow bloom */}
        <div
          style={{
            ...L,
            inset: -ring * 1.6,
            background: `conic-gradient(from 225deg, ${accent} 0 ${fillPct}, transparent ${fillPct} 100%)`,
            filter: `blur(${(ring * 1.1).toFixed(1)}px)`,
            opacity: turning ? 0.9 : 0.55,
            WebkitMask: `radial-gradient(circle at 50% 50%, transparent 0 calc(50% - ${ring * 3}px), #000 calc(50% - ${ring * 3}px) calc(50% + ${ring * 0.4}px), transparent calc(50% + ${ring * 0.4}px))`,
            mask: `radial-gradient(circle at 50% 50%, transparent 0 calc(50% - ${ring * 3}px), #000 calc(50% - ${ring * 3}px) calc(50% + ${ring * 0.4}px), transparent calc(50% + ${ring * 0.4}px))`,
          }}
        />
        {/* dark channel the LEDs sit in */}
        <div
          style={{
            ...L,
            inset: 0,
            background: '#050607',
            boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.9)',
            WebkitMask: channelMask,
            mask: channelMask,
          }}
        />
        {/* ring track (unlit) */}
        <div
          style={{
            ...L,
            inset: 0,
            background: 'conic-gradient(from 225deg, rgba(255,255,255,0.12) 0 75%, rgba(255,255,255,0.02) 75% 100%)',
            WebkitMask: ringMask,
            mask: ringMask,
          }}
        />
        {/* ring fill (lit) */}
        <div
          style={{
            ...L,
            inset: 0,
            background: `conic-gradient(from 225deg, ${accent} 0 ${fillPct}, transparent ${fillPct} 100%)`,
            WebkitMask: ringMask,
            mask: ringMask,
            filter: `drop-shadow(0 0 ${(ring * (turning ? 1.4 : 0.7)).toFixed(1)}px ${accent})`,
          }}
        />
        {/* inner bezel well */}
        <div
          style={{
            ...L,
            inset: ring * 1.8,
            background: 'radial-gradient(circle at 50% 120%, #2a2a2e 0%, #101012 60%, #08080a 100%)',
            boxShadow:
              'inset 0 1px 1px rgba(255,255,255,0.06), inset 0 -2px 6px rgba(0,0,0,0.9), 0 2px 3px rgba(0,0,0,0.6)',
          }}
        />
        {/* machined metal collar */}
        <div
          style={{
            ...L,
            inset: ring * 2.4,
            background: 'linear-gradient(180deg, #5a5f68 0%, #34383e 30%, #1b1d21 68%, #0d0e10 100%)',
            boxShadow: `0 ${size * 0.055}px ${size * 0.11}px rgba(0,0,0,0.8), 0 ${size * 0.012}px ${size * 0.02}px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.18)`,
          }}
        />
        {/* cap base — rotates */}
        <div
          style={{
            ...L,
            ...spin,
            inset: ring * 3.3,
            background:
              'linear-gradient(179deg, #f4f6f9 0%, #c6ccd4 11%, #8b929b 24%, #4c525a 41%, #2c3036 50%, #23262b 54%, #50565f 63%, #949ba4 76%, #dfe4ea 89%, #aab0b9 96%, #7d838c 100%)',
            boxShadow: `0 ${size * 0.03}px ${size * 0.05}px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.35)`,
          }}
        />
        {/* static environment sheen (does not rotate) */}
        <div style={{ ...L, inset: ring * 3.3, overflow: 'hidden' }}>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              background:
                'conic-gradient(from 196deg, rgba(255,255,255,0) 0deg, rgba(255,255,255,0.42) 26deg, rgba(255,255,255,0.02) 66deg, rgba(0,0,0,0.30) 132deg, rgba(255,255,255,0.06) 178deg, rgba(255,255,255,0.34) 214deg, rgba(255,255,255,0) 262deg, rgba(0,0,0,0.24) 318deg, rgba(255,255,255,0) 360deg)',
              mixBlendMode: 'overlay',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: '-10%',
              top: '-34%',
              width: '120%',
              height: '52%',
              borderRadius: '50%',
              background: 'radial-gradient(50% 60% at 50% 100%, rgba(255,255,255,0.55), rgba(255,255,255,0) 72%)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              background:
                'linear-gradient(198deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 34%, rgba(0,0,0,0.28) 76%, rgba(255,255,255,0.10) 100%)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              boxShadow: `inset 0 ${-size * 0.02}px ${size * 0.05}px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.10)`,
            }}
          />
        </div>
        {/* cap top dome + accent pointer — rotates */}
        <div style={{ ...L, ...spin, inset: ring * 3.3 }}>
          <div
            style={{
              position: 'absolute',
              inset: '15%',
              borderRadius: '50%',
              background: 'radial-gradient(circle at 40% 26%, rgba(255,255,255,0.16), rgba(0,0,0,0.30) 74%)',
              boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.22), inset 0 -1px 2px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.4)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '7%',
              width: Math.max(1.5, size * 0.034),
              height: '33%',
              marginLeft: -Math.max(0.75, size * 0.017),
              borderRadius: Math.max(0.75, size * 0.017),
              background: accent,
              boxShadow: `0 0 ${size * 0.075}px ${accent}, 0 1px 1px rgba(0,0,0,0.6), inset 0 0 2px rgba(255,255,255,0.9)`,
            }}
          />
        </div>
        {/* centre-detent reference for bipolar params (0 at 12 o'clock) */}
        {spec.bipolar && (
          <div style={{ ...L, inset: 0 }}>
            <div
              style={{
                margin: '0 auto',
                width: 2,
                height: ring + 2,
                borderRadius: 1,
                background: 'rgba(239,68,68,0.85)',
              }}
            />
          </div>
        )}
        {/* keyboard focus ring — a hairline, distinct from the LED arc */}
        <div
          style={{
            ...L,
            inset: -2,
            boxShadow: `0 0 0 1px rgba(255,255,255,0.55), 0 0 0 3px ${accent}44`,
            opacity: focused ? 1 : 0,
            transition: 'opacity 120ms',
          }}
        />
      </div>

      <div
        className={`mt-1 text-[8px] font-black tracking-wide uppercase text-center leading-none w-full whitespace-nowrap ${
          turning ? 'text-gray-200' : 'text-gray-400'
        }`}
      >
        {spec.label}
      </div>
    </div>
  );
};

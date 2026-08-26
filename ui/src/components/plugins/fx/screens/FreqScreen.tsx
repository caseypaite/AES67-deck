import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Log-frequency response screen for the EQs and the De-Esser. The response
// curve is a sum of approximate analog band magnitudes (good enough for a
// UI, not a real biquad). It measures its own pixel size so it renders
// undistorted whether it's a wide strip (EQ) or a square (De-Esser).
// Draggable node per active band (X = frequency, Y = gain). `markers` draws
// vertical reference lines with a draggable handle (De-Esser split point).
// `rta` carries the engine's live Goertzel band analysis (dBFS), drawn as a
// gradient spectrum behind the curve.

export type EqBandType = 'hp' | 'lp' | 'ls' | 'hs' | 'peak';

export interface EqBand {
  id: string;
  type: EqBandType;
  freq: number;
  gainDb: number;
  q: number;
  slopeDb: number; // hp/lp only, negative dB/oct
  active: boolean;
}

export interface FreqMarker {
  id: string;
  freq: number;
  label: string;
  onFreq?: (f: number) => void;
}

const F_MIN = 20, F_MAX = 22000;
const Y_RANGE = 18;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const freqFrac = (f: number) => Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN);
const fFromFrac = (frac: number) => F_MIN * Math.pow(F_MAX / F_MIN, clamp(frac, 0, 1));

function bandMag(b: EqBand, f: number): number {
  if (!b.active) return 0;
  const r = f / b.freq;
  switch (b.type) {
    case 'peak':
      return b.gainDb / (1 + Math.pow(b.q * (r - 1 / r), 2));
    case 'ls':
      return b.gainDb * 0.5 * (1 - Math.tanh(1.6 * Math.log(r)));
    case 'hs':
      return b.gainDb * 0.5 * (1 + Math.tanh(1.6 * Math.log(r)));
    case 'hp':
      return f >= b.freq ? 0 : Math.max(-Y_RANGE * 2, b.slopeDb * Math.log2(b.freq / f));
    case 'lp':
      return f <= b.freq ? 0 : Math.max(-Y_RANGE * 2, b.slopeDb * Math.log2(f / b.freq));
    default:
      return 0;
  }
}

// ── live RTA spectrum (engine Goertzel bands, dBFS) ─────────────────────────
const RTA_F_LO = 30, RTA_F_HI = 18000;
const RTA_DB_FLOOR = -78, RTA_DB_TOP = -3;
const rtaFreq = (k: number, n: number) => RTA_F_LO * Math.pow(RTA_F_HI / RTA_F_LO, k / (n - 1));

const RtaSpectrum = ({ data, w, h }: { data: number[]; w: number; h: number }) => {
  const [shown, setShown] = useState<number[]>(data);
  const raf = useRef(0);

  useEffect(() => {
    const tick = () => {
      setShown(prev => {
        const n = Math.max(prev.length, data.length);
        return Array.from({ length: n }, (_, i) => {
          const target = data[i] ?? RTA_DB_FLOOR;
          const cur = prev[i] ?? RTA_DB_FLOOR;
          return cur + (target - cur) * 0.35;
        });
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [data]);

  if (!shown.length) return null;
  const n = shown.length;
  const px = (f: number) => freqFrac(f) * w;
  const py = (db: number) => h - clamp((db - RTA_DB_FLOOR) / (RTA_DB_TOP - RTA_DB_FLOOR), 0, 1) * h;
  const pts = shown.map((db, i) => `${px(rtaFreq(i, n)).toFixed(1)},${py(db).toFixed(1)}`);
  const d = `M ${px(rtaFreq(0, n)).toFixed(1)},${h} L ${pts.join(' L ')} L ${px(rtaFreq(n - 1, n)).toFixed(1)},${h} Z`;
  return (
    <>
      <defs>
        <linearGradient id="rta-grad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#1e3a8a" stopOpacity="0.05" />
          <stop offset="35%" stopColor="#0891b2" stopOpacity="0.22" />
          <stop offset="62%" stopColor="#65a30d" stopOpacity="0.34" />
          <stop offset="82%" stopColor="#ca8a04" stopOpacity="0.46" />
          <stop offset="100%" stopColor="#dc2626" stopOpacity="0.62" />
        </linearGradient>
      </defs>
      <path d={d} fill="url(#rta-grad)" />
      <path d={`M ${pts.join(' L ')}`} fill="none" stroke="#e2e8f0" strokeOpacity={0.25} strokeWidth={1} />
    </>
  );
};

// ── the graph ───────────────────────────────────────────────────────────────
export const FreqScreen = ({
  bands,
  accent,
  onBand,
  selected,
  onSelect,
  markers = [],
  rta,
}: {
  bands: EqBand[];
  accent: string;
  onBand: (id: string, patch: { freq?: number; gainDb?: number }) => void;
  selected?: string;
  onSelect?: (id: string) => void;
  markers?: FreqMarker[];
  rta?: number[];
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState({ w: 400, h: 240 });

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setDim({ w: el.clientWidth || 400, h: el.clientHeight || 240 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { w, h } = dim;
  const sx = (f: number) => freqFrac(f) * w;
  const sy = (db: number) => h / 2 - (db / Y_RANGE) * (h / 2);

  const response = (f: number) => bands.reduce((sum, b) => sum + bandMag(b, f), 0);
  const pts: string[] = [];
  const steps = Math.max(80, Math.round(w / 4));
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    pts.push(`${(frac * w).toFixed(1)},${sy(clamp(response(fFromFrac(frac)), -Y_RANGE, Y_RANGE)).toFixed(1)}`);
  }
  const line = `M ${pts.join(' L ')}`;
  const fill = `${line} L ${w},${sy(0)} L 0,${sy(0)} Z`;

  const fracFromEvent = (clientX: number, clientY: number) => {
    const r = rootRef.current!.getBoundingClientRect();
    return { fx: (clientX - r.left) / r.width, fy: (clientY - r.top) / r.height };
  };

  const dragBand = (b: EqBand) => (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect?.(b.id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const { fx, fy } = fracFromEvent(ev.clientX, ev.clientY);
      const patch: { freq?: number; gainDb?: number } = { freq: clamp(fFromFrac(fx), F_MIN, 20000) };
      if (b.type !== 'hp' && b.type !== 'lp') patch.gainDb = clamp(Y_RANGE - fy * 2 * Y_RANGE, -Y_RANGE, Y_RANGE);
      onBand(b.id, patch);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dragMarker = (m: FreqMarker) => (e: React.PointerEvent) => {
    if (!m.onFreq) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const { fx } = fracFromEvent(ev.clientX, ev.clientY);
      m.onFreq!(clamp(fFromFrac(fx), F_MIN, 20000));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={rootRef}
      className="relative w-full h-full touch-none"
      style={{ background: 'radial-gradient(circle at 50% 30%, #0a0d12, #050608)' }}
    >
      <svg viewBox={`0 0 ${w} ${h}`} className="absolute inset-0 w-full h-full">
        {rta && rta.length > 0 && <RtaSpectrum data={rta} w={w} h={h} />}

        {[100, 1000, 10000].map(f => (
          <line key={f} x1={sx(f)} y1={0} x2={sx(f)} y2={h} stroke="rgba(255,255,255,0.07)" strokeWidth={1} />
        ))}
        {[-12, -6, 6, 12].map(db => (
          <line key={db} x1={0} y1={sy(db)} x2={w} y2={sy(db)} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
        ))}
        <line x1={0} y1={sy(0)} x2={w} y2={sy(0)} stroke="rgba(255,255,255,0.22)" strokeWidth={1} />

        <path d={fill} fill={accent} opacity={0.14} />
        <path d={line} fill="none" stroke={accent} strokeWidth={2} style={{ filter: `drop-shadow(0 0 3px ${accent})` }} />

        {markers.map(m => (
          <line key={m.id} x1={sx(m.freq)} y1={0} x2={sx(m.freq)} y2={h} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />
        ))}

        {[100, 1000, 10000].map(f => (
          <text key={f} x={sx(f) + 3} y={h - 5} fill="#4a5568" fontSize={9} fontFamily="monospace">
            {f >= 1000 ? `${f / 1000}k` : f}
          </text>
        ))}
      </svg>

      {/* draggable markers */}
      {markers.map(m => (
        <button
          key={m.id}
          onPointerDown={dragMarker(m)}
          className={`absolute -translate-x-1/2 top-0 px-1 py-[1px] text-[7px] font-black tracking-widest text-gray-900 bg-gray-200 rounded-b-[2px] ${m.onFreq ? 'cursor-ew-resize' : ''}`}
          style={{ left: sx(m.freq) }}
        >
          {m.label}
        </button>
      ))}

      {/* draggable band nodes — HTML overlay, always round */}
      {bands.filter(b => b.active).map(b => {
        const cx = sx(b.freq);
        const cy = b.type === 'hp' || b.type === 'lp' ? sy(0) : sy(clamp(b.gainDb, -Y_RANGE, Y_RANGE));
        const on = b.id === selected;
        return (
          <button
            key={b.id}
            onPointerDown={dragBand(b)}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 cursor-move touch-none"
            style={{
              left: cx,
              top: cy,
              width: on ? 16 : 12,
              height: on ? 16 : 12,
              background: '#0b0c10',
              borderColor: accent,
              boxShadow: on ? `0 0 8px ${accent}` : `0 0 3px ${accent}88`,
              zIndex: on ? 2 : 1,
            }}
            title={b.id}
          />
        );
      })}
    </div>
  );
};

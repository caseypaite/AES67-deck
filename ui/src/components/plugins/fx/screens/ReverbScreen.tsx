import React, { useRef } from 'react';

// Reverb decay-envelope screen — level (dB, 0…−70) vs time. Pre-delay gap,
// an early-reflection cluster scaled by diffusion, then the exponential tail
// reaching −60 dB at the decay time. Pre-delay and decay time are draggable.

// square viewBox — the screen slot is always a square (see FxEditorShell)
const VB_W = 300, VB_H = 300;
const DB_FLOOR = -70;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const ReverbScreen = ({
  decayTime,
  predelayMs,
  diffusion,
  accent,
  onPredelay,
  onDecay,
}: {
  decayTime: number; // seconds
  predelayMs: number;
  diffusion: number; // 0..1
  accent: string;
  onPredelay: (ms: number) => void;
  onDecay: (s: number) => void;
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const windowS = Math.max(1.2, decayTime * 1.25);
  const tx = (s: number) => (s / windowS) * VB_W;
  const ty = (db: number) => (db / DB_FLOOR) * VB_H;

  const preS = predelayMs / 1000;
  // tail: 0 dB at onset → −60 dB at onset+decayTime
  const tailPts: string[] = [];
  for (let i = 0; i <= 100; i++) {
    const s = preS + (i / 100) * (windowS - preS);
    const db = clamp((-60 * (s - preS)) / Math.max(0.05, decayTime), DB_FLOOR, 0);
    tailPts.push(`${tx(s).toFixed(1)},${ty(db).toFixed(1)}`);
  }
  const tail = `M ${tx(preS)},${ty(0)} L ${tailPts.join(' L ')}`;
  const fillTail = `${tail} L ${tx(windowS)},${VB_H} L ${tx(preS)},${VB_H} Z`;

  const drag = (which: 'pre' | 'decay') => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = svgRef.current!.getBoundingClientRect();
      const s = clamp(((ev.clientX - r.left) / r.width) * windowS, 0, windowS);
      if (which === 'pre') onPredelay(clamp(s * 1000, 0, 500));
      else onDecay(clamp(s - preS, 0.4, 15));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
      className="w-full h-full block touch-none"
      style={{ background: 'radial-gradient(circle at 50% 40%, #0a0d12, #050608)' }}
    >
      {[-12, -24, -36, -48, -60].map(db => (
        <line key={db} x1={0} y1={ty(db)} x2={VB_W} y2={ty(db)} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
      ))}
      {Array.from({ length: Math.ceil(windowS) }).map((_, i) => (
        <line key={i} x1={tx(i + 1)} y1={0} x2={tx(i + 1)} y2={VB_H} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
      ))}

      {/* early reflections */}
      {Array.from({ length: 7 }).map((_, i) => {
        const s = preS + (i + 1) * 0.012 * (2 - diffusion);
        const amp = (1 - i / 9) * (0.5 + diffusion * 0.5);
        return s < windowS ? (
          <line key={i} x1={tx(s)} y1={ty(0)} x2={tx(s)} y2={ty(clamp(-8 - i * 3, DB_FLOOR, 0)) * amp} stroke={accent} strokeWidth={1.5} opacity={0.5} />
        ) : null;
      })}

      <path d={fillTail} fill={accent} opacity={0.13} />
      <path d={tail} fill="none" stroke={accent} strokeWidth={2} style={{ filter: `drop-shadow(0 0 3px ${accent})` }} />

      {/* pre-delay handle */}
      <line x1={tx(preS)} y1={0} x2={tx(preS)} y2={VB_H} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} pointerEvents="none" />
      <circle cx={tx(preS)} cy={14} r={6} fill="#0b0c10" stroke="#e5e7eb" strokeWidth={2} className="cursor-ew-resize" onPointerDown={drag('pre')} />

      {/* decay-time handle (−60 dB crossing) */}
      <circle cx={tx(preS + decayTime)} cy={ty(-60)} r={6} fill="#0b0c10" stroke={accent} strokeWidth={2.5} className="cursor-ew-resize" onPointerDown={drag('decay')} />

      <text x={VB_W - 4} y={12} textAnchor="end" fill="#4a5568" fontSize={8} fontFamily="monospace">RT60 {decayTime.toFixed(1)} s</text>
      <text x={5} y={VB_H - 4} fill="#4a5568" fontSize={8} fontFamily="monospace" letterSpacing="1">TIME</text>
    </svg>
  );
};

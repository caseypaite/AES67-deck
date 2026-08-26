import React, { useEffect, useRef, useState } from 'react';

// Generic input→output transfer-curve screen (dBFS on both axes). Used by
// Saturator, Crusher and Limiter — each passes its own curve function, and
// Limiter additionally passes a draggable ceiling line. Grid + unity
// diagonal + live operating-point dot & comet trail, matching TransferGraph.

const X_MIN = -54, X_MAX = 0;
const Y_MIN = -54, Y_MAX = 6;
const VB = 300;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const sx = (db: number) => ((db - X_MIN) / (X_MAX - X_MIN)) * VB;
const sy = (db: number) => VB - ((db - Y_MIN) / (Y_MAX - Y_MIN)) * VB;

export const CurveScreen = ({
  curve,
  accent,
  live,
  ceilingDb,
  onCeiling,
  caption,
}: {
  curve: (xDb: number) => number;
  accent: string;
  live: { inDb: number; outDb: number } | null;
  ceilingDb?: number;
  onCeiling?: (db: number) => void;
  caption?: string;
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [trail, setTrail] = useState<{ x: number; y: number }[]>([]);
  const signal = !!live && live.inDb > X_MIN + 1;

  useEffect(() => {
    if (!live || live.inDb <= X_MIN + 1) {
      setTrail(prev => (prev.length ? [] : prev));
      return;
    }
    setTrail(prev => [...prev.slice(-22), { x: live.inDb, y: live.outDb }]);
  }, [live]);

  const pts: string[] = [];
  for (let i = 0; i <= 120; i++) {
    const x = X_MIN + (i / 120) * (X_MAX - X_MIN);
    pts.push(`${sx(x).toFixed(1)},${sy(clamp(curve(x), Y_MIN, Y_MAX)).toFixed(1)}`);
  }
  const line = `M ${pts.join(' L ')}`;
  const fill = `${line} L ${sx(X_MAX)},${sy(Y_MIN)} L ${sx(X_MIN)},${sy(Y_MIN)} Z`;

  const startCeilingDrag = (e: React.PointerEvent) => {
    if (!onCeiling) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = svgRef.current!.getBoundingClientRect();
      const fy = clamp((ev.clientY - r.top) / r.height, 0, 1);
      onCeiling(clamp(Y_MAX - fy * (Y_MAX - Y_MIN), -24, 0));
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
      viewBox={`0 0 ${VB} ${VB}`}
      preserveAspectRatio="none"
      className="w-full h-full block touch-none"
      style={{ background: 'radial-gradient(circle at 50% 40%, #0a0d12, #050608)' }}
    >
      {[-42, -30, -18, -6].map(db => (
        <g key={db} stroke="rgba(255,255,255,0.06)" strokeWidth={1}>
          <line x1={sx(db)} y1={0} x2={sx(db)} y2={VB} />
          <line x1={0} y1={sy(db)} x2={VB} y2={sy(db)} />
        </g>
      ))}
      <line x1={sx(X_MIN)} y1={sy(X_MIN)} x2={sx(X_MAX)} y2={sy(X_MAX)} stroke="rgba(255,255,255,0.22)" strokeWidth={1} strokeDasharray="3 3" />

      <path d={fill} fill={accent} opacity={0.12} />
      <path d={line} fill="none" stroke={accent} strokeWidth={2} style={{ filter: `drop-shadow(0 0 3px ${accent})` }} />

      {ceilingDb !== undefined && (
        <line
          x1={0} y1={sy(ceilingDb)} x2={VB} y2={sy(ceilingDb)}
          stroke="#fbbf24" strokeWidth={onCeiling ? 6 : 2}
          strokeOpacity={onCeiling ? 0.001 : 0.7}
          className={onCeiling ? 'cursor-ns-resize' : ''}
          onPointerDown={startCeilingDrag}
        />
      )}
      {ceilingDb !== undefined && (
        <line x1={0} y1={sy(ceilingDb)} x2={VB} y2={sy(ceilingDb)} stroke="#fbbf24" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />
      )}

      {trail.map((p, i) => (
        <circle key={i} cx={sx(clamp(p.x, X_MIN, X_MAX))} cy={sy(clamp(p.y, Y_MIN, Y_MAX))} r={1.8} fill={accent} opacity={(i / trail.length) * 0.45} />
      ))}
      {signal && live && (
        <circle cx={sx(clamp(live.inDb, X_MIN, X_MAX))} cy={sy(clamp(live.outDb, Y_MIN, Y_MAX))} r={4.5} fill="#fff" stroke={accent} strokeWidth={2}>
          <animate attributeName="r" values="4.5;6.5;4.5" dur="0.7s" repeatCount="indefinite" />
        </circle>
      )}

      <text x={VB - 4} y={VB - 4} textAnchor="end" fill="#4a5568" fontSize={8} fontFamily="monospace" letterSpacing="1">INPUT dB</text>
      <text x={5} y={11} fill="#4a5568" fontSize={8} fontFamily="monospace" letterSpacing="1">{caption ?? 'OUTPUT dB'}</text>
    </svg>
  );
};

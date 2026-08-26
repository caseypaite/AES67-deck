import React, { useEffect, useRef, useState } from 'react';

// Compressor/limiter transfer-function graph: input dB (x) vs output dB (y),
// the compression law drawn as a curve, a unity diagonal, draggable
// threshold + ratio nodes, and a live operating-point dot + comet trail +
// gain-reduction drop-line driven off the engine's per-plugin metering
// (docs/fx-ui-design.md §4.2).

const X_MIN = -60, X_MAX = 0;   // input dBFS
const Y_MIN = -60, Y_MAX = 6;   // output dBFS (a little headroom for makeup)
const VB_W = 300, VB_H = 300;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const sx = (db: number) => ((db - X_MIN) / (X_MAX - X_MIN)) * VB_W;
const sy = (db: number) => VB_H - ((db - Y_MIN) / (Y_MAX - Y_MIN)) * VB_H;

// Static soft-knee compressor law (no makeup). Matches the quadratic-knee
// form Calf uses: hard below/above the knee, quadratic blend across it.
function compressorCurve(xDb: number, thrDb: number, ratio: number, kneeDb: number): number {
  const t = xDb - thrDb;
  if (kneeDb < 0.1) return t <= 0 ? xDb : thrDb + t / ratio;
  if (2 * t < -kneeDb) return xDb;
  if (2 * t > kneeDb) return thrDb + t / ratio;
  const a = 1 / ratio - 1;
  const d = t + kneeDb / 2;
  return xDb + (a * d * d) / (2 * kneeDb);
}

export const TransferGraph = ({
  thresholdDb,
  ratio,
  kneeDb,
  makeupDb,
  live,
  accent,
  onThreshold,
  onRatio,
}: {
  thresholdDb: number;
  ratio: number;
  kneeDb: number;
  makeupDb: number;
  live: { inDb: number; outDb: number } | null;
  accent: string;
  onThreshold: (db: number) => void;
  onRatio: (ratio: number) => void;
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

  const curveAt = (x: number) => clamp(compressorCurve(x, thresholdDb, ratio, kneeDb) + makeupDb, Y_MIN, Y_MAX);

  // curve + fill
  const pts: string[] = [];
  for (let i = 0; i <= 100; i++) {
    const x = X_MIN + (i / 100) * (X_MAX - X_MIN);
    pts.push(`${sx(x).toFixed(1)},${sy(curveAt(x)).toFixed(1)}`);
  }
  const curvePath = `M ${pts.join(' L ')}`;
  const fillPath = `${curvePath} L ${sx(X_MAX)},${sy(Y_MIN)} L ${sx(X_MIN)},${sy(Y_MIN)} Z`;

  // nodes
  const thrNodeY = curveAt(thresholdDb);
  const ratioX = clamp(thresholdDb + 18, X_MIN + 12, X_MAX - 2);
  const ratioNodeY = curveAt(ratioX);

  const dbFromEvent = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const fx = clamp((clientX - r.left) / r.width, 0, 1);
    const fy = clamp((clientY - r.top) / r.height, 0, 1);
    return {
      xdb: X_MIN + fx * (X_MAX - X_MIN),
      ydb: Y_MAX - fy * (Y_MAX - Y_MIN),
    };
  };

  const startDrag = (kind: 'thr' | 'ratio') => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const { xdb, ydb } = dbFromEvent(ev.clientX, ev.clientY);
      if (kind === 'thr') {
        onThreshold(clamp(xdb, X_MIN, X_MAX));
      } else {
        const outAboveThr = ydb - makeupDb - thresholdDb; // pre-makeup, above threshold
        const inAboveThr = ratioX - thresholdDb;
        onRatio(clamp(inAboveThr / Math.max(outAboveThr, 0.4), 1, 20));
      }
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
      {/* grid */}
      {[-48, -36, -24, -12].map(db => (
        <g key={db} stroke="rgba(255,255,255,0.06)" strokeWidth={1}>
          <line x1={sx(db)} y1={0} x2={sx(db)} y2={VB_H} />
          <line x1={0} y1={sy(db)} x2={VB_W} y2={sy(db)} />
        </g>
      ))}
      {[-36, -12].map(db => (
        <text key={db} x={sx(db) + 2} y={VB_H - 3} fill="#4a5568" fontSize={8} fontFamily="monospace">{db}</text>
      ))}

      {/* unity diagonal */}
      <line x1={sx(X_MIN)} y1={sy(X_MIN)} x2={sx(X_MAX)} y2={sy(X_MAX)} stroke="rgba(255,255,255,0.22)" strokeWidth={1} strokeDasharray="3 3" />

      {/* transfer curve */}
      <path d={fillPath} fill={accent} opacity={0.12} />
      <path d={curvePath} fill="none" stroke={accent} strokeWidth={2} style={{ filter: `drop-shadow(0 0 3px ${accent})` }} />

      {/* threshold guide line */}
      <line x1={sx(thresholdDb)} y1={0} x2={sx(thresholdDb)} y2={VB_H} stroke={accent} strokeWidth={1} opacity={0.3} strokeDasharray="2 4" />

      {/* comet trail */}
      {trail.map((p, i) => (
        <circle
          key={i}
          cx={sx(clamp(p.x, X_MIN, X_MAX))}
          cy={sy(clamp(p.y, Y_MIN, Y_MAX))}
          r={1.8}
          fill={accent}
          opacity={(i / trail.length) * 0.45}
        />
      ))}

      {/* live operating point + gain-reduction drop line */}
      {signal && live && (
        <>
          <line
            x1={sx(clamp(live.inDb, X_MIN, X_MAX))}
            y1={sy(clamp(live.inDb + makeupDb, Y_MIN, Y_MAX))}
            x2={sx(clamp(live.inDb, X_MIN, X_MAX))}
            y2={sy(clamp(live.outDb, Y_MIN, Y_MAX))}
            stroke="#fbbf24"
            strokeWidth={2}
            opacity={0.8}
          />
          <circle cx={sx(clamp(live.inDb, X_MIN, X_MAX))} cy={sy(clamp(live.outDb, Y_MIN, Y_MAX))} r={4.5} fill="#fff" stroke={accent} strokeWidth={2}>
            <animate attributeName="r" values="4.5;6.5;4.5" dur="0.7s" repeatCount="indefinite" />
          </circle>
        </>
      )}

      {/* draggable nodes */}
      <circle
        cx={sx(thresholdDb)} cy={sy(thrNodeY)} r={7}
        fill="#0b0c10" stroke={accent} strokeWidth={2.5}
        className="cursor-ew-resize" onPointerDown={startDrag('thr')}
      />
      <circle
        cx={sx(ratioX)} cy={sy(ratioNodeY)} r={7}
        fill="#0b0c10" stroke={accent} strokeWidth={2.5}
        className="cursor-ns-resize" onPointerDown={startDrag('ratio')}
      />

      {/* axis captions */}
      <text x={VB_W - 4} y={VB_H - 4} textAnchor="end" fill="#4a5568" fontSize={8} fontFamily="monospace" letterSpacing="1">INPUT dB</text>
      <text x={5} y={11} fill="#4a5568" fontSize={8} fontFamily="monospace" letterSpacing="1">OUTPUT dB</text>
    </svg>
  );
};

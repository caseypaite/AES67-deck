import React from 'react';

// Vintage Delay tap timeline — dry impulse at t=0, then the L (up) and R
// (down) echo trains decaying by feedback over a ~2 s window.

// square viewBox — the screen slot is always a square (see FxEditorShell)
const VB_W = 300, VB_H = 300;
const MID = VB_H / 2;

export const DelayScreen = ({
  bpm,
  subdiv,
  timeL,
  timeR,
  feedback,
  wet,
  dry,
  accent,
}: {
  bpm: number;
  subdiv: number;
  timeL: number;
  timeR: number;
  feedback: number;
  wet: number;
  dry: number;
  accent: string;
}) => {
  const stepMs = (60000 / bpm) / Math.max(1, subdiv);
  const delayL = Math.max(1, timeL) * stepMs;
  const delayR = Math.max(1, timeR) * stepMs;
  const windowMs = Math.max(800, Math.max(delayL, delayR) * 4.2);
  const tx = (ms: number) => (ms / windowMs) * VB_W;

  const echoes = (delay: number, up: boolean) => {
    const rows: React.ReactNode[] = [];
    let amp = Math.min(1, wet);
    for (let k = 1; k <= 12; k++) {
      const t = k * delay;
      if (t > windowMs) break;
      const h = amp * (MID - 8);
      rows.push(
        <line
          key={k}
          x1={tx(t)} y1={MID} x2={tx(t)} y2={up ? MID - h : MID + h}
          stroke={accent} strokeWidth={2} strokeLinecap="round"
          opacity={0.4 + amp * 0.6}
        />,
      );
      amp *= feedback;
      if (amp < 0.02) break;
    }
    return rows;
  };

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
      className="w-full h-full block"
      style={{ background: 'radial-gradient(circle at 50% 50%, #0a0d12, #050608)' }}
    >
      {/* beat grid */}
      {Array.from({ length: 40 }).map((_, i) => {
        const t = (i + 1) * stepMs;
        return t < windowMs ? (
          <line key={i} x1={tx(t)} y1={0} x2={tx(t)} y2={VB_H} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
        ) : null;
      })}
      <line x1={0} y1={MID} x2={VB_W} y2={MID} stroke="rgba(255,255,255,0.18)" strokeWidth={1} />

      {/* dry impulse */}
      <line x1={1} y1={MID - Math.min(1, dry) * (MID - 8)} x2={1} y2={MID + Math.min(1, dry) * (MID - 8)} stroke="#e5e7eb" strokeWidth={2.5} />

      {echoes(delayL, true)}
      {echoes(delayR, false)}

      <text x={4} y={12} fill="#4a5568" fontSize={8} fontFamily="monospace" letterSpacing="1">L</text>
      <text x={4} y={VB_H - 4} fill="#4a5568" fontSize={8} fontFamily="monospace" letterSpacing="1">R</text>
      <text x={VB_W - 4} y={MID - 4} textAnchor="end" fill="#4a5568" fontSize={8} fontFamily="monospace">
        {Math.round(delayL)} / {Math.round(delayR)} ms
      </text>
    </svg>
  );
};

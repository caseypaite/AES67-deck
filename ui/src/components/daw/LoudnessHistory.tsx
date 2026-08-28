import { useMemo } from 'react';
import { useDawStore } from '../../stores/useDawStore';
import { useMixerStore } from '../../stores/useMixerStore';
import { useLoudnessStore } from '../../stores/useLoudnessStore';
import { wsSend } from '../../lib/wsBus';

// Phase 3c — the loudness-history strip under the TIMELINE. Short-term (filled)
// and Integrated (line) over time against the target, with a live M/S/I/TP
// readout and a one-click compliance-report export for the region bracketing
// the playhead. The server keeps the authoritative CSV log; this only draws it.

const VB_W = 1000;
const VB_H = 100;
const DB_TOP = 0;     // top of the plot, LUFS
const DB_BOT = -36;   // bottom of the plot, LUFS
const TARGETS = [-14, -23, -24];

const yOf = (db: number) => {
  const c = Math.max(DB_BOT, Math.min(DB_TOP, db));
  return ((DB_TOP - c) / (DB_TOP - DB_BOT)) * VB_H;
};

const fmt = (v: number | undefined | null) => (v == null || v < -100 ? '––.–' : v.toFixed(1));

export function LoudnessHistory() {
  const samples = useLoudnessStore((s) => s.samples);
  const target = useLoudnessStore((s) => s.target);
  const logWhileStopped = useLoudnessStore((s) => s.logWhileStopped);
  const setTarget = useLoudnessStore((s) => s.setTarget);
  const setLogWhileStopped = useLoudnessStore((s) => s.setLogWhileStopped);

  const lufs = useMixerStore((s) => s.lufs);
  const markers = useDawStore((s) => s.markers);
  const playhead = useDawStore((s) => s.playheadPosition);
  const projectName = useDawStore((s) => s.projectName);
  const setLoudnessOpen = useDawStore((s) => s.setLoudnessOpen);

  const { stArea, stLine, iLine } = useMemo(() => {
    const n = samples.length;
    if (n === 0) return { stArea: '', stLine: '', iLine: '' };
    const x = (idx: number) => (n === 1 ? VB_W : (idx / (n - 1)) * VB_W);

    let line = '';
    samples.forEach((s, idx) => {
      const v = Number.isFinite(s.s) && s.s > -120 ? s.s : DB_BOT;
      line += `${idx ? ' L' : 'M'} ${x(idx).toFixed(1)} ${yOf(v).toFixed(1)}`;
    });
    const area = `M 0 ${VB_H} ${line.replace(/^M/, 'L')} L ${VB_W} ${VB_H} Z`;

    // Integrated: skip the early "no measurement yet" samples so the line only
    // starts once the gate has something.
    let iPath = '';
    let started = false;
    samples.forEach((s, idx) => {
      if (!Number.isFinite(s.i) || s.i <= -70) return;
      iPath += `${started ? ' L' : 'M'} ${x(idx).toFixed(1)} ${yOf(s.i).toFixed(1)}`;
      started = true;
    });
    return { stArea: area, stLine: line, iLine: iPath };
  }, [samples]);

  const exportReport = () => {
    const times = Object.values(markers).map((m) => m.time).sort((a, b) => a - b);
    const lastSec = samples.length ? samples[samples.length - 1].sec : playhead;
    let start = 0;
    let end = Math.max(playhead, lastSec);
    const prev = [...times].reverse().find((t) => t <= playhead + 1e-3);
    const next = times.find((t) => t > playhead + 1e-3);
    if (prev != null && next != null) { start = prev; end = next; }
    else if (times.length >= 2) { start = times[0]; end = times[times.length - 1]; }
    if (end <= start) end = start + Math.max(1, lastSec - start);
    wsSend({
      type: 'export_loudness_report',
      startSec: start, endSec: end, target,
      name: `${projectName || 'session'}`,
    });
  };

  const tpWarn = (lufs?.tp ?? -120) > -1;
  const overTarget = (lufs?.i ?? -120) > target + 1;

  return (
    <div className="shrink-0 h-[92px] bg-[#0d0f13] border-t border-[#242832] flex items-stretch text-gray-300">
      {/* controls */}
      <div className="w-[150px] shrink-0 border-r border-[#242832] p-1.5 flex flex-col gap-1 justify-between">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-black tracking-widest text-gray-500">LUFS LOG</span>
          <button onClick={() => setLoudnessOpen(false)} className="text-gray-500 hover:text-white text-xs px-0.5" title="Close">✕</button>
        </div>
        <div className="flex gap-0.5">
          {TARGETS.map((t) => (
            <button
              key={t}
              onClick={() => setTarget(t)}
              className={`flex-1 py-0.5 text-[9px] font-bold rounded ${
                target === t ? 'bg-cyan-600 text-white' : 'bg-[#1a1c22] text-gray-400 hover:bg-[#26282f]'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-[8px] text-gray-500">
          <input type="checkbox" checked={logWhileStopped} onChange={(e) => setLogWhileStopped(e.target.checked)} />
          log while stopped
        </label>
        <button
          onClick={exportReport}
          className="py-1 text-[9px] font-bold rounded bg-[#1a1c22] text-gray-200 hover:bg-[#26282f]"
          title="Compliance report for the region bracketing the playhead"
        >
          REPORT REGION
        </button>
      </div>

      {/* plot */}
      <div className="flex-1 relative min-w-0">
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
          {/* target band + line */}
          <rect x={0} y={yOf(target + 1)} width={VB_W} height={Math.max(0, yOf(target - 1) - yOf(target + 1))} fill="#22d3ee" opacity={0.10} />
          <line x1={0} x2={VB_W} y1={yOf(target)} y2={yOf(target)} stroke="#22d3ee" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" opacity={0.8} />
          {/* -1 dBTP ceiling reference */}
          <line x1={0} x2={VB_W} y1={yOf(-1)} y2={yOf(-1)} stroke="#f87171" strokeWidth={1} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" opacity={0.4} />
          {stArea && <path d={stArea} fill="#34d399" opacity={0.18} />}
          {stLine && <path d={stLine} fill="none" stroke="#34d399" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.55} />}
          {iLine && <path d={iLine} fill="none" stroke="#e5e7eb" strokeWidth={1.75} vectorEffect="non-scaling-stroke" />}
        </svg>

        {samples.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-gray-600">
            Roll the transport to log loudness
          </div>
        )}

        {/* live readout */}
        <div className="absolute top-1 right-2 flex gap-2.5 font-mono tabular-nums text-[10px] bg-[#0d0f13]/80 rounded px-1.5 py-0.5">
          <span className="text-gray-400">M <span className="text-gray-200">{fmt(lufs?.m)}</span></span>
          <span className="text-gray-400">S <span className="text-gray-200">{fmt(lufs?.s)}</span></span>
          <span className="text-gray-400">I <span className={overTarget ? 'text-red-400' : 'text-gray-200'}>{fmt(lufs?.i)}</span></span>
          <span className="text-gray-400">TP <span className={tpWarn ? 'text-red-400' : 'text-gray-200'}>{fmt(lufs?.tp)}</span></span>
        </div>
        <div className="absolute bottom-0.5 left-1.5 text-[8px] font-mono text-gray-600">{DB_BOT}</div>
        <div className="absolute top-0.5 left-1.5 text-[8px] font-mono text-gray-600">{DB_TOP} LUFS</div>
      </div>
    </div>
  );
}

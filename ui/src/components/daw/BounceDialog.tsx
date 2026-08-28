import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDawStore } from '../../stores/useDawStore';

// Phase 4 — realtime master bounce. Render a timeline span through the mixing
// graph to a WAV in records/bounces/. The server times the run (locate → roll →
// stop); this dialog picks the span / name / bit-depth and shows progress.

const fmtBytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const fmtDur = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export function BounceDialog({ onClose }: { onClose: () => void }) {
  const region = useDawStore((s) => s.region);
  const projectName = useDawStore((s) => s.projectName);
  const bounceState = useDawStore((s) => s.bounceState);
  const bounceError = useDawStore((s) => s.bounceError);
  const lastBounce = useDawStore((s) => s.lastBounce);
  const bounces = useDawStore((s) => s.bounces);
  const startBounce = useDawStore((s) => s.startBounce);
  const cancelBounce = useDawStore((s) => s.cancelBounce);
  const playhead = useDawStore((s) => s.playheadPosition);

  const [name, setName] = useState(projectName || 'mix');
  const [bits, setBits] = useState<16 | 24>(24);
  const [useRegion, setUseRegion] = useState(!!region);

  useEffect(() => { setUseRegion(!!region); }, [region]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const span = useMemo(() => {
    if (useRegion && region) return { inSec: region.inSec, outSec: region.outSec };
    return { inSec: 0, outSec: useDawStore.getState().projectEndSec() };
  }, [useRegion, region]);
  const spanLen = Math.max(0, span.outSec - span.inSec);
  const canBounce = spanLen > 0.05 && name.trim().length > 0;

  const running = bounceState === 'running';
  const progress = running && spanLen > 0
    ? Math.max(0, Math.min(1, (playhead - span.inSec) / spanLen))
    : 0;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70" onClick={running ? undefined : onClose}>
      <div
        className="bg-[#1a1c22] border border-[#2a2d33] rounded-sm p-4 flex flex-col gap-3 shadow-2xl w-[380px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-bold text-white text-sm flex items-center justify-between">
          Bounce
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xs">✕</button>
        </div>

        {running ? (
          <>
            <div className="text-xs text-gray-400">Rendering {fmtDur(spanLen)} through the master chain…</div>
            <div className="h-2 rounded-full bg-[#0b0c10] overflow-hidden border border-[#2a2d33]">
              <div className="h-full bg-blue-600 transition-[width] duration-150" style={{ width: `${progress * 100}%` }} />
            </div>
            <div className="flex justify-between text-[10px] font-mono text-gray-500 tabular-nums">
              <span>{fmtDur(Math.max(0, playhead - span.inSec))}</span>
              <span>{Math.round(progress * 100)}%</span>
              <span>{fmtDur(spanLen)}</span>
            </div>
            <div className="flex justify-end pt-1">
              <button onClick={cancelBounce} className="px-3 py-1.5 text-xs font-bold rounded-sm bg-red-700 text-white hover:bg-red-600">
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-black tracking-widest uppercase text-gray-500">File name</span>
              <div className="flex items-center bg-[#0b0c10] border border-[#2a2d33] rounded-sm">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && canBounce) startBounce({ ...span, name, bits }); }}
                  className="flex-1 bg-transparent text-gray-200 text-sm px-2 py-1.5 outline-none"
                />
                <span className="text-[10px] text-gray-600 pr-2 font-mono">-‹ts›.wav</span>
              </div>
            </label>

            <div className="flex gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-black tracking-widest uppercase text-gray-500">Range</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setUseRegion(true)} disabled={!region}
                    className={`px-2.5 py-1 text-xs font-bold rounded-sm disabled:opacity-30 ${useRegion && region ? 'bg-blue-600 text-white' : 'bg-[#23262d] text-gray-400'}`}
                  >Region</button>
                  <button
                    onClick={() => setUseRegion(false)}
                    className={`px-2.5 py-1 text-xs font-bold rounded-sm ${!useRegion ? 'bg-blue-600 text-white' : 'bg-[#23262d] text-gray-400'}`}
                  >Full project</button>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-black tracking-widest uppercase text-gray-500">Bit depth</span>
                <div className="flex gap-1">
                  {[24, 16].map((b) => (
                    <button
                      key={b} onClick={() => setBits(b as 16 | 24)}
                      className={`px-2.5 py-1 text-xs font-bold rounded-sm ${bits === b ? 'bg-blue-600 text-white' : 'bg-[#23262d] text-gray-400'}`}
                    >{b}-bit</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="text-[11px] text-gray-500 font-mono tabular-nums">
              {spanLen > 0.05
                ? `${fmtDur(span.inSec)} – ${fmtDur(span.outSec)}  ·  ${fmtDur(spanLen)}  ·  realtime`
                : 'nothing to bounce — record or set a region first'}
            </div>

            {bounceState === 'failed' && bounceError && (
              <div className="text-xs text-red-400">⚠ {bounceError}</div>
            )}
            {bounceState === 'done' && lastBounce && (
              <div className="text-xs text-emerald-400 leading-relaxed">
                ✓ {lastBounce.name} · {fmtBytes(lastBounce.bytes)} · {fmtDur(lastBounce.durationSec)}
                <div className="text-gray-500 font-mono text-[10px]">records/bounces/</div>
                {lastBounce.overrun && <div className="text-amber-400">⚠ disk overrun during render — re-bounce</div>}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-3 py-1.5 text-xs font-bold rounded-sm bg-[#23262d] text-gray-300 hover:bg-[#2c2f37]">
                Close
              </button>
              <button
                onClick={() => startBounce({ ...span, name, bits })}
                disabled={!canBounce}
                className="px-3 py-1.5 text-xs font-bold rounded-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
              >
                Bounce
              </button>
            </div>

            {bounces.length > 0 && (
              <div className="flex flex-col gap-0.5 pt-1 border-t border-[#2a2d33] max-h-28 overflow-y-auto">
                <span className="text-[9px] font-black tracking-widest uppercase text-gray-600 pt-1">Recent</span>
                {bounces.slice(0, 6).map((b) => (
                  <div key={b.name} className="flex justify-between text-[10px] font-mono text-gray-500">
                    <span className="truncate">{b.name}</span>
                    <span className="shrink-0 pl-2">{fmtBytes(b.bytes)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

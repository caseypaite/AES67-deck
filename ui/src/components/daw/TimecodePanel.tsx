import { useDawStore, formatTimecode } from '../../stores/useDawStore';

// Phase 3d — timecode & sync. Dense popover for the TIMELINE taskbar: picks the
// generated-timecode source (project transport position vs PTP time-of-day) and
// format, and arms the LTC generator / MTC generator / LTC chase. The engine
// owns generation + decode on `ltc_out` / `mtc_out` / `ltc_in`; this panel just
// drives `set_timecode_config` (server-persisted, replayed on engine reconnect).

const ROW = 'flex items-center justify-between gap-2 py-1';
const LABEL = 'text-[10px] font-bold tracking-wide text-gray-400';

function seg(active: boolean) {
  return `px-2 py-1 text-[10px] font-bold rounded transition-colors ${
    active ? 'bg-blue-600 text-white' : 'bg-[#363c47] text-gray-300 hover:bg-[#434a57]'
  }`;
}

// HH:MM:SS:FF string <-> whole TC frames, for the offset field.
function offsetToStr(frames: number, fps: number): string {
  const f = Math.max(0, Math.round(frames));
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${p(Math.floor(f / (3600 * fps)))}:${p(Math.floor(f / (60 * fps)) % 60)}:${p(Math.floor(f / fps) % 60)}:${p(f % fps)}`;
}
function strToOffset(str: string, fps: number): number | null {
  const m = str.trim().match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})[:;](\d{1,2})$/);
  if (!m) return null;
  const [, h, mn, s, fr] = m.map(Number);
  if (mn > 59 || s > 59 || fr >= fps) return null;
  return ((h * 60 + mn) * 60 + s) * fps + fr;
}

export function TimecodePanel({ onClose }: { onClose: () => void }) {
  const s = useDawStore();
  const set = s.setTimecodeConfig;

  return (
    <div className="absolute bottom-[46px] right-2 z-50 w-[300px] rounded-lg border border-[#2c313b] bg-[#0d0f13] shadow-2xl text-gray-300">
      <div className="flex items-center justify-between px-3 h-9 border-b border-[#242832]">
        <span className="text-[10px] font-black tracking-widest text-gray-500">TIMECODE &amp; SYNC</span>
        <button onClick={onClose} className="text-gray-500 hover:text-white text-xs px-1" title="Close">✕</button>
      </div>

      <div className="px-3 py-2">
        {/* Source */}
        <div className={ROW}>
          <span className={LABEL}>SOURCE</span>
          <div className="flex gap-1">
            <button className={seg(s.tcSource === 'project')} onClick={() => set({ tcSource: 'project' })}>PROJECT</button>
            <button className={seg(s.tcSource === 'tod')} onClick={() => set({ tcSource: 'tod' })}>TIME-OF-DAY</button>
          </div>
        </div>

        {/* Offset (project mode only) */}
        {s.tcSource === 'project' && (
          <div className={ROW}>
            <span className={LABEL}>START OFFSET</span>
            <input
              key={`${s.fps}-${s.tcOffsetFrames}`}
              defaultValue={offsetToStr(s.tcOffsetFrames, s.fps)}
              onBlur={(e) => {
                const v = strToOffset(e.target.value, s.fps);
                if (v != null) set({ tcOffsetFrames: v });
                else e.target.value = offsetToStr(s.tcOffsetFrames, s.fps);
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              className="w-24 bg-[#1a1d23] border border-[#3a3f48] rounded px-1.5 py-0.5 text-right font-mono text-[11px] text-gray-100 outline-none"
            />
          </div>
        )}

        {/* Format */}
        <div className={ROW}>
          <span className={LABEL}>FORMAT</span>
          <div className="flex gap-1">
            {[24, 25, 30].map((f) => (
              <button key={f} className={seg(s.fps === f)} onClick={() => set({ fps: f })}>{f}</button>
            ))}
            <button
              className={seg(s.dropFrame)}
              disabled={s.fps !== 30}
              onClick={() => set({ dropFrame: !s.dropFrame })}
              title="29.97 drop-frame (30 fps only)"
            >DF</button>
          </div>
        </div>

        <div className="my-1.5 border-t border-[#1e222a]" />

        {/* LTC out */}
        <div className={ROW}>
          <span className={LABEL}>LTC OUT <span className="text-gray-600 font-mono">ltc_out</span></span>
          <button className={seg(s.ltcGenOn)} onClick={() => set({ ltcGenOn: !s.ltcGenOn })}>{s.ltcGenOn ? 'ON' : 'OFF'}</button>
        </div>
        {s.ltcGenOn && (
          <div className={ROW}>
            <span className={LABEL}>LEVEL</span>
            <input
              type="range" min={0.05} max={1} step={0.05} value={s.ltcGenLevel}
              onChange={(e) => set({ ltcGenLevel: Number(e.target.value) })}
              className="w-40 accent-blue-500"
            />
          </div>
        )}

        {/* MTC out */}
        <div className={ROW}>
          <span className={LABEL}>MTC OUT <span className="text-gray-600 font-mono">mtc_out</span></span>
          <button className={seg(s.mtcGenOn)} onClick={() => set({ mtcGenOn: !s.mtcGenOn })}>{s.mtcGenOn ? 'ON' : 'OFF'}</button>
        </div>

        <div className="my-1.5 border-t border-[#1e222a]" />

        {/* LTC chase */}
        <div className={ROW}>
          <span className={LABEL}>LTC CHASE <span className="text-gray-600 font-mono">ltc_in</span></span>
          <button className={seg(s.ltcChaseOn)} onClick={() => set({ ltcChaseOn: !s.ltcChaseOn })}>{s.ltcChaseOn ? 'ON' : 'OFF'}</button>
        </div>
        {s.ltcChaseOn && (() => {
          const state = s.ltcChaseLocked
            ? (s.ltcInPeak > 0.02 ? 'LOCKED' : 'FLYWHEEL')
            : (s.ltcInPeak > 0.02 ? 'SIGNAL, NO LOCK' : 'NO SIGNAL');
          const dot = state === 'LOCKED' ? 'bg-emerald-400'
            : state === 'FLYWHEEL' ? 'bg-sky-400'
            : state === 'SIGNAL, NO LOCK' ? 'bg-amber-400' : 'bg-gray-600';
          const txt = state === 'LOCKED' ? 'text-emerald-400'
            : state === 'FLYWHEEL' ? 'text-sky-400'
            : state === 'SIGNAL, NO LOCK' ? 'text-amber-400' : 'text-gray-500';
          return (
            <div className={ROW}>
              <span className="flex items-center gap-1.5 text-[10px] font-bold">
                <span className={`w-2 h-2 rounded-full ${dot}`} />
                <span className={txt}>{state}</span>
                {s.ltcChaseLocked && <span className="text-gray-500 font-mono">{s.ltcChaseErrMs > 0 ? '+' : ''}{s.ltcChaseErrMs}ms</span>}
              </span>
              <span className="font-mono text-[11px] text-gray-300 tabular-nums">{s.ltcIncoming ?? '––:––:––:––'}</span>
            </div>
          );
        })()}
        {s.ltcChaseOn && (
          <p className="mt-1 text-[9px] leading-snug text-gray-600">
            The engine jam-syncs once, then flies on the JACK clock (riding through
            dropouts). Patch an LTC source to <span className="font-mono">ltc_in</span> in the patchbay.
          </p>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-[#242832] flex items-center justify-between">
        <span className="text-[9px] text-gray-600">
          {s.tcSource === 'tod' ? 'PTP wall clock' : 'transport + offset'}
        </span>
        <span className="font-mono text-[11px] text-gray-300 tabular-nums">
          {s.tcSource === 'tod' && s.tcTod != null
            ? formatTimecode(s.tcTod, s.fps, s.dropFrame)
            : formatTimecode(s.playheadPosition, s.fps, s.dropFrame)}
        </span>
      </div>
    </div>
  );
}

import { useDawStore } from '../stores/useDawStore';
import { useMixerStore, type Channel } from '../stores/useMixerStore';
import { RULER_H, DEFAULT_TRACK_H } from './SurfaceModel';

// Left column of track headers. Height-adaptive: a tall track shows the full
// control set, a short one collapses to name + arm. Scrolls in lockstep with
// the arrange surface via the shared scrollY in the store.
export function TrackPanel({ width }: { width: number }) {
  const channels = useMixerStore((s) => s.channels);
  const setChannelValue = useMixerStore((s) => s.setChannelValue);
  const renameChannel = useMixerStore((s) => s.renameChannel);
  const scrollY = useDawStore((s) => s.scrollY);
  const heights = useDawStore((s) => s.trackHeights);
  const setTrackHeight = useDawStore((s) => s.setTrackHeight);

  const tracks = Object.values(channels).filter((c: Channel) => c.type === 'input').sort((a, b) => a.id - b.id);

  return (
    <div className="shrink-0 bg-[#14161a] border-r border-black/60 relative overflow-hidden" style={{ width }}>
      <div className="h-full" style={{ transform: `translateY(${-scrollY}px)` }}>
        <div style={{ height: RULER_H }} className="border-b border-black/60 bg-[#101216] flex items-center px-3 text-[10px] font-black tracking-widest text-gray-500">
          TRACKS
        </div>
        {tracks.map((t) => {
          const h = heights[t.id] || DEFAULT_TRACK_H;
          const compact = h < 74;
          return (
            <div
              key={t.id}
              className={`relative border-b border-black/50 px-2 ${t.id % 2 ? 'bg-[#1a1d23]' : 'bg-[#181b20]'}`}
              style={{ height: h }}
            >
              <div className="flex items-center justify-between pt-1.5">
                <input
                  value={t.name}
                  onChange={(e) => renameChannel(t.id, e.target.value)}
                  className="bg-transparent text-gray-200 text-xs font-semibold w-full mr-1 outline-none focus:bg-black/30 rounded px-1"
                />
                <span className="text-[9px] text-gray-600 bg-black/40 px-1 rounded shrink-0">{t.id}</span>
              </div>
              <div className="flex gap-1 mt-1">
                {(['arm', 'solo', 'mute'] as const).map((k) => {
                  const on = t[k];
                  const col = k === 'arm' ? 'bg-red-600' : k === 'solo' ? 'bg-yellow-500 text-black' : 'bg-orange-600';
                  return (
                    <button
                      key={k}
                      onClick={() => setChannelValue(t.id, k, !on)}
                      className={`w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center transition-colors ${on ? col : 'bg-[#2a2c33] text-gray-500 hover:bg-[#333]'}`}
                    >
                      {k[0].toUpperCase()}
                    </button>
                  );
                })}
              </div>
              {!compact && (
                <div className="mt-1 h-1.5 bg-black rounded-sm overflow-hidden flex flex-col justify-end gap-px">
                  <div className="h-px bg-green-500" style={{ width: `${Math.max(0, (t.meterL + 60) / 60 * 100)}%` }} />
                  <div className="h-px bg-green-500" style={{ width: `${Math.max(0, (t.meterR + 60) / 60 * 100)}%` }} />
                </div>
              )}
              <div
                className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-white/10"
                onMouseDown={(e) => {
                  const y0 = e.clientY;
                  const h0 = h;
                  const mv = (ev: MouseEvent) => setTrackHeight(t.id, h0 + (ev.clientY - y0));
                  const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
                  window.addEventListener('mousemove', mv);
                  window.addEventListener('mouseup', up);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useRef, useState } from 'react';
import { useDawStore } from '../stores/useDawStore';
import { useMixerStore, type Channel } from '../stores/useMixerStore';
import { RULER_H, DEFAULT_TRACK_H, LANE_H, AUTO_LANE_H, TRACK_BG_ODD, TRACK_BG_EVEN } from './SurfaceModel';
import { AutoLanePicker } from '../components/daw/AutoLanePicker';

// Neutral (off-state) button — legible on the lightened track rows.
const OFF_BTN = 'bg-[#3b414d] text-gray-200 hover:bg-[#474e5c]';

// Left column of track headers. Height-adaptive: a tall track shows the full
// control set, a short one collapses to name + arm. Scrolls in lockstep with
// the arrange surface via the shared scrollY in the store.
export function TrackPanel({ width }: { width: number }) {
  const channels = useMixerStore((s) => s.channels);
  const setChannelValue = useMixerStore((s) => s.setChannelValue);
  const renameChannel = useMixerStore((s) => s.renameChannel);
  const monitorInputMask = useMixerStore((s) => s.monitorInputMask);
  const setChannelMonitorInput = useMixerStore((s) => s.setChannelMonitorInput);
  const scrollY = useDawStore((s) => s.scrollY);
  const scrollX = useDawStore((s) => s.scrollX);
  const setScroll = useDawStore((s) => s.setScroll);
  const heights = useDawStore((s) => s.trackHeights);
  const setTrackHeight = useDawStore((s) => s.setTrackHeight);
  const clips = useDawStore((s) => s.clips);
  const laneExpand = useDawStore((s) => s.laneExpand);
  const toggleLaneExpand = useDawStore((s) => s.toggleLaneExpand);
  const automation = useDawStore((s) => s.automation);
  const autoExpand = useDawStore((s) => s.autoExpand);
  const toggleAutoExpand = useDawStore((s) => s.toggleAutoExpand);
  const removeAutoLane = useDawStore((s) => s.removeAutoLane);
  const setAutoLaneEnabled = useDawStore((s) => s.setAutoLaneEnabled);
  const setAutoLaneArmed = useDawStore((s) => s.setAutoLaneArmed);
  const automationMode = useDawStore((s) => s.automationMode);
  const outerRef = useRef<HTMLDivElement>(null);
  const [pickerFor, setPickerFor] = useState<number | null>(null);

  const tracks = Object.values(channels).filter((c: Channel) => c.type === 'input').sort((a, b) => a.id - b.id);

  const laneCounts: Record<number, number> = {};
  for (const c of Object.values(clips)) {
    if (c.recording) continue;
    const L = c.lane || 0;
    if (L > (laneCounts[c.trackId] || 0)) laneCounts[c.trackId] = L;
  }
  const autoByTrack: Record<number, typeof automation[string][]> = {};
  for (const lane of Object.values(automation)) (autoByTrack[lane.target.channelId] ||= []).push(lane);

  const contentH = RULER_H + tracks.reduce((sum, t) => {
    const compH = heights[t.id] || DEFAULT_TRACK_H;
    const lanes = laneCounts[t.id] || 0;
    const autos = autoByTrack[t.id]?.length || 0;
    return sum + compH
      + (laneExpand[t.id] && lanes > 0 ? LANE_H * lanes : 0)
      + (autoExpand[t.id] && autos > 0 ? AUTO_LANE_H * autos : 0);
  }, 0);

  // Wheel over the track headers scrolls the shared vertical position, so you
  // don't have to be over the canvas to scroll the track list.
  const onWheel = (e: React.WheelEvent) => {
    const max = Math.max(0, contentH - (outerRef.current?.clientHeight ?? 0));
    if (max <= 0) return;
    setScroll(scrollX, Math.min(max, scrollY + e.deltaY));
  };

  return (
    <div ref={outerRef} onWheel={onWheel} className="shrink-0 bg-[#0f1114] border-r border-black/70 relative overflow-hidden" style={{ width }}>
      <div className="h-full" style={{ transform: `translateY(${-scrollY}px)` }}>
        <div style={{ height: RULER_H }} className="border-b border-black/70 bg-[#0c0e12] flex items-center px-3 text-[10px] font-black tracking-widest text-gray-300">
          TRACKS
        </div>
        {tracks.map((t) => {
          const compH = heights[t.id] || DEFAULT_TRACK_H;
          const lanes = laneCounts[t.id] || 0;
          const expanded = !!laneExpand[t.id] && lanes > 0;
          const autoLanes = autoByTrack[t.id] || [];
          const autoOpen = !!autoExpand[t.id] && autoLanes.length > 0;
          const h = compH + (expanded ? LANE_H * lanes : 0) + (autoOpen ? AUTO_LANE_H * autoLanes.length : 0);
          const autoTop = compH + (expanded ? LANE_H * lanes : 0);
          const compact = compH < 74;
          return (
            <div
              key={t.id}
              className="relative border-b border-black/70 px-2"
              style={{ height: h, background: t.id % 2 ? TRACK_BG_ODD : TRACK_BG_EVEN }}
            >
              <div className="flex items-center justify-between pt-1.5">
                {lanes > 0 && (
                  <button
                    onClick={() => toggleLaneExpand(t.id)}
                    title={expanded ? 'Hide take lanes' : `Show ${lanes} take lane${lanes > 1 ? 's' : ''}`}
                    className={`mr-1 w-4 h-4 shrink-0 flex items-center justify-center text-[9px] rounded ${OFF_BTN}`}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                )}
                <input
                  value={t.name}
                  onChange={(e) => renameChannel(t.id, e.target.value)}
                  className="bg-transparent text-gray-50 text-xs font-semibold w-full mr-1 outline-none focus:bg-black/40 rounded px-1"
                />
                {lanes > 0 && (
                  <span className="text-[8px] text-gray-200 bg-black/55 px-1 rounded shrink-0 mr-1" title="take lanes">⧉{lanes}</span>
                )}
                {autoLanes.length > 0 && (
                  <button
                    onClick={() => toggleAutoExpand(t.id)}
                    title={autoOpen ? 'Hide automation lanes' : `Show ${autoLanes.length} automation lane${autoLanes.length > 1 ? 's' : ''}`}
                    className={`text-[8px] px-1 rounded shrink-0 mr-1 ${autoOpen ? 'bg-sky-700 text-white' : OFF_BTN}`}
                  >⌁{autoLanes.length}</button>
                )}
                <button
                  onClick={() => setPickerFor(pickerFor === t.id ? null : t.id)}
                  title="Add an automation lane"
                  className={`w-4 h-4 shrink-0 mr-1 flex items-center justify-center text-[10px] rounded ${OFF_BTN}`}
                >+</button>
                <span className="text-[9px] text-gray-200 bg-black/55 px-1 rounded shrink-0">{t.id}</span>
              </div>
              {pickerFor === t.id && <AutoLanePicker channelId={t.id} onClose={() => setPickerFor(null)} />}
              <div className="flex gap-1 mt-1">
                {(['arm', 'solo', 'mute'] as const).map((k) => {
                  const on = t[k];
                  const col = k === 'arm' ? 'bg-red-600' : k === 'solo' ? 'bg-yellow-500 text-black' : 'bg-orange-600';
                  return (
                    <button
                      key={k}
                      onClick={() => setChannelValue(t.id, k, !on)}
                      className={`w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center transition-colors ${on ? col : OFF_BTN}`}
                    >
                      {k[0].toUpperCase()}
                    </button>
                  );
                })}
                {(() => {
                  const live = (monitorInputMask & (1 << (t.id - 1))) !== 0;
                  return (
                    <button
                      onClick={() => setChannelMonitorInput(t.id, !live)}
                      title={live ? 'Monitoring live input (click for timeline)' : 'Following the timeline (click to pin live input)'}
                      className={`w-6 h-5 rounded text-[8px] font-bold flex items-center justify-center transition-colors ml-auto ${live ? 'bg-amber-500 text-black' : OFF_BTN}`}
                    >
                      {live ? 'IN' : 'TL'}
                    </button>
                  );
                })()}
              </div>
              {!compact && (
                <div className="mt-1 h-1.5 bg-black rounded-sm overflow-hidden flex flex-col justify-end gap-px">
                  <div className="h-px bg-green-500" style={{ width: `${Math.max(0, (t.meterL + 60) / 60 * 100)}%` }} />
                  <div className="h-px bg-green-500" style={{ width: `${Math.max(0, (t.meterR + 60) / 60 * 100)}%` }} />
                </div>
              )}
              {expanded && Array.from({ length: lanes }, (_, k) => (
                <div
                  key={k}
                  className="absolute left-0 right-0 border-t border-white/15 bg-black/25 text-[8px] font-bold text-gray-300 pl-1"
                  style={{ top: compH + LANE_H * k, height: LANE_H }}
                >
                  take {k + 1}
                </div>
              ))}
              {autoOpen && autoLanes.map((lane, k) => (
                <div
                  key={lane.id}
                  className="absolute left-0 right-0 border-t border-white/15 bg-black/35 px-1 py-0.5 flex flex-col gap-0.5"
                  style={{ top: autoTop + AUTO_LANE_H * k, height: AUTO_LANE_H }}
                >
                  <div className="text-[8px] font-bold text-sky-300 truncate" title={lane.target.label}>⌁ {lane.target.label}</div>
                  <div className="flex gap-1 items-center">
                    <button
                      onClick={() => setAutoLaneEnabled(lane.id, !lane.enabled)}
                      title="Read (play this envelope)"
                      className={`px-1 rounded text-[8px] font-bold ${lane.enabled ? 'bg-sky-600 text-white' : OFF_BTN}`}
                    >R</button>
                    <button
                      onClick={() => setAutoLaneArmed(lane.id, !lane.armed)}
                      title="Arm for write-capture (needs automation mode = WRITE)"
                      className={`px-1 rounded text-[8px] font-bold ${lane.armed ? 'bg-red-600 text-white' : OFF_BTN} ${automationMode !== 'write' ? 'opacity-50' : ''}`}
                    >W</button>
                    <button
                      onClick={() => removeAutoLane(lane.id)}
                      title="Delete lane"
                      className={`ml-auto px-1 rounded text-[8px] font-bold ${OFF_BTN} hover:!bg-red-700`}
                    >✕</button>
                  </div>
                </div>
              ))}
              <div
                className="absolute left-0 right-0 h-1.5 cursor-ns-resize hover:bg-white/10"
                style={{ top: compH - 6 }}
                onMouseDown={(e) => {
                  const y0 = e.clientY;
                  const h0 = compH;
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

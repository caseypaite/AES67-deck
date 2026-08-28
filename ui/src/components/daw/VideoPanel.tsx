import { useEffect, useRef } from 'react';
import { useDawStore } from '../../stores/useDawStore';
import { useMixerStore } from '../../stores/useMixerStore';

// Reference-video monitor (plan Phase 5). A hidden-until-opened bottom strip
// with the <video> kept in sync with the transport: it plays while rolling,
// scrubs while stopped, corrected whenever it drifts. Files come from
// projects/<name>/video/ (served by the server's HTTP endpoint).
export function VideoPanel() {
  const video = useDawStore((s) => s.video);
  const projectVideos = useDawStore((s) => s.projectVideos);
  const setVideo = useDawStore((s) => s.setVideo);
  const setVideoOffset = useDawStore((s) => s.setVideoOffset);
  const setVideoOpen = useDawStore((s) => s.setVideoOpen);
  const url = useDawStore((s) => s.videoUrl());
  const fps = useDawStore((s) => s.fps);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    useMixerStore.getState().ws?.send(JSON.stringify({ type: 'list_project_videos' }));
  }, []);

  // Sync loop — decoupled from React.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      const s = useDawStore.getState();
      const rolling = useMixerStore.getState().transportState !== 'stopped';
      const target = s.playheadPosition - (s.video?.offsetSec ?? 0);
      if (target < 0 || (el.duration && target > el.duration)) {
        if (!el.paused) el.pause();
      } else if (rolling) {
        if (el.paused) el.play().catch(() => {});
        if (Math.abs(el.currentTime - target) > 0.18) el.currentTime = target;
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - target) > 0.03) el.currentTime = target;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [url]);

  return (
    <div className="shrink-0 h-[176px] bg-[#0b0d10] border-t border-[#242832] flex">
      <div className="flex-1 flex items-center justify-center bg-black">
        {url ? (
          <video ref={ref} src={url} className="max-h-full max-w-full" muted playsInline preload="auto" />
        ) : (
          <div className="text-[11px] text-gray-600 text-center px-4 leading-relaxed">
            No reference video. Copy an <span className="font-mono">.mp4</span> / <span className="font-mono">.webm</span> into
            <span className="font-mono"> projects/{useDawStore.getState().projectName}/video/</span> then pick it here.
          </div>
        )}
      </div>
      <div className="w-56 shrink-0 flex flex-col gap-2 p-2 text-gray-300 border-l border-[#242832]">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-black tracking-widest text-gray-500">REFERENCE VIDEO</span>
          <button onClick={() => setVideoOpen(false)} className="text-gray-500 hover:text-white text-xs px-1">✕</button>
        </div>
        <select
          value={video?.file ?? ''}
          onChange={(e) => setVideo(e.target.value || null)}
          className="w-full bg-[#1a1d23] border border-[#3a3f48] rounded px-1.5 py-1 text-[11px] text-gray-100 outline-none"
        >
          <option value="">— none —</option>
          {projectVideos.map((v) => (
            <option key={v.file} value={v.file}>{v.file} ({(v.sizeBytes / 1e6).toFixed(0)} MB)</option>
          ))}
        </select>
        {video && (
          <>
            <div className="flex items-center gap-1 text-[10px] font-bold text-gray-400">
              OFFSET
              <input
                type="number" step={0.01} value={video.offsetSec}
                onChange={(e) => setVideoOffset(Number(e.target.value) || 0)}
                className="w-16 bg-[#1a1d23] border border-[#3a3f48] rounded px-1 py-0.5 text-right text-gray-100 outline-none"
              />
              <span className="text-gray-600">s</span>
            </div>
            <div className="flex gap-1">
              {([['-1s', -1], ['-1f', -1 / fps], ['+1f', 1 / fps], ['+1s', 1]] as const).map(([lbl, d]) => (
                <button key={lbl} onClick={() => setVideoOffset(Math.round((video.offsetSec + d) * 1000) / 1000)}
                  className="flex-1 px-1 py-1 text-[10px] font-bold rounded bg-[#363c47] text-gray-200 hover:bg-[#434a57]">{lbl}</button>
              ))}
            </div>
            <button
              onClick={() => setVideoOffset(Math.round(useDawStore.getState().playheadPosition * 1000) / 1000)}
              title="Set the offset so the current video frame lands on the playhead"
              className="px-2 py-1 text-[10px] font-bold rounded bg-[#1a1c22] text-gray-200 hover:bg-blue-700"
            >ALIGN VIDEO START → PLAYHEAD</button>
          </>
        )}
        <p className="text-[9px] text-gray-600 leading-snug mt-auto">
          Positive offset = video starts later than project zero. Scrubs with the
          transport; plays while rolling.
        </p>
      </div>
    </div>
  );
}

import { useEffect } from 'react';
import { useDawStore } from '../stores/useDawStore';
import { ArrangeSurface } from '../daw/ArrangeSurface';
import { TrackPanel } from '../daw/TrackPanel';

const PANEL_W = 208;

export const DawView = () => {
  const zoom = useDawStore((s) => s.zoom);
  const setZoom = useDawStore((s) => s.setZoom);
  const snapToGrid = useDawStore((s) => s.snapToGrid);
  const setSnapToGrid = useDawStore((s) => s.setSnapToGrid);
  const fps = useDawStore((s) => s.fps);
  const setFps = useDawStore((s) => s.setFps);
  const lastOverrun = useDawStore((s) => s.lastOverrun);
  const playbackUnderrun = useDawStore((s) => s.playbackUnderrun);

  const deleteSelected = useDawStore((s) => s.deleteSelected);
  const copySelected = useDawStore((s) => s.copySelected);
  const pasteClipboard = useDawStore((s) => s.pasteClipboard);
  const sliceSelectedAtPlayhead = useDawStore((s) => s.sliceSelectedAtPlayhead);

  // The playhead clock and toolbar timecode are driven by the engine transport
  // (useDawStore.applyTransport / tickPlayhead) and painted by the ArrangeSurface
  // rAF loop — no React render loop here.

  // Keyboard shortcuts (the surface owns pointer input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Backspace' || e.key === 'Delete') deleteSelected();
      else if ((e.ctrlKey || e.metaKey) && e.key === 'c') copySelected();
      else if ((e.ctrlKey || e.metaKey) && e.key === 'v') pasteClipboard();
      else if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey) sliceSelectedAtPlayhead();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelected, copySelected, pasteClipboard, sliceSelectedAtPlayhead]);

  return (
    <div className="w-full h-full flex flex-col bg-[#16181d] select-none outline-none" tabIndex={0}>
      <div className="flex-1 flex overflow-hidden">
        <TrackPanel width={PANEL_W} />
        <ArrangeSurface />
      </div>

      {(lastOverrun || playbackUnderrun) && (
        <div className="absolute bottom-6 left-8 z-40 px-3 py-1.5 rounded bg-red-700 text-white text-xs font-bold shadow-xl border border-red-400">
          ⚠ {lastOverrun ? 'Last take dropped audio — disk could not keep up' : 'Playback dropout — disk could not keep up'}
        </div>
      )}

      <div className="absolute bottom-6 right-8 flex items-center bg-[#111] rounded-lg shadow-xl border border-[#333] p-1 z-40 gap-1">
        <button
          onClick={() => setSnapToGrid(!snapToGrid)}
          className={`px-3 py-1 text-xs font-bold rounded transition-colors ${snapToGrid ? 'bg-blue-600 text-white' : 'bg-[#222] text-gray-500 hover:text-gray-300'}`}
        >
          SNAP
        </button>
        <button
          onClick={() => setFps(fps === 30 ? 25 : 30)}
          className="px-2 py-1 text-xs font-bold rounded bg-[#222] text-gray-400 hover:text-white"
          title="Timecode frame rate"
        >
          {fps} fps
        </button>
        <div className="w-px h-6 bg-[#333] mx-1" />
        <button className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white hover:bg-[#222] rounded" onClick={() => setZoom(zoom / 1.3)}>−</button>
        <button className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white hover:bg-[#222] rounded" onClick={() => setZoom(zoom * 1.3)}>+</button>
      </div>
    </div>
  );
};

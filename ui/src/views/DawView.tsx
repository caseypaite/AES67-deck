import { useEffect, useState } from 'react';
import { useDawStore } from '../stores/useDawStore';
import { useMixerStore } from '../stores/useMixerStore';
import { ArrangeSurface } from '../daw/ArrangeSurface';
import { TrackPanel } from '../daw/TrackPanel';
import { CueListPanel } from '../components/daw/CueListPanel';
import { LoudnessHistory } from '../components/daw/LoudnessHistory';
import { BounceDialog } from '../components/daw/BounceDialog';

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
  const cuesOpen = useDawStore((s) => s.cuesOpen);
  const setCuesOpen = useDawStore((s) => s.setCuesOpen);
  const loudnessOpen = useDawStore((s) => s.loudnessOpen);
  const setLoudnessOpen = useDawStore((s) => s.setLoudnessOpen);
  const [bounceOpen, setBounceOpen] = useState(false);
  const bounceState = useDawStore((s) => s.bounceState);
  const vscMessage = useMixerStore((s) => s.vscStatus.message);
  const vscDiskLow = useMixerStore((s) => s.vscStatus.diskLow);

  const region = useDawStore((s) => s.region);
  const loopEnabled = useDawStore((s) => s.loopEnabled);
  const setLoopEnabled = useDawStore((s) => s.setLoopEnabled);
  const punchEnabled = useDawStore((s) => s.punchEnabled);
  const setPunchEnabled = useDawStore((s) => s.setPunchEnabled);
  const preRollSec = useDawStore((s) => s.preRollSec);
  const setPreRoll = useDawStore((s) => s.setPreRoll);
  const clearRegion = useDawStore((s) => s.clearRegion);
  const rippleEdit = useDawStore((s) => s.rippleEdit);
  const setRippleEdit = useDawStore((s) => s.setRippleEdit);
  const rippleDelete = useDawStore((s) => s.rippleDelete);
  const canUndo = useDawStore((s) => s.canUndo);
  const canRedo = useDawStore((s) => s.canRedo);
  const undo = useDawStore((s) => s.undo);
  const redo = useDawStore((s) => s.redo);

  const deleteSelected = useDawStore((s) => s.deleteSelected);
  const copySelected = useDawStore((s) => s.copySelected);
  const pasteClipboard = useDawStore((s) => s.pasteClipboard);
  const sliceSelectedAtPlayhead = useDawStore((s) => s.sliceSelectedAtPlayhead);

  // Set the region from the current clip selection, else a short span at the
  // playhead; toggled off when one already covers roughly that.
  const setRegionFromContext = () => {
    const d = useDawStore.getState();
    const sel = d.selectedClipIds.map((id) => d.clips[id]).filter(Boolean);
    if (sel.length) {
      d.setRegion(Math.min(...sel.map((c) => c.start)), Math.max(...sel.map((c) => c.start + c.length)));
    } else {
      const a = d.playheadPosition;
      d.setRegion(a, a + Math.max(2, d.gridSize * 8));
    }
  };

  // The playhead clock and toolbar timecode are driven by the engine transport
  // (useDawStore.applyTransport / tickPlayhead) and painted by the ArrangeSurface
  // rAF loop — no React render loop here.

  // Keyboard shortcuts (the surface owns pointer input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) useDawStore.getState().redo();
        else useDawStore.getState().undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); useDawStore.getState().redo(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') deleteSelected();
      else if (mod && e.key === 'c') copySelected();
      else if (mod && e.key === 'v') pasteClipboard();
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod) {
        const d = useDawStore.getState();
        if (!d.selectedClipIds.length) return;
        e.preventDefault();
        const fine = e.altKey ? 1 / d.fps : (d.snapToGrid ? d.gridSize : 0.1);
        const step = (e.shiftKey ? fine * 5 : fine) * (e.key === 'ArrowLeft' ? -1 : 1);
        d.nudgeSelected(step);
      }
      else if (e.key.toLowerCase() === 's' && !mod) sliceSelectedAtPlayhead();
      else if (e.key.toLowerCase() === 'l' && !mod) {
        const d = useDawStore.getState();
        if (d.region) d.setLoopEnabled(!d.loopEnabled);
      }
      else if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey) {
        const daw = useDawStore.getState();
        daw.addMarker(daw.playheadPosition);
        const mix = useMixerStore.getState();
        if (mix.transportState === 'recording' && mix.vscConfig.splitOnMarker) mix.vscSplit();
      } else if (e.key === ',' || e.key === '.') {
        const daw = useDawStore.getState();
        const times = Object.values(daw.markers).map((m) => m.time).sort((a, b) => a - b);
        const pos = daw.playheadPosition;
        const target = e.key === ','
          ? [...times].reverse().find((t) => t < pos - 1e-3)
          : times.find((t) => t > pos + 1e-3);
        if (target !== undefined) daw.locate(target);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelected, copySelected, pasteClipboard, sliceSelectedAtPlayhead]);

  return (
    <div className="w-full h-full flex flex-col bg-[#16181d] select-none outline-none" tabIndex={0}>
      <div className="flex-1 flex overflow-hidden">
        <TrackPanel width={PANEL_W} />
        <ArrangeSurface />
        {cuesOpen && <CueListPanel />}
      </div>

      {loudnessOpen && <LoudnessHistory />}
      {bounceOpen && <BounceDialog onClose={() => setBounceOpen(false)} />}

      {(lastOverrun || playbackUnderrun) && (
        <div className={`absolute ${loudnessOpen ? 'bottom-[152px]' : 'bottom-[54px]'} left-8 z-40 px-3 py-1.5 rounded bg-red-700 text-white text-xs font-bold shadow-xl border border-red-400`}>
          ⚠ {lastOverrun ? 'Last take dropped audio — disk could not keep up' : 'Playback dropout — disk could not keep up'}
        </div>
      )}

      {(vscMessage || vscDiskLow) && (
        <div className={`absolute ${loudnessOpen ? 'bottom-[192px]' : 'bottom-[94px]'} left-8 z-40 px-3 py-1.5 rounded text-white text-xs font-bold shadow-xl border ${vscDiskLow ? 'bg-red-700 border-red-400' : 'bg-blue-700 border-blue-400'}`}>
          {vscDiskLow ? '⚠ ' : ''}{vscMessage || 'Disk space low'}
        </div>
      )}

      {/* Phase 3e / 4 — region · loop · punch · pre-roll · undo/redo */}
      <div className={`absolute ${loudnessOpen ? 'bottom-[104px]' : 'bottom-6'} left-8 flex items-center bg-[#111] rounded-lg shadow-xl border border-[#333] p-1 z-40 gap-1`}>
        <button
          onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)"
          className="w-7 h-7 flex items-center justify-center text-sm rounded bg-[#222] text-gray-400 enabled:hover:text-white disabled:opacity-30"
        >⤺</button>
        <button
          onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)"
          className="w-7 h-7 flex items-center justify-center text-sm rounded bg-[#222] text-gray-400 enabled:hover:text-white disabled:opacity-30"
        >⤻</button>
        <div className="w-px h-6 bg-[#333] mx-1" />
        <button
          onClick={setRegionFromContext} title="Set loop/punch region from selection (or playhead)"
          className={`px-2.5 py-1 text-xs font-bold rounded transition-colors ${region ? 'bg-[#2a2f3a] text-gray-200' : 'bg-[#222] text-gray-500 hover:text-gray-300'}`}
        >REGION</button>
        {region && (
          <button onClick={clearRegion} title="Clear region" className="w-6 h-7 flex items-center justify-center text-xs rounded bg-[#222] text-gray-500 hover:text-red-400">✕</button>
        )}
        <button
          onClick={() => setLoopEnabled(!loopEnabled)} disabled={!region} title="Loop the region (L)"
          className={`px-2.5 py-1 text-xs font-bold rounded transition-colors disabled:opacity-30 ${loopEnabled ? 'bg-cyan-600 text-white' : 'bg-[#222] text-gray-500 enabled:hover:text-gray-300'}`}
        >LOOP</button>
        <button
          onClick={() => setPunchEnabled(!punchEnabled)} disabled={!region} title="Auto-punch armed tracks on the region"
          className={`px-2.5 py-1 text-xs font-bold rounded transition-colors disabled:opacity-30 ${punchEnabled ? 'bg-red-600 text-white' : 'bg-[#222] text-gray-500 enabled:hover:text-gray-300'}`}
        >PUNCH</button>
        <label className="flex items-center gap-1 text-[10px] font-bold text-gray-500 pl-1" title="Pre-roll seconds before the punch in-point">
          PRE
          <input
            type="number" min={0} max={30} step={1} value={preRollSec}
            onChange={(e) => setPreRoll(Number(e.target.value))}
            className="w-9 bg-[#0d0f13] border border-[#333] rounded px-1 py-0.5 text-right text-gray-300 outline-none"
          />
        </label>
        <div className="w-px h-6 bg-[#333] mx-1" />
        <button
          onClick={() => setRippleEdit(!rippleEdit)} title="Ripple edit — delete/paste close/open the gap after"
          className={`px-2.5 py-1 text-xs font-bold rounded transition-colors ${rippleEdit ? 'bg-amber-600 text-white' : 'bg-[#222] text-gray-500 hover:text-gray-300'}`}
        >RIPPLE</button>
        {region && (
          <button
            onClick={rippleDelete} title="Cut the region out of every track and close the gap"
            className="px-2 py-1 text-xs font-bold rounded bg-[#222] text-gray-400 hover:bg-red-700 hover:text-white transition-colors"
          >✂ CUT</button>
        )}
      </div>

      <div className={`absolute ${loudnessOpen ? 'bottom-[104px]' : 'bottom-6'} ${cuesOpen ? 'right-[280px]' : 'right-8'} flex items-center bg-[#111] rounded-lg shadow-xl border border-[#333] p-1 z-40 gap-1`}>
        <button
          onClick={() => setCuesOpen(!cuesOpen)}
          className={`px-3 py-1 text-xs font-bold rounded transition-colors ${cuesOpen ? 'bg-blue-600 text-white' : 'bg-[#222] text-gray-500 hover:text-gray-300'}`}
          title="Cue list"
        >
          CUES
        </button>
        <button
          onClick={() => setLoudnessOpen(!loudnessOpen)}
          className={`px-3 py-1 text-xs font-bold rounded transition-colors ${loudnessOpen ? 'bg-blue-600 text-white' : 'bg-[#222] text-gray-500 hover:text-gray-300'}`}
          title="Loudness log"
        >
          LUFS
        </button>
        <button
          onClick={() => setBounceOpen(true)}
          className={`px-3 py-1 text-xs font-bold rounded transition-colors ${bounceState === 'running' ? 'bg-blue-600 text-white animate-pulse' : 'bg-[#222] text-gray-500 hover:text-gray-300'}`}
          title="Bounce a region (or the whole project) through the master chain to a WAV"
        >
          BOUNCE
        </button>
        <div className="w-px h-6 bg-[#333] mx-1" />
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

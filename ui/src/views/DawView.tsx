import { useEffect, useState } from 'react';
import { useDawStore, beatSec } from '../stores/useDawStore';
import { useMixerStore } from '../stores/useMixerStore';
import { ArrangeSurface } from '../daw/ArrangeSurface';
import { TrackPanel } from '../daw/TrackPanel';
import { CueListPanel } from '../components/daw/CueListPanel';
import { LoudnessHistory } from '../components/daw/LoudnessHistory';
import { BounceDialog } from '../components/daw/BounceDialog';
import { TimecodePanel } from '../components/daw/TimecodePanel';
import { VideoPanel } from '../components/daw/VideoPanel';
import { PlaylistPanel } from '../components/daw/PlaylistPanel';

const PANEL_W = 208;

export const DawView = () => {
  const zoom = useDawStore((s) => s.zoom);
  const setZoom = useDawStore((s) => s.setZoom);
  const snapToGrid = useDawStore((s) => s.snapToGrid);
  const setSnapToGrid = useDawStore((s) => s.setSnapToGrid);
  const fps = useDawStore((s) => s.fps);
  const dropFrame = useDawStore((s) => s.dropFrame);
  const tempo = useDawStore((s) => s.tempo);
  const setTempo = useDawStore((s) => s.setTempo);
  const timeSig = useDawStore((s) => s.timeSig);
  const setTimeSig = useDawStore((s) => s.setTimeSig);
  const gridMode = useDawStore((s) => s.gridMode);
  const setGridMode = useDawStore((s) => s.setGridMode);
  const metronomeOn = useDawStore((s) => s.metronomeOn);
  const setMetronomeOn = useDawStore((s) => s.setMetronomeOn);
  const metroDest = useDawStore((s) => s.metroDest);
  const setMetroDest = useDawStore((s) => s.setMetroDest);
  const beatDiv = useDawStore((s) => s.beatDiv);
  const setBeatDiv = useDawStore((s) => s.setBeatDiv);
  const countInBars = useDawStore((s) => s.countInBars);
  const setCountInBars = useDawStore((s) => s.setCountInBars);
  const countInActive = useDawStore((s) => s.countInActive);
  const compCrossfadeSec = useDawStore((s) => s.compCrossfadeSec);
  const setCompCrossfadeSec = useDawStore((s) => s.setCompCrossfadeSec);
  const automationMode = useDawStore((s) => s.automationMode);
  const setAutomationMode = useDawStore((s) => s.setAutomationMode);
  const videoOpen = useDawStore((s) => s.videoOpen);
  const setVideoOpen = useDawStore((s) => s.setVideoOpen);
  const hasVideo = useDawStore((s) => !!s.video);
  const playlistOpen = useDawStore((s) => s.playlistOpen);
  const setPlaylistOpen = useDawStore((s) => s.setPlaylistOpen);
  const playlistRunning = useDawStore((s) => s.playlistStatus.running);
  const lastOverrun = useDawStore((s) => s.lastOverrun);
  const playbackUnderrun = useDawStore((s) => s.playbackUnderrun);
  const cuesOpen = useDawStore((s) => s.cuesOpen);
  const setCuesOpen = useDawStore((s) => s.setCuesOpen);
  const loudnessOpen = useDawStore((s) => s.loudnessOpen);
  const setLoudnessOpen = useDawStore((s) => s.setLoudnessOpen);
  const [bounceOpen, setBounceOpen] = useState(false);
  const [tcOpen, setTcOpen] = useState(false);
  const bounceState = useDawStore((s) => s.bounceState);
  const ltcChaseOn = useDawStore((s) => s.ltcChaseOn);
  const ltcChaseLocked = useDawStore((s) => s.ltcChaseLocked);
  const tcSource = useDawStore((s) => s.tcSource);
  const ltcGenOn = useDawStore((s) => s.ltcGenOn);
  const mtcGenOn = useDawStore((s) => s.mtcGenOn);
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
        const fine = e.altKey
          ? 1 / d.fps
          : d.gridMode === 'bars'
            ? beatSec(d.tempo) / Math.max(1, d.beatDiv)
            : (d.snapToGrid ? d.gridSize : 0.1);
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

  // Taskbar buttons: legible on the dark bar even in the off / disabled state.
  const OFF = 'bg-[#363c47] text-gray-200 hover:bg-[#434a57] hover:text-white';
  const tBtn = (active: boolean, activeCls = 'bg-blue-600 text-white') =>
    `px-2.5 py-1 text-xs font-bold rounded transition-colors ${active ? activeCls : OFF}`;

  return (
    <div className="relative w-full h-full flex flex-col bg-[#16181d] select-none outline-none" tabIndex={0}>
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <TrackPanel width={PANEL_W} />
        <ArrangeSurface />
        {cuesOpen && <CueListPanel />}
        {playlistOpen && <PlaylistPanel />}
      </div>

      {videoOpen && <VideoPanel />}
      {loudnessOpen && <LoudnessHistory />}
      {bounceOpen && <BounceDialog onClose={() => setBounceOpen(false)} />}
      {tcOpen && <TimecodePanel onClose={() => setTcOpen(false)} />}

      {(lastOverrun || playbackUnderrun) && (
        <div className="absolute bottom-[46px] left-8 z-40 px-3 py-1.5 rounded bg-red-700 text-white text-xs font-bold shadow-xl border border-red-400">
          ⚠ {lastOverrun ? 'Last take dropped audio — disk could not keep up' : 'Playback dropout — disk could not keep up'}
        </div>
      )}
      {(vscMessage || vscDiskLow) && (
        <div className={`absolute bottom-[46px] left-8 z-40 px-3 py-1.5 rounded text-white text-xs font-bold shadow-xl border ${(lastOverrun || playbackUnderrun) ? 'translate-y-[-32px] ' : ''}${vscDiskLow ? 'bg-red-700 border-red-400' : 'bg-blue-700 border-blue-400'}`}>
          {vscDiskLow ? '⚠ ' : ''}{vscMessage || 'Disk space low'}
        </div>
      )}
      {countInActive > 0 && (
        <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="px-8 py-4 rounded-xl bg-amber-600/90 text-white text-4xl font-black tracking-widest shadow-2xl animate-pulse">
            COUNT-IN
          </div>
        </div>
      )}

      {/* Bottom taskbar — track area scrolls between the app header and this bar */}
      <div className="shrink-0 h-10 flex items-center gap-1 px-2 bg-[#0c0e12] border-t border-[#3a3f48] overflow-x-auto">
        <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)"
          className={`w-7 h-7 shrink-0 flex items-center justify-center text-sm rounded transition-colors ${OFF} disabled:opacity-45`}>⤺</button>
        <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)"
          className={`w-7 h-7 shrink-0 flex items-center justify-center text-sm rounded transition-colors ${OFF} disabled:opacity-45`}>⤻</button>
        <div className="w-px h-6 bg-[#3a3f48] mx-1 shrink-0" />

        <button onClick={setRegionFromContext} title="Set loop/punch region from selection (or playhead)"
          className={`shrink-0 ${tBtn(!!region, 'bg-blue-600 text-white')}`}>REGION</button>
        {region && (
          <button onClick={clearRegion} title="Clear region"
            className={`w-6 h-7 shrink-0 flex items-center justify-center text-xs rounded ${OFF} hover:!text-red-400`}>✕</button>
        )}
        <button onClick={() => setLoopEnabled(!loopEnabled)} disabled={!region} title="Loop the region (L)"
          className={`shrink-0 disabled:opacity-45 ${tBtn(loopEnabled, 'bg-cyan-600 text-white')}`}>LOOP</button>
        <button onClick={() => setPunchEnabled(!punchEnabled)} disabled={!region} title="Auto-punch armed tracks on the region"
          className={`shrink-0 disabled:opacity-45 ${tBtn(punchEnabled, 'bg-red-600 text-white')}`}>PUNCH</button>
        <label className="flex items-center gap-1 text-[10px] font-bold text-gray-300 pl-1 shrink-0" title="Pre-roll seconds before the punch in-point">
          PRE
          <input type="number" min={0} max={30} step={1} value={preRollSec}
            onChange={(e) => setPreRoll(Number(e.target.value))}
            className="w-9 bg-[#1a1d23] border border-[#3a3f48] rounded px-1 py-0.5 text-right text-gray-100 outline-none" />
        </label>
        <div className="w-px h-6 bg-[#3a3f48] mx-1 shrink-0" />
        <button onClick={() => setRippleEdit(!rippleEdit)} title="Ripple edit — delete/paste close/open the gap after"
          className={`shrink-0 ${tBtn(rippleEdit, 'bg-amber-600 text-white')}`}>RIPPLE</button>
        {region && (
          <button onClick={rippleDelete} title="Cut the region out of every track and close the gap"
            className={`px-2 py-1 shrink-0 text-xs font-bold rounded transition-colors ${OFF} hover:!bg-red-700 hover:!text-white`}>✂ CUT</button>
        )}

        <div className="flex-1 min-w-[8px]" />

        <button onClick={() => setCuesOpen(!cuesOpen)} title="Cue list"
          className={`shrink-0 ${tBtn(cuesOpen)}`}>CUES</button>
        <button onClick={() => setLoudnessOpen(!loudnessOpen)} title="Loudness log"
          className={`shrink-0 ${tBtn(loudnessOpen)}`}>LUFS</button>
        <button onClick={() => setVideoOpen(!videoOpen)} title="Reference video monitor"
          className={`shrink-0 ${tBtn(videoOpen, hasVideo ? 'bg-purple-600 text-white' : 'bg-blue-600 text-white')}`}>VIDEO</button>
        <button onClick={() => setPlaylistOpen(!playlistOpen)} title="Playout playlist — queue projects back-to-back"
          className={`shrink-0 ${tBtn(playlistOpen || playlistRunning, playlistRunning ? 'bg-emerald-600 text-white animate-pulse' : 'bg-blue-600 text-white')}`}>PLAYLIST</button>
        <button onClick={() => setBounceOpen(true)} title="Bounce a region (or the whole project) through the master chain to a WAV"
          className={`shrink-0 ${tBtn(bounceState === 'running')} ${bounceState === 'running' ? 'animate-pulse' : ''}`}>BOUNCE</button>
        <button
          onClick={() => setAutomationMode(automationMode === 'off' ? 'read' : automationMode === 'read' ? 'write' : 'off')}
          title="Automation: OFF · READ (play envelopes) · WRITE (capture armed-lane moves)"
          className={`shrink-0 ${tBtn(automationMode !== 'off', automationMode === 'write' ? 'bg-red-600 text-white' : 'bg-sky-600 text-white')}`}
        >AUTO {automationMode === 'off' ? '' : automationMode === 'read' ? 'R' : 'W'}</button>
        <div className="w-px h-6 bg-[#3a3f48] mx-1 shrink-0" />
        <button onClick={() => setSnapToGrid(!snapToGrid)} title="Snap to grid" className={`shrink-0 ${tBtn(snapToGrid)}`}>SNAP</button>
        <label className="flex items-center gap-1 text-[10px] font-bold text-gray-300 pl-1 shrink-0" title="Comp seam crossfade length (ms)">
          XF
          <input type="number" min={0} max={100} step={1} value={Math.round(compCrossfadeSec * 1000)}
            onChange={(e) => setCompCrossfadeSec((Number(e.target.value) || 0) / 1000)}
            className="w-10 bg-[#1a1d23] border border-[#3a3f48] rounded px-1 py-0.5 text-right text-gray-100 outline-none" />
        </label>
        <button
          onClick={() => setGridMode(gridMode === 'bars' ? 'time' : 'bars')}
          title="Ruler / grid: bars+beats or timecode"
          className={`shrink-0 ${tBtn(gridMode === 'bars')}`}
        >{gridMode === 'bars' ? 'BARS' : 'TIME'}</button>
        {gridMode === 'bars' ? (
          <>
            <label className="flex items-center gap-1 text-[10px] font-bold text-gray-300 pl-1 shrink-0" title="Tempo (BPM)">
              ♩
              <input type="number" min={20} max={300} step={1} value={tempo}
                onChange={(e) => setTempo(Number(e.target.value))}
                className="w-11 bg-[#1a1d23] border border-[#3a3f48] rounded px-1 py-0.5 text-right text-gray-100 outline-none" />
            </label>
            <button
              onClick={() => setTimeSig(timeSig.num === 4 ? 3 : timeSig.num === 3 ? 6 : 4, timeSig.den)}
              title="Time signature (beats per bar)"
              className={`px-1.5 py-1 shrink-0 text-xs font-bold rounded font-mono transition-colors ${OFF}`}
            >{timeSig.num}/{timeSig.den}</button>
            <button
              onClick={() => setBeatDiv(beatDiv === 1 ? 2 : beatDiv === 2 ? 4 : 1)}
              title="Musical snap subdivision"
              className={`px-1.5 py-1 shrink-0 text-[10px] font-bold rounded font-mono transition-colors ${OFF}`}
            >1/{beatDiv * timeSig.den}</button>
            <button
              onClick={() => setMetronomeOn(!metronomeOn)}
              title="Metronome click while the transport rolls"
              className={`shrink-0 ${tBtn(metronomeOn, 'bg-emerald-600 text-white')}`}
            >METRO</button>
            <button
              onClick={() => setMetroDest(metroDest === 'monitor' ? 'master' : metroDest === 'master' ? 'both' : 'monitor')}
              title="Metronome routing: monitor bus, master, or both"
              className={`px-1.5 py-1 shrink-0 text-[10px] font-bold rounded font-mono transition-colors ${OFF}`}
            >{metroDest === 'monitor' ? 'MON' : metroDest === 'master' ? 'MST' : 'M+M'}</button>
            <button
              onClick={() => setCountInBars(countInBars >= 2 ? 0 : countInBars + 1)}
              title="Count-in bars before the transport rolls / recording opens"
              className={`px-1.5 py-1 shrink-0 text-[10px] font-bold rounded font-mono transition-colors ${countInBars > 0 ? 'bg-amber-600 text-white' : OFF}`}
            >CI {countInBars}</button>
          </>
        ) : null}
        <button
          onClick={() => setTcOpen((v) => !v)}
          title="Timecode & sync — LTC / MTC generator, LTC chase, PTP time-of-day"
          className={`shrink-0 ${tBtn(tcOpen || ltcGenOn || mtcGenOn || ltcChaseOn)}`}
        >
          TC {fps}{dropFrame ? 'DF' : ''}
        </button>
        {(ltcGenOn || mtcGenOn) && (
          <span className="shrink-0 text-[9px] font-bold text-blue-400 px-0.5" title="Timecode generator running">
            {tcSource === 'tod' ? 'ToD' : 'GEN'}
          </span>
        )}
        {ltcChaseOn && (
          <span className={`shrink-0 text-[9px] font-black px-1 rounded ${ltcChaseLocked ? 'bg-emerald-600 text-white' : 'bg-[#363c47] text-gray-400 animate-pulse'}`}
            title={ltcChaseLocked ? 'Chasing external LTC — engine drives the transport' : 'LTC chase armed, waiting for signal'}>
            CHASE
          </span>
        )}
        <div className="w-px h-6 bg-[#3a3f48] mx-1 shrink-0" />
        <button className={`w-7 h-7 shrink-0 flex items-center justify-center rounded transition-colors ${OFF}`} onClick={() => setZoom(zoom / 1.3)}>−</button>
        <button className={`w-7 h-7 shrink-0 flex items-center justify-center rounded transition-colors ${OFF}`} onClick={() => setZoom(zoom * 1.3)}>+</button>
      </div>
    </div>
  );
};

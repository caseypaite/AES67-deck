import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { uuid } from '../lib/uuid';
import { wsSend } from '../lib/wsBus';

export interface DawClip {
  id: string;
  trackId: number;
  start: number;  // seconds — position on the timeline
  length: number; // seconds
  color: string;
  name: string;
  // Source info — present on recorded / imported clips. Phase 2 playback
  // reads these.
  takeDir?: string;
  file?: string;
  originFrame?: number;
  endFrame?: number;
  sampleRate?: number;
  sourceOffset?: number; // seconds into the source file the clip starts (left-trim)
  gain?: number;         // linear playback gain, default 1
  fadeIn?: number;       // seconds — fade-in ramp at the clip head
  fadeOut?: number;      // seconds — fade-out ramp at the clip tail
}

export interface DawMarker {
  id: string;
  time: number; // seconds
  name: string;
  color?: string;
}

export interface PeaksData {
  version: number;
  sampleRate: number;
  frames: number;
  tiers: Record<string, number[]>;      // tier(spf) -> [min,max,min,max,...] mono
  rmsTiers?: Record<string, number[]>;  // tier(spf) -> [rms,...] mono (v2+); absent on legacy files
}

export function clipPeakKey(clip: Pick<DawClip, 'takeDir' | 'file'>): string | null {
  return clip.takeDir && clip.file ? `${clip.takeDir}/${clip.file}` : null;
}

interface DawState {
  projectName: string;
  projectList: string[];

  // REAPER-compatible multitrack recording projects in the records directory.
  recordingProjects: string[];
  activeRecordingProject: string | null;
  recordingProjectError: string | null;

  clips: Record<string, DawClip>;
  markers: Record<string, DawMarker>;
  trackHeights: Record<number, number>;

  playheadPosition: number;       // seconds — interpolated from the engine clock
  recordStartTime: number | null; // legacy field, unused by the engine-driven flow
  zoom: number;                   // pixels per second
  scrollX: number;                // arrange-surface horizontal scroll (px)
  scrollY: number;                // arrange-surface vertical scroll (px)

  // Engine transport follow (the engine owns the clock; see useMixerStore's
  // `metering` handler which calls applyTransport on every frame).
  engineState: 0 | 1 | 2;         // 0 stopped, 1 playing, 2 recording
  engineFrame: number;
  sampleRate: number;
  recordOriginSec: number | null; // where the current take started (seconds)
  _engineSec: number;             // engine position (s) at the last transport msg
  _engineWall: number;            // performance.now() at the last transport msg

  selectedClipIds: string[];
  clipboard: DawClip[];

  // Transient interaction state (not persisted, not serialised to the project).
  dragOverTrackId: number | null;         // lane highlighted as a vertical-move target
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;

  snapToGrid: boolean;
  gridSize: number;               // seconds

  fps: number;                    // timecode frame rate (25 | 30)
  timecode: string;               // hh:mm:ss:ff derived from the playhead — toolbar readout

  lastOverrun: boolean;           // last committed take reported a disk overrun
  playbackUnderrun: boolean;      // the timeline reader couldn't keep playback fed

  peaks: Record<string, PeaksData>; // clipPeakKey -> waveform peaks (not persisted)

  setZoom: (zoom: number) => void;
  setScroll: (x: number, y: number) => void;
  setPlayheadPosition: (pos: number) => void;
  locate: (sec: number) => void;
  tickPlayhead: () => void;
  setRecordStartTime: (time: number | null) => void;
  setSnapToGrid: (snap: boolean) => void;
  setGridSize: (size: number) => void;
  setFps: (fps: number) => void;

  applyTransport: (frame: number, state: number, sr: number) => void;
  flagPlaybackUnderrun: () => void;

  setPeaks: (key: string, data: PeaksData) => void;
  ensureClipPeaks: (clip: DawClip) => void;

  addClip: (clip: DawClip) => void;
  updateClip: (id: string, updates: Partial<DawClip>) => void;
  removeClip: (id: string) => void;

  addMarker: (time: number, name?: string) => void;
  updateMarker: (id: string, updates: Partial<DawMarker>) => void;
  removeMarker: (id: string) => void;

  setSelectedClips: (ids: string[]) => void;
  toggleClipSelection: (id: string) => void;
  clearSelection: () => void;
  deleteSelected: () => void;
  sliceSelectedAtPlayhead: () => void;
  splitClipAt: (clipId: string, time: number) => void;
  renameClip: (id: string, name: string) => void;
  setClipFade: (id: string, edge: 'in' | 'out', seconds: number) => void;
  setClipGain: (id: string, gain: number) => void;
  setDragOverTrack: (trackId: number | null) => void;
  setMarquee: (m: { x0: number; y0: number; x1: number; y1: number } | null) => void;
  copySelected: () => void;
  pasteClipboard: () => void;

  setTrackHeight: (trackId: number, height: number) => void;

  // Server sync
  loadProjectData: (name: string, project: unknown) => void;
  setProjectList: (list: string[], active?: string) => void;
  addCommittedClips: (clips: DawClip[], overrun: boolean) => void;
  newProject: (name: string) => void;
  openProject: (name: string) => void;

  // Recording projects (REAPER .rpp bundles)
  setRecordingProjects: (list: string[], active?: string | null) => void;
  setRecordingProjectError: (msg: string | null) => void;
  saveRecordingProject: (name: string) => void;
  openRecordingProject: (name: string) => void;
  refreshRecordingProjects: () => void;
}

// --- project persistence (debounced push to the server) ---
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let applyingRemote = false;
const requestedPeaks = new Set<string>(); // clipPeakKeys with a get_clip_peaks in flight

export function formatTimecode(sec: number, fps: number): string {
  const s = Math.max(0, sec);
  const hh = Math.floor(s / 3600).toString().padStart(2, '0');
  const mm = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
  const ss = Math.floor(s % 60).toString().padStart(2, '0');
  const ff = Math.floor((s % 1) * fps).toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}:${ff}`;
}

function serializeProject(s: DawState) {
  return {
    clips: Object.values(s.clips),
    markers: Object.values(s.markers),
    trackHeights: s.trackHeights,
  };
}

function scheduleSave() {
  if (applyingRemote) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = useDawStore.getState();
    wsSend({ type: 'save_project', name: s.projectName, project: serializeProject(s) });
  }, 500);
}

function toRecord<T extends { id: string }>(arr: unknown): Record<string, T> {
  const out: Record<string, T> = {};
  if (Array.isArray(arr)) {
    for (const item of arr) {
      if (item && typeof item === 'object' && typeof (item as T).id === 'string') {
        out[(item as T).id] = item as T;
      }
    }
  }
  return out;
}

export const useDawStore = create<DawState>()(
  persist(
    (set, get) => ({
      projectName: 'default',
      projectList: [],
      recordingProjects: [],
      activeRecordingProject: null,
      recordingProjectError: null,

      clips: {},
      markers: {},
      trackHeights: {},

      playheadPosition: 0,
      recordStartTime: null,
      zoom: 10,
      scrollX: 0,
      scrollY: 0,

      engineState: 0,
      engineFrame: 0,
      sampleRate: 48000,
      recordOriginSec: null,
      _engineSec: 0,
      _engineWall: 0,

      selectedClipIds: [],
      clipboard: [],

      dragOverTrackId: null,
      marquee: null,

      snapToGrid: true,
      gridSize: 1.0,
      fps: 30,
      timecode: '00:00:00:00',

      lastOverrun: false,
      playbackUnderrun: false,
      peaks: {},

      setZoom: (zoom) => set({ zoom: Math.max(2, Math.min(400, zoom)) }),
      setScroll: (x, y) => set({ scrollX: Math.max(0, x), scrollY: Math.max(0, y) }),
      flagPlaybackUnderrun: () => { if (!get().playbackUnderrun) set({ playbackUnderrun: true }); },

      setPeaks: (key, data) => set((s) => ({ peaks: { ...s.peaks, [key]: data } })),
      ensureClipPeaks: (clip) => {
        const key = clipPeakKey(clip);
        if (!key || get().peaks[key] || requestedPeaks.has(key)) return;
        requestedPeaks.add(key);
        wsSend({ type: 'get_clip_peaks', clipId: clip.id, takeDir: clip.takeDir, file: clip.file });
      },

      setPlayheadPosition: (pos) => set({ playheadPosition: Math.max(0, pos) }),

      locate: (sec) => {
        const s = Math.max(0, sec);
        set({
          playheadPosition: s, _engineSec: s, _engineWall: performance.now(),
          playbackUnderrun: false, timecode: formatTimecode(s, get().fps),
        });
        wsSend({ type: 'transport_locate', frame: Math.round(s * get().sampleRate) });
      },

      tickPlayhead: () => {
        const s = get();
        if (s.engineState === 0) return;
        const next = s._engineSec + (performance.now() - s._engineWall) / 1000;
        if (Math.abs(next - s.playheadPosition) > 0.0005) {
          set({ playheadPosition: next, timecode: formatTimecode(next, s.fps) });
        }
      },

      setRecordStartTime: (time) => set({ recordStartTime: time }),
      setSnapToGrid: (snap) => set({ snapToGrid: snap }),
      setGridSize: (size) => set({ gridSize: size }),
      setFps: (fps) => set({ fps, timecode: formatTimecode(get().playheadPosition, fps) }),

      applyTransport: (frame, state, sr) => {
        const s = get();
        const sampleRate = sr > 0 ? sr : s.sampleRate;
        const sec = frame / sampleRate;
        const st = (state === 2 ? 2 : state === 1 ? 1 : 0) as 0 | 1 | 2;
        let recordOriginSec = s.recordOriginSec;
        if (st === 2 && s.engineState !== 2) recordOriginSec = sec; // take just started
        else if (st === 0) recordOriginSec = null;                  // parked
        set({
          engineFrame: frame,
          engineState: st,
          sampleRate,
          recordOriginSec,
          _engineSec: sec,
          _engineWall: performance.now(),
          // When stopped, snap exactly; while rolling, tickPlayhead interpolates.
          ...(st === 0 ? { playheadPosition: sec, timecode: formatTimecode(sec, s.fps) } : {}),
        });
      },

      addClip: (clip) => {
        set((state) => ({ clips: { ...state.clips, [clip.id]: clip } }));
        scheduleSave();
      },
      updateClip: (id, updates) => {
        set((state) => {
          const clip = state.clips[id];
          if (!clip) return state;
          return { clips: { ...state.clips, [id]: { ...clip, ...updates } } };
        });
        scheduleSave();
      },
      removeClip: (id) => {
        set((state) => {
          const nextClips = { ...state.clips };
          delete nextClips[id];
          return { clips: nextClips };
        });
        scheduleSave();
      },

      addMarker: (time, name) => {
        const m: DawMarker = { id: uuid(), time: Math.max(0, time), name: name || 'Marker' };
        set((state) => ({ markers: { ...state.markers, [m.id]: m } }));
        scheduleSave();
      },
      updateMarker: (id, updates) => {
        set((state) => {
          const m = state.markers[id];
          if (!m) return state;
          return { markers: { ...state.markers, [id]: { ...m, ...updates } } };
        });
        scheduleSave();
      },
      removeMarker: (id) => {
        set((state) => {
          const next = { ...state.markers };
          delete next[id];
          return { markers: next };
        });
        scheduleSave();
      },

      setSelectedClips: (ids) => set({ selectedClipIds: ids }),
      toggleClipSelection: (id) =>
        set((state) => ({
          selectedClipIds: state.selectedClipIds.includes(id)
            ? state.selectedClipIds.filter((i) => i !== id)
            : [...state.selectedClipIds, id],
        })),
      clearSelection: () => set({ selectedClipIds: [] }),

      deleteSelected: () => {
        set((state) => {
          const nextClips = { ...state.clips };
          state.selectedClipIds.forEach((id) => delete nextClips[id]);
          return { clips: nextClips, selectedClipIds: [] };
        });
        scheduleSave();
      },

      sliceSelectedAtPlayhead: () => {
        set((state) => {
          const nextClips = { ...state.clips };
          const newSelection = [...state.selectedClipIds];
          const pos = state.playheadPosition;
          let slicedAny = false;

          state.selectedClipIds.forEach((id) => {
            const clip = nextClips[id];
            if (clip && pos > clip.start && pos < clip.start + clip.length) {
              slicedAny = true;
              const length1 = pos - clip.start;
              const length2 = clip.start + clip.length - pos;
              nextClips[id] = { ...clip, length: length1 };
              const newId = uuid();
              nextClips[newId] = {
                ...clip,
                id: newId,
                start: pos,
                length: length2,
                sourceOffset: (clip.sourceOffset || 0) + length1,
              };
              newSelection.push(newId);
            }
          });

          if (!slicedAny) return state;
          return { clips: nextClips, selectedClipIds: newSelection };
        });
        scheduleSave();
      },

      splitClipAt: (clipId, time) => {
        set((state) => {
          const clip = state.clips[clipId];
          if (!clip || time <= clip.start + 0.01 || time >= clip.start + clip.length - 0.01) return state;
          const len1 = time - clip.start;
          const len2 = clip.start + clip.length - time;
          const newId = uuid();
          // A fade that spanned the cut goes to the piece that keeps that edge.
          const nextClips = {
            ...state.clips,
            [clipId]: { ...clip, length: len1, fadeOut: Math.min(clip.fadeOut || 0, len1) },
            [newId]: {
              ...clip, id: newId, start: time, length: len2,
              sourceOffset: (clip.sourceOffset || 0) + len1,
              fadeIn: Math.min(clip.fadeIn || 0, len2),
            },
          };
          return { clips: nextClips, selectedClipIds: [newId] };
        });
        scheduleSave();
      },

      renameClip: (id, name) => {
        set((state) => {
          const c = state.clips[id];
          if (!c) return state;
          return { clips: { ...state.clips, [id]: { ...c, name } } };
        });
        scheduleSave();
      },

      setClipFade: (id, edge, seconds) => {
        set((state) => {
          const c = state.clips[id];
          if (!c) return state;
          const v = Math.max(0, Math.min(c.length, seconds));
          return { clips: { ...state.clips, [id]: { ...c, [edge === 'in' ? 'fadeIn' : 'fadeOut']: v } } };
        });
        scheduleSave();
      },

      setClipGain: (id, gain) => {
        set((state) => {
          const c = state.clips[id];
          if (!c) return state;
          return { clips: { ...state.clips, [id]: { ...c, gain: Math.max(0.001, Math.min(4, gain)) } } };
        });
        scheduleSave();
      },

      setDragOverTrack: (trackId) => set((s) => (s.dragOverTrackId === trackId ? s : { dragOverTrackId: trackId })),
      setMarquee: (m) => set({ marquee: m }),

      copySelected: () =>
        set((state) => ({
          clipboard: state.selectedClipIds.map((id) => state.clips[id]).filter(Boolean) as DawClip[],
        })),

      pasteClipboard: () => {
        set((state) => {
          if (state.clipboard.length === 0) return state;
          const earliestStart = Math.min(...state.clipboard.map((c) => c.start));
          const offset = state.playheadPosition - earliestStart;
          const nextClips = { ...state.clips };
          const newSelection: string[] = [];
          state.clipboard.forEach((clip) => {
            const newId = uuid();
            nextClips[newId] = { ...clip, id: newId, start: Math.max(0, clip.start + offset) };
            newSelection.push(newId);
          });
          return { clips: nextClips, selectedClipIds: newSelection };
        });
        scheduleSave();
      },

      setTrackHeight: (trackId, height) => {
        set((state) => ({
          trackHeights: { ...state.trackHeights, [trackId]: Math.max(48, height) },
        }));
        scheduleSave();
      },

      loadProjectData: (name, project) => {
        const p = (project || {}) as { clips?: unknown; markers?: unknown; trackHeights?: unknown };
        applyingRemote = true;
        set({
          projectName: name || 'default',
          clips: toRecord<DawClip>(p.clips),
          markers: toRecord<DawMarker>(p.markers),
          trackHeights:
            p.trackHeights && typeof p.trackHeights === 'object'
              ? (p.trackHeights as Record<number, number>)
              : {},
          selectedClipIds: [],
        });
        applyingRemote = false;
      },

      setProjectList: (list, active) =>
        set({
          projectList: Array.isArray(list) ? list : [],
          ...(active ? { projectName: active } : {}),
        }),

      addCommittedClips: (clips, overrun) => {
        set((state) => {
          const next = { ...state.clips };
          for (const c of clips) if (c && c.id) next[c.id] = c;
          return { clips: next, lastOverrun: overrun };
        });
        scheduleSave();
      },

      newProject: (name) => wsSend({ type: 'new_project', name }),
      openProject: (name) => wsSend({ type: 'load_project', name }),

      setRecordingProjects: (list, active) =>
        set({
          recordingProjects: Array.isArray(list) ? list : [],
          ...(active !== undefined ? { activeRecordingProject: active } : {}),
        }),
      setRecordingProjectError: (msg) => set({ recordingProjectError: msg }),
      saveRecordingProject: (name) => {
        set({ recordingProjectError: null });
        wsSend({ type: 'save_recording_project', name, project: serializeProject(get()) });
      },
      openRecordingProject: (name) => wsSend({ type: 'open_recording_project', name }),
      refreshRecordingProjects: () => wsSend({ type: 'list_recording_projects' }),
    }),
    {
      name: 'aes67-daw-project',
      partialize: (s) => ({
        projectName: s.projectName,
        clips: s.clips,
        markers: s.markers,
        trackHeights: s.trackHeights,
        zoom: s.zoom,
        snapToGrid: s.snapToGrid,
        gridSize: s.gridSize,
        fps: s.fps,
      }),
    }
  )
);

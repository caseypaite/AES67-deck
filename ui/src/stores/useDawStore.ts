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
  recording?: boolean;   // transient placeholder growing during a live take
  // Phase 4 take comping. 0 / undefined = the comp lane (this is what plays and
  // persists to the engine); >= 1 = alternate take lanes stacked below, parked.
  lane?: number;
  locked?: boolean;      // Phase 4 — no move / trim / delete
  group?: string;        // Phase 4 — clips sharing a group id select + move together
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
  laneExpand: Record<number, boolean>;   // trackId -> take lanes shown (view state)

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

  // Wall-clock anchor for the current take, for the as-run CSV's WallClock
  // column: a marker at timeline second t occurred at
  // _takeStartedAtMs + (t - _takeOriginSec) * 1000. Null when not recording.
  _takeStartedAtMs: number | null;
  _takeOriginSec: number;

  // TIMELINE side-panel visibility (persisted so layout is sticky).
  cuesOpen: boolean;
  loudnessOpen: boolean;

  // Phase 3e — one shared loop / punch region (a time selection). Persisted
  // in the project (server DawProject.loop) and localStorage.
  region: { inSec: number; outSec: number } | null;
  loopEnabled: boolean;
  punchEnabled: boolean;
  preRollSec: number;

  // Phase 4 — realtime master bounce (server-timed; not persisted).
  bounceState: 'idle' | 'running' | 'done' | 'failed';
  lastBounce: { name: string; bytes: number; durationSec: number; overrun: boolean } | null;
  bounceError: string | null;
  bounces: Array<{ name: string; bytes: number; mtime: number }>;

  selectedClipIds: string[];
  clipboard: DawClip[];

  // Transient interaction state (not persisted, not serialised to the project).
  dragOverTrackId: number | null;         // track highlighted as a vertical-move target
  dragOverLane: number | null;            // lane within that track (take-comping vertical move)
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  compPreview: { trackId: number; lane: number; fromSec: number; toSec: number } | null;

  // Live recording: placeholder clips that grow with the transport, plus the
  // coarse min/max envelope streamed on the metering frame. Cleared on commit.
  recordingClips: Record<number, string>;          // trackId -> placeholder clip id
  livePeaks: Record<string, number[]>;             // clip id -> flat [min,max,min,max,...]

  snapToGrid: boolean;
  gridSize: number;               // seconds
  rippleEdit: boolean;            // Phase 4 — delete/paste close/open the gap after

  // Phase 5 — bars/beats. A single project tempo + time signature (a full
  // tempo map can come later). gridMode switches the ruler + snap between
  // seconds and musical time; beatDiv is the musical snap subdivision.
  tempo: number;                  // BPM
  timeSig: { num: number; den: number };
  gridMode: 'time' | 'bars';
  beatDiv: number;                // 1 = beat, 2 = 1/8, 4 = 1/16 (in 4/4 terms)
  metronomeOn: boolean;           // engine click while rolling (session state)
  metroDest: 'monitor' | 'master' | 'both';

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

  // Phase 5 — bars/beats + metronome.
  setTempo: (bpm: number) => void;
  setTimeSig: (num: number, den: number) => void;
  setGridMode: (mode: 'time' | 'bars') => void;
  setBeatDiv: (div: number) => void;
  setMetronomeOn: (on: boolean) => void;
  setMetroDest: (dest: 'monitor' | 'master' | 'both') => void;
  snapTime: (sec: number) => number;   // musical or time snap, per gridMode/snapToGrid

  applyTransport: (frame: number, state: number, sr: number) => void;
  flagPlaybackUnderrun: () => void;

  setCuesOpen: (v: boolean) => void;
  setLoudnessOpen: (v: boolean) => void;

  // Phase 3e — region + transport modes (each syncs the engine loop/punch).
  setRegion: (inSec: number, outSec: number) => void;
  clearRegion: () => void;
  setLoopEnabled: (v: boolean) => void;
  setPunchEnabled: (v: boolean) => void;
  setPreRoll: (sec: number) => void;
  reassertRegionToEngine: (engineLoopOn: boolean, enginePunchOn: boolean) => void;

  // Phase 4 — undo / redo over clip + marker + track-layout edits.
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  historyBegin: () => void;   // open a coalescing txn (a pointer gesture)
  historyEnd: () => void;

  // Phase 4 — bounce.
  startBounce: (opts: { inSec: number; outSec: number; name: string; bits: number }) => void;
  cancelBounce: () => void;
  applyBounceStatus: (msg: { state: string; error?: string }) => void;
  applyBounceDone: (msg: { name: string; bytes: number; durationSec: number; overrun: boolean }) => void;
  setBounces: (list: Array<{ name: string; bytes: number; mtime: number }>) => void;
  projectEndSec: () => number;

  beginRecordingClips: (armed: number[], originSec: number, sr: number) => void;
  pushRecPeaks: (byTrack: Record<string, number[]>) => void;
  endRecordingClips: () => void;

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
  setDragOverTrack: (trackId: number | null, lane?: number | null) => void;
  setMarquee: (m: { x0: number; y0: number; x1: number; y1: number } | null) => void;
  setCompPreview: (p: { trackId: number; lane: number; fromSec: number; toSec: number } | null) => void;
  copySelected: () => void;
  pasteClipboard: () => void;

  setTrackHeight: (trackId: number, height: number) => void;

  // Phase 4 — take comping.
  laneCountFor: (trackId: number) => number;       // highest take-lane index in use (0 = none)
  toggleLaneExpand: (trackId: number) => void;
  moveClipToLane: (clipId: string, lane: number) => void;
  compPick: (trackId: number, fromSec: number, toSec: number, lane: number) => void;

  // Phase 4 — nudge / ripple / group / lock.
  setRippleEdit: (v: boolean) => void;
  nudgeSelected: (dtSec: number) => void;
  rippleDelete: () => void;
  toggleLockSelected: () => void;
  groupSelected: () => void;
  ungroupSelected: () => void;

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
// clipPeakKey -> last get_clip_peaks request time. Cleared when the peaks land;
// a stale entry (lost response, socket race) is retried after RETRY_MS.
const requestedPeaks = new Map<string, number>();
const PEAK_RETRY_MS = 4000;

// --- Phase 5: bars / beats helpers ---
export function beatSec(tempo: number): number { return 60 / Math.max(1, tempo); }
export function musicalGrid(tempo: number, sigNum: number): { beat: number; bar: number } {
  const beat = beatSec(tempo);
  return { beat, bar: beat * Math.max(1, sigNum) };
}
// 1-indexed bar / beat + 0..959 tick for a ruler label (REAPER-style).
export function secToBBT(sec: number, tempo: number, sigNum: number): { bar: number; beat: number; tick: number } {
  const beat = beatSec(tempo);
  const totalBeats = Math.max(0, sec) / beat;
  const n = Math.max(1, sigNum);
  return {
    bar: Math.floor(totalBeats / n) + 1,
    beat: Math.floor(totalBeats % n) + 1,
    tick: Math.round((totalBeats % 1) * 960),
  };
}
export function formatBBT(sec: number, tempo: number, sigNum: number): string {
  const { bar, beat, tick } = secToBBT(sec, tempo, sigNum);
  return `${bar}.${beat}.${String(tick).padStart(3, '0')}`;
}

function pushMetronome(s: { metronomeOn: boolean; tempo: number; timeSig: { num: number; den: number }; metroDest: string }) {
  wsSend({ type: 'set_metronome', enabled: s.metronomeOn, bpm: s.tempo, sigNum: s.timeSig.num, sigDen: s.timeSig.den, dest: s.metroDest });
}

// The transport readout string — timecode or bars/beats, per gridMode.
function fmtPlayhead(s: { gridMode: 'time' | 'bars'; tempo: number; timeSig: { num: number }; fps: number }, sec: number): string {
  return s.gridMode === 'bars' ? formatBBT(sec, s.tempo, s.timeSig.num) : formatTimecode(sec, s.fps);
}

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
    clips: Object.values(s.clips).filter((c) => !c.recording),
    markers: Object.values(s.markers),
    trackHeights: s.trackHeights,
    // Rides the server's DawProject.loop slot (pass-through); extra keys survive.
    loop: s.region
      ? { start: s.region.inSec, end: s.region.outSec, loop: s.loopEnabled, punch: s.punchEnabled, preRoll: s.preRollSec }
      : null,
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

// --- Phase 3e: push the region to the engine as loop + punch ------------
function syncRegionToEngine(s: Pick<DawState, 'region' | 'loopEnabled' | 'punchEnabled' | 'sampleRate'>) {
  const sr = s.sampleRate > 0 ? s.sampleRate : 48000;
  const start = s.region ? Math.round(s.region.inSec * sr) : 0;
  const end = s.region ? Math.round(s.region.outSec * sr) : 0;
  wsSend({ type: 'transport_set_loop', start, end, enabled: !!s.region && s.loopEnabled });
  wsSend({ type: 'transport_set_punch', start, end, enabled: !!s.region && s.punchEnabled });
}

// --- Phase 4: undo / redo -----------------------------------------------
// Snapshot the editable arrangement (clips + markers + track layout). Region
// and transport modes are deliberately excluded — they're transport settings,
// not arrangement edits.
type HistSnap = {
  clips: Record<string, DawClip>;
  markers: Record<string, DawMarker>;
  trackHeights: Record<number, number>;
};
const HIST_CAP = 60;
const HIST_COALESCE_MS = 250;
let undoStack: HistSnap[] = [];
let redoStack: HistSnap[] = [];
let lastSnapMs = 0;
let txnDepth = 0;

function histSnap(s: DawState): HistSnap {
  return { clips: s.clips, markers: s.markers, trackHeights: s.trackHeights };
}
function clearHistory() {
  undoStack = [];
  redoStack = [];
  lastSnapMs = 0;
  txnDepth = 0;
  useDawStore.setState({ canUndo: false, canRedo: false });
}
// Called at the START of every arrangement mutator, before it changes state.
function pushHistory(force = false) {
  if (applyingRemote) return;
  const now = Date.now();
  if (!force && txnDepth > 0) return;                 // the open txn already snapshotted
  if (!force && now - lastSnapMs < HIST_COALESCE_MS) return; // fold rapid edits (a drag) into one
  lastSnapMs = now;
  undoStack.push(histSnap(useDawStore.getState()));
  if (undoStack.length > HIST_CAP) undoStack.shift();
  redoStack = [];
  useDawStore.setState({ canUndo: true, canRedo: false });
}

// Phase 4 — group selection: pull in every clip sharing a group with one of `ids`.
function expandGroups(clips: Record<string, DawClip>, ids: string[]): string[] {
  const groups = new Set<string>();
  for (const id of ids) { const g = clips[id]?.group; if (g) groups.add(g); }
  if (!groups.size) return ids;
  const out = new Set(ids);
  for (const c of Object.values(clips)) if (c.group && groups.has(c.group)) out.add(c.id);
  return [...out];
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
      laneExpand: {},

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
      _takeStartedAtMs: null,
      _takeOriginSec: 0,
      cuesOpen: false,
      loudnessOpen: false,

      region: null,
      loopEnabled: false,
      punchEnabled: false,
      preRollSec: 0,
      canUndo: false,
      canRedo: false,
      bounceState: 'idle',
      lastBounce: null,
      bounceError: null,
      bounces: [],

      selectedClipIds: [],
      clipboard: [],

      dragOverTrackId: null,
      dragOverLane: null,
      marquee: null,
      compPreview: null,
      recordingClips: {},
      livePeaks: {},

      snapToGrid: true,
      gridSize: 1.0,
      rippleEdit: false,
      tempo: 120,
      timeSig: { num: 4, den: 4 },
      gridMode: 'time',
      beatDiv: 1,
      metronomeOn: false,
      metroDest: 'monitor',
      fps: 30,
      timecode: '00:00:00:00',

      lastOverrun: false,
      playbackUnderrun: false,
      peaks: {},

      setZoom: (zoom) => set({ zoom: Math.max(2, Math.min(400, zoom)) }),
      setScroll: (x, y) => set({ scrollX: Math.max(0, x), scrollY: Math.max(0, y) }),
      flagPlaybackUnderrun: () => { if (!get().playbackUnderrun) set({ playbackUnderrun: true }); },

      setCuesOpen: (v) => set({ cuesOpen: v }),
      setLoudnessOpen: (v) => set({ loudnessOpen: v }),

      // --- Phase 3e: region + transport modes ---
      setRegion: (inSec, outSec) => {
        const a = Math.max(0, Math.min(inSec, outSec));
        const b = Math.max(a + 0.01, Math.max(inSec, outSec));
        set({ region: { inSec: a, outSec: b } });
        syncRegionToEngine(get());
        scheduleSave();
      },
      clearRegion: () => {
        set({ region: null, loopEnabled: false, punchEnabled: false });
        syncRegionToEngine(get());
        scheduleSave();
      },
      setLoopEnabled: (v) => { set({ loopEnabled: v }); syncRegionToEngine(get()); scheduleSave(); },
      setPunchEnabled: (v) => { set({ punchEnabled: v }); syncRegionToEngine(get()); scheduleSave(); },
      setPreRoll: (sec) => { set({ preRollSec: Math.max(0, Math.min(30, sec)) }); scheduleSave(); },
      reassertRegionToEngine: (engineLoopOn, enginePunchOn) => {
        const s = get();
        const want = { loop: !!s.region && s.loopEnabled, punch: !!s.region && s.punchEnabled };
        if (want.loop !== engineLoopOn || want.punch !== enginePunchOn) syncRegionToEngine(s);
      },

      // --- Phase 4: bounce ---
      projectEndSec: () => {
        const cs = Object.values(get().clips).filter((c) => !c.recording);
        return cs.length ? Math.max(...cs.map((c) => c.start + c.length)) : 0;
      },
      startBounce: ({ inSec, outSec, name, bits }) => {
        if (!(outSec > inSec)) return;
        set({ bounceState: 'running', bounceError: null, lastBounce: null });
        wsSend({ type: 'bounce', inSec, outSec, name, bits });
      },
      cancelBounce: () => { wsSend({ type: 'bounce_cancel' }); set({ bounceState: 'idle' }); },
      applyBounceStatus: (msg) => {
        if (msg.state === 'running') set({ bounceState: 'running', bounceError: null });
        else if (msg.state === 'failed') set({ bounceState: 'failed', bounceError: msg.error || 'bounce failed' });
        else set({ bounceState: 'idle' }); // cancelled
      },
      applyBounceDone: (msg) => set({
        bounceState: 'done',
        lastBounce: { name: msg.name, bytes: msg.bytes, durationSec: msg.durationSec, overrun: !!msg.overrun },
      }),
      setBounces: (list) => set({ bounces: Array.isArray(list) ? list : [] }),

      // --- Phase 4: nudge / ripple / group / lock ---
      setRippleEdit: (v) => set({ rippleEdit: v }),

      nudgeSelected: (dtSec) => {
        pushHistory();
        set((state) => {
          const next = { ...state.clips };
          let any = false;
          for (const id of state.selectedClipIds) {
            const c = next[id];
            if (!c || c.locked) continue;
            next[id] = { ...c, start: Math.max(0, c.start + dtSec) };
            any = true;
          }
          return any ? { clips: next } : state;
        });
        scheduleSave();
      },

      // Cut the region span out of every comp-lane track and close the gap
      // (clips + markers after it shift left). The "remove this section" edit.
      rippleDelete: () => {
        const r = get().region;
        if (!r) return;
        const span = r.outSec - r.inSec;
        if (span <= 0) return;
        pushHistory(true);
        set((state) => {
          const next: Record<string, DawClip> = {};
          for (const c of Object.values(state.clips)) {
            if ((c.lane || 0) !== 0 || c.recording || c.locked) { next[c.id] = c; continue; }
            const cs = c.start, ce = c.start + c.length;
            if (ce <= r.inSec + 1e-6) { next[c.id] = c; continue; }
            if (cs >= r.outSec - 1e-6) { next[c.id] = { ...c, start: Math.max(0, cs - span) }; continue; }
            const keepLeft = cs < r.inSec - 1e-6;
            const keepRight = ce > r.outSec + 1e-6;
            if (keepLeft) next[c.id] = { ...c, length: r.inSec - cs, fadeOut: Math.min(c.fadeOut || 0, r.inSec - cs) };
            if (keepRight) {
              const id = keepLeft ? uuid() : c.id;
              next[id] = {
                ...c, id, start: r.inSec, length: ce - r.outSec,
                sourceOffset: (c.sourceOffset || 0) + (r.outSec - cs),
                fadeIn: Math.min(c.fadeIn || 0, ce - r.outSec),
              };
            }
          }
          const markers: Record<string, DawMarker> = {};
          for (const m of Object.values(state.markers)) {
            if (m.time <= r.inSec + 1e-6) markers[m.id] = m;
            else if (m.time >= r.outSec - 1e-6) markers[m.id] = { ...m, time: m.time - span };
            // markers strictly inside the region are removed
          }
          return { clips: next, markers, selectedClipIds: [], region: null, loopEnabled: false, punchEnabled: false };
        });
        syncRegionToEngine(get());
        scheduleSave();
      },

      toggleLockSelected: () => {
        pushHistory();
        set((state) => {
          const ids = state.selectedClipIds;
          if (!ids.length) return state;
          const lock = ids.some((id) => state.clips[id] && !state.clips[id].locked);
          const next = { ...state.clips };
          for (const id of ids) { const c = next[id]; if (c) next[id] = { ...c, locked: lock || undefined }; }
          return { clips: next };
        });
        scheduleSave();
      },

      groupSelected: () => {
        pushHistory();
        set((state) => {
          const ids = state.selectedClipIds;
          if (ids.length < 2) return state;
          const gid = uuid().slice(0, 8);
          const next = { ...state.clips };
          for (const id of ids) { const c = next[id]; if (c) next[id] = { ...c, group: gid }; }
          return { clips: next };
        });
        scheduleSave();
      },
      ungroupSelected: () => {
        pushHistory();
        set((state) => {
          const next = { ...state.clips };
          let any = false;
          for (const id of state.selectedClipIds) {
            const c = next[id];
            if (c?.group) { next[id] = { ...c, group: undefined }; any = true; }
          }
          return any ? { clips: next } : state;
        });
        scheduleSave();
      },

      // --- Phase 4: undo / redo ---
      historyBegin: () => { if (txnDepth === 0) pushHistory(true); txnDepth += 1; },
      historyEnd: () => { txnDepth = Math.max(0, txnDepth - 1); },
      undo: () => {
        if (!undoStack.length) return;
        const s = get();
        redoStack.push(histSnap(s));
        const prev = undoStack.pop() as HistSnap;
        applyingRemote = true;
        set({ ...prev, selectedClipIds: [], canUndo: undoStack.length > 0, canRedo: true });
        applyingRemote = false;
        scheduleSave();
      },
      redo: () => {
        if (!redoStack.length) return;
        const s = get();
        undoStack.push(histSnap(s));
        const next = redoStack.pop() as HistSnap;
        applyingRemote = true;
        set({ ...next, selectedClipIds: [], canUndo: true, canRedo: redoStack.length > 0 });
        applyingRemote = false;
        scheduleSave();
      },

      setPeaks: (key, data) => {
        requestedPeaks.delete(key);
        set((s) => ({ peaks: { ...s.peaks, [key]: data } }));
      },
      ensureClipPeaks: (clip) => {
        const key = clipPeakKey(clip);
        if (!key || get().peaks[key]) return;
        const last = requestedPeaks.get(key);
        if (last && Date.now() - last < PEAK_RETRY_MS) return; // in flight / just tried
        requestedPeaks.set(key, Date.now());
        wsSend({ type: 'get_clip_peaks', clipId: clip.id, takeDir: clip.takeDir, file: clip.file });
      },

      setPlayheadPosition: (pos) => set({ playheadPosition: Math.max(0, pos) }),

      locate: (sec) => {
        const p = Math.max(0, sec);
        set({
          playheadPosition: p, _engineSec: p, _engineWall: performance.now(),
          playbackUnderrun: false, timecode: fmtPlayhead(get(), p),
        });
        wsSend({ type: 'transport_locate', frame: Math.round(p * get().sampleRate) });
      },

      tickPlayhead: () => {
        const s = get();
        if (s.engineState === 0) return;
        const next = s._engineSec + (performance.now() - s._engineWall) / 1000;
        if (Math.abs(next - s.playheadPosition) > 0.0005) {
          set({ playheadPosition: next, timecode: fmtPlayhead(s, next) });
        }
      },

      setRecordStartTime: (time) => set({ recordStartTime: time }),
      setSnapToGrid: (snap) => set({ snapToGrid: snap }),
      setGridSize: (size) => set({ gridSize: size }),

      // --- Phase 5: bars/beats + metronome ---
      setTempo: (bpm) => {
        const t = Math.max(20, Math.min(300, Math.round(bpm) || 120));
        set({ tempo: t, timecode: fmtPlayhead({ ...get(), tempo: t }, get().playheadPosition) });
        pushMetronome({ ...get(), tempo: t });
        scheduleSave();
      },
      setTimeSig: (num, den) => {
        const n = Math.max(1, Math.min(16, Math.round(num) || 4));
        const d = [1, 2, 4, 8, 16].includes(den) ? den : 4;
        const timeSig = { num: n, den: d };
        set({ timeSig, timecode: fmtPlayhead({ ...get(), timeSig }, get().playheadPosition) });
        pushMetronome({ ...get(), timeSig });
        scheduleSave();
      },
      setGridMode: (mode) => {
        const gridMode = mode === 'bars' ? 'bars' : 'time';
        set({ gridMode, timecode: fmtPlayhead({ ...get(), gridMode }, get().playheadPosition) });
        scheduleSave();
      },
      setBeatDiv: (div) => set({ beatDiv: [1, 2, 4].includes(div) ? div : 1 }),
      setMetronomeOn: (on) => { set({ metronomeOn: !!on }); pushMetronome({ ...get(), metronomeOn: !!on }); },
      setMetroDest: (dest) => {
        const d = dest === 'master' || dest === 'both' ? dest : 'monitor';
        set({ metroDest: d });
        pushMetronome({ ...get(), metroDest: d });
      },
      snapTime: (sec) => {
        const s = get();
        if (!s.snapToGrid) return sec;
        const step = s.gridMode === 'bars' ? beatSec(s.tempo) / Math.max(1, s.beatDiv) : s.gridSize;
        return step > 0 ? Math.round(sec / step) * step : sec;
      },
      setFps: (fps) => set({ fps, timecode: fmtPlayhead({ ...get(), fps }, get().playheadPosition) }),

      applyTransport: (frame, state, sr) => {
        const s = get();
        const sampleRate = sr > 0 ? sr : s.sampleRate;
        const sec = frame / sampleRate;
        const st = (state === 2 ? 2 : state === 1 ? 1 : 0) as 0 | 1 | 2;
        let recordOriginSec = s.recordOriginSec;
        let takeStartedAtMs = s._takeStartedAtMs;
        let takeOriginSec = s._takeOriginSec;
        if (st === 2 && s.engineState !== 2) {                      // take just started
          recordOriginSec = sec;
          takeStartedAtMs = Date.now();
          takeOriginSec = sec;
        } else if (st === 0) {                                      // parked
          recordOriginSec = null;
          takeStartedAtMs = null;
        }
        // Grow the live recording placeholders with the transport.
        let clips = s.clips;
        if (st === 2 && Object.keys(s.recordingClips).length) {
          const origin = recordOriginSec ?? 0;
          const len = Math.max(0, sec - origin);
          const next = { ...clips };
          for (const id of Object.values(s.recordingClips)) {
            const c = next[id];
            if (c) next[id] = { ...c, length: len };
          }
          clips = next;
        }

        set({
          engineFrame: frame,
          engineState: st,
          sampleRate,
          recordOriginSec,
          _takeStartedAtMs: takeStartedAtMs,
          _takeOriginSec: takeOriginSec,
          _engineSec: sec,
          _engineWall: performance.now(),
          ...(clips !== s.clips ? { clips } : {}),
          // When stopped, snap exactly; while rolling, tickPlayhead interpolates.
          ...(st === 0 ? { playheadPosition: sec, timecode: fmtPlayhead(s, sec) } : {}),
        });
      },

      beginRecordingClips: (armed, originSec, sr) => {
        set((state) => {
          const recordingClips: Record<number, string> = {};
          const livePeaks: Record<string, number[]> = {};
          const nextClips = { ...state.clips };
          for (const trackId of armed) {
            const id = uuid();
            recordingClips[trackId] = id;
            livePeaks[id] = [];
            nextClips[id] = {
              id, trackId, start: originSec, length: 0,
              color: 'bg-red-600', name: 'Recording…',
              sampleRate: sr, recording: true,
            };
          }
          return { clips: nextClips, recordingClips, livePeaks };
        });
      },

      pushRecPeaks: (byTrack) => {
        set((state) => {
          if (!Object.keys(state.recordingClips).length) return state;
          const livePeaks = { ...state.livePeaks };
          for (const [tid, pairs] of Object.entries(byTrack)) {
            const id = state.recordingClips[Number(tid)];
            if (!id || !Array.isArray(pairs) || pairs.length < 2) continue;
            const arr = livePeaks[id] ? livePeaks[id].slice() : [];
            for (let i = 0; i + 1 < pairs.length; i += 2) arr.push(pairs[i], pairs[i + 1]);
            if (arr.length > 400000) arr.splice(0, arr.length - 400000); // cap
            livePeaks[id] = arr;
          }
          return { livePeaks };
        });
      },

      endRecordingClips: () => {
        set((state) => {
          if (!Object.keys(state.recordingClips).length) return state;
          const nextClips = { ...state.clips };
          for (const id of Object.values(state.recordingClips)) delete nextClips[id];
          return { clips: nextClips, recordingClips: {}, livePeaks: {} };
        });
      },

      addClip: (clip) => {
        pushHistory();
        set((state) => ({ clips: { ...state.clips, [clip.id]: clip } }));
        scheduleSave();
      },
      updateClip: (id, updates) => {
        pushHistory();
        set((state) => {
          const clip = state.clips[id];
          if (!clip) return state;
          return { clips: { ...state.clips, [id]: { ...clip, ...updates } } };
        });
        scheduleSave();
      },
      removeClip: (id) => {
        pushHistory();
        set((state) => {
          const nextClips = { ...state.clips };
          delete nextClips[id];
          return { clips: nextClips };
        });
        scheduleSave();
      },

      addMarker: (time, name) => {
        pushHistory();
        const m: DawMarker = { id: uuid(), time: Math.max(0, time), name: name || 'Marker' };
        set((state) => ({ markers: { ...state.markers, [m.id]: m } }));
        scheduleSave();
      },
      updateMarker: (id, updates) => {
        pushHistory();
        set((state) => {
          const m = state.markers[id];
          if (!m) return state;
          return { markers: { ...state.markers, [id]: { ...m, ...updates } } };
        });
        scheduleSave();
      },
      removeMarker: (id) => {
        pushHistory();
        set((state) => {
          const next = { ...state.markers };
          delete next[id];
          return { markers: next };
        });
        scheduleSave();
      },

      setSelectedClips: (ids) => set((s) => ({ selectedClipIds: expandGroups(s.clips, ids) })),
      toggleClipSelection: (id) =>
        set((state) => {
          const has = state.selectedClipIds.includes(id);
          return {
            selectedClipIds: has
              ? state.selectedClipIds.filter((i) => i !== id)
              : expandGroups(state.clips, [...state.selectedClipIds, id]),
          };
        }),
      clearSelection: () => set({ selectedClipIds: [] }),

      deleteSelected: () => {
        pushHistory();
        set((state) => {
          const nextClips = { ...state.clips };
          const del = state.selectedClipIds
            .map((id) => state.clips[id])
            .filter((c): c is DawClip => !!c && !c.locked);
          for (const c of del) delete nextClips[c.id];

          if (state.rippleEdit) {
            // close the gap on each affected comp-lane track
            const byTrack = new Map<number, DawClip[]>();
            for (const c of del) {
              if ((c.lane || 0) !== 0) continue;
              const a = byTrack.get(c.trackId) || []; a.push(c); byTrack.set(c.trackId, a);
            }
            for (const [tid, dels] of byTrack) {
              dels.sort((a, b) => a.start - b.start);
              for (const d of dels) {
                for (const id of Object.keys(nextClips)) {
                  const c = nextClips[id];
                  if (c.trackId !== tid || (c.lane || 0) !== 0 || c.locked) continue;
                  if (c.start >= d.start + d.length - 1e-6)
                    nextClips[id] = { ...c, start: Math.max(0, c.start - d.length) };
                }
              }
            }
          }
          return { clips: nextClips, selectedClipIds: [] };
        });
        scheduleSave();
      },

      sliceSelectedAtPlayhead: () => {
        pushHistory();
        set((state) => {
          const nextClips = { ...state.clips };
          const newSelection = [...state.selectedClipIds];
          const pos = state.playheadPosition;
          let slicedAny = false;

          state.selectedClipIds.forEach((id) => {
            const clip = nextClips[id];
            if (clip && !clip.locked && pos > clip.start && pos < clip.start + clip.length) {
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
        pushHistory();
        set((state) => {
          const clip = state.clips[clipId];
          if (!clip || clip.locked || time <= clip.start + 0.01 || time >= clip.start + clip.length - 0.01) return state;
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
        pushHistory();
        set((state) => {
          const c = state.clips[id];
          if (!c) return state;
          return { clips: { ...state.clips, [id]: { ...c, name } } };
        });
        scheduleSave();
      },

      setClipFade: (id, edge, seconds) => {
        pushHistory();
        set((state) => {
          const c = state.clips[id];
          if (!c) return state;
          const v = Math.max(0, Math.min(c.length, seconds));
          return { clips: { ...state.clips, [id]: { ...c, [edge === 'in' ? 'fadeIn' : 'fadeOut']: v } } };
        });
        scheduleSave();
      },

      setClipGain: (id, gain) => {
        pushHistory();
        set((state) => {
          const c = state.clips[id];
          if (!c) return state;
          return { clips: { ...state.clips, [id]: { ...c, gain: Math.max(0.001, Math.min(4, gain)) } } };
        });
        scheduleSave();
      },

      setDragOverTrack: (trackId, lane = null) =>
        set((s) => (s.dragOverTrackId === trackId && s.dragOverLane === lane ? s : { dragOverTrackId: trackId, dragOverLane: lane })),
      setMarquee: (m) => set({ marquee: m }),
      setCompPreview: (p) => set({ compPreview: p }),

      copySelected: () =>
        set((state) => ({
          clipboard: state.selectedClipIds.map((id) => state.clips[id]).filter(Boolean) as DawClip[],
        })),

      pasteClipboard: () => {
        pushHistory();
        set((state) => {
          if (state.clipboard.length === 0) return state;
          const earliestStart = Math.min(...state.clipboard.map((c) => c.start));
          const latestEnd = Math.max(...state.clipboard.map((c) => c.start + c.length));
          const offset = state.playheadPosition - earliestStart;
          const span = latestEnd - earliestStart;
          const at = state.playheadPosition;
          const nextClips = { ...state.clips };

          if (state.rippleEdit && span > 0) {
            const tracks = new Set(state.clipboard.map((c) => c.trackId));
            for (const id of Object.keys(nextClips)) {
              const c = nextClips[id];
              if (!tracks.has(c.trackId) || (c.lane || 0) !== 0 || c.locked) continue;
              if (c.start >= at - 1e-6) nextClips[id] = { ...c, start: c.start + span };
            }
          }

          const newSelection: string[] = [];
          state.clipboard.forEach((clip) => {
            const newId = uuid();
            nextClips[newId] = { ...clip, id: newId, group: undefined, start: Math.max(0, clip.start + offset) };
            newSelection.push(newId);
          });
          return { clips: nextClips, selectedClipIds: newSelection };
        });
        scheduleSave();
      },

      setTrackHeight: (trackId, height) => {
        pushHistory();
        set((state) => ({
          trackHeights: { ...state.trackHeights, [trackId]: Math.max(48, height) },
        }));
        scheduleSave();
      },

      // --- Phase 4: take comping ---
      laneCountFor: (trackId) => {
        let m = 0;
        for (const c of Object.values(get().clips))
          if (c.trackId === trackId && !c.recording && (c.lane || 0) > m) m = c.lane || 0;
        return m;
      },

      toggleLaneExpand: (trackId) =>
        set((s) => ({ laneExpand: { ...s.laneExpand, [trackId]: !s.laneExpand[trackId] } })),

      moveClipToLane: (clipId, lane) => {
        pushHistory();
        set((state) => {
          const c = state.clips[clipId];
          if (!c) return state;
          const L = Math.max(0, Math.round(lane));
          if ((c.lane || 0) === L) return state;
          return { clips: { ...state.clips, [clipId]: { ...c, lane: L || undefined } } };
        });
        scheduleSave();
      },

      // Swipe-to-comp: make `lane`'s take audio the active take over [fromSec,
      // toSec] on `trackId` — clear the comp lane there and splice in trimmed
      // copies of the source-lane clips. The comp lane stays a flat, playable
      // clip row.
      compPick: (trackId, fromSec, toSec, lane) => {
        const a = Math.max(0, Math.min(fromSec, toSec));
        const b = Math.max(fromSec, toSec);
        if (b - a < 0.02 || !lane) return;
        pushHistory();
        set((state) => {
          const SEAM = 0.008; // click-guard fade at the seams
          const next: Record<string, DawClip> = { ...state.clips };
          const onTrack = Object.values(state.clips).filter((c) => c.trackId === trackId && !c.recording);

          // 1. carve [a,b] out of the comp lane
          for (const c of onTrack) {
            if ((c.lane || 0) !== 0) continue;
            const cs = c.start, ce = c.start + c.length;
            if (ce <= a || cs >= b) continue;             // untouched
            delete next[c.id];
            if (cs < a) {                                  // keep the left offcut
              const id = uuid();
              next[id] = {
                ...c, id, length: a - cs,
                fadeOut: Math.min(c.fadeOut || SEAM, a - cs, SEAM * 4),
              };
            }
            if (ce > b) {                                  // keep the right offcut
              const id = uuid();
              next[id] = {
                ...c, id, start: b, length: ce - b,
                sourceOffset: (c.sourceOffset || 0) + (b - cs),
                fadeIn: Math.min(c.fadeIn || SEAM, ce - b, SEAM * 4),
              };
            }
          }

          // 2. splice the source lane's audio into [a,b] on the comp lane
          const picked: string[] = [];
          for (const c of onTrack) {
            if ((c.lane || 0) !== lane) continue;
            const cs = c.start, ce = c.start + c.length;
            const s = Math.max(a, cs), e = Math.min(b, ce);
            if (e - s < 0.005) continue;
            const id = uuid();
            next[id] = {
              ...c, id, lane: undefined,
              start: s, length: e - s,
              sourceOffset: (c.sourceOffset || 0) + (s - cs),
              fadeIn: s > cs ? SEAM : (c.fadeIn || 0),
              fadeOut: e < ce ? SEAM : (c.fadeOut || 0),
            };
            picked.push(id);
          }
          return { clips: next, selectedClipIds: picked };
        });
        scheduleSave();
      },

      loadProjectData: (name, project) => {
        const p = (project || {}) as {
          clips?: unknown; markers?: unknown; trackHeights?: unknown;
          loop?: { start?: number; end?: number; loop?: boolean; punch?: boolean; preRoll?: number } | null;
        };
        applyingRemote = true;
        const lp = p.loop && typeof p.loop === 'object' ? p.loop : null;
        const region = lp && typeof lp.start === 'number' && typeof lp.end === 'number' && lp.end > lp.start
          ? { inSec: lp.start, outSec: lp.end } : null;
        set({
          projectName: name || 'default',
          clips: toRecord<DawClip>(p.clips),
          markers: toRecord<DawMarker>(p.markers),
          trackHeights:
            p.trackHeights && typeof p.trackHeights === 'object'
              ? (p.trackHeights as Record<number, number>)
              : {},
          selectedClipIds: [],
          laneExpand: {},
          region,
          loopEnabled: !!(lp && lp.loop) && !!region,
          punchEnabled: !!(lp && lp.punch) && !!region,
          preRollSec: lp && typeof lp.preRoll === 'number' ? Math.max(0, Math.min(30, lp.preRoll)) : 0,
        });
        applyingRemote = false;
        clearHistory();
        syncRegionToEngine(get());
      },

      setProjectList: (list, active) =>
        set({
          projectList: Array.isArray(list) ? list : [],
          ...(active ? { projectName: active } : {}),
        }),

      addCommittedClips: (clips, overrun) => {
        pushHistory(true); // a finished recording is one undoable step
        set((state) => {
          const next = { ...state.clips };
          // A new take that lands on top of existing audio on its track stacks
          // onto a fresh take lane rather than overlapping it (Phase 4 comping).
          const laneExpand = { ...state.laneExpand };
          for (const c of clips) {
            if (!c || !c.id) continue;
            let lane = c.lane || 0;
            const cs = c.start, ce = c.start + (c.length || 0);
            let maxLane = 0;
            let clash = false;
            for (const ex of Object.values(next)) {
              if (ex.trackId !== c.trackId || ex.recording) continue;
              if ((ex.lane || 0) > maxLane) maxLane = ex.lane || 0;
              if (ce > ex.start && cs < ex.start + ex.length) clash = true;
            }
            if (clash && lane === 0) { lane = maxLane + 1; laneExpand[c.trackId] = true; }
            next[c.id] = lane ? { ...c, lane } : c;
          }
          return { clips: next, laneExpand, lastOverrun: overrun };
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
        clips: Object.fromEntries(Object.entries(s.clips).filter(([, c]) => !c.recording)),
        markers: s.markers,
        trackHeights: s.trackHeights,
        laneExpand: s.laneExpand,
        zoom: s.zoom,
        snapToGrid: s.snapToGrid,
        gridSize: s.gridSize,
        rippleEdit: s.rippleEdit,
        tempo: s.tempo,
        timeSig: s.timeSig,
        gridMode: s.gridMode,
        beatDiv: s.beatDiv,
        metroDest: s.metroDest,
        fps: s.fps,
        cuesOpen: s.cuesOpen,
        loudnessOpen: s.loudnessOpen,
        region: s.region,
        loopEnabled: s.loopEnabled,
        punchEnabled: s.punchEnabled,
        preRollSec: s.preRollSec,
      }),
    }
  )
);

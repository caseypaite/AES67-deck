import { WebSocketServer, WebSocket } from 'ws';
import * as net from 'net';
import * as fs from 'fs';
import * as dgram from 'dgram';
import * as http from 'http';
import { execFile } from 'child_process';
import { Worker } from 'worker_threads';
import * as path from 'path';
import type { PeaksFile } from './wavPeaks';
import { buildRpp, parseRpp, type RppProject } from './rpp';
import {
  TIMECODE_DEFAULTS, timecodeAt, type TimecodeConfig, type TcFps,
} from './timecode';

// ── Crash-safe file write ────────────────────────────────────────────────
// Write to a temp file in the same directory, then atomically rename over the
// target. A power cut or kill mid-write then leaves the previous version
// intact instead of a truncated/empty/half-JSON file. Used for every piece of
// persisted session state (mixer, fx racks, projects, routing, playlists, …).
function writeFileAtomicSync(file: string, data: string | Buffer): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

// ── Waveform peaks: off the event loop ───────────────────────────────────
// computePeaks() is seconds of blocking work for a long take; run it on a
// single persistent worker thread with a FIFO queue (peak requests are
// infrequent and disk-bound, so serialising is fine and keeps memory flat).
const PEAKS_WORKER_PATH = path.join(
  __dirname, __filename.endsWith('.ts') ? 'wavPeaksWorker.ts' : 'wavPeaksWorker.js',
);
let peaksWorker: Worker | null = null;
const peaksQueue: Array<{ srcPath: string; resolve: (p: PeaksFile | null) => void }> = [];
let peaksInFlight: { resolve: (p: PeaksFile | null) => void } | null = null;

function pumpPeaksQueue(): void {
  if (peaksInFlight || peaksQueue.length === 0) return;
  const job = peaksQueue.shift()!;
  peaksInFlight = job;

  const settle = (peaks: PeaksFile | null) => {
    const j = peaksInFlight;
    peaksInFlight = null;
    j?.resolve(peaks);
    pumpPeaksQueue();
  };

  try {
    if (!peaksWorker) {
      peaksWorker = new Worker(PEAKS_WORKER_PATH, {
        execArgv: __filename.endsWith('.ts') ? ['-r', 'ts-node/register/transpile-only'] : [],
      });
      peaksWorker.unref(); // don't keep the process alive for a pending peaks job
      peaksWorker.on('message', (peaks: PeaksFile | null) => settle(peaks ?? null));
      peaksWorker.on('error', (e) => {
        console.error('peaks worker error', e);
        peaksWorker = null;
        settle(null);
      });
      peaksWorker.on('exit', (code) => {
        peaksWorker = null;
        if (code !== 0) console.error('peaks worker exited with code', code);
        if (peaksInFlight) settle(null);
      });
    }
    peaksWorker.postMessage(job.srcPath);
  } catch (e) {
    console.error('peaks worker spawn failed', e);
    settle(null);
  }
}

function getPeaksAsync(srcPath: string): Promise<PeaksFile | null> {
  return new Promise((resolve) => {
    peaksQueue.push({ srcPath, resolve });
    pumpPeaksQueue();
  });
}

const SCENES_DIR = path.join(process.cwd(), '..', 'scenes');
if (!fs.existsSync(SCENES_DIR)) {
  fs.mkdirSync(SCENES_DIR);
}

// FX chain presets — a named, reusable "rack": the plugin list (uri, name,
// enabled, params) for one channel's insert chain, save/loadable onto any
// other channel. Separate from scenes (which snapshot the whole mixer).
const RACK_PRESETS_DIR = path.join(process.cwd(), '..', 'rack_presets');
if (!fs.existsSync(RACK_PRESETS_DIR)) {
  fs.mkdirSync(RACK_PRESETS_DIR);
}

// DAW projects (plan/daw-timeline-roadmap.md Phase 1c). A project is the
// timeline arrangement — clips, markers, track layout — kept separate from
// scenes (a live mixer snapshot). Each project is a directory:
//   projects/<name>/project.json          the arrangement (UI is source of truth)
//   projects/<name>/takes/<timestamp>/     ch<NN>.wav + take.json per recording
const PROJECTS_DIR = path.join(process.cwd(), '..', 'projects');
if (!fs.existsSync(PROJECTS_DIR)) {
  fs.mkdirSync(PROJECTS_DIR);
}
const ACTIVE_PROJECT_PATH = path.join(PROJECTS_DIR, '.active');

// Playout playlists (plan Phase 5) — an ordered list of projects the server
// plays back-to-back, advancing on the metering clock.
const PLAYLISTS_DIR = path.join(process.cwd(), '..', 'playlists');
if (!fs.existsSync(PLAYLISTS_DIR)) fs.mkdirSync(PLAYLISTS_DIR);

interface DawProject {
  clips: any[];
  markers: any[];
  trackHeights: Record<string, number>;
  loop?: { start: number; end: number; enabled: boolean };
  // Phase 5 — musical settings persisted with the arrangement.
  tempo?: number;
  timeSig?: { num: number; den: number };
  beatDiv?: number;
  countInBars?: number;
  compCrossfadeSec?: number;
  metroDest?: string;
  automation?: AutoLane[];
  video?: { file: string; offsetSec: number } | null;
}

// Phase 5 — automation lanes. Points hold the target's raw value (fader 0..1,
// pan -1..1, plugin param in its own port range). Playback is a server-side
// runner on the metering clock; write-capture appends points from live moves.
interface AutoPoint { t: number; v: number; }
interface AutoLane {
  id: string;
  target: {
    kind: 'fader' | 'pan' | 'plugin';
    channelId: number; label?: string;
    pluginId?: string; pluginIndex?: number; paramSymbol?: string;
  };
  min: number; max: number;
  points: AutoPoint[];
  enabled: boolean;
  armed: boolean;
}

function coerceAutoLanes(raw: unknown): AutoLane[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((l: any) => l && typeof l.id === 'string' && l.target &&
    ['fader', 'pan', 'plugin'].includes(l.target.kind) && Number.isFinite(Number(l.target.channelId)))
    .map((l: any) => ({
      id: l.id,
      target: {
        kind: l.target.kind,
        channelId: Number(l.target.channelId),
        label: typeof l.target.label === 'string' ? l.target.label : undefined,
        pluginId: typeof l.target.pluginId === 'string' ? l.target.pluginId : undefined,
        pluginIndex: Number.isFinite(Number(l.target.pluginIndex)) ? Number(l.target.pluginIndex) : undefined,
        paramSymbol: typeof l.target.paramSymbol === 'string' ? l.target.paramSymbol : undefined,
      },
      min: Number.isFinite(Number(l.min)) ? Number(l.min) : 0,
      max: Number.isFinite(Number(l.max)) ? Number(l.max) : 1,
      points: Array.isArray(l.points)
        ? l.points.filter((p: any) => Number.isFinite(Number(p?.t)) && Number.isFinite(Number(p?.v)))
            .map((p: any) => ({ t: Math.max(0, Number(p.t)), v: Number(p.v) }))
            .sort((a: AutoPoint, b: AutoPoint) => a.t - b.t)
        : [],
      enabled: l.enabled !== false,
      armed: l.armed === true,
    }));
}

function emptyProject(): DawProject {
  return { clips: [], markers: [], trackHeights: {} };
}

function sanitizeProjectName(name: unknown): string {
  const s = String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return s.length > 0 ? s : 'default';
}

function projectDir(name: string): string {
  return path.join(PROJECTS_DIR, sanitizeProjectName(name));
}

// --- REAPER-compatible multitrack recording projects ---------------------
// A recording project is a portable bundle: records/<Name>/<Name>.rpp plus
// its consolidated WavPack media, openable directly in REAPER. It is the
// primary saved format; projects/default/project.json is just the scratch
// autosave for the not-yet-saved session.
const RECORDS_DIR = process.env.AES67_RECORDS_DIR
  ? path.resolve(process.env.AES67_RECORDS_DIR)
  : path.join(process.cwd(), '..', 'records');
try { fs.mkdirSync(RECORDS_DIR, { recursive: true }); } catch { /* ignore */ }

// As-run logs (plan/daw-timeline-roadmap.md Phase 3c): the ~1 Hz loudness CSV
// and the compliance reports exported from it.
const LOGS_DIR = process.env.AES67_LOGS_DIR
  ? path.resolve(process.env.AES67_LOGS_DIR)
  : path.join(process.cwd(), '..', 'logs');
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch { /* ignore */ }

// Rendered bounces (plan Phase 4). Live under records/ so they ride the same
// backup / file-share path as the recordings.
const BOUNCES_DIR = path.join(RECORDS_DIR, 'bounces');
try { fs.mkdirSync(BOUNCES_DIR, { recursive: true }); } catch { /* ignore */ }

// Name of the recording project currently open, or null for the scratch
// session. When set, its media lives in records/<name>/ (flat) and autosave
// rewrites records/<name>/<name>.rpp.
let activeRecordingProject: string | null = null;

function recProjectDir(name: string): string {
  return path.join(RECORDS_DIR, sanitizeProjectName(name));
}
function rppPath(name: string): string {
  return path.join(recProjectDir(name), `${sanitizeProjectName(name)}.rpp`);
}

function listRecordingProjects(): string[] {
  try {
    return fs.readdirSync(RECORDS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(rppPath(d.name)))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// Flat, collision-free media name for a consolidated take file.
function consolidatedName(takeDir: string, file: string): string {
  const td = String(takeDir || '').replace(/[^0-9A-Za-z_-]/g, '');
  const base = path.basename(String(file || ''));
  return td && !base.startsWith(td) ? `${td}_${base}` : base;
}

// The current timeline (DawProject-shaped) -> RppProject. `fileFor` maps each
// clip to the media filename to write into the .rpp (relative to it).
function timelineToRpp(
  clips: any[], markers: any[], trackHeights: Record<string, number>,
  sampleRate: number, fileFor: (c: any) => string,
  music?: { tempo?: number; timeSig?: { num: number; den: number } },
): RppProject {
  const byTrack = new Map<number, any[]>();
  for (const c of clips) {
    if (!c || !c.file) continue;
    if (c.lane) continue;               // comp-lane only in the .rpp bundle
    const t = Number(c.trackId) || 1;
    if (!byTrack.has(t)) byTrack.set(t, []);
    byTrack.get(t)!.push(c);
  }
  const tracks = [...byTrack.keys()].sort((a, b) => a - b).map((tid) => ({
    name: `IN ${tid}`,
    trackId: tid,
    height: Number(trackHeights[String(tid)]) || undefined,
    items: byTrack.get(tid)!.map((c) => ({
      id: typeof c.id === 'string' ? c.id : undefined,
      name: String(c.name || `CH${tid}`),
      position: Number(c.start) || 0,
      length: Number(c.length) || 0,
      soffs: Number(c.sourceOffset) || 0,
      gain: typeof c.gain === 'number' ? c.gain : 1,
      fadeIn: Number(c.fadeIn) || 0,
      fadeOut: Number(c.fadeOut) || 0,
      file: fileFor(c),
    })),
  }));
  return {
    sampleRate: sampleRate || 48000,
    tempo: Number(music?.tempo) || 120,
    timeSig: music?.timeSig,
    tracks,
    markers: (markers || []).map((m: any) => ({ position: Number(m.time) || 0, name: String(m.name || 'Marker') })),
  };
}

const REC_CLIP_COLORS = ['bg-red-600', 'bg-blue-600', 'bg-green-600', 'bg-orange-600', 'bg-purple-600', 'bg-teal-600'];

// A parsed .rpp -> DawProject the UI store understands. `projName` is stamped
// onto each clip's takeDir so peak lookups route to records/<projName>/.
function rppToProject(rpp: RppProject, projName: string): DawProject {
  const clips: any[] = [];
  rpp.tracks.forEach((tr, ti) => {
    const trackId = tr.trackId && tr.trackId >= 1 && tr.trackId <= NUM_CHANNELS ? tr.trackId : ti + 1;
    for (const it of tr.items) {
      clips.push({
        id: it.id || (globalThis.crypto as Crypto).randomUUID(),
        trackId,
        start: it.position,
        length: it.length,
        color: REC_CLIP_COLORS[(trackId - 1) % REC_CLIP_COLORS.length],
        name: it.name,
        takeDir: projName,
        file: path.basename(it.file),
        originFrame: Math.round(it.position * rpp.sampleRate),
        endFrame: Math.round((it.position + it.length) * rpp.sampleRate),
        sampleRate: rpp.sampleRate,
        ...(it.soffs ? { sourceOffset: it.soffs } : {}),
        ...(it.gain !== 1 ? { gain: it.gain } : {}),
        ...(it.fadeIn ? { fadeIn: it.fadeIn } : {}),
        ...(it.fadeOut ? { fadeOut: it.fadeOut } : {}),
      });
    }
  });
  const trackHeights: Record<string, number> = {};
  rpp.tracks.forEach((tr) => {
    const tid = tr.trackId && tr.trackId >= 1 && tr.trackId <= NUM_CHANNELS ? tr.trackId : null;
    if (tid && tr.height) trackHeights[String(tid)] = tr.height;
  });
  const markers = rpp.markers.map((m, i) => ({ id: `m${i}_${Math.round(m.position * 1000)}`, time: m.position, name: m.name }));
  return {
    clips, markers, trackHeights,
    ...(rpp.tempo ? { tempo: rpp.tempo } : {}),
    ...(rpp.timeSig ? { timeSig: rpp.timeSig } : {}),
  };
}

let rppSaveTimer: ReturnType<typeof setTimeout> | null = null;
function writeRppDebounced(name: string, rpp: RppProject): void {
  if (rppSaveTimer) clearTimeout(rppSaveTimer);
  rppSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(recProjectDir(name), { recursive: true });
      writeFileAtomicSync(rppPath(name), buildRpp(rpp));
    } catch (e) {
      console.error(`Error writing ${name}.rpp`, e);
    }
  }, 500);
}

function broadcastRecordingProjects(): void {
  const msg = JSON.stringify({ type: 'recording_projects_list', projects: listRecordingProjects(), active: activeRecordingProject });
  connectedWsClients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function ensureProject(name: string): void {
  const dir = projectDir(name);
  fs.mkdirSync(path.join(dir, 'takes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'video'), { recursive: true });
  const pj = path.join(dir, 'project.json');
  if (!fs.existsSync(pj)) {
    writeFileAtomicSync(pj, JSON.stringify(emptyProject(), null, 2));
  }
}

// Reference videos the operator has copied into projects/<name>/video/.
function listProjectVideos(name: string): Array<{ file: string; sizeBytes: number }> {
  try {
    const dir = path.join(projectDir(name), 'video');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => /\.(mp4|webm|mov|m4v|mkv)$/i.test(f))
      .map((f) => ({ file: f, sizeBytes: fs.statSync(path.join(dir, f)).size }));
  } catch { return []; }
}

function listScenes(): string[] {
  try {
    return fs.readdirSync(SCENES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();
  } catch {
    return [];
  }
}

function listProjects(): string[] {
  try {
    return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

// Merge any recorded takes on disk that aren't yet represented as clips in
// project.json (covers a take finishing while no UI was connected, or a UI
// that never persisted). Dedupe by (takeDir, trackId).
function projectWithOrphanTakes(name: string, project: DawProject): DawProject {
  const takesRoot = path.join(projectDir(name), 'takes');
  if (!fs.existsSync(takesRoot)) return project;
  const known = new Set(
    (project.clips || []).map((c: any) => `${c.takeDir || ''}::${c.trackId}`)
  );
  const clips = [...(project.clips || [])];
  for (const takeName of fs.readdirSync(takesRoot).sort()) {
    const manifestPath = path.join(takesRoot, takeName, 'take.json');
    if (!fs.existsSync(manifestPath)) continue;
    let m: any;
    try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { continue; }
    for (const clip of takeManifestToClips(takeName, m)) {
      if (known.has(`${clip.takeDir}::${clip.trackId}`)) continue;
      clips.push(clip);
    }
  }
  return { ...project, clips };
}

// Coerce the Phase 5 musical settings out of a project blob (from disk or a
// save_project message) — undefined keys are simply omitted so the UI keeps its
// current value.
function musicalFields(raw: any): Partial<DawProject> {
  const out: Partial<DawProject> = {};
  if (Number.isFinite(Number(raw?.tempo)) && Number(raw.tempo) >= 20 && Number(raw.tempo) <= 300) out.tempo = Number(raw.tempo);
  if (raw?.timeSig && Number.isFinite(Number(raw.timeSig.num)) && Number.isFinite(Number(raw.timeSig.den)))
    out.timeSig = { num: Math.max(1, Math.min(16, Math.round(Number(raw.timeSig.num)))), den: Number(raw.timeSig.den) };
  if ([1, 2, 4].includes(Number(raw?.beatDiv))) out.beatDiv = Number(raw.beatDiv);
  if (Number.isFinite(Number(raw?.countInBars))) out.countInBars = Math.max(0, Math.min(4, Math.round(Number(raw.countInBars))));
  if (Number.isFinite(Number(raw?.compCrossfadeSec))) out.compCrossfadeSec = Math.max(0, Math.min(0.1, Number(raw.compCrossfadeSec)));
  if (['monitor', 'master', 'both'].includes(String(raw?.metroDest))) out.metroDest = String(raw.metroDest);
  if (raw?.automation !== undefined) out.automation = coerceAutoLanes(raw.automation);
  if (raw?.video && typeof raw.video === 'object' && typeof raw.video.file === 'string') {
    out.video = { file: raw.video.file, offsetSec: Number(raw.video.offsetSec) || 0 };
  } else if (raw?.video === null) {
    out.video = null;
  }
  return out;
}

function loadProject(name: string): DawProject {
  const pj = path.join(projectDir(name), 'project.json');
  let project = emptyProject();
  try {
    if (fs.existsSync(pj)) {
      const raw = JSON.parse(fs.readFileSync(pj, 'utf8'));
      project = {
        clips: Array.isArray(raw.clips) ? raw.clips : [],
        markers: Array.isArray(raw.markers) ? raw.markers : [],
        trackHeights: raw.trackHeights && typeof raw.trackHeights === 'object' ? raw.trackHeights : {},
        loop: raw.loop && typeof raw.loop === 'object' ? raw.loop : undefined,
        ...musicalFields(raw),
      };
    }
  } catch (e) {
    console.error(`Error loading project ${name}, starting fresh`, e);
  }
  return projectWithOrphanTakes(name, project);
}

let projectSaveTimer: ReturnType<typeof setTimeout> | null = null;
function saveProjectDebounced(name: string, project: DawProject): void {
  ensureProject(name);
  const pj = path.join(projectDir(name), 'project.json');
  if (projectSaveTimer) clearTimeout(projectSaveTimer);
  projectSaveTimer = setTimeout(() => {
    try {
      writeFileAtomicSync(pj, JSON.stringify(project, null, 2));
    } catch (e) {
      console.error(`Error saving project ${name}`, e);
    }
  }, 500);
}

// One take manifest -> one clip per recorded channel, in the DawClip shape the
// UI store expects (start/length in seconds), plus source fields Phase 2
// playback needs.
function takeManifestToClips(takeName: string, m: any): any[] {
  const sr = Number(m.sampleRate) > 0 ? Number(m.sampleRate) : 48000;
  const origin = Number(m.originFrame) || 0;
  // Prefer the frames actually written (engine `frames`) — reliable even if the
  // transport moved between arming and rolling; fall back to the frame span.
  const recorded = Number(m.frames) || 0;
  const end = recorded > 0 ? origin + recorded : (Number(m.endFrame) || origin);
  const lengthSec = Math.max(0, (end - origin) / sr);
  const armed: number[] = Array.isArray(m.armed) ? m.armed : [];
  const ext = typeof m.ext === 'string' && /^[a-z0-9]{2,4}$/.test(m.ext) ? m.ext : 'wv';
  const label = takeName.replace(/T(\d\d)-(\d\d)-(\d\d).*/, ' $1:$2');
  return armed.map((ch) => ({
    id: (globalThis.crypto as Crypto).randomUUID(),
    trackId: ch,
    start: origin / sr,
    length: lengthSec,
    color: 'bg-red-600',
    name: `Take${label} · CH${ch}`,
    takeDir: takeName,
    file: `ch${String(ch).padStart(2, '0')}.${ext}`,
    originFrame: origin,
    endFrame: end,
    sampleRate: sr,
  }));
}

let activeProjectName = 'default';
try {
  if (fs.existsSync(ACTIVE_PROJECT_PATH)) {
    activeProjectName = sanitizeProjectName(fs.readFileSync(ACTIVE_PROJECT_PATH, 'utf8').trim());
  }
} catch { /* keep default */ }
// If the persisted active project is a REAPER recording project, reopen it as
// one (media in records/<name>/, autosave to the .rpp).
if (activeProjectName !== 'default' && fs.existsSync(rppPath(activeProjectName))) {
  activeRecordingProject = activeProjectName;
} else {
  ensureProject(activeProjectName);
}

function setActiveProject(name: string): void {
  activeProjectName = sanitizeProjectName(name);
  ensureProject(activeProjectName);
  syncLastRegionFromProject(activeProjectName);
  if (engineSocket) replayRegionToEngine();
  try {
    writeFileAtomicSync(ACTIVE_PROJECT_PATH, activeProjectName);
  } catch (e) {
    console.error('Could not persist active project name', e);
  }
}

// The take directory the engine is currently recording into (set when we
// issue start_multitrack_record, read when take_started/finished comes back).
let activeTakeDir: string | null = null;

const SOCKET_PATH = process.env.AES67_SOCKET_PATH || '/tmp/aes67_deck.sock';
const WSS_PORT = parseInt(process.env.PORT || '8081', 10);

const PATCHBAY_CONFIG_PATH = 'patchbay_config.json';

// Seed routing used when no patchbay_config.json exists yet (fresh install /
// first boot). Channel 1 <- the machine's captured system audio, so a
// headless appliance has its own playback in the mixer before anyone opens
// the UI. Matches initialMappings in ui/src/stores/usePatchbayStore.ts.
const DEFAULT_PATCHBAY_MAPPINGS: Record<string, any> = {
  '1': { channelId: 1, sourceStreamId: 'system-audio-loopback', sourceChannel: 0, destStreamId: null, destChannel: 0 },
};
const OUTPUT_ROUTING_PATH = 'output_routing.json';
const TALKBACK_CONFIG_PATH = 'talkback_config.json';
const MIXER_STATE_PATH = 'mixer_state.json';
// Phase 2 (plan/unified-aes67-network-control.md): operator overrides for the
// fixed transmit-Source groups (Master, Monitor, Aux 1..8), and the AES67_Source capture-channel block
// allocated to each subscribed receive Sink.
const TX_SOURCES_PATH = 'tx_sources.json';
const RX_SINKS_PATH = 'rx_sinks.json';

// In-memory snapshot of all fader-level mixer state. Written to
// mixer_state.json on every change (debounced 500ms) and replayed to the
// engine on reconnect and to each UI client on connect, so all clients stay
// in sync and the console resumes correctly after any restart.
interface ChannelMixerState {
  fader?: number;   // normalised UI position 0..1
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  arm?: boolean;    // record-armed for multitrack capture (plan Phase 3a)
  phase?: boolean;  // polarity invert ("ø")
  auxSends?: Record<string, number>;
}
type MixerStateMap = Record<string, ChannelMixerState>;

let mixerState: MixerStateMap = {};
let mixerStateSaveTimer: ReturnType<typeof setTimeout> | null = null;

// --- FX rack persistence -------------------------------------------------
// The engine's per-channel insert chains are runtime-only. The server mirrors
// them here by observing the same add/remove/reorder/replace/param/bypass/
// load_rack messages it already forwards, persists the result, and replays it:
// to a reconnecting engine (load_rack per channel) and to a connecting UI
// (fx_racks_loaded). Same self-heal contract as routing / mixer_state.
const FX_RACKS_PATH = 'fx_racks.json';
interface FxNode { uri: string; name?: string; enabled: boolean; params: Record<string, number>; }
type FxRacks = Record<string, FxNode[]>; // channel id -> ordered insert chain

let fxRacks: FxRacks = {};
let fxRacksSaveTimer: ReturnType<typeof setTimeout> | null = null;

function loadFxRacks() {
  try {
    if (fs.existsSync(FX_RACKS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(FX_RACKS_PATH, 'utf8'));
      if (raw && typeof raw === 'object') fxRacks = raw;
      console.log(`Loaded FX racks for ${Object.keys(fxRacks).length} channels from disk.`);
    }
  } catch (e) {
    console.error('Error loading fx_racks.json, starting fresh', e);
  }
}

// Push one channel's mirrored insert chain to the engine as a load_rack
// (Clear + Add-per-plugin). Returns whether anything was sent.
function sendLoadRack(channel: number): boolean {
  const chain = fxRacks[String(channel)];
  if (!engineSocket || !Array.isArray(chain) || chain.length === 0) return false;
  engineSocket.write(JSON.stringify({
    type: 'load_rack', channel,
    plugins: chain.map((p) => ({ uri: p.uri, enabled: p.enabled, params: p.params })),
  }) + '\n');
  return true;
}

// Self-heal: the engine echoes its real insert-chain lengths on `fxN`. If that
// disagrees with our mirror for more than a few seconds (e.g. a load_rack got
// dropped), re-push that channel. Grace period avoids fighting the normal
// async apply right after an edit.
const fxDriftSince = new Map<number, number>();
function reconcileFxRacks(fxN: Record<string, number> | undefined): void {
  if (!engineSocket || !fxN || typeof fxN !== 'object') return;
  const now = Date.now();
  const channels = new Set<number>([
    ...Object.keys(fxRacks).map(Number),
    ...Object.keys(fxN).map(Number),
  ]);
  for (const ch of channels) {
    const want = fxRacks[String(ch)]?.length ?? 0;
    const have = Number(fxN[String(ch)] ?? 0);
    if (want === have) { fxDriftSince.delete(ch); continue; }
    const since = fxDriftSince.get(ch);
    if (since == null) { fxDriftSince.set(ch, now); continue; }
    if (now - since > 3000) {
      console.warn(`FX chain drift on ch ${ch}: engine ${have}, mirror ${want} — re-pushing`);
      if (want === 0) engineSocket.write(JSON.stringify({ type: 'load_rack', channel: ch, plugins: [] }) + '\n');
      else sendLoadRack(ch);
      fxDriftSince.set(ch, now + 5000); // extra cooldown before another attempt
    }
  }
}

function saveFxRacks() {
  if (fxRacksSaveTimer) clearTimeout(fxRacksSaveTimer);
  fxRacksSaveTimer = setTimeout(() => {
    try {
      writeFileAtomicSync(FX_RACKS_PATH, JSON.stringify(fxRacks, null, 2));
    } catch (e) {
      console.error('Error saving fx_racks.json', e);
    }
  }, 500);
}

function normalizeFxNode(p: any): FxNode {
  return {
    uri: String(p?.uri || ''),
    name: typeof p?.name === 'string' ? p.name : undefined,
    enabled: p?.enabled !== false,
    params: (p?.params && typeof p.params === 'object') ? p.params : {},
  };
}

// Apply one UI plugin message to the mirrored fxRacks[ch]. Mirrors the array
// maths in the UI store's plugin actions and the engine's PluginCmd handling.
// Only touches (or creates) fxRacks[ch] on a real mutation — no empty-array
// cruft for channels that never had an insert chain. Empty chains are pruned.
function applyFxRackMessage(data: any): boolean {
  if (typeof data.channel !== 'number') return false;
  const ch = String(data.channel);

  if (data.type === 'load_rack') {
    const next = Array.isArray(data.plugins) ? data.plugins.map(normalizeFxNode).filter((p: FxNode) => p.uri) : [];
    if (next.length === 0) delete fxRacks[ch]; else fxRacks[ch] = next;
    return true;
  }

  if (data.type === 'add_plugin') {
    const node = normalizeFxNode(data);
    if (!node.uri) return false;
    const chain = fxRacks[ch] || (fxRacks[ch] = []);
    const idx = Number.isInteger(data.index) && data.index >= 0 && data.index <= chain.length ? data.index : chain.length;
    chain.splice(idx, 0, node);
    return true;
  }

  const chain = fxRacks[ch];
  if (!chain) return false; // nothing to edit yet
  const i = data.pluginIndex;
  const inRange = Number.isInteger(i) && i >= 0 && i < chain.length;
  let changed = false;

  switch (data.type) {
    case 'remove_plugin':
      if (inRange) { chain.splice(i, 1); changed = true; }
      break;
    case 'reorder_plugin': {
      const { fromIndex: from, toIndex: to } = data;
      if (Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < chain.length && to >= 0 && to < chain.length) {
        const [m] = chain.splice(from, 1);
        chain.splice(to, 0, m);
        changed = true;
      }
      break;
    }
    case 'replace_plugin':
      if (inRange && typeof data.uri === 'string') {
        chain[i] = {
          uri: data.uri, name: typeof data.name === 'string' ? data.name : undefined,
          enabled: true, params: (data.params && typeof data.params === 'object') ? data.params : {},
        };
        changed = true;
      }
      break;
    case 'set_plugin_param':
      if (inRange && typeof data.paramId === 'string') {
        chain[i].params = { ...chain[i].params, [data.paramId]: data.value };
        changed = true;
      }
      break;
    case 'set_plugin_bypass':
      if (inRange) { chain[i].enabled = Number(data.value) < 0.5; changed = true; }
      break;
  }

  if (changed && chain.length === 0) delete fxRacks[ch];
  return changed;
}

function loadMixerState() {
  try {
    if (fs.existsSync(MIXER_STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(MIXER_STATE_PATH, 'utf8'));
      if (raw && typeof raw === 'object') mixerState = raw;
      console.log(`Loaded mixer state for ${Object.keys(mixerState).length} channels from disk.`);
    }
  } catch (e) {
    console.error('Error loading mixer_state.json, starting fresh', e);
  }
}

function saveMixerState() {
  if (mixerStateSaveTimer) clearTimeout(mixerStateSaveTimer);
  mixerStateSaveTimer = setTimeout(() => {
    try {
      writeFileAtomicSync(MIXER_STATE_PATH, JSON.stringify(mixerState, null, 2));
    } catch (e) {
      console.error('Error saving mixer_state.json', e);
    }
  }, 500);
}

// Build IPC command lines to replay the full persisted mixer state to the
// engine (faders, pans, mutes, solos, aux sends). Called on every engine
// (re)connect so the live audio matches what was last saved.
function buildEngineRestoreCommands(): string[] {
  const lines: string[] = [];
  for (const [chId, ch] of Object.entries(mixerState)) {
    const channel = Number(chId);
    if (!Number.isFinite(channel)) continue;
    if (typeof ch.fader === 'number') {
      // Replicate positionToAmplitude from the UI store.
      const y = ch.fader;
      let db: number;
      if (y >= 0.75)      db = 0    + ((y - 0.75) / 0.25) * 10;
      else if (y >= 0.50) db = -10  + ((y - 0.50) / 0.25) * 10;
      else if (y >= 0.30) db = -20  + ((y - 0.30) / 0.20) * 10;
      else if (y >= 0.15) db = -40  + ((y - 0.15) / 0.15) * 20;
      else if (y > 0)     db = -100 + (y  / 0.15)  * 60;
      else                db = -Infinity;
      const gain = db === -Infinity ? 0 : Math.pow(10, db / 20);
      lines.push(JSON.stringify({ type: 'set_fader', channel, value: gain / 2.0 }));
    }
    if (typeof ch.pan === 'number')
      lines.push(JSON.stringify({ type: 'set_pan', channel, value: ch.pan }));
    if (typeof ch.mute === 'boolean')
      lines.push(JSON.stringify({ type: 'set_mute', channel, value: ch.mute ? 1 : 0 }));
    if (typeof ch.solo === 'boolean')
      lines.push(JSON.stringify({ type: 'set_solo', channel, value: ch.solo ? 1 : 0 }));
    if (typeof ch.phase === 'boolean')
      lines.push(JSON.stringify({ type: 'set_phase', channel, value: ch.phase ? 1 : 0 }));
    if (ch.auxSends)
      for (const [busId, level] of Object.entries(ch.auxSends))
        lines.push(JSON.stringify({ type: 'set_aux_send', channel, busId: Number(busId), value: level }));
  }
  if (typeof (mixerState as any).aflPflMode === 'number') {
    lines.push(JSON.stringify({ type: 'set_afl_pfl_mode', channel: 0, busId: 0, value: (mixerState as any).aflPflMode }));
  }
  return lines;
}

loadMixerState();
loadFxRacks();

// Fixed console topology (mirrors engine/src/main.cpp's constants exactly —
// this is not runtime-configurable, since the engine only registers JACK
// ports once at startup): 32 source-only inputs, a Master output, 8 Aux
// output buses, one dedicated operator Monitor bus, and a dedicated
// push-to-talk Talkback mic input.
const NUM_CHANNELS = 32;
const NUM_AUX = 8;
const MASTER_ID = 100;
const AUX_BASE = 101; // 101..108
const MONITOR_ID = 109;
const TALKBACK_ID = 110;

function isValidTalkbackDest(busId: any): boolean {
  return busId === MASTER_ID || (Number.isInteger(busId) && busId >= AUX_BASE && busId < AUX_BASE + NUM_AUX);
}

// Packs a set of destination bus ids into the bitmask the engine's
// TalkbackState::dest_bus_mask expects: bit 0 = Master (100), bit i
// (1..NUM_AUX) = Aux (100+i). Invalid ids are dropped rather than rejecting
// the whole set.
function talkbackDestMask(destBusIds: number[]): number {
  let mask = 0;
  for (const id of destBusIds) {
    if (id === MASTER_ID) mask |= 1;
    else if (isValidTalkbackDest(id)) mask |= (1 << (id - AUX_BASE + 1));
  }
  return mask;
}

interface TalkbackConfig {
  sourcePorts: string[];
  // Master and/or any of the 8 Aux buses — talkback can fan out to several
  // at once. Never Monitor.
  destBusIds: number[];
  // Set when sourcePorts came from picking a device in the mic dropdown
  // rather than typing ports by hand. micAlsaPortName, when present, is an
  // ALSA port id (e.g. an external mic-jack input) that needs to be made
  // ALSA's active port on micSourceName — the PipeWire graph ports are the
  // same regardless of which physical jack is selected, so without this the
  // capture would keep coming from whatever ALSA already had active.
  micSourceName: string | null;
  micAlsaPortName: string | null;
}

function getTalkbackConfig(): TalkbackConfig {
  let sourcePorts: string[] = [];
  let destBusIds = [MASTER_ID];
  let micSourceName: string | null = null;
  let micAlsaPortName: string | null = null;
  try {
    if (fs.existsSync(TALKBACK_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TALKBACK_CONFIG_PATH, 'utf8'));
      if (Array.isArray(raw.sourcePorts) && raw.sourcePorts.every((p: any) => typeof p === 'string')) {
        sourcePorts = raw.sourcePorts;
      }
      if (Array.isArray(raw.destBusIds)) {
        // Current (multi-destination) shape.
        const filtered = raw.destBusIds.filter((id: any) => isValidTalkbackDest(id));
        if (filtered.length > 0) destBusIds = filtered;
      } else if (isValidTalkbackDest(raw.destBusId)) {
        // Config written before multi-destination talkback existed.
        destBusIds = [raw.destBusId];
      }
      if (typeof raw.micSourceName === 'string') micSourceName = raw.micSourceName;
      if (typeof raw.micAlsaPortName === 'string') micAlsaPortName = raw.micAlsaPortName;
    }
  } catch (e) {
    console.error('Error reading talkback config, using defaults', e);
  }
  return { sourcePorts, destBusIds, micSourceName, micAlsaPortName };
}

// --- Virtual soundcheck (plan/daw-timeline-roadmap.md Phase 3a) ------------
// Unattended multitrack capture of a live show: auto-start on first play,
// split the take at each marker, guard the disk, and optionally start on a
// daily schedule. Config is a small JSON file next to the others.
const VSC_CONFIG_PATH = 'vsc_config.json';

interface VscConfig {
  autoRecord: boolean;        // open a take automatically on the first transport_play
  splitOnMarker: boolean;     // a marker drop while recording splits into a new take
  minFreeGb: number;          // warn below this much free space in RECORDS_DIR
  schedule: { enabled: boolean; at: string /* "HH:MM", local time */ };
}

const VSC_DEFAULTS: VscConfig = {
  autoRecord: false, splitOnMarker: true, minFreeGb: 5,
  schedule: { enabled: false, at: '19:00' },
};

function getVscConfig(): VscConfig {
  try {
    if (fs.existsSync(VSC_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(VSC_CONFIG_PATH, 'utf8'));
      return {
        autoRecord: typeof raw.autoRecord === 'boolean' ? raw.autoRecord : VSC_DEFAULTS.autoRecord,
        splitOnMarker: typeof raw.splitOnMarker === 'boolean' ? raw.splitOnMarker : VSC_DEFAULTS.splitOnMarker,
        minFreeGb: Number.isFinite(raw.minFreeGb) && raw.minFreeGb >= 0 ? Number(raw.minFreeGb) : VSC_DEFAULTS.minFreeGb,
        schedule: {
          enabled: typeof raw?.schedule?.enabled === 'boolean' ? raw.schedule.enabled : VSC_DEFAULTS.schedule.enabled,
          at: /^\d{1,2}:\d{2}$/.test(raw?.schedule?.at || '') ? raw.schedule.at : VSC_DEFAULTS.schedule.at,
        },
      };
    }
  } catch (e) {
    console.error('Error reading vsc_config.json, using defaults', e);
  }
  return { ...VSC_DEFAULTS, schedule: { ...VSC_DEFAULTS.schedule } };
}

function writeVscConfig(patch: Partial<VscConfig>): VscConfig {
  const cur = getVscConfig();
  const next: VscConfig = { ...cur, schedule: { ...cur.schedule } };
  if (typeof patch.autoRecord === 'boolean') next.autoRecord = patch.autoRecord;
  if (typeof patch.splitOnMarker === 'boolean') next.splitOnMarker = patch.splitOnMarker;
  if (Number.isFinite(patch.minFreeGb) && (patch.minFreeGb as number) >= 0) next.minFreeGb = Number(patch.minFreeGb);
  if (patch.schedule && typeof patch.schedule === 'object') {
    if (typeof patch.schedule.enabled === 'boolean') next.schedule.enabled = patch.schedule.enabled;
    if (/^\d{1,2}:\d{2}$/.test(patch.schedule.at || '')) next.schedule.at = patch.schedule.at;
  }
  try {
    writeFileAtomicSync(VSC_CONFIG_PATH, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('Error writing vsc_config.json', e);
  }
  return next;
}

// Input channel ids the operator has record-armed (persisted in mixerState).
function armedChannels(): number[] {
  const out: number[] = [];
  for (let ch = 1; ch <= NUM_CHANNELS; ch++) {
    if (mixerState[String(ch)]?.arm) out.push(ch);
  }
  return out;
}

// The armed set of the take currently open (for split — a split reopens with
// the same channels).
let lastArmed: number[] = [];

// Set by vsc_split: the channels to immediately re-arm once the engine confirms
// the current take has closed (handleTakeFinished consumes it).
let pendingSplitArmed: number[] | null = null;

// Loop-record pass tracking (plan Phase 5 tail): each loop wrap closes one pass
// and opens the next; the committed takes are tagged loopPass + passIndex so the
// UI stacks every pass on its own take lane (never the comp lane).
let loopRecordActive = false;
let loopRecordPass = 0;
let pendingLoopPassIndex: number | null = null;
function resetLoopRecord(): void { loopRecordActive = false; loopRecordPass = 0; pendingLoopPassIndex = null; }

// Open a multitrack take: make the take dir, remember it, tell the engine.
// Shared by the manual start_multitrack_record path, auto-record, split and
// the scheduler. Returns an error string, or null on success.
function startTake(armed: number[], countinFrames = 0, isSplitReopen = false): string | null {
  const valid = armed.filter((n) => Number.isInteger(n) && n >= 1 && n <= NUM_CHANNELS);
  if (valid.length === 0) return 'no armed tracks';
  if (!engineSocket) return 'engine not connected';
  if (activeTakeDir) return 'already recording';
  if (!isSplitReopen) resetLoopRecord();   // a fresh session, not a loop-wrap reopen
  ensureProject(activeProjectName);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  activeTakeDir = path.join(projectDir(activeProjectName), 'takes', ts);
  fs.mkdirSync(activeTakeDir, { recursive: true });
  lastArmed = valid;
  engineSocket.write(JSON.stringify({
    type: 'start_multitrack_record', dir: path.resolve(activeTakeDir), armed: valid,
    countinFrames: countinFrames > 0 ? Math.round(countinFrames) : 0,
  }) + '\n');
  startDiskGuard();
  return null;
}

function stopTake(): void {
  if (engineSocket && activeTakeDir) {
    engineSocket.write(JSON.stringify({ type: 'stop_multitrack_record' }) + '\n');
  }
}

// --- disk-space guard: poll RECORDS_DIR free space while a take is open ---
let diskGuardTimer: ReturnType<typeof setInterval> | null = null;
let diskWasLow = false;

function diskFreeGb(): number {
  try {
    const s = fs.statfsSync(RECORDS_DIR);
    return (Number(s.bsize) * Number(s.bavail)) / 1e9;
  } catch {
    return Infinity;
  }
}

function startDiskGuard(): void {
  if (diskGuardTimer) return;
  diskWasLow = false;
  const check = () => {
    if (!activeTakeDir) { stopDiskGuard(); return; }
    const freeGb = Math.round(diskFreeGb() * 10) / 10;
    const min = getVscConfig().minFreeGb;
    if (freeGb < 1) {
      stopTake();
      broadcastToClients(JSON.stringify({ type: 'vsc_status', diskLow: true, autoStopped: true, freeGb }));
      diskWasLow = true;
    } else if (freeGb < min) {
      broadcastToClients(JSON.stringify({ type: 'vsc_status', diskLow: true, freeGb }));
      diskWasLow = true;
    } else if (diskWasLow) {
      broadcastToClients(JSON.stringify({ type: 'vsc_status', diskLow: false, freeGb }));
      diskWasLow = false;
    }
  };
  diskGuardTimer = setInterval(check, 10_000);
  check();
}

function stopDiskGuard(): void {
  if (diskGuardTimer) { clearInterval(diskGuardTimer); diskGuardTimer = null; }
  if (diskWasLow) {
    broadcastToClients(JSON.stringify({ type: 'vsc_status', diskLow: false }));
    diskWasLow = false;
  }
}

// --- scheduled start: one daily HH:MM timer -------------------------------
let vscScheduleTimer: ReturnType<typeof setTimeout> | null = null;

function rearmVscSchedule(): void {
  if (vscScheduleTimer) { clearTimeout(vscScheduleTimer); vscScheduleTimer = null; }
  const cfg = getVscConfig();
  if (!cfg.schedule.enabled) return;
  const [h, m] = cfg.schedule.at.split(':').map(Number);
  const now = new Date();
  const fire = new Date(now);
  fire.setHours(h, m, 0, 0);
  if (fire.getTime() <= now.getTime()) fire.setDate(fire.getDate() + 1);
  const delay = fire.getTime() - now.getTime();
  vscScheduleTimer = setTimeout(() => {
    vscScheduleTimer = null;
    const armed = armedChannels();
    if (engineSocket && armed.length > 0 && !activeTakeDir) {
      const err = startTake(armed);
      if (!err) {
        engineSocket.write(JSON.stringify({ type: 'transport_play' }) + '\n');
        broadcastToClients(JSON.stringify({ type: 'vsc_status', scheduledStarted: true, armed }));
      } else {
        broadcastToClients(JSON.stringify({ type: 'vsc_status', scheduleError: err }));
      }
    } else {
      broadcastToClients(JSON.stringify({ type: 'vsc_status', scheduleError: 'no armed tracks or engine offline' }));
    }
    rearmVscSchedule(); // next day
  }, delay);
}

rearmVscSchedule();

// --- Loudness logging & compliance (plan/daw-timeline-roadmap.md Phase 3c) --
// The engine already computes BS.1770 M/S/I + true-peak on the Master and ships
// it on every metering frame (`lufs` key). Persist it: a ~1 Hz CSV in logs/, an
// in-memory ring for the UI history strip, and an on-demand compliance report
// for a marked region.
const LOUDNESS_CONFIG_PATH = 'loudness_config.json';
const LOUDNESS_TARGETS = [-14, -23, -24];

interface LoudnessConfig {
  target: number;           // LUFS target for the history strip + report
  logWhileStopped: boolean; // append rows even when the transport is parked
}
const LOUDNESS_DEFAULTS: LoudnessConfig = { target: -14, logWhileStopped: false };

function getLoudnessConfig(): LoudnessConfig {
  try {
    if (fs.existsSync(LOUDNESS_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LOUDNESS_CONFIG_PATH, 'utf8'));
      return {
        target: LOUDNESS_TARGETS.includes(Number(raw.target)) ? Number(raw.target) : LOUDNESS_DEFAULTS.target,
        logWhileStopped: typeof raw.logWhileStopped === 'boolean' ? raw.logWhileStopped : LOUDNESS_DEFAULTS.logWhileStopped,
      };
    }
  } catch (e) {
    console.error('Error reading loudness_config.json, using defaults', e);
  }
  return { ...LOUDNESS_DEFAULTS };
}

function writeLoudnessConfig(patch: Partial<LoudnessConfig>): LoudnessConfig {
  const next = getLoudnessConfig();
  if (LOUDNESS_TARGETS.includes(Number(patch.target))) next.target = Number(patch.target);
  if (typeof patch.logWhileStopped === 'boolean') next.logWhileStopped = patch.logWhileStopped;
  try {
    writeFileAtomicSync(LOUDNESS_CONFIG_PATH, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('Error writing loudness_config.json', e);
  }
  return next;
}

interface LoudnessSample { wall: number; frame: number; sec: number; m: number; s: number; i: number; tp: number; }
const loudnessRing: LoudnessSample[] = [];
const LOUDNESS_RING_CAP = 5400;   // ~90 min at 1 Hz
const LOUDNESS_LOG_INTERVAL_MS = 1000;
const LOUDNESS_CSV_HEADER = 'wallClock,projectFrame,sec,M,S,I,TP\n';
let lastLoudnessLogMs = 0;

function loudnessCsvPath(d = new Date()): string {
  return path.join(LOGS_DIR, `loudness-${d.toISOString().slice(0, 10)}.csv`);
}

// Called for every engine `metering` frame (from the IPC data handler). Cheap
// guard + 1 Hz throttle so this costs ~1 append/sec while the transport rolls.
function maybeLogLoudness(frame: any): void {
  const lufs = frame?.lufs;
  const tr = frame?.transport;
  if (!lufs || !tr) return;
  const rolling = tr.state === 1 || tr.state === 2;
  if (!rolling && !getLoudnessConfig().logWhileStopped) return;
  const now = Date.now();
  if (now - lastLoudnessLogMs < LOUDNESS_LOG_INTERVAL_MS) return;
  lastLoudnessLogMs = now;

  const sr = Number(tr.sr) || 48000;
  const f = Number(tr.frame) || 0;
  const sec = f / sr;
  const m = Number(lufs.m), s = Number(lufs.s), i = Number(lufs.i), tp = Number(lufs.tp);

  loudnessRing.push({ wall: now, frame: f, sec, m, s, i, tp });
  if (loudnessRing.length > LOUDNESS_RING_CAP) loudnessRing.splice(0, loudnessRing.length - LOUDNESS_RING_CAP);

  const p = loudnessCsvPath(new Date(now));
  const row = `${new Date(now).toISOString()},${f},${sec.toFixed(3)},${m.toFixed(1)},${s.toFixed(1)},${i.toFixed(1)},${tp.toFixed(1)}\n`;
  try {
    if (!fs.existsSync(p)) fs.writeFileSync(p, LOUDNESS_CSV_HEADER);
    fs.appendFile(p, row, () => { /* best-effort */ });
  } catch (e) {
    console.error('loudness log write failed', e);
  }
}

function fmtTc(sec: number): string {
  const x = Math.max(0, sec);
  const hh = String(Math.floor(x / 3600)).padStart(2, '0');
  const mm = String(Math.floor((x % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(x % 60)).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// Compliance report for [startSec, endSec], scanned from the day's CSV logs.
// Metrics come from the 1 Hz samples, not a sample-accurate re-measure.
function buildLoudnessReport(startSec: number, endSec: number, name: unknown, target: number): { csv: string; summary: any } {
  const lo = Math.min(startSec, endSec), hi = Math.max(startSec, endSec);
  const rows: LoudnessSample[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(LOGS_DIR).filter((f) => /^loudness-\d{4}-\d{2}-\d{2}\.csv$/.test(f));
  } catch { /* ignore */ }
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(LOGS_DIR, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('wallClock') || line.startsWith('#')) continue;
      const [wall, frame, sec, m, s, i, tp] = line.split(',');
      const secN = Number(sec);
      if (!Number.isFinite(secN) || secN < lo || secN > hi) continue;
      rows.push({
        wall: Date.parse(wall) || 0, frame: Number(frame) || 0, sec: secN,
        m: Number(m), s: Number(s), i: Number(i), tp: Number(tp),
      });
    }
  }
  rows.sort((a, b) => a.sec - b.sec);

  const stVals = rows.map((r) => r.s).filter((v) => Number.isFinite(v) && v > -120);
  const iVals = rows.map((r) => r.i).filter((v) => Number.isFinite(v) && v > -120);
  const tpVals = rows.map((r) => r.tp).filter((v) => Number.isFinite(v) && v > -120);
  const integrated = iVals.length ? iVals[iVals.length - 1] : NaN;
  const shortTermMax = stVals.length ? Math.max(...stVals) : NaN;
  const shortTermMean = stVals.length ? stVals.reduce((a, b) => a + b, 0) / stVals.length : NaN;
  const truePeakMax = tpVals.length ? Math.max(...tpVals) : NaN;
  const pass = Number.isFinite(integrated) && Math.abs(integrated - target) <= 1
    && (!Number.isFinite(truePeakMax) || truePeakMax <= -1);

  const n1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');
  const head = [
    `# AES67-Deck loudness compliance report`,
    `# region: ${fmtTc(lo)} - ${fmtTc(hi)}  (${(hi - lo).toFixed(1)} s, ${rows.length} samples @ ~1 Hz)`,
    `# generated: ${new Date().toISOString()}`,
    `# target: ${target} LUFS   tolerance: +/-1 LU   true-peak ceiling: -1 dBTP`,
    `# integrated (LUFS): ${n1(integrated)}`,
    `# short-term max / mean (LUFS): ${n1(shortTermMax)} / ${n1(shortTermMean)}`,
    `# true-peak max (dBTP): ${n1(truePeakMax)}`,
    `# result: ${pass ? 'PASS' : 'FAIL'}`,
    `# note: metrics derived from 1 Hz M/S/I/TP samples, not a sample-accurate re-measure.`,
    `#       the sec-range filter can mix rows if multiple sessions share a timeline range on the same day.`,
    LOUDNESS_CSV_HEADER.trim(),
  ].join('\n');
  const body = rows.map((r) =>
    `${new Date(r.wall).toISOString()},${r.frame},${r.sec.toFixed(3)},${r.m.toFixed(1)},${r.s.toFixed(1)},${r.i.toFixed(1)},${r.tp.toFixed(1)}`,
  ).join('\n');
  const csv = `${head}\n${body}\n`;

  const safe = String(name || 'region').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 48) || 'region';
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const outName = `report-${safe}-${ts}.csv`;
  try { fs.writeFileSync(path.join(LOGS_DIR, outName), csv); } catch (e) { console.error('report write failed', e); }

  return {
    csv,
    summary: { region: [lo, hi], samples: rows.length, target, integrated, shortTermMax, shortTermMean, truePeakMax, pass, file: outName },
  };
}

// --- Phase 3e: server-timed auto-punch + loop-record split --------------
// The engine echoes the punch/loop region on every metering `transport` frame
// (`punchOn/In/Out`, `loopOn/In/Out`). The server does the drop-in / drop-out
// and the per-pass split here: opening take files has to be off the audio
// thread, and metering-rate timing (~±25 ms) is fine for broadcast with
// pre-roll. Reuses startTake / stopTake / the VSC split machinery.
let lastPunchFrame = 0;
let punchDoneThisRoll = false;

function maybePunch(t: any): void {
  if (!t || typeof t.frame !== 'number') return;
  if (bounce.active) return;   // a server-driven bounce roll must not auto-punch
  const frame = t.frame as number;
  const prev = lastPunchFrame;
  lastPunchFrame = frame;
  const rolling = t.state === 1 || t.state === 2;
  if (!rolling) { punchDoneThisRoll = false; return; }

  const punchIn = Number(t.punchIn) || 0;
  const punchOut = Number(t.punchOut) || 0;
  const sr = Number(t.sr) || 48000;

  // Rewound to before the region ⇒ re-arm the drop-in for this pass.
  if (frame < punchIn) punchDoneThisRoll = false;

  // Loop-record: the frame wrapped backwards while a take is still open
  // (recording the whole loop region, no punch) ⇒ close + reopen contiguously,
  // one take per pass. handleTakeFinished's reopenForSplit does the rest.
  if (activeTakeDir && !pendingSplitArmed && t.loopOn && Number(t.loopOut) > Number(t.loopIn)
      && frame < prev - sr * 0.05) {
    pendingSplitArmed = lastArmed.length ? lastArmed : armedChannels();
    loopRecordActive = true;
    pendingLoopPassIndex = loopRecordPass;      // the take closing now is this pass
    loopRecordPass += 1;
    stopTake();
    return;
  }

  if (!t.punchOn || punchOut <= punchIn) return;

  // Drop-in: inside the punch window, armed, nothing recording, not yet done.
  if (!activeTakeDir && !pendingSplitArmed && !punchDoneThisRoll
      && frame >= punchIn && frame < punchOut) {
    const armed = armedChannels();
    if (armed.length > 0) {
      const err = startTake(armed);
      if (!err) punchDoneThisRoll = true;
      broadcastToClients(JSON.stringify(err
        ? { type: 'vsc_status', autoRecordError: err }
        : { type: 'vsc_status', punchIn: true, armed }));
    }
  // Drop-out: crossed the out-point with a take open.
  } else if (activeTakeDir && !pendingSplitArmed && frame >= punchOut) {
    stopTake();
    broadcastToClients(JSON.stringify({ type: 'vsc_status', punchOut: true }));
  }
}

// --- Phase 4: realtime master bounce -----------------------------------
// Server picks the file path + times the run; the engine opens/closes the
// writer (bounce_start / bounce_abort) and echoes bounceState on the metering
// frame. Same server-timed pattern as auto-punch.
const bounce: { active: boolean; path: string; name: string; inSec: number; outSec: number; bits: number; prerollFrames: number } =
  { active: false, path: '', name: '', inSec: 0, outSec: 0, bits: 24, prerollFrames: 0 };

// Phase 5 — last metronome config the UI set; replayed to the engine on reconnect.
let lastMetronome: { enabled: boolean; bpm: number; sigNum: number; sigDen: number; dest: string } | null = null;

// Last loop / punch region the engine was told about (frames). The engine drops
// these on restart and the server's reconnect replay doesn't otherwise cover
// them; the server is the authority so clients don't have to re-assert every
// metering frame (which made two clients with different local intent fight).
let lastLoop: { start: number; end: number; enabled: boolean } = { start: 0, end: 0, enabled: false };
let lastPunch: { start: number; end: number; enabled: boolean } = { start: 0, end: 0, enabled: false };
function replayRegionToEngine(): void {
  if (!engineSocket) return;
  engineSocket.write(JSON.stringify({ type: 'transport_set_loop', ...lastLoop }) + '\n');
  engineSocket.write(JSON.stringify({ type: 'transport_set_punch', ...lastPunch }) + '\n');
}
// Seed lastLoop/lastPunch (frames) from a project's persisted `loop` slot
// ({start,end} in seconds, plus loop/punch booleans) so a cold start restores
// a saved region even before any UI connects.
function syncLastRegionFromProject(name: string): void {
  const lp = loadProject(name).loop as
    { start?: number; end?: number; loop?: boolean; punch?: boolean } | undefined;
  const sr = 48000;
  const s = lp && typeof lp.start === 'number' ? Math.round(lp.start * sr) : 0;
  const e = lp && typeof lp.end === 'number' ? Math.round(lp.end * sr) : 0;
  const valid = e > s;
  lastLoop = { start: s, end: e, enabled: valid && !!(lp && lp.loop) };
  lastPunch = { start: s, end: e, enabled: valid && !!(lp && lp.punch) };
}
syncLastRegionFromProject(activeProjectName);   // seed from the active project at startup

// --- Timecode & sync (plan/daw-timeline-roadmap.md Phase 3d) ----------------
// Persisted like loudness_config.json / vsc_config.json; the four engine
// commands it drives are replayed on engine reconnect (same as the metronome).
const TIMECODE_CONFIG_PATH = 'timecode_config.json';

function getTimecodeConfig(): TimecodeConfig {
  try {
    if (fs.existsSync(TIMECODE_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TIMECODE_CONFIG_PATH, 'utf8'));
      const fps: TcFps = [24, 25, 30].includes(Number(raw.fps)) ? (Number(raw.fps) as TcFps) : TIMECODE_DEFAULTS.fps;
      return {
        source: raw.source === 'tod' ? 'tod' : 'project',
        fps,
        df: fps === 30 && raw.df === true,
        offsetFrames: Number.isFinite(Number(raw.offsetFrames)) ? Math.round(Number(raw.offsetFrames)) : 0,
        ltcGen: raw.ltcGen === true,
        ltcLevel: Number.isFinite(Number(raw.ltcLevel)) ? Math.min(1, Math.max(0, Number(raw.ltcLevel))) : TIMECODE_DEFAULTS.ltcLevel,
        mtcGen: raw.mtcGen === true,
        ltcChase: raw.ltcChase === true,
      };
    }
  } catch (e) {
    console.error('Error reading timecode_config.json, using defaults', e);
  }
  return { ...TIMECODE_DEFAULTS };
}

function writeTimecodeConfig(patch: Partial<TimecodeConfig>): TimecodeConfig {
  // Ignore keys the caller left undefined so a partial message can't wipe a field.
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next = { ...getTimecodeConfig(), ...clean } as TimecodeConfig;
  if (next.source !== 'tod') next.source = 'project';
  if (![24, 25, 30].includes(Number(next.fps))) next.fps = TIMECODE_DEFAULTS.fps;
  next.ltcGen = next.ltcGen === true;
  next.mtcGen = next.mtcGen === true;
  next.ltcChase = next.ltcChase === true;
  next.df = next.fps === 30 && next.df === true;
  next.offsetFrames = Number.isFinite(Number(next.offsetFrames)) ? Math.round(Number(next.offsetFrames)) : 0;
  next.ltcLevel = Number.isFinite(Number(next.ltcLevel)) ? Math.min(1, Math.max(0, Number(next.ltcLevel))) : TIMECODE_DEFAULTS.ltcLevel;
  try {
    writeFileAtomicSync(TIMECODE_CONFIG_PATH, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('Error writing timecode_config.json', e);
  }
  return next;
}

// The engine IPC lines that carry one TimecodeConfig.
function timecodeEngineCommands(c: TimecodeConfig): string[] {
  return [
    JSON.stringify({ type: 'transport_set_timecode', source: c.source, fps: c.fps, df: c.df, offsetFrames: c.offsetFrames }),
    JSON.stringify({ type: 'ltc_gen', enabled: c.ltcGen, level: c.ltcLevel }),
    JSON.stringify({ type: 'mtc_gen', enabled: c.mtcGen }),
    JSON.stringify({ type: 'ltc_chase', enabled: c.ltcChase }),
  ];
}

function pushTimecodeToEngine(c: TimecodeConfig): void {
  if (!engineSocket) return;
  for (const line of timecodeEngineCommands(c)) engineSocket.write(line + '\n');
}

// Latest engine `tc` telemetry, for take stamping (seconds past midnight UTC).
let lastTodSec: number | null = null;
let lastSampleRate = 48000;

// --- Phase 5: automation runner + write-capture --------------------------
// The UI sends the full lane set + mode on every edit (set_automation_state).
// While rolling in READ, `maybeRunAutomation` interpolates each enabled lane on
// the metering clock and emits set_fader / set_pan / set_plugin_param (also
// broadcast so UI faders move). In WRITE, incoming armed-lane param moves are
// appended as points; on stop the touched lanes are thinned + broadcast back.
let activeAutomation: AutoLane[] = [];
let automationMode: 'off' | 'read' | 'write' = 'off';
const autoLastEmit = new Map<string, number>();      // laneId -> last value sent
const autoWriteTouched = new Set<string>();          // laneIds captured this roll
let autoLastFrame = 0;

// The UI store's fader position (0..1) -> linear amplitude (mirrors
// buildEngineRestoreCommands / the UI positionToAmplitude).
function faderPositionToAmplitude(y: number): number {
  let db: number;
  if (y >= 0.75)      db = 0    + ((y - 0.75) / 0.25) * 10;
  else if (y >= 0.50) db = -10  + ((y - 0.50) / 0.25) * 10;
  else if (y >= 0.30) db = -20  + ((y - 0.30) / 0.20) * 10;
  else if (y >= 0.15) db = -40  + ((y - 0.15) / 0.15) * 20;
  else if (y > 0)     db = -100 + (y  / 0.15)  * 60;
  else                return 0;
  return Math.pow(10, db / 20);
}

function autoValueAt(lane: AutoLane, sec: number): number | null {
  const p = lane.points;
  if (p.length === 0) return null;
  if (sec <= p[0].t) return p[0].v;
  if (sec >= p[p.length - 1].t) return p[p.length - 1].v;
  for (let i = 1; i < p.length; i++) {
    if (p[i].t >= sec) {
      const a = p[i - 1], b = p[i];
      return a.v + (b.v - a.v) * (sec - a.t) / Math.max(1e-9, b.t - a.t);
    }
  }
  return p[p.length - 1].v;
}

function emitAutoValue(lane: AutoLane, v: number): void {
  const t = lane.target;
  let msg: any;
  if (t.kind === 'fader') {
    msg = { type: 'set_fader', channel: t.channelId, value: faderPositionToAmplitude(v) / 2.0, faderPosition: v };
  } else if (t.kind === 'pan') {
    msg = { type: 'set_pan', channel: t.channelId, value: Math.max(-1, Math.min(1, v)) };
  } else if (t.kind === 'plugin' && typeof t.pluginIndex === 'number' && t.paramSymbol) {
    msg = { type: 'set_plugin_param', channel: t.channelId, pluginIndex: t.pluginIndex, paramId: t.paramSymbol, value: v };
  } else {
    return;
  }
  const line = JSON.stringify(msg);
  if (engineSocket) engineSocket.write(line + '\n');
  broadcastToClients(line);
}

function maybeRunAutomation(t: any): void {
  if (!t || typeof t.frame !== 'number') return;
  const rolling = t.state === 1 || t.state === 2;
  autoLastFrame = t.frame;
  if (!rolling || automationMode !== 'read') { autoLastEmit.clear(); return; }
  const sr = Number(t.sr) || lastSampleRate || 48000;
  const sec = t.frame / sr;
  for (const lane of activeAutomation) {
    if (!lane.enabled) continue;
    const v = autoValueAt(lane, sec);
    if (v == null) continue;
    const prev = autoLastEmit.get(lane.id);
    if (prev != null && Math.abs(prev - v) < (lane.max - lane.min) * 1e-4) continue;
    autoLastEmit.set(lane.id, v);
    emitAutoValue(lane, v);
  }
}

// Called from the mixer-intercept branch for set_fader / set_pan / set_plugin_param.
function maybeCaptureAutomation(data: any): void {
  if (automationMode !== 'write') return;
  const sec = autoLastFrame / (lastSampleRate || 48000);
  for (const lane of activeAutomation) {
    if (!lane.armed) continue;
    const tg = lane.target;
    let v: number | null = null;
    if (data.type === 'set_fader' && tg.kind === 'fader' && data.channel === tg.channelId) {
      v = typeof data.faderPosition === 'number' ? data.faderPosition : null;
    } else if (data.type === 'set_pan' && tg.kind === 'pan' && data.channel === tg.channelId) {
      v = Number(data.value);
    } else if (data.type === 'set_plugin_param' && tg.kind === 'plugin'
      && data.channel === tg.channelId && data.pluginIndex === tg.pluginIndex && data.paramId === tg.paramSymbol) {
      v = Number(data.value);
    }
    if (v == null || !Number.isFinite(v)) continue;
    // ~10 Hz decimation.
    const last = lane.points[lane.points.length - 1];
    if (last && Math.abs(last.t - sec) < 0.1) { last.v = v; }
    else { lane.points.push({ t: Math.max(0, sec), v }); lane.points.sort((a, b) => a.t - b.t); }
    autoWriteTouched.add(lane.id);
  }
}

// On transport stop: thin the captured lanes (drop near-collinear points) and
// push them back to the UI.
// --- Phase 5: multi-project playlist / playout --------------------------
interface PlaylistSegment { project: string; recProject?: boolean; gapSec?: number; }
interface Playlist { name: string; segments: PlaylistSegment[]; }

function playlistPath(name: string): string {
  return path.join(PLAYLISTS_DIR, sanitizeProjectName(name) + '.json');
}
function listPlaylists(): string[] {
  try {
    return fs.readdirSync(PLAYLISTS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch { return []; }
}
function loadPlaylist(name: string): Playlist {
  try {
    const raw = JSON.parse(fs.readFileSync(playlistPath(name), 'utf8'));
    const segments = Array.isArray(raw.segments) ? raw.segments
      .filter((s: any) => s && typeof s.project === 'string')
      .map((s: any) => ({ project: String(s.project), recProject: !!s.recProject, gapSec: Math.max(0, Number(s.gapSec) || 0) }))
      : [];
    return { name: sanitizeProjectName(name), segments };
  } catch { return { name: sanitizeProjectName(name), segments: [] }; }
}
function savePlaylist(pl: Playlist): void {
  writeFileAtomicSync(playlistPath(pl.name), JSON.stringify(pl, null, 2));
}

// End of the arrangement (seconds) = the latest clip end in the project/.rpp.
function projectEndSec(name: string, recProject: boolean): number {
  try {
    const proj = recProject
      ? rppToProject(parseRpp(fs.readFileSync(rppPath(name), 'utf8')), name)
      : loadProject(name);
    let end = 0;
    for (const c of proj.clips || []) {
      const e = (Number(c.start) || 0) + (Number(c.length) || 0);
      if (e > end) end = e;
    }
    return end;
  } catch { return 0; }
}

const playlistState: {
  active: Playlist | null; index: number; running: boolean;
  segEndFrame: number; gapUntil: number; armed: boolean;
} = { active: null, index: 0, running: false, segEndFrame: 0, gapUntil: 0, armed: false };

function broadcastPlaylistStatus(): void {
  broadcastToClients(JSON.stringify({
    type: 'playlist_status',
    name: playlistState.active?.name ?? null,
    index: playlistState.index,
    running: playlistState.running,
    count: playlistState.active?.segments.length ?? 0,
  }));
}

function loadSegmentAndPlay(seg: PlaylistSegment): void {
  const sr = lastSampleRate || 48000;
  const name = sanitizeProjectName(seg.project);
  if (seg.recProject) {
    try {
      const proj = rppToProject(parseRpp(fs.readFileSync(rppPath(name), 'utf8')), name);
      activeRecordingProject = name; activeProjectName = name;
      broadcastToClients(JSON.stringify({ type: 'project_data', name, project: proj }));
      pushTimelineToEngine(name, proj);
    } catch (e) { console.error('playlist: rec segment load failed', e); }
  } else {
    setActiveProject(name);
    activeRecordingProject = null;
    const proj = loadProject(name);
    broadcastToClients(JSON.stringify({ type: 'project_data', name, project: proj }));
    pushTimelineToEngine(name, proj);
  }
  playlistState.segEndFrame = Math.max(Math.round(sr * 0.5), Math.round(projectEndSec(name, !!seg.recProject) * sr));
  playlistState.armed = false;   // wait until the transport has actually reset near 0
  if (engineSocket) {
    engineSocket.write(JSON.stringify({ type: 'transport_locate', frame: 0 }) + '\n');
    engineSocket.write(JSON.stringify({ type: 'transport_play' }) + '\n');
  }
}

function startPlaylist(name: string, fromIndex: number): void {
  const pl = loadPlaylist(name);
  if (!pl.segments.length) return;
  playlistState.active = pl;
  playlistState.index = Math.max(0, Math.min(pl.segments.length - 1, fromIndex));
  playlistState.running = true;
  playlistState.gapUntil = 0;
  loadSegmentAndPlay(pl.segments[playlistState.index]);
  broadcastPlaylistStatus();
}

function stopPlaylist(): void {
  playlistState.running = false;
  playlistState.active = null;
  if (engineSocket) engineSocket.write(JSON.stringify({ type: 'transport_stop' }) + '\n');
  broadcastPlaylistStatus();
}

function maybeAdvancePlaylist(t: any): void {
  if (!playlistState.running || !playlistState.active || !t || typeof t.frame !== 'number') return;
  const now = Date.now();
  if (playlistState.gapUntil > now) return;
  const rolling = t.state === 1 || t.state === 2;
  if (playlistState.gapUntil && playlistState.gapUntil <= now) {
    // Gap elapsed → roll the segment we pre-loaded.
    playlistState.gapUntil = 0;
    loadSegmentAndPlay(playlistState.active.segments[playlistState.index]);
    broadcastPlaylistStatus();
    return;
  }
  if (!rolling) return;
  // Don't test the end until we've seen the transport reset for this segment
  // (the metering frame lags the locate we just sent by a block or two).
  if (!playlistState.armed) {
    if (t.frame < playlistState.segEndFrame * 0.5) playlistState.armed = true;
    return;
  }
  if (t.frame < playlistState.segEndFrame) return;

  // Segment finished.
  const next = playlistState.index + 1;
  if (next >= playlistState.active.segments.length) { stopPlaylist(); return; }
  playlistState.index = next;
  const seg = playlistState.active.segments[next];
  if (engineSocket) engineSocket.write(JSON.stringify({ type: 'transport_stop' }) + '\n');
  if (seg.gapSec && seg.gapSec > 0) {
    playlistState.gapUntil = now + seg.gapSec * 1000;
    broadcastPlaylistStatus();
  } else {
    loadSegmentAndPlay(seg);
    broadcastPlaylistStatus();
  }
}

function finishAutomationWrite(): void {
  if (!autoWriteTouched.size) return;
  for (const id of autoWriteTouched) {
    const lane = activeAutomation.find((l) => l.id === id);
    if (!lane || lane.points.length < 3) continue;
    const out: AutoPoint[] = [lane.points[0]];
    for (let i = 1; i < lane.points.length - 1; i++) {
      const a = out[out.length - 1], b = lane.points[i], c = lane.points[i + 1];
      const expected = a.v + (c.v - a.v) * (b.t - a.t) / Math.max(1e-9, c.t - a.t);
      if (Math.abs(b.v - expected) > (lane.max - lane.min) * 0.01) out.push(b);
    }
    out.push(lane.points[lane.points.length - 1]);
    lane.points = out;
    broadcastToClients(JSON.stringify({ type: 'auto_lane_updated', lane }));
  }
  autoWriteTouched.clear();
}

// Drop `frames` of audio off the head of a PCM WAV (the bounce preroll) and fix
// the RIFF / data chunk sizes. No-op if the layout isn't what we wrote.
function trimWavHead(file: string, frames: number): void {
  const cutFrames = Math.max(0, Math.round(frames));
  if (cutFrames === 0) return;
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return;
  let off = 12, channels = 2, bits = 24, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') { channels = buf.readUInt16LE(off + 10); bits = buf.readUInt16LE(off + 22); }
    else if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz & 1);
  }
  if (dataOff < 0) return;
  const blockAlign = channels * (bits >> 3);
  const cut = Math.min(dataLen, cutFrames * blockAlign);
  if (cut <= 0) return;
  const out = Buffer.concat([
    buf.subarray(0, dataOff),
    buf.subarray(dataOff + cut, dataOff + dataLen),
    buf.subarray(dataOff + dataLen),
  ]);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(dataLen - cut, dataOff - 4);
  writeFileAtomicSync(file, out);
}

function startBounce(inSec: number, outSec: number, name: string, bits: number): string | null {
  if (!engineSocket) return 'engine not connected';
  if (bounce.active) return 'a bounce is already running';
  if (activeTakeDir) return 'stop recording first';
  if (!(outSec > inSec)) return 'invalid region';
  const safe = String(name || 'bounce').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 48) || 'bounce';
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = `${safe}-${ts}.wav`;
  const b = bits === 16 || bits === 24 ? bits : 24;
  const sr = 48000;
  // Roll in from ~1.5 s before the in-point so the timeline reader primes
  // before the region; the preroll is trimmed off the file head on completion.
  const beginFrame = Math.round(inSec * sr);
  const locateFrame = Math.max(0, beginFrame - Math.round(1.5 * sr));
  Object.assign(bounce, { active: true, path: path.join(BOUNCES_DIR, file), name: file, inSec, outSec, bits: b, prerollFrames: beginFrame - locateFrame });
  // play before bounce_start: the engine's bounce_start blocks the IPC thread
  // waiting for the reader to prime, so the transport must already be rolling.
  engineSocket.write(JSON.stringify({ type: 'transport_locate', frame: locateFrame }) + '\n');
  engineSocket.write(JSON.stringify({ type: 'transport_play' }) + '\n');
  engineSocket.write(JSON.stringify({ type: 'bounce_start', path: path.resolve(bounce.path), bits: b, beginFrame, endFrame: Math.round(outSec * sr) }) + '\n');
  broadcastToClients(JSON.stringify({ type: 'bounce_status', state: 'running', name: file, inSec, outSec }));
  return null;
}

function cancelBounce(): void {
  if (!bounce.active) return;
  bounce.active = false;
  if (engineSocket) engineSocket.write(JSON.stringify({ type: 'bounce_abort' }) + '\n');
  try { if (fs.existsSync(bounce.path)) fs.rmSync(bounce.path); } catch { /* ignore */ }
  broadcastToClients(JSON.stringify({ type: 'bounce_status', state: 'cancelled', name: bounce.name }));
}

// Called on the metering frame: the engine flips bounceState to 2 when the
// clock reaches the out-point. Give the disk thread a beat to finalise, then
// report the file.
function maybeFinishBounce(t: any): void {
  if (!bounce.active || !t || t.bounceState !== 2) return;
  const b = { ...bounce };
  bounce.active = false;
  setTimeout(() => {
    try { trimWavHead(b.path, b.prerollFrames); } catch (e) { console.error('bounce: preroll trim failed', e); }
    let bytes = 0;
    try { bytes = fs.statSync(b.path).size; } catch { /* ignore */ }
    broadcastToClients(JSON.stringify({
      type: 'bounce_done',
      name: b.name,
      path: path.relative(RECORDS_DIR, b.path),
      bytes,
      durationSec: Math.round((b.outSec - b.inSec) * 100) / 100,
      overrun: !!t.bounceOverrun,
    }));
    broadcastToClients(JSON.stringify({ type: 'bounces_list', bounces: listBounces() }));
  }, 300);
}

function listBounces(): Array<{ name: string; bytes: number; mtime: number }> {
  try {
    return fs.readdirSync(BOUNCES_DIR)
      .filter((f) => f.toLowerCase().endsWith('.wav'))
      .map((f) => { const s = fs.statSync(path.join(BOUNCES_DIR, f)); return { name: f, bytes: s.size, mtime: s.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

// HTTP server on the same port as the WS: serves reference-video files for the
// timeline (plan Phase 5). Read-only, Range-aware, path-sanitised; everything
// else 404s. The WS upgrade rides the same server.
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)$/i;
function projectVideoDir(name: string): string {
  return path.join(projectDir(name), 'video');
}
const httpServer = http.createServer((req, res) => {
  const m = req.url && req.method === 'GET' && /^\/video\/([^/]+)\/([^/?#]+)/.exec(req.url);
  if (!m) { res.writeHead(404).end(); return; }
  const proj = sanitizeProjectName(decodeURIComponent(m[1]));
  const file = decodeURIComponent(m[2]).replace(/[^0-9A-Za-z._ -]/g, '');
  if (!VIDEO_EXT.test(file)) { res.writeHead(404).end(); return; }
  const full = path.join(projectVideoDir(proj), file);
  if (!full.startsWith(projectVideoDir(proj)) || !fs.existsSync(full)) { res.writeHead(404).end(); return; }
  const stat = fs.statSync(full);
  const type = file.match(/webm$/i) ? 'video/webm' : file.match(/(mkv)$/i) ? 'video/x-matroska' : 'video/mp4';
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? parseInt(range[1], 10) : 0;
    const end = range[2] ? parseInt(range[2], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end(); return; }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': type,
    });
    fs.createReadStream(full, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Content-Type': type });
    fs.createReadStream(full).pipe(res);
  }
});
httpServer.listen(WSS_PORT);

// Set up WebSocket server (shares the HTTP server)
const wss = new WebSocketServer({ server: httpServer });
console.log(`WebSocket + HTTP server listening on :${WSS_PORT}`);

let connectedWsClients: WebSocket[] = [];
wss.on('connection', (ws) => {
  console.log('UI Client connected to WebSocket');
  connectedWsClients.push(ws);

  try {
    // Effective mappings — the saved file if present, otherwise the seeded
    // default (channel 1 <- system audio) so the UI and the wired graph agree.
    ws.send(JSON.stringify({ type: 'patchbay_config_loaded', mappings: getPatchbayMappings() }));
  } catch (e) {
    console.error('Error sending patchbay config', e);
  }

  ws.send(JSON.stringify({ type: 'output_routing_loaded', outputs: getOutputRouting() }));
  ws.send(JSON.stringify({ type: 'talkback_config_loaded', ...getTalkbackConfig() }));
  ws.send(JSON.stringify({ type: 'vsc_config_loaded', config: getVscConfig() }));
  ws.send(JSON.stringify({ type: 'loudness_config_loaded', config: getLoudnessConfig() }));
  ws.send(JSON.stringify({ type: 'timecode_config_loaded', config: getTimecodeConfig() }));
  ws.send(JSON.stringify({ type: 'project_videos', name: activeProjectName, videos: listProjectVideos(activeProjectName) }));
  ws.send(JSON.stringify({ type: 'playlists_list', playlists: listPlaylists() }));
  ws.send(JSON.stringify({ type: 'bounces_list', bounces: listBounces() }));
  ws.send(JSON.stringify({ type: 'daemon_destinations_loaded', destinations: lastDaemonDestinations, daemonReachable }));
  ws.send(JSON.stringify(daemonStateMessage()));
  ws.send(JSON.stringify({ type: 'mic_devices_loaded', devices: lastMicDevices }));
  if (lastPluginCatalog.length > 0) {
    ws.send(JSON.stringify({ type: 'plugin_list_loaded', plugins: lastPluginCatalog }));
  }

  // Send current mixer state so this client starts in sync with all others.
  if (Object.keys(mixerState).length > 0) {
    ws.send(JSON.stringify({ type: 'mixer_state_loaded', state: mixerState }));
  }

  // Send the persisted FX insert chains so the rack UI restores on reload.
  if (Object.keys(fxRacks).length > 0) {
    ws.send(JSON.stringify({ type: 'fx_racks_loaded', racks: fxRacks }));
  }

  // DAW: the active project (arrangement) and the available projects. A
  // REAPER recording project takes precedence over the scratch session.
  ws.send(JSON.stringify({ type: 'scenes_list', scenes: listScenes() }));
  ws.send(JSON.stringify({ type: 'projects_list', projects: listProjects(), active: activeProjectName }));
  ws.send(JSON.stringify({ type: 'recording_projects_list', projects: listRecordingProjects(), active: activeRecordingProject }));
  if (activeRecordingProject && fs.existsSync(rppPath(activeRecordingProject))) {
    try {
      ws.send(JSON.stringify({
        type: 'project_data', name: activeRecordingProject,
        project: rppToProject(parseRpp(fs.readFileSync(rppPath(activeRecordingProject), 'utf8')), activeRecordingProject),
      }));
    } catch {
      ws.send(JSON.stringify({ type: 'project_data', name: activeProjectName, project: loadProject(activeProjectName) }));
    }
  } else {
    ws.send(JSON.stringify({ type: 'project_data', name: activeProjectName, project: loadProject(activeProjectName) }));
  }

  ws.on('close', () => {
    connectedWsClients = connectedWsClients.filter(client => client !== ws);
    console.log('UI Client disconnected');
  });

  // Forward UI commands to C++ Engine with basic validation
  ws.on('message', (message) => {
    try {
      const payloadStr = message.toString();
      const data = JSON.parse(payloadStr);
      // Only forward allowed types to prevent arbitrary data injection
      const allowedTypes = [
        'set_fader', 'set_pan', 'set_mute', 'set_solo', 'set_arm', 'set_phase', 'set_aux_send', 'start_record', 'stop_record',
        'set_plugin_param', 'set_plugin_bypass', 'set_talkback_active', 'set_afl_pfl_mode',
        // Which plugin editor the UI has open — drives the engine's
        // per-plugin in/out metering (the `fx` key on `metering`).
        'fx_focus',
        // Restart the Master integrated-loudness measurement.
        'lufs_reset',
        // Plugin-chain structure — engine applies these to the live
        // insert_chain (see engine/src/main.cpp's PluginCmd); the server
        // just forwards, same trust model as the params/bypass types above.
        'add_plugin', 'remove_plugin', 'reorder_plugin', 'replace_plugin', 'load_rack',
        // Transport control — engine owns the clock; plain forward + fan-out
        // to other clients (start/stop_multitrack_record are handled
        // explicitly below because the server injects the take directory).
        'transport_play', 'transport_stop', 'transport_locate', 'transport_set_loop',
        // Phase 3e punch region — engine stores + echoes it; server auto-punches.
        'transport_set_punch',
        // Virtual soundcheck: per-channel live/timeline monitor override mask
        // (engine reads it every block); plain forward + fan-out.
        'set_monitor_input_mask'
      ];

      // Virtual soundcheck auto-record: opening the transport for the first
      // time also opens a take, if armed. Non-terminating — transport_play
      // still falls through to the generic forward + fan-out below.
      if (data.type === 'transport_play' && getVscConfig().autoRecord && !activeTakeDir) {
        const armed = armedChannels();
        if (armed.length > 0) {
          const err = startTake(armed);
          broadcastToClients(JSON.stringify(
            err ? { type: 'vsc_status', autoRecordError: err }
                : { type: 'vsc_status', autoRecordStarted: true, armed }));
        }
      }
      if (data.type === 'save_scene') {
        const safeName = data.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        writeFileAtomicSync(path.join(SCENES_DIR, `${safeName}.json`), JSON.stringify(data.state, null, 2));
        broadcastToClients(JSON.stringify({ type: 'scenes_list', scenes: listScenes() }));
      } else if (data.type === 'list_scenes') {
        ws.send(JSON.stringify({ type: 'scenes_list', scenes: listScenes() }));
      } else if (data.type === 'delete_scene') {
        const safeName = String(data.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        const p = path.join(SCENES_DIR, `${safeName}.json`);
        if (safeName && fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch (e) { console.error('delete_scene failed', e); }
        }
        broadcastToClients(JSON.stringify({ type: 'scenes_list', scenes: listScenes() }));
      } else if (data.type === 'load_scene') {
        const safeName = data.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const p = path.join(SCENES_DIR, `${safeName}.json`);
        if (fs.existsSync(p)) {
          const state = JSON.parse(fs.readFileSync(p, 'utf8'));
          ws.send(JSON.stringify({ type: 'scene_data', state, name: data.name }));
        }
      } else if (data.type === 'save_rack_preset') {
        if (!Array.isArray(data.plugins)) {
          console.error('Rejected save_rack_preset: plugins is not an array');
        } else {
          const safeName = String(data.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
          // Only the fields a rack preset actually needs — never the
          // per-instance runtime `id` (a fresh UUID gets assigned wherever
          // this preset is loaded next).
          const plugins = data.plugins.map((p: any) => ({
            uri: p.uri,
            name: p.name,
            enabled: p.enabled !== false,
            params: (p.params && typeof p.params === 'object') ? p.params : {}
          }));
          writeFileAtomicSync(path.join(RACK_PRESETS_DIR, `${safeName}.json`), JSON.stringify(plugins, null, 2));
          const presets = fs.readdirSync(RACK_PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
          connectedWsClients.forEach(c => {
             if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'rack_presets_list', presets }));
          });
        }
      } else if (data.type === 'list_rack_presets') {
        const presets = fs.readdirSync(RACK_PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        ws.send(JSON.stringify({ type: 'rack_presets_list', presets }));
      } else if (data.type === 'delete_rack_preset') {
        const safeName = String(data.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        const p = path.join(RACK_PRESETS_DIR, `${safeName}.json`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        const presets = fs.readdirSync(RACK_PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        connectedWsClients.forEach(c => {
           if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'rack_presets_list', presets }));
        });
      } else if (data.type === 'load_rack_preset') {
        const safeName = String(data.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        const p = path.join(RACK_PRESETS_DIR, `${safeName}.json`);
        if (fs.existsSync(p)) {
          const plugins = JSON.parse(fs.readFileSync(p, 'utf8'));
          ws.send(JSON.stringify({ type: 'rack_preset_data', plugins, name: data.name }));
        }
      } else if (data.type === 'sync_patchbay_matrix') {
        const merged = mergePatchbayMappings(data.mappings);
        writeFileAtomicSync(PATCHBAY_CONFIG_PATH, JSON.stringify(merged));

        const mergedOutputs = mergeOutputRouting(data.outputs);
        writeFileAtomicSync(OUTPUT_ROUTING_PATH, JSON.stringify(mergedOutputs));

        // Sequenced, not concurrent: both touch AES67_Deck ports via
        // pw-link, and an output endpoint could in principle coincide with
        // one of the engine's own input ports, so run them one at a time
        // rather than racing two independent pw-link sweeps.
        (async () => {
          await handlePatchbaySync(merged);
          await applyOutputRouting(mergedOutputs);
          await applyMonitorRouting();
          await applyBroadcastRouting();
        })();
      } else if (data.type === 'sync_talkback_config') {
        const sourcePorts = Array.isArray(data.sourcePorts) ? data.sourcePorts.filter((p: any) => typeof p === 'string') : [];
        const filteredDestBusIds = Array.isArray(data.destBusIds) ? data.destBusIds.filter((id: any) => isValidTalkbackDest(id)) : [];
        const destBusIds = filteredDestBusIds.length > 0 ? filteredDestBusIds : getTalkbackConfig().destBusIds;
        const micSourceName = typeof data.micSourceName === 'string' ? data.micSourceName : null;
        const micAlsaPortName = typeof data.micAlsaPortName === 'string' ? data.micAlsaPortName : null;
        const cfg: TalkbackConfig = { sourcePorts, destBusIds, micSourceName, micAlsaPortName };
        writeFileAtomicSync(TALKBACK_CONFIG_PATH, JSON.stringify(cfg));

        (async () => {
          await applyTalkbackRouting(cfg);
          if (engineSocket) {
            engineSocket.write(JSON.stringify({ type: 'set_talkback_dest', channel: TALKBACK_ID, busId: talkbackDestMask(destBusIds) }) + '\n');
          }
        })();

        const loadedMsg = JSON.stringify({ type: 'talkback_config_loaded', ...cfg });
        connectedWsClients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) c.send(loadedMsg);
        });
      } else if (data.type === 'daemon_create_sink') {
        // Receive an AES67 stream: create a daemon Sink from a discovered
        // remote's SDP (or a pasted one), and hand it a contiguous block of
        // AES67_Source capture channels (0..31) sized to the stream's channel
        // count. reconcileRxSinks() re-asserts the block after a daemon
        // restart; the block is persisted in rx_sinks.json.
        runDaemonOp(async () => {
          const sinkId = lowestFreeDaemonId(lastDaemonState.sinks);
          if (sinkId < 0) { console.error('daemon_create_sink: no free sink id'); return; }
          const sdp = typeof data.sdp === 'string' ? data.sdp : '';
          const source = typeof data.source === 'string' ? data.source : '';
          const channels = Array.isArray(data.map) && data.map.length > 0
            ? data.map.length : sdpChannelCount(sdp);
          const assignments = getRxSinkAssignments();
          const base = allocateCaptureBlock(channels, assignments, lastDaemonState.sinks);
          if (base < 0) {
            console.error(`daemon_create_sink: no ${channels}-ch capture block free (0..${RX_CAPTURE_CHANNELS - 1})`);
            return;
          }
          const map = Array.from({ length: channels }, (_, i) => base + i);
          const name = String(data.name || `Deck Sink ${sinkId}`);
          // ignore_refclk_gmid defaults true: the daemon's SDP parser rejects
          // (400 "cannot parse SDP") any stream whose a=ts-refclk gmid doesn't
          // match the daemon's current PTP grandmaster — which is every stream
          // whenever we're not yet locked to the same GM. The existing
          // appliance sink is configured the same way.
          const body = {
            name,
            io: 'Audio Device',
            use_sdp: true,
            source,
            sdp,
            delay: typeof data.delay === 'number' ? data.delay : 384,
            ignore_refclk_gmid: data.ignore_refclk_gmid !== false,
            map
          };
          const res = await daemonRequest('PUT', `/api/sink/${sinkId}`, body);
          if (!res.ok) { console.error(`daemon_create_sink failed (${res.status})`, res.json); return; }
          assignments.push({ sinkId, streamName: name, address: sdpAddress(sdp), captureBase: base, channels });
          saveRxSinkAssignments(assignments);
          await refreshDaemonState();
        });
      } else if (data.type === 'daemon_delete_sink') {
        runDaemonOp(async () => {
          const id = Number(data.id);
          if (!Number.isInteger(id)) return;
          const res = await daemonRequest('DELETE', `/api/sink/${id}`);
          if (!res.ok) console.error(`daemon_delete_sink failed (${res.status})`, res.json);
          saveRxSinkAssignments(getRxSinkAssignments().filter((a) => a.sinkId !== id));
          await refreshDaemonState();
        });
      } else if (data.type === 'set_tx_source') {
        // Phase 2: enable/disable/rename one transmit group (Master / Monitor / Aux 1..8).
        // Persist the override then converge the daemon.
        runDaemonOp(async () => {
          const key = String(data.key || '');
          if (!TX_SOURCE_PLAN.some((g) => g.key === key)) {
            console.error(`set_tx_source: unknown group ${JSON.stringify(data.key)}`);
            return;
          }
          const prefs = getTxSourcePrefs();
          if (typeof data.enabled === 'boolean') prefs[key].enabled = data.enabled;
          if (typeof data.name === 'string' && data.name.trim()) prefs[key].name = data.name.trim();
          saveTxSourcePrefs(prefs);
          if (lastDaemonState.reachable) await reconcileTxSources(lastDaemonState.sources);
          await refreshDaemonState();
        });
      } else if (data.type === 'daemon_set_ptp') {
        runDaemonOp(async () => {
          const domain = Number(data.domain);
          const dscp = Number(data.dscp);
          if (!Number.isInteger(domain) || !Number.isInteger(dscp)) return;
          const res = await daemonRequest('POST', '/api/ptp/config', { domain, dscp });
          if (!res.ok) console.error(`daemon_set_ptp failed (${res.status})`, res.json);
          await refreshDaemonState();
        });
      } else if (data.type === 'list_projects') {
        ws.send(JSON.stringify({ type: 'projects_list', projects: listProjects(), active: activeProjectName }));
      } else if (data.type === 'load_project') {
        const name = sanitizeProjectName(data.name);
        setActiveProject(name);
        const project = loadProject(name);
        // Persist back so any orphan takes that were merged in stick.
        saveProjectDebounced(name, project);
        connectedWsClients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'project_data', name, project }));
          }
        });
        connectedWsClients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'projects_list', projects: listProjects(), active: activeProjectName }));
        });
        pushTimelineToEngine(name, project);
      } else if (data.type === 'new_project') {
        const name = sanitizeProjectName(data.name);
        ensureProject(name);
        setActiveProject(name);
        const project = emptyProject();
        writeFileAtomicSync(path.join(projectDir(name), 'project.json'), JSON.stringify(project, null, 2));
        connectedWsClients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'project_data', name, project }));
            c.send(JSON.stringify({ type: 'projects_list', projects: listProjects(), active: activeProjectName }));
          }
        });
        pushTimelineToEngine(name, project);
      } else if (data.type === 'clear_timeline') {
        // Reset the active project's timeline to a blank slate. Musical settings
        // (tempo / time sig / metro dest / …) survive; clips, markers,
        // automation, the loop/punch region and any video are dropped.
        // deleteTakes: also permanently remove the recorded take dirs — required
        // for the clear to actually stick, since loadProject() otherwise
        // re-merges orphan takes back in as clips.
        const name = activeProjectName;
        const deleteTakes = !!data.deleteTakes;
        if (activeTakeDir) {
          ws.send(JSON.stringify({ type: 'timeline_cleared', error: 'a take is recording' }));
        } else if (activeRecordingProject) {
          // A saved REAPER project's timeline lives in its .rpp, not
          // project.json, and its media is consolidated under records/ — a
          // blank-slate reset there is meaningless and its take-dir delete
          // would only hit the (already-consolidated) staging area. The UI
          // hides the button in this mode; refuse a scripted request too.
          ws.send(JSON.stringify({ type: 'timeline_cleared', error: 'close the recording project first' }));
        } else {
          const cleared: DawProject = {
            clips: [], markers: [], trackHeights: {},
            ...musicalFields(loadProject(name)),
            loop: undefined, video: null, automation: [],
          };
          writeFileAtomicSync(path.join(projectDir(name), 'project.json'), JSON.stringify(cleared, null, 2));

          let deleted = 0;
          if (deleteTakes) {
            const takesRoot = path.join(projectDir(name), 'takes');
            try {
              if (fs.existsSync(takesRoot)) {
                for (const d of fs.readdirSync(takesRoot)) {
                  fs.rmSync(path.join(takesRoot, d), { recursive: true, force: true });
                  deleted++;
                }
              }
            } catch (e) { console.error('clear_timeline: take delete failed', e); }
          }

          lastLoop = { start: 0, end: 0, enabled: false };
          lastPunch = { start: 0, end: 0, enabled: false };
          if (engineSocket) {
            engineSocket.write(JSON.stringify({ type: 'transport_stop' }) + '\n');
            engineSocket.write(JSON.stringify({ type: 'transport_locate', frame: 0 }) + '\n');
            replayRegionToEngine();
          }
          pushTimelineToEngine(name, cleared);
          connectedWsClients.forEach(c => {
            if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'project_data', name, project: cleared }));
          });
          console.log(`clear_timeline: ${name} reset${deleteTakes ? `, ${deleted} take dir(s) deleted` : ''}`);
          ws.send(JSON.stringify({ type: 'timeline_cleared', deletedTakes: deleted }));
        }
      } else if (data.type === 'list_recording_projects') {
        ws.send(JSON.stringify({ type: 'recording_projects_list', projects: listRecordingProjects(), active: activeRecordingProject }));
      } else if (data.type === 'save_recording_project') {
        const name = sanitizeProjectName(data.name);
        const p = data.project || {};
        const project: DawProject = {
          clips: Array.isArray(p.clips) ? p.clips : [],
          markers: Array.isArray(p.markers) ? p.markers : [],
          trackHeights: p.trackHeights && typeof p.trackHeights === 'object' ? p.trackHeights : {},
          ...musicalFields(p),
        };
        if (!name || name === 'default') {
          ws.send(JSON.stringify({ type: 'recording_project_error', reason: 'pick a project name' }));
        } else {
          try {
            const dir = recProjectDir(name);
            fs.mkdirSync(dir, { recursive: true });
            const sr = Number(project.clips.find((c: any) => c?.sampleRate)?.sampleRate) || 48000;
            // Consolidate: MOVE every referenced media file (and its .peaks.json)
            // into records/<name>/ with a flat, collision-free name.
            const remap = new Map<string, string>();
            const sourceTakeDirs = new Set<string>();
            for (const c of project.clips) {
              if (!c || !c.file) continue;
              const key = `${c.takeDir || ''}/${c.file}`;
              if (remap.has(key)) { c.file = remap.get(key)!; c.takeDir = name; continue; }
              const inRec = activeRecordingProject && (!c.takeDir || c.takeDir === activeRecordingProject);
              if (!inRec && c.takeDir) sourceTakeDirs.add(String(c.takeDir));
              const cur = inRec
                ? path.join(recProjectDir(activeRecordingProject as string), path.basename(c.file))
                : path.join(projectDir(activeProjectName), 'takes', String(c.takeDir || ''), path.basename(c.file));
              const destBase = inRec ? path.basename(c.file) : consolidatedName(String(c.takeDir || ''), c.file);
              const dest = path.join(dir, destBase);
              try {
                if (fs.existsSync(cur) && path.resolve(cur) !== path.resolve(dest)) {
                  fs.renameSync(cur, dest);
                  const pk = cur.replace(/\.(wav|wv)$/i, '') + '.peaks.json';
                  if (fs.existsSync(pk)) { try { fs.renameSync(pk, dest.replace(/\.(wav|wv)$/i, '') + '.peaks.json'); } catch { /* ignore */ } }
                }
              } catch (e) {
                console.error('save_recording_project: could not move', cur, e);
              }
              remap.set(key, destBase);
              c.file = destBase;
              c.takeDir = name;
            }
            // Drop the now-consolidated staging take dirs.
            for (const td of sourceTakeDirs) {
              try { fs.rmSync(path.join(projectDir(activeProjectName), 'takes', td), { recursive: true, force: true }); } catch { /* ignore */ }
            }
            writeFileAtomicSync(rppPath(name), buildRpp(
              timelineToRpp(project.clips, project.markers, project.trackHeights, sr, (c) => c.file, project),
            ));
            activeRecordingProject = name;
            activeProjectName = name;
            try { writeFileAtomicSync(ACTIVE_PROJECT_PATH, name); } catch { /* ignore */ }

            const loaded = rppToProject(parseRpp(fs.readFileSync(rppPath(name), 'utf8')), name);
            connectedWsClients.forEach((c) => {
              if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'project_data', name, project: loaded }));
            });
            broadcastRecordingProjects();
            pushTimelineToEngine(name, loaded);
            console.log(`Recording project saved: ${rppPath(name)} (${loaded.clips.length} clip(s))`);
          } catch (e) {
            console.error('save_recording_project failed', e);
            ws.send(JSON.stringify({ type: 'recording_project_error', reason: 'save failed' }));
          }
        }
      } else if (data.type === 'open_recording_project') {
        const name = sanitizeProjectName(data.name);
        if (!fs.existsSync(rppPath(name))) {
          ws.send(JSON.stringify({ type: 'recording_project_error', reason: 'not found' }));
        } else {
          try {
            const proj = rppToProject(parseRpp(fs.readFileSync(rppPath(name), 'utf8')), name);
            activeRecordingProject = name;
            activeProjectName = name;
            try { writeFileAtomicSync(ACTIVE_PROJECT_PATH, name); } catch { /* ignore */ }
            connectedWsClients.forEach((c) => {
              if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'project_data', name, project: proj }));
            });
            broadcastRecordingProjects();
            pushTimelineToEngine(name, proj);
            console.log(`Opened recording project: ${name} (${proj.clips.length} clip(s))`);
          } catch (e) {
            console.error('open_recording_project failed', e);
            ws.send(JSON.stringify({ type: 'recording_project_error', reason: 'open failed' }));
          }
        }
      } else if (data.type === 'save_project') {
        const name = sanitizeProjectName(data.name);
        const p = data.project || {};
        const project: DawProject = {
          clips: Array.isArray(p.clips) ? p.clips : [],
          markers: Array.isArray(p.markers) ? p.markers : [],
          trackHeights: p.trackHeights && typeof p.trackHeights === 'object' ? p.trackHeights : {},
          loop: p.loop && typeof p.loop === 'object' ? p.loop : undefined,
          ...musicalFields(p),
        };
        if (activeRecordingProject) {
          // A REAPER project is open: autosave rewrites its .rpp in place
          // (media already consolidated in records/<name>/).
          const sr = Number(project.clips.find((c: any) => c?.sampleRate)?.sampleRate) || 48000;
          writeRppDebounced(activeRecordingProject,
            timelineToRpp(project.clips, project.markers, project.trackHeights, sr, (c) => path.basename(String(c.file || '')), project));
          pushTimelineToEngine(activeRecordingProject, project);
        } else {
          saveProjectDebounced(name, project);
          if (name === activeProjectName) pushTimelineToEngine(name, project);
        }
        // Fan out so other connected clients converge on the same arrangement.
        connectedWsClients.forEach(c => {
          if (c !== ws && c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'project_data', name: activeRecordingProject || name, project }));
          }
        });
      } else if (data.type === 'start_multitrack_record') {
        const armed: number[] = Array.isArray(data.armed) ? data.armed : [];
        const err = startTake(armed, Number(data.countinFrames) || 0);
        if (err) ws.send(JSON.stringify({ type: 'take_failed', reason: err }));
      } else if (data.type === 'stop_multitrack_record') {
        stopTake();
      } else if (data.type === 'vsc_split') {
        // Split the running take: close it and reopen with the same channels.
        // The engine keeps the transport rolling across stop_multitrack_record,
        // so the new take's origin frame is contiguous with the old one's end.
        // handleTakeFinished reopens once the engine confirms the close.
        if (activeTakeDir && engineSocket) {
          pendingSplitArmed = lastArmed.slice();
          stopTake();
        }
      } else if (data.type === 'vsc_set_config') {
        const next = writeVscConfig({
          autoRecord: data.autoRecord, splitOnMarker: data.splitOnMarker,
          minFreeGb: data.minFreeGb, schedule: data.schedule,
        });
        rearmVscSchedule();
        broadcastToClients(JSON.stringify({ type: 'vsc_config_loaded', config: next }));
      } else if (data.type === 'get_loudness_config') {
        ws.send(JSON.stringify({ type: 'loudness_config_loaded', config: getLoudnessConfig() }));
      } else if (data.type === 'set_loudness_config') {
        const cfg = writeLoudnessConfig({ target: data.target, logWhileStopped: data.logWhileStopped });
        broadcastToClients(JSON.stringify({ type: 'loudness_config_loaded', config: cfg }));
      } else if (data.type === 'get_loudness_history') {
        ws.send(JSON.stringify({ type: 'loudness_history', points: loudnessRing, target: getLoudnessConfig().target }));
      } else if (data.type === 'export_loudness_report') {
        const startSec = Number(data.startSec) || 0;
        const endSec = Number(data.endSec);
        if (!Number.isFinite(endSec) || endSec <= startSec) {
          ws.send(JSON.stringify({ type: 'loudness_report', error: 'invalid region' }));
        } else {
          const target = LOUDNESS_TARGETS.includes(Number(data.target)) ? Number(data.target) : getLoudnessConfig().target;
          const { csv, summary } = buildLoudnessReport(startSec, endSec, data.name, target);
          ws.send(JSON.stringify({ type: 'loudness_report', name: summary.file, csv, summary }));
        }
      } else if (data.type === 'bounce') {
        const err = startBounce(Number(data.inSec) || 0, Number(data.outSec) || 0, String(data.name || ''), Number(data.bits) || 24);
        if (err) ws.send(JSON.stringify({ type: 'bounce_status', state: 'failed', error: err }));
      } else if (data.type === 'bounce_cancel') {
        cancelBounce();
      } else if (data.type === 'set_metronome') {
        // Phase 5: remember the click config + forward to the engine; replayed
        // on engine reconnect like the timeline.
        lastMetronome = {
          enabled: !!data.enabled,
          bpm: Number(data.bpm) || 120,
          sigNum: Number(data.sigNum) || 4,
          sigDen: Number(data.sigDen) || 4,
          dest: data.dest === 'master' || data.dest === 'both' ? data.dest : 'monitor',
        };
        if (engineSocket) engineSocket.write(JSON.stringify({ type: 'set_metronome', ...lastMetronome }) + '\n');
      } else if (data.type === 'set_automation_state') {
        activeAutomation = coerceAutoLanes(data.lanes);
        automationMode = data.mode === 'read' || data.mode === 'write' ? data.mode : 'off';
        autoLastEmit.clear();
      } else if (data.type === 'list_project_videos') {
        ws.send(JSON.stringify({ type: 'project_videos', name: activeProjectName, videos: listProjectVideos(activeProjectName) }));
      } else if (data.type === 'list_playlists') {
        ws.send(JSON.stringify({ type: 'playlists_list', playlists: listPlaylists() }));
      } else if (data.type === 'load_playlist') {
        ws.send(JSON.stringify({ type: 'playlist_data', playlist: loadPlaylist(String(data.name || '')) }));
      } else if (data.type === 'new_playlist') {
        const pl: Playlist = { name: sanitizeProjectName(data.name), segments: [] };
        savePlaylist(pl);
        broadcastToClients(JSON.stringify({ type: 'playlists_list', playlists: listPlaylists() }));
        broadcastToClients(JSON.stringify({ type: 'playlist_data', playlist: pl }));
      } else if (data.type === 'save_playlist') {
        const segs = Array.isArray(data.segments) ? data.segments
          .filter((s: any) => s && typeof s.project === 'string')
          .map((s: any) => ({ project: String(s.project), recProject: !!s.recProject, gapSec: Math.max(0, Number(s.gapSec) || 0) }))
          : [];
        const pl: Playlist = { name: sanitizeProjectName(data.name), segments: segs };
        savePlaylist(pl);
        broadcastToClients(JSON.stringify({ type: 'playlist_data', playlist: pl }));
      } else if (data.type === 'playlist_transport') {
        if (data.action === 'start') startPlaylist(String(data.name || ''), Number(data.fromIndex) || 0);
        else stopPlaylist();
      } else if (data.type === 'get_timecode_config') {
        ws.send(JSON.stringify({ type: 'timecode_config_loaded', config: getTimecodeConfig() }));
      } else if (data.type === 'set_timecode_config') {
        // Phase 3d: persist + forward the four engine commands; replayed on
        // engine reconnect like the metronome/timeline.
        const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
        const cfg = writeTimecodeConfig({
          source: data.source, fps: num(data.fps) as TcFps | undefined, df: data.df,
          offsetFrames: num(data.offsetFrames), ltcGen: data.ltcGen,
          ltcLevel: num(data.ltcLevel), mtcGen: data.mtcGen, ltcChase: data.ltcChase,
        });
        pushTimecodeToEngine(cfg);
        broadcastToClients(JSON.stringify({ type: 'timecode_config_loaded', config: cfg }));
      } else if (data.type === 'list_bounces') {
        ws.send(JSON.stringify({ type: 'bounces_list', bounces: listBounces() }));
      } else if (data.type === 'get_clip_peaks') {
        // Lazy waveform data: compute (and cache) min/max peaks for one take
        // file on first request, then serve from disk.
        const takeDir = String(data.takeDir || '').replace(/[^0-9A-Za-z:_-]/g, '');
        const file = String(data.file || '').replace(/[^0-9A-Za-z._-]/g, '');
        if (takeDir && /^[0-9A-Za-z_-]+\.(wav|wv)$/.test(file)) {
          const srcPath = activeRecordingProject
            ? path.join(recProjectDir(activeRecordingProject), file)
            : path.join(projectDir(activeProjectName), 'takes', takeDir, file);
          const clipId = data.clipId;
          // Computed on a worker thread — a long take is seconds of blocking
          // work that must not stall the event loop (see pumpPeaksQueue).
          getPeaksAsync(srcPath).then((peaks) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'clip_peaks', clipId, takeDir, file, peaks }));
            }
          });
        }
      } else if (data.type && allowedTypes.includes(data.type)) {
        // Intercept mixer state changes: update in-memory snapshot, persist
        // to disk (debounced), and fan-out to all other connected clients.
        const ch = String(data.channel);
        if (data.type === 'set_fader' && typeof data.channel === 'number') {
          if (!mixerState[ch]) mixerState[ch] = {};
          // Prefer faderPosition (normalised 0..1 UI value) added by the
          // UI store; fall back to raw amplitude value if absent.
          mixerState[ch].fader = typeof data.faderPosition === 'number' ? data.faderPosition : data.value;
          saveMixerState();
        } else if (data.type === 'set_pan' && typeof data.channel === 'number') {
          if (!mixerState[ch]) mixerState[ch] = {};
          mixerState[ch].pan = data.value;
          saveMixerState();
        } else if (data.type === 'set_mute' && typeof data.channel === 'number') {
          if (!mixerState[ch]) mixerState[ch] = {};
          mixerState[ch].mute = !!data.value;
          saveMixerState();
        } else if (data.type === 'set_solo' && typeof data.channel === 'number') {
          if (!mixerState[ch]) mixerState[ch] = {};
          mixerState[ch].solo = !!data.value;
          saveMixerState();
        } else if (data.type === 'set_afl_pfl_mode') {
          (mixerState as any).aflPflMode = data.value;
          saveMixerState();
        } else if (data.type === 'set_arm' && typeof data.channel === 'number') {
          if (!mixerState[ch]) mixerState[ch] = {};
          mixerState[ch].arm = !!data.value;
          saveMixerState();
        } else if (data.type === 'set_phase' && typeof data.channel === 'number') {
          if (!mixerState[ch]) mixerState[ch] = {};
          mixerState[ch].phase = !!data.value;
          saveMixerState();
        } else if (
          data.type === 'add_plugin' || data.type === 'remove_plugin' ||
          data.type === 'reorder_plugin' || data.type === 'replace_plugin' ||
          data.type === 'load_rack' || data.type === 'set_plugin_param' ||
          data.type === 'set_plugin_bypass'
        ) {
          if (applyFxRackMessage(data)) saveFxRacks();
        } else if (data.type === 'set_aux_send' && typeof data.channel === 'number') {
          if (!mixerState[ch]) mixerState[ch] = {};
          if (!mixerState[ch].auxSends) mixerState[ch].auxSends = {};
          mixerState[ch].auxSends![String(data.busId)] = data.value;
          saveMixerState();
          console.log('Forwarding set_aux_send to IPC:', payloadStr);
        }
        // Phase 5 — capture live moves onto armed automation lanes (WRITE).
        if (data.type === 'set_fader' || data.type === 'set_pan' || data.type === 'set_plugin_param') {
          maybeCaptureAutomation(data);
        }
        if (data.type === 'transport_stop') finishAutomationWrite();
        // Remember the loop / punch region so the server can replay it on an
        // engine reconnect — clients no longer re-assert it every frame.
        if (data.type === 'transport_set_loop') {
          lastLoop = { start: Number(data.start) || 0, end: Number(data.end) || 0, enabled: !!data.enabled };
        } else if (data.type === 'transport_set_punch') {
          lastPunch = { start: Number(data.start) || 0, end: Number(data.end) || 0, enabled: !!data.enabled };
        }
        // Forward to engine
        if (engineSocket) {
          engineSocket.write(payloadStr + '\n');
        }
        // Broadcast to all OTHER clients for live multi-client sync.
        connectedWsClients.forEach(other => {
          if (other !== ws && other.readyState === WebSocket.OPEN) {
            other.send(payloadStr);
          }
        });
      }
    } catch (e) {
      // Invalid JSON or format, drop it
    }
  });
});

// Set up Unix Domain Socket Server for C++ Engine
if (fs.existsSync(SOCKET_PATH)) {
  fs.unlinkSync(SOCKET_PATH);
}

let engineSocket: net.Socket | null = null;

// Engine reports a multitrack take has begun: write the take manifest so the
// recording is self-describing on disk regardless of what the UI does. Still
// forwarded to the UI (return false) as a recording-confirmed signal.
function handleTakeStarted(msg: any): boolean {
  if (!activeTakeDir) return false;
  try {
    const tcCfg = getTimecodeConfig();
    const sr = Number(msg.sampleRate) || lastSampleRate || 48000;
    writeFileAtomicSync(path.join(activeTakeDir, 'take.json'), JSON.stringify({
      originFrame: Number(msg.originFrame) || 0,
      sampleRate: sr,
      armed: Array.isArray(msg.armed) ? msg.armed : [],
      channels: 2,
      project: activeProjectName,
      startedAt: new Date().toISOString(),
      // Phase 3d — PTP-locked wall clock + SMPTE at the take origin.
      ptpWallClock: lastTodSec != null
        ? `${Math.floor(lastTodSec / 3600).toString().padStart(2, '0')}:${Math.floor((lastTodSec % 3600) / 60).toString().padStart(2, '0')}:${(lastTodSec % 60).toFixed(3).padStart(6, '0')} UTC`
        : null,
      startTimecode: timecodeAt(tcCfg, sr, Number(msg.originFrame) || 0, lastTodSec),
      timecodeFps: tcCfg.fps,
      timecodeDropFrame: tcCfg.df,
    }, null, 2));
  } catch (e) {
    console.error('Could not write take.json', e);
  }
  return false;
}

// Engine reports a take has closed: turn it into clips, hand them to every UI
// as `take_committed` (the raw take_finished line is not forwarded).
function handleTakeFinished(msg: any): boolean {
  const takeDir = activeTakeDir;
  activeTakeDir = null;
  const splitArmed = pendingSplitArmed;
  pendingSplitArmed = null;
  if (!splitArmed) stopDiskGuard();
  if (!takeDir) return false;
  const takeName = path.basename(takeDir);

  // Loop-record pass tagging. A split closed pass `pendingLoopPassIndex`; the
  // final pass (loop-record ended by a plain stop) is the current counter.
  let loopPass = false, passIndex = 0;
  if (pendingLoopPassIndex !== null) {
    loopPass = true; passIndex = pendingLoopPassIndex; pendingLoopPassIndex = null;
  } else if (loopRecordActive) {
    loopPass = true; passIndex = loopRecordPass;
  }
  if (!splitArmed) resetLoopRecord();   // recording session over

  // A split: the current take just closed; reopen immediately with the same
  // channels so capture is continuous. The engine kept the transport rolling,
  // so this take's origin frame abuts the one that just finished.
  const reopenForSplit = () => {
    if (!splitArmed) return;
    const err = startTake(splitArmed, 0, true);
    broadcastToClients(JSON.stringify(
      err ? { type: 'vsc_status', splitError: err } : { type: 'vsc_status', splitDone: true }));
  };

  const manifest = {
    originFrame: Number(msg.originFrame) || 0,
    endFrame: Number(msg.endFrame) || 0,
    frames: Number(msg.frames) || 0,
    sampleRate: Number(msg.sampleRate) || 48000,
    armed: Array.isArray(msg.armed) ? msg.armed : [],
    ext: typeof msg.ext === 'string' ? msg.ext : 'wv',
  };
  try {
    // Merge end frame into the manifest written at take_started.
    const p = path.join(takeDir, 'take.json');
    const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    writeFileAtomicSync(p, JSON.stringify({ ...existing, ...manifest, overrun: !!msg.overrun }, null, 2));
  } catch (e) {
    console.error('Could not finalise take.json', e);
  }

  const clips = takeManifestToClips(takeName, manifest);

  // If a REAPER recording project is open, consolidate this take straight into
  // records/<name>/ (flat, collision-free) and fold it into the .rpp so the
  // project stays self-contained.
  if (activeRecordingProject) {
    const recName = activeRecordingProject;
    const recDir = recProjectDir(recName);
    try { fs.mkdirSync(recDir, { recursive: true }); } catch { /* ignore */ }
    for (const c of clips) {
      const from = path.join(takeDir, path.basename(c.file));
      const base = consolidatedName(takeName, c.file);
      const to = path.join(recDir, base);
      try {
        if (fs.existsSync(from)) {
          fs.renameSync(from, to);
          const pk = from.replace(/\.(wav|wv)$/i, '') + '.peaks.json';
          if (fs.existsSync(pk)) { try { fs.renameSync(pk, to.replace(/\.(wav|wv)$/i, '') + '.peaks.json'); } catch { /* ignore */ } }
        }
      } catch (e) {
        console.error('handleTakeFinished: consolidate move failed', from, e);
      }
      c.file = base;
      c.takeDir = recName;
    }
    try { fs.rmSync(takeDir, { recursive: true, force: true }); } catch { /* ignore */ }

    let merged: DawProject = { clips: [], markers: [], trackHeights: {} };
    try {
      const base = rppToProject(parseRpp(fs.readFileSync(rppPath(recName), 'utf8')), recName);
      merged = { clips: [...base.clips, ...clips], markers: base.markers, trackHeights: base.trackHeights,
                 tempo: base.tempo, timeSig: base.timeSig };
      writeFileAtomicSync(rppPath(recName), buildRpp(
        timelineToRpp(merged.clips, merged.markers, merged.trackHeights, manifest.sampleRate, (x) => path.basename(String(x.file || '')), merged),
      ));
    } catch (e) {
      console.error('handleTakeFinished: rpp rewrite failed', e);
    }

    broadcastToClients(JSON.stringify({
      type: 'take_committed', project: recName, takeDir: recName, overrun: !!msg.overrun, clips,
      loopPass, passIndex,
    }));
    pushTimelineToEngine(recName, merged);
    reopenForSplit();
    return true;
  }

  broadcastToClients(JSON.stringify({
    type: 'take_committed',
    project: activeProjectName,
    takeDir: takeName,
    overrun: !!msg.overrun,
    clips,
    loopPass, passIndex,
  }));
  // The committed clips aren't in project.json yet (the UI persists them via
  // save_project), so fold them into the engine schedule now.
  pushTimelineToEngine(activeProjectName, undefined, clips);
  reopenForSplit();
  return true;
}

// Resolve the active project's clips to absolute source paths + frame
// positions and push them to the engine as the playback schedule.
function pushTimelineToEngine(name: string, project?: DawProject, extraClips: any[] = []): void {
  if (!engineSocket) return;
  const isRec = activeRecordingProject === sanitizeProjectName(name);
  const proj = project || (isRec ? rppToProject(parseRpp(fs.readFileSync(rppPath(name), 'utf8')), name) : loadProject(name));
  const allClips = [...(proj.clips || []), ...extraClips];
  const dir = isRec ? recProjectDir(name) : projectDir(name);
  const specs: any[] = [];
  for (const c of allClips) {
    if (!c || !c.file) continue;
    if (c.lane) continue;                 // take-comping alternates don't play
    if (!isRec && !c.takeDir) continue;
    const sr = Number(c.sampleRate) > 0 ? Number(c.sampleRate) : 48000;
    const start = Number(c.start) || 0;
    const length = Number(c.length) || 0;
    const sourceOffset = Number(c.sourceOffset) || 0;
    if (length <= 0) continue;
    const fadeIn = Math.max(0, Math.min(length, Number(c.fadeIn) || 0));
    const fadeOut = Math.max(0, Math.min(length, Number(c.fadeOut) || 0));
    specs.push({
      trackId: Number(c.trackId),
      timelineStart: Math.round(start * sr),
      length: Math.round(length * sr),
      fileStart: Math.round(sourceOffset * sr),
      gain: typeof c.gain === 'number' ? c.gain : 1.0,
      fadeIn: Math.round(fadeIn * sr),
      fadeOut: Math.round(fadeOut * sr),
      path: isRec
        ? path.resolve(dir, path.basename(String(c.file)))
        : path.resolve(dir, 'takes', String(c.takeDir), String(c.file)),
    });
  }
  engineSocket.write(JSON.stringify({ type: 'set_timeline', clips: specs }) + '\n');
}

const ipcServer = net.createServer((socket) => {
  if (engineSocket) {
    console.log('Replacing existing C++ Engine IPC connection');
    engineSocket.destroy();
  }
  console.log('C++ Engine connected via IPC');
  engineSocket = socket;

  // The engine is a JACK client: anything that restarts the JACK server out
  // from under it (e.g. `systemctl restart pipewire`) kills its process
  // (JackClient's shutdown callback calls std::exit) and every pw-link it
  // held. A fresh engine process comes back with a blank port graph, and
  // nothing was re-driving pw-link against it — the UI's "Apply" is what
  // normally does that, but only on demand. Re-apply everything persisted
  // to disk on every (re)connect so the signal chain self-heals whether
  // this is the first boot or a recovery, with no manual step required.
  (async () => {
    // The engine opens this IPC socket before it finishes registering its
    // JACK ports — on a cold PipeWire+engine restart the ports can lag the
    // connection by several seconds. Applying pw-link routing before the
    // ports exist silently no-ops (pw-link errors are ignored) and nothing
    // retries, leaving the whole graph disconnected. Wait for the engine's
    // ports to actually appear first.
    await waitForEnginePorts();
    await ensureSystemAudioDefault();
    await handlePatchbaySync(getPatchbayMappings());
    await applyOutputRouting(getOutputRouting());
    await applyMonitorRouting();
    await applyBroadcastRouting();
    const talkbackCfg = getTalkbackConfig();
    await applyTalkbackRouting(talkbackCfg);
    // applyTalkbackRouting only wires the mic source side (pw-link); the
    // destination mask lives in the engine's own TalkbackState and defaults
    // to Master-only on a fresh process, so it needs resending explicitly
    // or a recovered engine would silently diverge from what's persisted.
    if (engineSocket) {
      engineSocket.write(JSON.stringify({ type: 'set_talkback_dest', channel: TALKBACK_ID, busId: talkbackDestMask(talkbackCfg.destBusIds) }) + '\n');
    }
    // Restore fader/pan/mute/solo/aux positions to the engine from the
    // persisted mixer_state.json so it resumes at the right levels.
    const restoreLines = buildEngineRestoreCommands();
    for (const line of restoreLines) {
      if (engineSocket) engineSocket.write(line + '\n');
    }
    if (restoreLines.length > 0) {
      console.log(`Mixer state restored to engine: ${restoreLines.length} commands sent.`);
    }
    // Rebuild each channel's FX insert chain from the persisted snapshot.
    let rackCount = 0;
    for (const [chId] of Object.entries(fxRacks)) { if (sendLoadRack(Number(chId))) rackCount++; }
    if (rackCount > 0) console.log(`FX racks restored to engine: ${rackCount} channels.`);
    // Replay the active project's timeline so playback works after an engine
    // restart, same self-heal contract as routing.
    pushTimelineToEngine(activeProjectName);
    replayRegionToEngine();   // loop / punch region — engine drops it on restart
    if (lastMetronome && engineSocket)
      engineSocket.write(JSON.stringify({ type: 'set_metronome', ...lastMetronome }) + '\n');
    pushTimecodeToEngine(getTimecodeConfig());   // Phase 3d
    console.log('Routing re-applied after engine (re)connect');
  })();

  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim().length > 0) {
        let handled = false;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'plugin_list' && Array.isArray(parsed.plugins)) {
            lastPluginCatalog = parsed.plugins;
          } else if (parsed.type === 'metering') {
            // `handled` stays false so the frame still forwards to every UI.
            maybeLogLoudness(parsed);              // Phase 3c: 1 Hz loudness CSV + ring
            maybePunch(parsed.transport);         // Phase 3e: auto drop-in/out + loop-record split
            maybeFinishBounce(parsed.transport);  // Phase 4: bounce done → report the file
            maybeRunAutomation(parsed.transport); // Phase 5: play automation envelopes
            reconcileFxRacks(parsed.fxN);         // heal a dropped load_rack
            maybeAdvancePlaylist(parsed.transport); // Phase 5: back-to-back playout
            if (parsed.tc && typeof parsed.tc.tod === 'number') lastTodSec = parsed.tc.tod;
            if (parsed.transport && typeof parsed.transport.sr === 'number') lastSampleRate = parsed.transport.sr;
          } else if (parsed.type === 'bounce_failed') {
            if (bounce.active) {
              bounce.active = false;
              broadcastToClients(JSON.stringify({ type: 'bounce_status', state: 'failed', name: bounce.name }));
            }
          } else if (parsed.type === 'take_started') {
            handled = handleTakeStarted(parsed);
          } else if (parsed.type === 'take_finished') {
            handled = handleTakeFinished(parsed);
          } else if (parsed.type === 'take_failed') {
            // Engine couldn't open the files — bin the empty take dir.
            if (activeTakeDir && fs.existsSync(activeTakeDir)) {
              try { fs.rmSync(activeTakeDir, { recursive: true, force: true }); } catch { /* ignore */ }
            }
            activeTakeDir = null;
            stopDiskGuard();
          }
        } catch {
          // Not JSON or not a message we care about caching; still forward below.
        }
        if (!handled) {
          connectedWsClients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(line);
            }
          });
        }
      }
    }
  });

  socket.on('end', () => {
    if (engineSocket === socket) {
      console.log('C++ Engine disconnected');
      engineSocket = null;
    }
  });

  socket.on('error', (err) => {
    console.error('IPC Socket error:', err.message);
    if (engineSocket === socket) engineSocket = null;
  });
});

ipcServer.listen(SOCKET_PATH, () => {
  console.log(`IPC Server listening on ${SOCKET_PATH}`);
});

// Assert the system-audio default sink as soon as we start — the engine may
// already be connected (also re-asserted on every engine reconnect above).
ensureSystemAudioDefault().catch(() => {});

// Full routing (patchbay + output endpoints + Monitor + Talkback) is now
// re-applied from the "C++ Engine connected via IPC" handler above on every
// engine (re)connect, which covers both first boot and recovery after the
// engine restarts — see the comment there.

// --- aes67-linux-daemon control proxy ---
// The daemon is control-plane only: it configures the RAVENNA kernel module
// over netlink and does SAP/mDNS discovery, and is never in the audio path.
// Everything it does is reachable through its REST API, so the deck drives it
// directly (PTP, Sinks to receive streams, transmit Sources) instead of the
// operator opening the separate daemon WebUI on :8080. We poll a full snapshot
// of daemon state every 5s and broadcast it as `daemon_state`; a handful of
// write commands come back over the same WS the UI already uses.
//
// The pre-existing Output-Endpoints feature ("AES67 destinations" — feed a bus
// into a configured Source to transmit it) still consumes a derived
// `daemon_destinations_loaded` message, kept emitted below unchanged.
const DAEMON_BASE_URL = process.env.AES67_DAEMON_URL || 'http://localhost:8080';
const DAEMON_POLL_INTERVAL_MS = 5000;

interface DaemonDestination {
  name: string;
  address: string;
}

interface DaemonRequestResult {
  ok: boolean;
  status: number;
  json: any;
}

// Generic daemon REST call. Never throws — a dead daemon, a timeout, or a
// non-JSON body all resolve to { ok:false, status:0, json:null } so callers
// stay branch-free.
function daemonRequest(method: string, apiPath: string, body?: unknown): Promise<DaemonRequestResult> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let url: URL;
    try {
      url = new URL(apiPath, DAEMON_BASE_URL);
    } catch {
      resolve({ ok: false, status: 0, json: null });
      return;
    }
    const req = http.request(url, {
      method,
      timeout: 2000,
      headers: payload === undefined ? undefined : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        const ok = status >= 200 && status < 300;
        let json: any = null;
        if (raw.trim().length > 0) {
          try { json = JSON.parse(raw); } catch { json = null; }
        }
        resolve({ ok, status, json });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, json: null }); });
    req.on('error', () => resolve({ ok: false, status: 0, json: null }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

interface DaemonState {
  reachable: boolean;
  config: any;
  ptp: any;
  sources: any[];
  sinks: any[];
  remote: any[];
}

let lastDaemonState: DaemonState = {
  reachable: false, config: null, ptp: null, sources: [], sinks: [], remote: []
};
let lastDaemonDestinations: DaemonDestination[] = [];
let daemonReachable = false;

// Lowest integer id in 0..63 not already taken by an existing source/sink,
// matching how the daemon WebUI allocates them. -1 if all 64 are in use.
function lowestFreeDaemonId(items: any[]): number {
  const used = new Set((items || []).map((i) => Number(i.id)));
  for (let i = 0; i <= 63; i++) {
    if (!used.has(i)) return i;
  }
  return -1;
}

function broadcastToClients(msg: string) {
  connectedWsClients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// Multicast address from an SDP connection line, for display / persistence.
function sdpAddress(sdp: string): string {
  const m = /c=IN IP4 ([0-9.]+)/.exec(sdp || '');
  return m ? m[1] : '';
}

// ===========================================================================
// Phase 2 — network I/O for the mix (plan/unified-aes67-network-control.md).
// No engine change: the 20 mix-product ports already exist; this pins the
// engine->AES67_Sink link map, auto-provisions the transmit Sources, and
// auto-allocates AES67_Source capture channels to subscribed Sinks.
// ===========================================================================

// --- Transmit: fixed stereo Source groups, each reading a pair of AES67_Sink
//     playout channels the engine is pinned to (see applyBroadcastRouting).
//     Master, Monitor, and Aux 1..8 — each its own 2-channel AES67 stream. ---
interface TxSourceGroup {
  key: string;
  defaultName: string;
  map: number[];          // 0-indexed AES67_Sink playout channels
  enginePorts: string[];  // AES67_Deck output ports feeding those channels, in order
}

const TX_SOURCE_PLAN: TxSourceGroup[] = [
  { key: 'master',  defaultName: 'Deck Master',  map: [0, 1], enginePorts: ['out_L', 'out_R'] },
  { key: 'monitor', defaultName: 'Deck Monitor', map: [2, 3], enginePorts: ['monitor_L', 'monitor_R'] },
  ...Array.from({ length: NUM_AUX }, (_, i) => ({
    key: `aux${i + 1}`,
    defaultName: `Deck AUX ${i + 1}`,
    map: [4 + i * 2, 5 + i * 2],
    enginePorts: [`bus_${AUX_BASE + i}_L`, `bus_${AUX_BASE + i}_R`],
  })),
  // Mono SMPTE LTC carrier from the engine's timecode generator (plan Phase 3d
  // follow-up). AES67_Sink playout channel AUX20 — see the widened bridge conf.
  { key: 'ltc', defaultName: 'Deck LTC', map: [20], enginePorts: ['ltc_out'] },
];

// sourceId: the daemon Source id this group currently owns (null = none). It's
// the identity used for reconcile so a rename PUTs in place instead of
// orphaning the old-named Source. Name is only a fallback match (adopts a
// Source left over from a daemon restart / an earlier server version).
interface TxSourcePref { enabled: boolean; name: string; sourceId: number | null; }
type TxSourcePrefs = Record<string, TxSourcePref>;

// Operator overrides, per group. Default: every group disabled — the operator
// enables them incrementally (Phase 2 caveat: watch PTP offset / xruns).
function getTxSourcePrefs(): TxSourcePrefs {
  const prefs: TxSourcePrefs = {};
  for (const g of TX_SOURCE_PLAN) prefs[g.key] = { enabled: false, name: g.defaultName, sourceId: null };
  try {
    if (fs.existsSync(TX_SOURCES_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TX_SOURCES_PATH, 'utf8'));
      // Migrate the old 8-channel bundled aux groups to the per-aux stereo
      // ones: if aux1-4 was enabled, aux1..4 start enabled (and vice versa).
      for (const [legacy, targets] of [['aux1-4', [1, 2, 3, 4]], ['aux5-8', [5, 6, 7, 8]]] as const) {
        const lv = raw?.[legacy];
        if (lv && typeof lv === 'object' && raw[`aux${targets[0]}`] === undefined) {
          for (const n of targets) if (typeof lv.enabled === 'boolean') prefs[`aux${n}`].enabled = lv.enabled;
        }
      }
      for (const g of TX_SOURCE_PLAN) {
        const v = raw?.[g.key];
        if (v && typeof v === 'object') {
          if (typeof v.enabled === 'boolean') prefs[g.key].enabled = v.enabled;
          if (typeof v.name === 'string' && v.name.trim()) prefs[g.key].name = v.name.trim();
          if (Number.isInteger(v.sourceId)) prefs[g.key].sourceId = v.sourceId;
        }
      }
    }
  } catch (e) {
    console.error('Error reading tx_sources.json, using defaults', e);
  }
  return prefs;
}

function saveTxSourcePrefs(prefs: TxSourcePrefs) {
  writeFileAtomicSync(TX_SOURCES_PATH, JSON.stringify(prefs, null, 2));
}

// Converge the daemon's transmit Sources to the enabled TX groups. Each group
// owns one Source, tracked by id (name is a fallback for adoption). Returns
// true if it issued any PUT/DELETE (so the caller re-fetches before broadcast).
async function reconcileTxSources(daemonSourcesIn: any[]): Promise<boolean> {
  const prefs = getTxSourcePrefs();
  let changed = false;
  let prefsDirty = false;

  // Sweep the legacy bundled aux sources ("Deck AUX 1-4" / "5-8", >2 channels)
  // from the old 2-group layout, so their daemon ids free up for the new
  // per-aux stereo sources created below.
  let daemonSources = daemonSourcesIn;
  const legacy = daemonSources.filter((s: any) =>
    /^Deck AUX [15]-[48]$/.test(String(s.name)) && Array.isArray(s.map) && s.map.length > 2);
  for (const s of legacy) {
    const res = await daemonRequest('DELETE', `/api/source/${s.id}`);
    if (res.ok) { changed = true; console.log(`reconcileTxSources: removed legacy bundled source "${s.name}"`); }
  }
  if (legacy.length) daemonSources = daemonSources.filter((s: any) => !legacy.includes(s));

  for (const g of TX_SOURCE_PLAN) {
    const pref = prefs[g.key];
    let existing = pref.sourceId != null
      ? daemonSources.find((s: any) => Number(s.id) === pref.sourceId)
      : undefined;
    if (!existing) existing = daemonSources.find((s: any) => s.name === pref.name);

    if (pref.enabled) {
      const mapOk = existing && Array.isArray(existing.map) &&
        existing.map.length === g.map.length &&
        existing.map.every((v: number, i: number) => v === g.map[i]);
      const ok = existing && mapOk && existing.enabled === true && existing.name === pref.name;
      const id = existing ? Number(existing.id)
        : (pref.sourceId != null && !daemonSources.some((s: any) => Number(s.id) === pref.sourceId)
          ? pref.sourceId : lowestFreeDaemonId(daemonSources));
      if (id !== pref.sourceId) { pref.sourceId = id; prefsDirty = true; }
      if (ok) continue;
      if (id < 0) { console.error(`reconcileTxSources: no free source id for ${g.key}`); continue; }
      const body = {
        enabled: true, name: pref.name, io: 'Audio Device', map: g.map,
        max_samples_per_packet: 48, codec: 'L24', address: existing?.address || '',
        ttl: 15, payload_type: 98, dscp: 34, refclk_ptp_traceable: false
      };
      const res = await daemonRequest('PUT', `/api/source/${id}`, body);
      if (res.ok) {
        changed = true;
        // Reflect the new/updated source in the working snapshot so the next
        // group in this pass doesn't pick the same free id.
        daemonSources = [...daemonSources.filter((s: any) => Number(s.id) !== id), { ...body, id }];
      } else {
        console.error(`reconcileTxSources PUT ${g.key} failed (${res.status})`, res.json);
      }
    } else {
      if (existing) {
        const res = await daemonRequest('DELETE', `/api/source/${existing.id}`);
        if (res.ok) changed = true;
        else console.error(`reconcileTxSources DELETE ${g.key} failed (${res.status})`, res.json);
      }
      if (pref.sourceId != null) { pref.sourceId = null; prefsDirty = true; }
    }
  }

  if (prefsDirty) saveTxSourcePrefs(prefs);
  return changed;
}

// Resolved per-group TX state for the UI.
function resolveTxSources(daemonSources: any[], ptpLocked: boolean) {
  const prefs = getTxSourcePrefs();
  return TX_SOURCE_PLAN.map((g) => {
    const pref = prefs[g.key];
    const live = (pref.sourceId != null && daemonSources.find((s: any) => Number(s.id) === pref.sourceId))
      || daemonSources.find((s: any) => s.name === pref.name);
    return {
      key: g.key,
      name: pref.name,
      enabled: pref.enabled,
      channels: g.map.length,
      address: live?.address || '',
      present: !!live,
      running: !!live && live.enabled === true && ptpLocked
    };
  });
}

// --- Receive: allocate a contiguous AES67_Source capture-channel block to
//     each subscribed Sink, and keep the daemon's sink `map` matching it. ---
const RX_CAPTURE_CHANNELS = 32;

interface RxSinkAssignment {
  sinkId: number;
  streamName: string;
  address: string;
  captureBase: number;
  channels: number;
}

function getRxSinkAssignments(): RxSinkAssignment[] {
  try {
    if (fs.existsSync(RX_SINKS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(RX_SINKS_PATH, 'utf8'));
      if (Array.isArray(raw)) {
        return raw.filter((a: any) =>
          a && Number.isInteger(a.sinkId) && Number.isInteger(a.captureBase) &&
          Number.isInteger(a.channels) && a.channels > 0);
      }
    }
  } catch (e) {
    console.error('Error reading rx_sinks.json, starting fresh', e);
  }
  return [];
}

function saveRxSinkAssignments(list: RxSinkAssignment[]) {
  writeFileAtomicSync(RX_SINKS_PATH, JSON.stringify(list, null, 2));
}

// Lowest capture channel where `count` contiguous channels are free. Counts
// both our persisted blocks and the live `map` of every current daemon sink
// (a sink configured outside the deck, e.g. the pre-existing appliance sink,
// still occupies capture channels). -1 if it won't fit in 0..N-1.
function allocateCaptureBlock(count: number, assignments: RxSinkAssignment[], daemonSinks: any[]): number {
  const used = new Array(RX_CAPTURE_CHANNELS).fill(false);
  const mark = (start: number, len: number) => {
    for (let i = start; i < start + len && i < RX_CAPTURE_CHANNELS; i++) used[i] = true;
  };
  for (const a of assignments) mark(a.captureBase, a.channels);
  for (const s of daemonSinks || []) {
    if (Array.isArray(s.map)) for (const ch of s.map) if (Number.isInteger(ch)) used[ch] = true;
  }
  for (let base = 0; base + count <= RX_CAPTURE_CHANNELS; base++) {
    if (!used.slice(base, base + count).some(Boolean)) return base;
  }
  return -1;
}

// Channel count from an SDP's first audio rtpmap ("...L24/48000/8").
function sdpChannelCount(sdp: string): number {
  const m = /a=rtpmap:\d+\s+[A-Za-z0-9]+\/\d+\/(\d+)/.exec(sdp || '');
  return m ? Math.max(1, Number(m[1])) : 2;
}

// AES67_Source capture ports a sink's live map resolves to, for the UI.
function sinkCapturePorts(sink: any): string[] {
  if (!Array.isArray(sink.map)) return [];
  return sink.map.map((n: number) => `AES67_Source:capture_AUX${n}`);
}

// After each poll: drop assignments whose sink is gone, and re-PUT any sink
// whose live `map` drifted from its persisted block (covers a daemon restart
// that reloaded sinks with different maps). Returns true if it issued a PUT.
async function reconcileRxSinks(daemonSinks: any[]): Promise<boolean> {
  const assignments = getRxSinkAssignments();
  const liveIds = new Set(daemonSinks.map((s: any) => Number(s.id)));
  const kept = assignments.filter((a) => liveIds.has(a.sinkId));
  if (kept.length !== assignments.length) saveRxSinkAssignments(kept);

  let changed = false;
  for (const a of kept) {
    const live = daemonSinks.find((s: any) => Number(s.id) === a.sinkId);
    if (!live) continue;
    const want = Array.from({ length: a.channels }, (_, i) => a.captureBase + i);
    const mapOk = Array.isArray(live.map) && live.map.length === want.length &&
      live.map.every((v: number, i: number) => v === want[i]);
    if (mapOk) continue;
    const body = {
      name: live.name, io: live.io || 'Audio Device', use_sdp: !!live.use_sdp,
      source: live.source || '', sdp: live.sdp || '',
      delay: typeof live.delay === 'number' ? live.delay : 384,
      ignore_refclk_gmid: live.ignore_refclk_gmid !== false, map: want
    };
    const res = await daemonRequest('PUT', `/api/sink/${a.sinkId}`, body);
    if (res.ok) changed = true;
    else console.error(`reconcileRxSinks PUT sink ${a.sinkId} failed (${res.status})`, res.json);
  }
  return changed;
}

// All daemon-mutating work (WS handlers + the periodic reconcile) runs through
// this single promise chain, so two commands — or a command racing the 5s
// poll — can never both allocate the same source id / capture block off a
// stale snapshot.
let daemonOpChain: Promise<unknown> = Promise.resolve();
function runDaemonOp<T>(fn: () => Promise<T>): Promise<T> {
  const result = daemonOpChain.then(fn, fn);
  daemonOpChain = result.catch(() => undefined);
  return result;
}

// The enriched `daemon_state` payload — daemon snapshot plus per-Sink
// capturePorts and resolved txSources. Used by the poll and the WS greeting.
function daemonStateMessage() {
  const ptpLocked = lastDaemonState.ptp?.status === 'locked';
  return {
    type: 'daemon_state',
    ...lastDaemonState,
    sinks: lastDaemonState.sinks.map((s: any) => ({ ...s, capturePorts: sinkCapturePorts(s) })),
    txSources: resolveTxSources(lastDaemonState.sources, ptpLocked)
  };
}

// Fetch a fresh daemon snapshot, converge it to persisted intent, and
// broadcast. NOT self-locking — always call via pollDaemonState() (interval)
// or inside a runDaemonOp() block (WS handlers), never bare.
async function refreshDaemonState() {
  const [configRes, ptpRes, sourcesRes, sinksRes, remoteRes] = await Promise.all([
    daemonRequest('GET', '/api/config'),
    daemonRequest('GET', '/api/ptp/status'),
    daemonRequest('GET', '/api/sources'),
    daemonRequest('GET', '/api/sinks'),
    daemonRequest('GET', '/api/browse/sources/all')
  ]);

  const reachable = configRes.ok || sourcesRes.ok;
  if (reachable !== daemonReachable) {
    console.log(reachable
      ? `Connected to aes67-linux-daemon at ${DAEMON_BASE_URL}`
      : `aes67-linux-daemon unreachable at ${DAEMON_BASE_URL} (daemon control paused)`);
    daemonReachable = reachable;
  }

  if (reachable) {
    lastDaemonState = {
      reachable: true,
      config: configRes.json ?? lastDaemonState.config,
      ptp: ptpRes.json ?? null,
      sources: Array.isArray(sourcesRes.json?.sources) ? sourcesRes.json.sources : [],
      sinks: Array.isArray(sinksRes.json?.sinks) ? sinksRes.json.sinks : [],
      remote: Array.isArray(remoteRes.json?.remote_sources) ? remoteRes.json.remote_sources : []
    };

    // Phase 2: converge the daemon to persisted intent (enabled TX groups,
    // per-Sink capture blocks). Re-fetch if anything moved so the broadcast
    // below reflects the converged state, not the pre-reconcile snapshot.
    const txChanged = await reconcileTxSources(lastDaemonState.sources);
    const rxChanged = await reconcileRxSinks(lastDaemonState.sinks);
    if (txChanged || rxChanged) {
      const [s2, k2] = await Promise.all([
        daemonRequest('GET', '/api/sources'),
        daemonRequest('GET', '/api/sinks')
      ]);
      if (Array.isArray(s2.json?.sources)) lastDaemonState.sources = s2.json.sources;
      if (Array.isArray(k2.json?.sinks)) lastDaemonState.sinks = k2.json.sinks;
    }

    lastDaemonDestinations = lastDaemonState.sources.map((s: any) => ({
      name: typeof s.name === 'string' && s.name ? s.name : `Source ${s.id}`,
      address: typeof s.address === 'string' ? s.address : ''
    }));
  } else {
    lastDaemonState = { ...lastDaemonState, reachable: false };
  }

  broadcastToClients(JSON.stringify(daemonStateMessage()));
  broadcastToClients(JSON.stringify({ type: 'daemon_destinations_loaded', destinations: lastDaemonDestinations, daemonReachable: reachable }));
}

function pollDaemonState() {
  return runDaemonOp(refreshDaemonState);
}

setInterval(pollDaemonState, DAEMON_POLL_INTERVAL_MS);
pollDaemonState();

// --- Box telemetry for the toolbar (CPU / RAM) ---------------------------
let prevCpu: { total: number; idle: number } | null = null;
function readCpuSample(): { total: number; idle: number } | null {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0]; // "cpu  u n s i io irq sirq steal ..."
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    if (v.length < 5 || v.some((n) => !Number.isFinite(n))) return null;
    const idle = v[3] + (v[4] || 0);
    const total = v.reduce((a, b) => a + b, 0);
    return { total, idle };
  } catch { return null; }
}
function readMem(): { usedMB: number; totalMB: number } | null {
  try {
    const t = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k: string) => {
      const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t);
      return m ? Number(m[1]) : NaN;
    };
    const total = kb('MemTotal');
    const avail = kb('MemAvailable');
    if (!Number.isFinite(total) || !Number.isFinite(avail)) return null;
    return { usedMB: Math.round((total - avail) / 1024), totalMB: Math.round(total / 1024) };
  } catch { return null; }
}
function broadcastServerStats() {
  const cur = readCpuSample();
  let cpu: number | null = null;
  if (cur && prevCpu && cur.total > prevCpu.total) {
    cpu = Math.round((1 - (cur.idle - prevCpu.idle) / (cur.total - prevCpu.total)) * 1000) / 10;
  }
  if (cur) prevCpu = cur;
  const mem = readMem();
  if (cpu == null && !mem) return;
  broadcastToClients(JSON.stringify({
    type: 'server_stats',
    cpu,
    memUsedMB: mem?.usedMB ?? null,
    memTotalMB: mem?.totalMB ?? null,
  }));
}
readCpuSample() && (prevCpu = readCpuSample());
setInterval(broadcastServerStats, 2000);

// --- Local microphone discovery (Talkback source dropdown) ---
// Polls `pactl list sources` for real capture devices (not sink monitors),
// classified as builtin/USB/jack by device.bus / device.form_factor and,
// where a device exposes ALSA port-level jack sensing, an "available"
// external mic-jack port. Polling on an interval — rather than a one-shot
// scan — is what makes a USB mic "automatically" show up: PipeWire creates
// its node the moment it's plugged in, so the next cycle just sees it.
const MIC_POLL_INTERVAL_MS = 3000;

interface MicDevice {
  id: string;
  sourceName: string;
  // ALSA port id to activate via `pactl set-source-port` when this entry
  // represents a specific jack rather than "whatever ALSA already has
  // active" — see applyTalkbackRouting.
  alsaPortName: string | null;
  label: string;
  kind: 'builtin' | 'usb' | 'jack' | 'other';
  channels: number;
  ports: string[];
}

function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

async function listAllOutputPorts(): Promise<string[]> {
  const stdout = await runCmd('pw-link', ['-o']);
  return stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

// Point the machine's default sink at the "AES67 System Audio" loopback so
// every app's playback is captured into the mixer (channel 1 by default).
// No-op unless that sink exists — i.e. deploy/pipewire/30-aes67-system-audio.conf
// is installed. Uses pw-dump + wpctl (core PipeWire/WirePlumber tools, present
// on the appliance which has no pactl). Idempotent; safe on start and on every
// engine (re)connect. WirePlumber persists the choice, so after the first run
// this only corrects a drift.
async function ensureSystemAudioDefault(): Promise<void> {
  const dump = await runCmd('pw-dump', []);
  if (!dump) return;
  let sinkId: number | null = null;
  let effName = '';
  try {
    for (const o of JSON.parse(dump) as any[]) {
      if (o?.type === 'PipeWire:Interface:Node'
          && o?.info?.props?.['node.name'] === 'AES67_System_Audio') {
        sinkId = o.id;
      } else if (o?.type === 'PipeWire:Interface:Metadata' && Array.isArray(o.metadata)) {
        // The *effective* default (default.audio.sink), not the stored
        // preference (default.configured.audio.sink) — WirePlumber can fail
        // to honour the preference (e.g. another sink outranks it), and then
        // the configured value lies. Assert against reality.
        const e = o.metadata.find((x: any) => x?.key === 'default.audio.sink');
        if (e) {
          const v = typeof e.value === 'string' ? (() => { try { return JSON.parse(e.value); } catch { return e.value; } })() : e.value;
          effName = (v && typeof v === 'object' ? v.name : v) || '';
        }
      }
    }
  } catch { return; }
  if (sinkId == null) return;                       // config not deployed here
  if (effName === 'AES67_System_Audio') return;
  await runCmd('wpctl', ['set-default', String(sinkId)]);
  console.log(`Default sink → AES67_System_Audio (node ${sinkId}; system audio into the mixer; was ${effName || 'unset'})`);
}

// Polls the PipeWire graph until the engine's JACK ports are present (or a
// timeout), so the routing reapply on engine (re)connect doesn't race the
// engine's port registration. `monitor_R` is the very last output port the
// engine registers (main.cpp: inputs, then out/bus, then monitor_L/R), so
// seeing it means every port this block links is up.
async function waitForEnginePorts(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await listAllOutputPorts()).includes('AES67_Deck:monitor_R')) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.warn('waitForEnginePorts: AES67_Deck ports not seen within timeout — applying routing anyway');
}

interface PactlSource {
  name: string;
  description: string;
  props: Record<string, string>;
  channelMap: string[];
  ports: Array<{ id: string; desc: string; available: boolean | null }>;
}

// Parses the classic (non-JSON) `pactl list sources` text format. Written
// defensively: this box's only capture device runs ALSA's "pro audio"
// profile, which exposes no Ports:/jack-sensing block at all, so the
// per-port parsing here is unverified against real jack-sensing output — if
// it doesn't match a given system's exact wording, sources still come
// through with a base builtin/USB entry (see fetchMicDevices), only the
// extra jack-specific entries are lost.
function parsePactlSources(text: string): PactlSource[] {
  const chunks = text.split(/\nSource #\d+/).slice(1);
  const out: PactlSource[] = [];

  for (const block of chunks) {
    const nameM = block.match(/\n\tName: (.+)/);
    if (!nameM) continue;
    const descM = block.match(/\n\tDescription: (.+)/);
    const chMapM = block.match(/\n\tChannel Map: (.+)/);

    const props: Record<string, string> = {};
    const propsBlockM = block.match(/\n\tProperties:\n([\s\S]*?)(\n\t[A-Z][a-zA-Z ]*:|$)/);
    if (propsBlockM) {
      const re = /\n\t\t([\w.-]+) = "(.*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(propsBlockM[1]))) props[m[1]] = m[2];
    }

    const ports: PactlSource['ports'] = [];
    const portsBlockM = block.match(/\n\tPorts:\n([\s\S]*?)(\n\tActive Port:|\n\t[A-Z][a-zA-Z ]*:|$)/);
    if (portsBlockM) {
      const re = /\n\t\t([\w-]+): (.+?) \(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(portsBlockM[1]))) {
        const paren = m[3];
        let available: boolean | null = null;
        if (/not available/i.test(paren)) available = false;
        else if (/\bavailable\b/i.test(paren)) available = true;
        ports.push({ id: m[1], desc: m[2], available });
      }
    }

    out.push({
      name: nameM[1].trim(),
      description: descM ? descM[1].trim() : nameM[1].trim(),
      props,
      channelMap: chMapM ? chMapM[1].split(',').map(s => s.trim()).filter(Boolean) : [],
      ports
    });
  }

  return out;
}

async function fetchMicDevices(): Promise<MicDevice[]> {
  const [sourcesText, allOutputPorts] = await Promise.all([
    runCmd('pactl', ['list', 'sources']),
    listAllOutputPorts()
  ]);
  if (!sourcesText) return [];

  const sources = parsePactlSources(sourcesText);
  const devices: MicDevice[] = [];

  for (const s of sources) {
    if (s.props['device.class'] === 'monitor') continue;
    if (s.props['media.class'] !== 'Audio/Source') continue;

    const ports = allOutputPorts.filter(p => p.startsWith(`${s.name}:`));
    if (ports.length === 0) continue; // not actually wired into the PipeWire graph

    const bus = s.props['device.bus'];
    const formFactor = s.props['device.form_factor'];
    const isUsb = bus === 'usb';
    const isBuiltin = !isUsb && (formFactor === 'internal' || !bus || bus === 'pci' || bus === 'platform' || bus === 'isa');

    devices.push({
      id: s.name,
      sourceName: s.name,
      alsaPortName: null,
      label: isUsb ? `USB Microphone — ${s.description}` : `Built-in Microphone — ${s.description}`,
      kind: isUsb ? 'usb' : (isBuiltin ? 'builtin' : 'other'),
      channels: s.channelMap.length || 2,
      ports
    });

    // Any external mic-jack ALSA port this device exposes that's currently
    // sensed as plugged in becomes its own selectable entry — same
    // PipeWire graph ports, but picking it also switches ALSA's active
    // port (see applyTalkbackRouting).
    for (const p of s.ports) {
      const looksLikeMic = /mic/i.test(p.id) || /mic/i.test(p.desc);
      const looksInternal = /internal/i.test(p.id) || /internal/i.test(p.desc);
      if (looksLikeMic && !looksInternal && p.available === true) {
        devices.push({
          id: `${s.name}::${p.id}`,
          sourceName: s.name,
          alsaPortName: p.id,
          label: `Mic Jack — ${p.desc} (${s.description})`,
          kind: 'jack',
          channels: s.channelMap.length || 2,
          ports
        });
      }
    }
  }

  return devices;
}

let lastMicDevices: MicDevice[] = [];
// System LV2 plugin catalog, sent once by the engine at startup and cached
// here so it can be replayed to any UI client that connects afterward.
let lastPluginCatalog: any[] = [];

async function pollMicDevices() {
  lastMicDevices = await fetchMicDevices();
  const msg = JSON.stringify({ type: 'mic_devices_loaded', devices: lastMicDevices });
  connectedWsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

setInterval(pollMicDevices, MIC_POLL_INTERVAL_MS);
pollMicDevices();

// --- AES67 SAP Discovery ---
const SAP_PORT = 9875;
const SAP_MCAST_ADDR = '239.255.255.255';

const sapClient = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const sapDedupe = new Map<string, number>();

sapClient.on('listening', () => {
  try {
    sapClient.addMembership(SAP_MCAST_ADDR);
    console.log(`AES67 SAP Listener bound to ${SAP_MCAST_ADDR}:${SAP_PORT}`);
  } catch (err) {
    console.error(`Failed to add multicast membership. You may need a route for multicast traffic: ${err}`);
  }
});

sapClient.on('message', (message, rinfo) => {
  if (message.length < 4) return;

  // RFC 2974 SAP header parsing
  const v = message[0] >> 5;
  if (v !== 1) return; // Only SAP v1

  const a = (message[0] >> 4) & 1; // 0 = IPv4, 1 = IPv6
  const authLen = message[1];
  const ipLen = a === 0 ? 4 : 16;
  const headerLen = 4 + ipLen + (authLen * 4);

  if (message.length <= headerLen) return;

  const payload = message.toString('utf8', headerLen);
  const lines = payload.split(/[\r\n]+/);

  let streamName = 'Unknown Stream';
  const sLine = lines.find(l => l.startsWith('s='));
  if (sLine) streamName = sLine.substring(2).trim();

  // Deduplicate discovery updates (throttle to 1 update per 10s per stream)
  const dedupKey = `${rinfo.address}-${streamName}`;
  const now = Date.now();
  if (sapDedupe.has(dedupKey) && (now - (sapDedupe.get(dedupKey) || 0)) < 10000) {
    return;
  }
  sapDedupe.set(dedupKey, now);

  const discoveryMsg = JSON.stringify({
    type: 'aes67_discovery',
    name: streamName,
    address: rinfo.address
  });

  connectedWsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(discoveryMsg);
    }
  });
});

try {
  sapClient.bind(SAP_PORT);
} catch (e) {
  console.error("Failed to bind SAP port (might require root or cap_net_admin):", e);
}


// Merges an incoming (possibly partial) mapping payload on top of whatever is
// currently persisted, so a client that only touched one channel can never
// wipe out every other channel's routing. Also rejects any channel id that
// isn't a real channel number before it's written to disk.
function mergePatchbayMappings(incoming: any): Record<string, any> {
  let merged: Record<string, any> = { ...DEFAULT_PATCHBAY_MAPPINGS };
  try {
    if (fs.existsSync(PATCHBAY_CONFIG_PATH)) {
      merged = JSON.parse(fs.readFileSync(PATCHBAY_CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading existing patchbay config, starting fresh', e);
    merged = { ...DEFAULT_PATCHBAY_MAPPINGS };
  }

  if (!incoming || typeof incoming !== 'object') return merged;

  for (const rawChId in incoming) {
    const chId = Number(rawChId);
    if (!Number.isInteger(chId) || chId < 1 || chId > NUM_CHANNELS) {
      console.error(`Rejected invalid patchbay channel id in sync: ${JSON.stringify(rawChId)}`);
      continue;
    }
    merged[String(chId)] = incoming[rawChId];
  }

  return merged;
}

// The Monitor bus's destination — "the system's audio out device" so the
// operator hears the mix locally. Not user-editable (Monitor never appears in
// output_routing.json); Master and the Aux buses have no forced default of
// their own and are freely mapped to any destination via Output Endpoints.
//
// Resolved from the live graph at routing time rather than hardcoded, so the
// dev workstation and the ck-aes67 appliance each land on their own on-board
// analog output — the jack the operator plugs headphones into — with no
// per-host build. `DECK_MONITOR_PORTS="node:portL,node:portR"` pins it.
const MONITOR_FALLBACK_PORTS: [string, string] = [
  'alsa_output.pci-0000_00_1b.0.analog-stereo:playback_FL', // ck-aes67 on-board PCH
  'alsa_output.pci-0000_00_1b.0.analog-stereo:playback_FR',
];

// A usable local monitor sink is a real ALSA analog output — not the AES67
// network / RAVENNA bridge (Monitor would go on the wire or loop into the
// deck's own input), not the "AES67 System Audio" virtual sink, and not an
// HDMI/SPDIF digital port (no headphone jack behind it).
function isLocalHardwareSink(node: string): boolean {
  return node.startsWith('alsa_output.')
    && !/aes67|ravenna|hdmi|iec958|spdif|\.monitor$/i.test(node);
}

// Rank candidate hardware sinks so the headphone / on-board analog output
// wins over a USB DAC, a dock, or a second card's line-out.
function monitorSinkScore(node: string): number {
  let s = 0;
  if (/head[\s._-]?phone/i.test(node)) s += 1000; // explicit headphone route
  if (/analog/i.test(node))            s += 200;  // analog-stereo etc.
  if (/\.pci-/i.test(node))            s += 60;   // on-board / PCI codec
  if (/pro-output/i.test(node))        s += 20;   // Pro profile: raw AUX0/1
  if (/\.usb-/i.test(node))            s += 10;   // USB DAC — usable, lower
  return s;
}

// The L/R pair of a sink node: prefer front L/R, then AUX0/1, then the first
// two ports (avoids grabbing FC/LFE off a surround card).
function stereoPairOf(ports: string[]): [string, string] | [string] | null {
  const bySuffix = (suf: string) => ports.find((p) => new RegExp(`[:_]${suf}$`).test(p));
  const fl = bySuffix('FL'), fr = bySuffix('FR');
  if (fl && fr) return [fl, fr];
  const a0 = bySuffix('AUX0'), a1 = bySuffix('AUX1');
  if (a0 && a1) return [a0, a1];
  if (ports.length >= 2) return [ports[0], ports[1]];
  if (ports.length === 1) return [ports[0]];
  return null;
}

async function resolveMonitorOutputPorts(): Promise<[string, string]> {
  const pins = (process.env.DECK_MONITOR_PORTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (pins.length >= 2) return [pins[0], pins[1]];
  if (pins.length === 1) return [pins[0], pins[0]];

  const inPorts = (await runCmd('pw-link', ['-i']))
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const portsOf = (node: string) => inPorts.filter((p) => p.startsWith(node + ':')).sort();

  const nodes = new Set<string>();
  for (const p of inPorts) {
    const node = p.slice(0, p.lastIndexOf(':'));
    if (isLocalHardwareSink(node)) nodes.add(node);
  }
  const ranked = [...nodes].sort(
    (a, b) => monitorSinkScore(b) - monitorSinkScore(a) || a.localeCompare(b));

  for (const node of ranked) {
    const pair = stereoPairOf(portsOf(node));
    if (pair) return pair.length === 2 ? [pair[0], pair[1]] : [pair[0], pair[0]];
  }

  console.warn('resolveMonitorOutputPorts: no local analog sink in the graph — using fallback');
  return MONITOR_FALLBACK_PORTS;
}

// A bus's output-endpoint assignment: the destination ports plus whether
// they carry an identical mono downmix rather than a distinct L/R pair.
// `mono` only means something when there are 2+ ports — a single-port
// endpoint is inherently mono either way, `mono` or not.
interface OutputEndpoint {
  ports: string[];
  mono?: boolean;
}

function isOutputEndpoint(v: any): v is OutputEndpoint {
  return v && typeof v === 'object' && Array.isArray(v.ports) && v.ports.every((p: any) => typeof p === 'string');
}

// Merges an incoming (possibly partial) output-endpoint payload for Master
// (100) and the 8 Aux buses (101..108) on top of whatever is currently
// persisted, so a client that only touched one bus can't wipe the rest.
function mergeOutputRouting(incoming: any): Record<string, OutputEndpoint> {
  let merged: Record<string, OutputEndpoint> = {};
  try {
    if (fs.existsSync(OUTPUT_ROUTING_PATH)) {
      const raw = JSON.parse(fs.readFileSync(OUTPUT_ROUTING_PATH, 'utf8'));
      for (const busId in raw) {
        const v = raw[busId];
        if (Array.isArray(v) && v.every((p: any) => typeof p === 'string')) {
          // Config written before mono output support existed — a bare
          // port list was always the stereo pairing.
          merged[busId] = { ports: v };
        } else if (isOutputEndpoint(v)) {
          merged[busId] = { ports: v.ports, mono: !!v.mono };
        }
      }
    }
  } catch (e) {
    console.error('Error reading existing output routing config, starting fresh', e);
    merged = {};
  }

  if (incoming && typeof incoming === 'object') {
    for (const rawBusId in incoming) {
      const busId = Number(rawBusId);
      if (!Number.isInteger(busId) || busId < MASTER_ID || busId > MASTER_ID + NUM_AUX) {
        console.error(`Rejected invalid output bus id in sync: ${JSON.stringify(rawBusId)}`);
        continue;
      }
      const entry = incoming[rawBusId];
      if (!isOutputEndpoint(entry)) {
        console.error(`Rejected invalid output endpoint for bus ${busId}`);
        continue;
      }
      if (entry.ports.length === 0) {
        // Explicit empty list clears this bus's assignment.
        delete merged[String(busId)];
      } else {
        merged[String(busId)] = { ports: entry.ports, mono: !!entry.mono };
      }
    }
  }

  return merged;
}

function getOutputRouting(): Record<string, OutputEndpoint> {
  return mergeOutputRouting(null);
}

function getPatchbayMappings(): Record<string, any> {
  return mergePatchbayMappings(null);
}

// Runs pw-link with an argv array (never a shell string) so no piece of a
// mapping can ever be interpreted as shell syntax. Failures (e.g. "link
// already exists" / "no such link") are expected and ignored.
function pwLink(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile('pw-link', args, () => resolve());
  });
}

function listPwLinks(): Promise<string> {
  return new Promise((resolve) => {
    execFile('pw-link', ['-l'], (err, stdout) => resolve(err ? '' : stdout));
  });
}

// Parses `pw-link -l` output (each output port listed as a bare line,
// followed by indented "|-> <input port>" lines for each of its current
// connections) to find who is currently feeding a given input port.
async function findLinksTo(inputPort: string): Promise<string[]> {
  const stdout = await listPwLinks();
  const sources: string[] = [];
  let currentOutput: string | null = null;
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    if (!/^\s/.test(rawLine)) {
      currentOutput = rawLine.trim();
    } else {
      const m = rawLine.match(/\|->\s*(.+)$/);
      if (m && currentOutput && m[1].trim() === inputPort) {
        sources.push(currentOutput);
      }
    }
  }
  return sources;
}

// Same idea in the other direction: finds what a given output port currently
// feeds.
async function findLinksFrom(outputPort: string): Promise<string[]> {
  const stdout = await listPwLinks();
  const dests: string[] = [];
  let capturing = false;
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    if (!/^\s/.test(rawLine)) {
      capturing = rawLine.trim() === outputPort;
    } else if (capturing) {
      const m = rawLine.match(/\|->\s*(.+)$/);
      if (m) dests.push(m[1].trim());
    }
  }
  return dests;
}

async function disconnectAllInputsOf(inputPort: string) {
  const sources = await findLinksTo(inputPort);
  for (const src of sources) {
    await pwLink(['-d', src, inputPort]);
  }
}

async function disconnectAllOutputsOf(outputPort: string) {
  const dests = await findLinksFrom(outputPort);
  for (const dest of dests) {
    await pwLink(['-d', outputPort, dest]);
  }
}

// Resolves which real PipeWire ports feed a channel mapping. Prefers the
// explicit `sourcePorts` the UI resolved from its stream registry (so any
// discovered/manual AES67 stream can be routed, not just one hardcoded
// name); falls back to the original hardcoded loopback for mapping entries
// persisted before per-stream ports existed.
function resolveSourcePorts(m: any): string[] | null {
  if (Array.isArray(m.sourcePorts) && m.sourcePorts.length > 0 && m.sourcePorts.every((p: any) => typeof p === 'string')) {
    return m.sourcePorts;
  }
  if (m.sourceStreamId === 'system-audio-loopback') {
    return ['AES67_System_Audio_Loopback:output_FL', 'AES67_System_Audio_Loopback:output_FR'];
  }
  return null;
}

async function handlePatchbaySync(mappings: any) {
  if (!mappings || typeof mappings !== 'object') return;

  for (let i = 1; i <= NUM_CHANNELS; i++) {
    await disconnectAllInputsOf(`AES67_Deck:in_${i}_L`);
    await disconnectAllInputsOf(`AES67_Deck:in_${i}_R`);
  }

  for (const rawChId in mappings) {
    // Channel ids are only ever used to build JACK/PipeWire port names
    // below, so reject anything that isn't a real channel number before
    // it touches a subprocess argument.
    const chId = Number(rawChId);
    if (!Number.isInteger(chId) || chId < 1 || chId > NUM_CHANNELS) {
      console.error(`Rejected invalid patchbay channel id: ${JSON.stringify(rawChId)}`);
      continue;
    }

    const m = mappings[rawChId];
    if (!m) continue;
    const ports = resolveSourcePorts(m);
    if (!ports) continue;

    const targetL = `AES67_Deck:in_${chId}_L`;
    const targetR = `AES67_Deck:in_${chId}_R`;

    if (m.sourceChannel === 0 && ports.length >= 2) {
      // Stereo mapping
      await pwLink([ports[0], targetL]);
      await pwLink([ports[1], targetR]);
    } else if (typeof m.sourceChannel === 'number' && m.sourceChannel >= 1) {
      const port = ports[m.sourceChannel - 1];
      if (port) {
        await pwLink([port, targetL]);
        await pwLink([port, targetR]); // mono to both
      }
    }
  }

  console.log('Patchbay matrix applied successfully');
}

// Applies Master (100) and each of the 8 Aux buses' (101..108) output
// endpoint assignment. Unlike Monitor, neither has a forced default — if
// nothing is assigned, that bus just isn't routed anywhere.
async function applyOutputRouting(routing: Record<string, OutputEndpoint>) {
  for (let busId = MASTER_ID; busId <= MASTER_ID + NUM_AUX; busId++) {
    const outL = busId === MASTER_ID ? 'AES67_Deck:out_L' : `AES67_Deck:bus_${busId}_L`;
    const outR = busId === MASTER_ID ? 'AES67_Deck:out_R' : `AES67_Deck:bus_${busId}_R`;

    await disconnectAllOutputsOf(outL);
    await disconnectAllOutputsOf(outR);

    const entry = routing[String(busId)];
    if (!entry || entry.ports.length === 0) continue;

    if (entry.mono) {
      // Mono: every destination port gets the identical downmix — both bus
      // channels feed each port, rather than a distinct L/R pairing.
      for (const p of entry.ports) {
        await pwLink([outL, p]);
        await pwLink([outR, p]);
      }
    } else if (entry.ports.length >= 2) {
      await pwLink([outL, entry.ports[0]]);
      await pwLink([outR, entry.ports[1]]);
    } else {
      await pwLink([outL, entry.ports[0]]);
      await pwLink([outR, entry.ports[0]]);
    }
  }

  console.log('Output routing applied successfully');
}

// Monitor's destination is fixed, not user-editable: it always goes to the
// system's local audio out device so the operator can hear the mix.
async function applyMonitorRouting() {
  const [L, R] = await resolveMonitorOutputPorts();
  await disconnectAllOutputsOf('AES67_Deck:monitor_L');
  await disconnectAllOutputsOf('AES67_Deck:monitor_R');
  await pwLink(['AES67_Deck:monitor_L', L]);
  await pwLink(['AES67_Deck:monitor_R', R]);
  console.log(`Monitor routing applied → ${L} / ${R}`);
}

// Phase 2: pin each engine mix-product output port to its fixed AES67_Sink
// playout channel (TX_SOURCE_PLAN). Idempotent; only removes stale links from
// those engine ports to a *different* AES67_Sink channel — Output-Endpoint
// links target other nodes and are left alone. MUST run after
// applyOutputRouting / applyMonitorRouting in any block that also touches
// these ports: those do a blanket disconnectAllOutputsOf on out_/bus_/monitor_
// and would otherwise tear this map down.
async function applyBroadcastRouting() {
  for (const g of TX_SOURCE_PLAN) {
    for (let i = 0; i < g.enginePorts.length; i++) {
      const src = `AES67_Deck:${g.enginePorts[i]}`;
      const dst = `AES67_Sink:playback_AUX${g.map[i]}`;
      for (const d of await findLinksFrom(src)) {
        if (d.startsWith('AES67_Sink:') && d !== dst) await pwLink(['-d', src, d]);
      }
      await pwLink([src, dst]);
    }
  }
  console.log('Broadcast routing applied successfully');
}

// Wires the talkback mic's configured source ports to the engine's dedicated
// talkback_L/R input. This is the source side only — where the resulting
// audio goes (Master or an Aux bus, never Monitor) is the engine's own
// `talkback.dest_bus_id`, set via the `set_talkback_dest` IPC command.
async function applyTalkbackRouting(cfg: TalkbackConfig) {
  if (cfg.micSourceName && cfg.micAlsaPortName) {
    // The PipeWire graph ports (cfg.sourcePorts) are the same regardless of
    // which physical input is selected — switching to e.g. an external mic
    // jack instead of the internal mic is an ALSA-level routing choice on
    // the source itself, so it needs its own command.
    await new Promise<void>((resolve) => {
      execFile('pactl', ['set-source-port', cfg.micSourceName as string, cfg.micAlsaPortName as string], () => resolve());
    });
  }

  await disconnectAllInputsOf('AES67_Deck:talkback_L');
  await disconnectAllInputsOf('AES67_Deck:talkback_R');

  if (cfg.sourcePorts.length >= 2) {
    await pwLink([cfg.sourcePorts[0], 'AES67_Deck:talkback_L']);
    await pwLink([cfg.sourcePorts[1], 'AES67_Deck:talkback_R']);
  } else if (cfg.sourcePorts.length === 1) {
    await pwLink([cfg.sourcePorts[0], 'AES67_Deck:talkback_L']);
    await pwLink([cfg.sourcePorts[0], 'AES67_Deck:talkback_R']);
  }

  console.log('Talkback routing applied successfully');
}

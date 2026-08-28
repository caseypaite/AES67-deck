// Timecode formatting (plan/daw-timeline-roadmap.md Phase 3d).
// Server-side SMPTE string helpers — used to stamp take.json and the loudness
// compliance report. Mirrors the engine's Timecode.cpp numbering.

export type TcFps = 24 | 25 | 30;

export interface TimecodeConfig {
  source: 'project' | 'tod';
  fps: TcFps;
  df: boolean;                // 29.97 drop-frame (fps 30 only)
  offsetFrames: number;       // project-zero -> TC start, in TC frames
  ltcGen: boolean;
  ltcLevel: number;           // 0..1
  mtcGen: boolean;
  ltcChase: boolean;
}

export const TIMECODE_DEFAULTS: TimecodeConfig = {
  source: 'project',
  fps: 30,
  df: false,
  offsetFrames: 0,
  ltcGen: false,
  ltcLevel: 0.35,
  mtcGen: false,
  ltcChase: false,
};

function pad(n: number, w = 2): string {
  return Math.floor(n).toString().padStart(w, '0');
}

// Effective seconds of audio per TC frame (29.97 for drop-frame).
export function srPerTcFrame(sr: number, fps: TcFps, df: boolean): number {
  if (df && fps === 30) return (sr * 1001) / 30000;
  return sr / fps;
}

export function framesToSmpte(frame: number, fps: TcFps, df: boolean): string {
  frame = Math.max(0, Math.round(frame));
  if (df && fps === 30) {
    const d = Math.floor(frame / 17982);
    let mo = frame % 17982;
    if (mo < 2) mo += 2;
    frame += 18 * d + 2 * Math.floor((mo - 2) / 1798);
    const f = frame % 30;
    const s = Math.floor(frame / 30) % 60;
    const m = Math.floor(frame / 1800) % 60;
    const h = Math.floor(frame / 108000) % 24;
    return `${pad(h)}:${pad(m)}:${pad(s)};${pad(f)}`;
  }
  const f = frame % fps;
  const s = Math.floor(frame / fps) % 60;
  const m = Math.floor(frame / (60 * fps)) % 60;
  const h = Math.floor(frame / (3600 * fps)) % 24;
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

// The SMPTE string for a transport position (in audio frames) or, when the
// config source is time-of-day, for `todSec` (seconds past midnight UTC as
// reported by the engine on the metering `tc` key).
export function timecodeAt(
  cfg: TimecodeConfig,
  sr: number,
  transportFrame: number,
  todSec: number | null,
): string {
  const spf = srPerTcFrame(sr, cfg.fps, cfg.df);
  if (cfg.source === 'tod' && todSec != null) {
    return framesToSmpte(Math.round((todSec * sr) / spf), cfg.fps, cfg.df);
  }
  return framesToSmpte(Math.round(transportFrame / spf) + cfg.offsetFrames, cfg.fps, cfg.df);
}

import { create } from 'zustand';
import { wsSend } from '../lib/wsBus';

// Phase 3c — a lightweight local ring of BS.1770 samples for the timeline
// loudness-history strip. Fed from the engine `metering` frame (see
// useMixerStore's metering handler). The server keeps the authoritative CSV
// log; this store only backs the on-screen strip and the "export region
// report" action.

export interface LoudnessSample {
  sec: number;  // timeline position (engine frame / sr)
  m: number;    // momentary LUFS
  s: number;    // short-term LUFS
  i: number;    // integrated LUFS
  tp: number;   // true-peak dBTP
}

const CAP = 2400;              // ~40 min at 1 Hz
const MIN_INTERVAL_MS = 950;   // in-store throttle so it matches the server's 1 Hz

interface LoudnessState {
  samples: LoudnessSample[];
  target: number;              // -14 | -23 | -24
  logWhileStopped: boolean;
  _lastPushMs: number;

  push: (sample: LoudnessSample, rolling: boolean) => void;
  seed: (points: Array<{ sec: number; m: number; s: number; i: number; tp: number }>, target?: number) => void;
  clear: () => void;
  applyConfig: (cfg: { target?: number; logWhileStopped?: boolean }) => void;
  setTarget: (target: number) => void;
  setLogWhileStopped: (v: boolean) => void;
}

export const useLoudnessStore = create<LoudnessState>((set, get) => ({
  samples: [],
  target: -14,
  logWhileStopped: false,
  _lastPushMs: 0,

  push: (sample, rolling) => {
    if (!rolling && !get().logWhileStopped) return;
    if (!Number.isFinite(sample.s) && !Number.isFinite(sample.i)) return;
    const now = performance.now();
    if (now - get()._lastPushMs < MIN_INTERVAL_MS) return;
    set((st) => {
      const next = st.samples.length >= CAP ? st.samples.slice(st.samples.length - CAP + 1) : st.samples.slice();
      next.push(sample);
      return { samples: next, _lastPushMs: now };
    });
  },

  seed: (points, target) => {
    const samples = (points || [])
      .filter((p) => p && Number.isFinite(p.sec))
      .slice(-CAP)
      .map((p) => ({ sec: p.sec, m: p.m, s: p.s, i: p.i, tp: p.tp }));
    set({ samples, ...(typeof target === 'number' ? { target } : {}) });
  },

  clear: () => set({ samples: [] }),

  applyConfig: (cfg) =>
    set({
      ...(typeof cfg.target === 'number' ? { target: cfg.target } : {}),
      ...(typeof cfg.logWhileStopped === 'boolean' ? { logWhileStopped: cfg.logWhileStopped } : {}),
    }),

  setTarget: (target) => {
    set({ target });
    wsSend({ type: 'set_loudness_config', target });
  },
  setLogWhileStopped: (v) => {
    set({ logWhileStopped: v });
    wsSend({ type: 'set_loudness_config', logWhileStopped: v });
  },
}));

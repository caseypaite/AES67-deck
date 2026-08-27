// Built-in FX-rack starter chains for common voice and instrument sources.
// Calf plugins only (Saturator / Compressor / De-Esser / 8-Band EQ / Vintage
// Delay / Reverb / Limiter / Crusher). Each chain is an ordered list the FX
// rack loads onto the selected channel; anything not set keeps the plugin's
// own .ttl default. Calf gain ports are linear coefficients (1.0 = 0 dB) —
// `db()` converts.

const SAT = 'http://calf.sourceforge.net/plugins/Saturator';
const CRU = 'http://calf.sourceforge.net/plugins/Crusher';
const COMP = 'http://calf.sourceforge.net/plugins/Compressor';
const DES = 'http://calf.sourceforge.net/plugins/Deesser';
const EQ8 = 'http://calf.sourceforge.net/plugins/Equalizer8Band';
const DLY = 'http://calf.sourceforge.net/plugins/VintageDelay';
const REV = 'http://calf.sourceforge.net/plugins/Reverb';
const LIM = 'http://calf.sourceforge.net/plugins/Limiter';

const db = (x: number) => Math.pow(10, x / 20);

export type FxChainGroup = 'Vocals' | 'Instruments';

export interface FxChain {
  id: string;
  name: string;
  group: FxChainGroup;
  desc: string;
  plugins: { uri: string; params: Record<string, number> }[];
}

// ─── chain building blocks ──────────────────────────────────────────────────

interface EqBand { freq: number; gain?: number; q?: number }
interface EqSpec {
  hp?: number; hpSlope?: 0 | 1 | 2;
  ls?: EqBand; b1?: EqBand; b2?: EqBand; b3?: EqBand; b4?: EqBand; hs?: EqBand;
  lp?: number; lpSlope?: 0 | 1 | 2;
}
const eq = (o: EqSpec) => {
  const p: Record<string, number> = {};
  if (o.hp) { p.hp_active = 1; p.hp_freq = o.hp; p.hp_mode = o.hpSlope ?? 1; }
  const band = (pre: string, b?: EqBand) => {
    if (!b) return;
    p[`${pre}_active`] = 1;
    p[`${pre}_freq`] = b.freq;
    if (b.gain !== undefined) p[`${pre}_level`] = db(b.gain);
    if (b.q !== undefined) p[`${pre}_q`] = b.q;
  };
  band('ls', o.ls); band('p1', o.b1); band('p2', o.b2); band('p3', o.b3); band('p4', o.b4); band('hs', o.hs);
  if (o.lp) { p.lp_active = 1; p.lp_freq = o.lp; p.lp_mode = o.lpSlope ?? 1; }
  return { uri: EQ8, params: p };
};

const comp = (o: {
  thr: number; ratio: number; attack?: number; release?: number;
  makeup?: number; mix?: number; knee?: number; peak?: boolean;
}) => ({
  uri: COMP,
  params: {
    threshold: db(o.thr), ratio: o.ratio,
    attack: o.attack ?? 15, release: o.release ?? 150,
    knee: o.knee ?? 2.8, makeup: db(o.makeup ?? 0), mix: o.mix ?? 1,
    detection: o.peak ? 1 : 0, stereo_link: 1,
  },
});

const deess = (o: { freq?: number; thr?: number; ratio?: number }) => ({
  uri: DES,
  params: {
    mode: 1, detection: 1,
    f1_freq: (o.freq ?? 6500) - 700, f2_freq: o.freq ?? 6500, f2_q: 2.5,
    threshold: db(o.thr ?? -22), ratio: o.ratio ?? 3.5,
  },
});

const sat = (o: {
  drive?: number; mix?: number; blend?: number;
  toneFreq?: number; toneAmt?: number; postLp?: number; outDb?: number;
}) => ({
  uri: SAT,
  params: {
    drive: o.drive ?? 2, blend: o.blend ?? 6, mix: o.mix ?? 0.4,
    ...(o.toneFreq ? { p_freq: o.toneFreq, p_level: db(o.toneAmt ?? 0), p_q: 1 } : {}),
    ...(o.postLp ? { post: 1, lp_post_freq: o.postLp } : {}),
    level_in: 1, level_out: db(o.outDb ?? -1),
  },
});

const rev = (o: {
  decay?: number; size?: 0 | 1 | 2 | 3 | 4 | 5; predelay?: number;
  wet?: number; hfDamp?: number; bassCut?: number;
}) => ({
  uri: REV,
  params: {
    decay_time: o.decay ?? 1.4, room_size: o.size ?? 2, predelay: o.predelay ?? 12,
    diffusion: 0.6, hf_damp: o.hfDamp ?? 6000, bass_cut: o.bassCut ?? 200, treble_cut: 8000,
    amount: o.wet ?? 0.22, dry: 1,
  },
});

const delay = (o: {
  subdiv?: number; timeL?: number; timeR?: number; fb?: number;
  wet?: number; pingpong?: boolean;
}) => ({
  uri: DLY,
  params: {
    bpm: 120, subdiv: o.subdiv ?? 16, time_l: o.timeL ?? 3, time_r: o.timeR ?? 4,
    timing: 0, feedback: o.fb ?? 0.2, amount: o.wet ?? 0.2, dry: 1,
    width: 1, mix_mode: o.pingpong ? 1 : 0, medium: 1,
  },
});

const crush = (o: { bits?: number; samples?: number; mix?: number }) => ({
  uri: CRU,
  params: { bits: o.bits ?? 12, samples: o.samples ?? 2, morph: 0.4, mode: 0, mix: o.mix ?? 0.5, level_in: 1, level_out: 1 },
});

const lim = (o: { ceil?: number; release?: number } = {}) => ({
  uri: LIM,
  params: {
    limit: db(o.ceil ?? -0.5), attack: 4, release: o.release ?? 60,
    asc: 1, asc_coeff: 0.5, oversampling: 2, auto_level: 1,
  },
});

// ─── chains ─────────────────────────────────────────────────────────────────

export const FX_CHAINS: FxChain[] = [
  // ── Vocals ──
  {
    id: 'v-lead-pop', name: 'Lead Vocal · Pop', group: 'Vocals',
    desc: 'HPF, low-mid clean-up, presence + air, de-ess, 3:1 glue, a touch of saturation.',
    plugins: [
      eq({ hp: 90, b1: { freq: 300, gain: -2, q: 1.2 }, b3: { freq: 4000, gain: 2.5, q: 1.2 }, hs: { freq: 12000, gain: 2.5, q: 0.7 } }),
      deess({ freq: 6800, thr: -20, ratio: 4 }),
      comp({ thr: -18, ratio: 3, attack: 8, release: 120, makeup: 3, knee: 2 }),
      sat({ drive: 1.6, mix: 0.25, outDb: -0.5 }),
    ],
  },
  {
    id: 'v-lead-warm', name: 'Lead Vocal · Warm', group: 'Vocals',
    desc: 'Tape-style saturation, low-mid body, gentle 2:1 compression, intimate short reverb.',
    plugins: [
      sat({ drive: 2.5, mix: 0.35, postLp: 16000, outDb: -1 }),
      eq({ hp: 80, ls: { freq: 200, gain: 1.5, q: 0.8 }, b2: { freq: 450, gain: 1, q: 0.9 }, hs: { freq: 10000, gain: -1, q: 0.7 } }),
      comp({ thr: -20, ratio: 2, attack: 25, release: 200, makeup: 2 }),
      rev({ decay: 1.6, size: 2, wet: 0.18, hfDamp: 5000 }),
    ],
  },
  {
    id: 'v-vo-male', name: 'Voiceover · Male', group: 'Vocals',
    desc: 'Proximity tame, mud cut, firm 4:1 fast compression for consistency, safe limiter.',
    plugins: [
      eq({ hp: 80, ls: { freq: 120, gain: -1.5, q: 0.7 }, b1: { freq: 300, gain: -2.5, q: 1.4 }, b3: { freq: 4500, gain: 2, q: 1 }, hs: { freq: 11000, gain: 1.5 } }),
      deess({ freq: 6200, thr: -22, ratio: 4 }),
      comp({ thr: -20, ratio: 4, attack: 5, release: 90, makeup: 4, knee: 1.5, peak: true }),
      lim({ ceil: -1, release: 100 }),
    ],
  },
  {
    id: 'v-vo-female', name: 'Voiceover · Female', group: 'Vocals',
    desc: 'Higher HPF, stronger de-ess (7 kHz), 3.5:1 compression, presence + air, safe limiter.',
    plugins: [
      eq({ hp: 100, b1: { freq: 350, gain: -2, q: 1.3 }, b3: { freq: 5000, gain: 2, q: 1 }, hs: { freq: 12000, gain: 2 } }),
      deess({ freq: 7200, thr: -24, ratio: 5 }),
      comp({ thr: -19, ratio: 3.5, attack: 6, release: 90, makeup: 3.5, peak: true }),
      lim({ ceil: -1, release: 100 }),
    ],
  },
  {
    id: 'v-rap', name: 'Rap / Hip-Hop Vocal', group: 'Vocals',
    desc: 'Aggressive fast 6:1 compression (85% wet), bright EQ, grit saturation, tight slap, hard ceiling.',
    plugins: [
      eq({ hp: 90, b1: { freq: 250, gain: -2, q: 1.2 }, b3: { freq: 3500, gain: 2, q: 1 }, hs: { freq: 10000, gain: 2 } }),
      comp({ thr: -22, ratio: 6, attack: 3, release: 70, makeup: 5, knee: 1.5, mix: 0.85, peak: true }),
      sat({ drive: 2.4, mix: 0.4, outDb: -0.5 }),
      delay({ subdiv: 16, timeL: 3, timeR: 3, fb: 0.12, wet: 0.15 }),
      lim({ ceil: -0.3, release: 40 }),
    ],
  },
  {
    id: 'v-bgv', name: 'Backing Vocals', group: 'Vocals',
    desc: 'Tucked-back EQ (dip 3 kHz), 3:1 compression, wide medium plate to sit behind the lead.',
    plugins: [
      eq({ hp: 130, b2: { freq: 500, gain: -1.5, q: 1 }, b3: { freq: 3000, gain: -2, q: 1.2 }, hs: { freq: 11000, gain: 1 } }),
      comp({ thr: -20, ratio: 3, attack: 10, release: 150, makeup: 3 }),
      rev({ decay: 2.2, size: 2, wet: 0.32, predelay: 20 }),
    ],
  },
  {
    id: 'v-announcer', name: 'Announcer / Broadcast', group: 'Vocals',
    desc: 'Heavy 5:1 leveling for a forward, even read; proximity tame, presence lift, true-peak safe.',
    plugins: [
      eq({ hp: 90, ls: { freq: 150, gain: -2, q: 0.7 }, b1: { freq: 350, gain: -2, q: 1.3 }, b3: { freq: 4000, gain: 2.5, q: 1 }, hs: { freq: 10000, gain: 1.5 } }),
      deess({ freq: 6500, thr: -20, ratio: 4 }),
      comp({ thr: -24, ratio: 5, attack: 4, release: 80, makeup: 6, knee: 1.5, peak: true }),
      lim({ ceil: -1, release: 120 }),
    ],
  },
  {
    id: 'v-telephone', name: 'Telephone / Lo-Fi FX', group: 'Vocals',
    desc: 'Band-limited 400 Hz–3 kHz, mid honk, drive + light bit/sample crush for a distant, radio-comm effect.',
    plugins: [
      eq({ hp: 400, hpSlope: 1, b2: { freq: 1500, gain: 4, q: 1.5 }, lp: 3000, lpSlope: 1 }),
      sat({ drive: 4, mix: 0.6, outDb: -2 }),
      crush({ bits: 12, samples: 2, mix: 0.5 }),
      comp({ thr: -18, ratio: 4, attack: 5, release: 80, makeup: 3 }),
    ],
  },

  // ── Instruments ──
  {
    id: 'i-ac-guitar', name: 'Acoustic Guitar', group: 'Instruments',
    desc: 'Tame boom + box, sparkle above 8 kHz, gentle 2.5:1 compression, small room.',
    plugins: [
      eq({ hp: 70, b1: { freq: 180, gain: -2, q: 1 }, b2: { freq: 450, gain: -1.5, q: 1.3 }, b4: { freq: 8000, gain: 2, q: 0.8 }, hs: { freq: 12000, gain: 1.5 } }),
      comp({ thr: -18, ratio: 2.5, attack: 20, release: 180, makeup: 2 }),
      rev({ decay: 1.3, size: 1, wet: 0.15 }),
    ],
  },
  {
    id: 'i-el-guitar', name: 'Electric Guitar', group: 'Instruments',
    desc: 'Mid focus ~1.2 kHz, fizz tamed with a 10 kHz LPF, light leveling, warmth saturation.',
    plugins: [
      eq({ hp: 90, b2: { freq: 1200, gain: 1.5, q: 0.9 }, b3: { freq: 3000, gain: -2, q: 1.5 }, lp: 10000 }),
      comp({ thr: -16, ratio: 2, attack: 25, release: 150, makeup: 1.5 }),
      sat({ drive: 2, mix: 0.35, outDb: -1 }),
    ],
  },
  {
    id: 'i-bass-di', name: 'Bass Guitar / DI', group: 'Instruments',
    desc: 'Deep HPF at 35 Hz, mud cut ~250, punch ~800, firm 4:1 compression, harmonic saturation — no reverb.',
    plugins: [
      eq({ hp: 35, b1: { freq: 250, gain: -2, q: 1.2 }, b2: { freq: 800, gain: 1.5, q: 0.9 }, b4: { freq: 2500, gain: 1, q: 1 } }),
      comp({ thr: -20, ratio: 4, attack: 15, release: 120, makeup: 4, knee: 2 }),
      sat({ drive: 2.2, mix: 0.3, toneFreq: 1200, toneAmt: 1, outDb: -0.5 }),
    ],
  },
  {
    id: 'i-kick', name: 'Kick Drum', group: 'Instruments',
    desc: 'Sub thump ~65, scoop the box ~380, beater click ~4 kHz, punchy 4:1 peak compression + drive.',
    plugins: [
      eq({ hp: 30, b1: { freq: 65, gain: 3, q: 1 }, b2: { freq: 380, gain: -4, q: 1.6 }, b4: { freq: 4000, gain: 3, q: 1.2 } }),
      comp({ thr: -16, ratio: 4, attack: 8, release: 120, makeup: 3, knee: 1.5, peak: true }),
      sat({ drive: 2, mix: 0.3, outDb: -0.5 }),
    ],
  },
  {
    id: 'i-snare', name: 'Snare Drum', group: 'Instruments',
    desc: 'Body ~200, crack ~5 kHz, 3:1 compression, drive, short bright plate.',
    plugins: [
      eq({ hp: 90, b1: { freq: 200, gain: 2, q: 1 }, b3: { freq: 5000, gain: 3, q: 1 }, hs: { freq: 12000, gain: 1.5 } }),
      comp({ thr: -18, ratio: 3, attack: 12, release: 130, makeup: 3 }),
      sat({ drive: 1.8, mix: 0.3, outDb: -0.5 }),
      rev({ decay: 1.1, size: 1, predelay: 8, wet: 0.2, hfDamp: 7000 }),
    ],
  },
  {
    id: 'i-overheads', name: 'Drum Overheads', group: 'Instruments',
    desc: 'HPF 250, cymbal harshness dipped ~3.5 kHz, air lift, gentle 2:1 compression, light room.',
    plugins: [
      eq({ hp: 250, hpSlope: 1, b3: { freq: 3500, gain: -2.5, q: 1.4 }, hs: { freq: 13000, gain: 2 } }),
      comp({ thr: -18, ratio: 2, attack: 20, release: 200, makeup: 1.5 }),
      rev({ decay: 1.4, size: 2, wet: 0.12 }),
    ],
  },
  {
    id: 'i-drum-bus', name: 'Drum Bus Glue', group: 'Instruments',
    desc: 'Tilt EQ (low weight + air), slow 2:1 glue compression, subtle drive, protective limiter.',
    plugins: [
      eq({ hp: 30, ls: { freq: 80, gain: 1, q: 0.7 }, b2: { freq: 500, gain: -1.5, q: 1 }, hs: { freq: 12000, gain: 1.5 } }),
      comp({ thr: -18, ratio: 2, attack: 30, release: 200, makeup: 2, knee: 3 }),
      sat({ drive: 1.6, mix: 0.25, outDb: -0.5 }),
      lim({ ceil: -0.5, release: 60 }),
    ],
  },
  {
    id: 'i-piano', name: 'Piano', group: 'Instruments',
    desc: 'HPF 40, low-mid control, gentle presence + air, light 2:1 compression, subtle reverb.',
    plugins: [
      eq({ hp: 40, b1: { freq: 200, gain: -1.5, q: 1 }, b3: { freq: 5000, gain: 1.5, q: 0.8 }, hs: { freq: 12000, gain: 1.5 } }),
      comp({ thr: -18, ratio: 2, attack: 25, release: 250, makeup: 1.5 }),
      rev({ decay: 1.6, size: 2, wet: 0.16 }),
    ],
  },
  {
    id: 'i-strings-pads', name: 'Strings / Pads', group: 'Instruments',
    desc: 'HPF 80, dip ~1.5 kHz, air, slow 2:1 compression, long lush hall.',
    plugins: [
      eq({ hp: 80, b2: { freq: 1500, gain: -1.5, q: 1 }, hs: { freq: 11000, gain: 2 } }),
      comp({ thr: -20, ratio: 2, attack: 40, release: 300, makeup: 1.5 }),
      rev({ decay: 3.5, size: 4, wet: 0.4, predelay: 30 }),
    ],
  },
  {
    id: 'i-brass', name: 'Brass Section', group: 'Instruments',
    desc: 'HPF 90, blare tamed ~2.5 kHz, presence ~5.5 kHz, firm 4:1 peak compression, medium room.',
    plugins: [
      eq({ hp: 90, b3: { freq: 2500, gain: -3, q: 1.3 }, b4: { freq: 5500, gain: 2, q: 1 }, hs: { freq: 11000, gain: 1 } }),
      comp({ thr: -18, ratio: 4, attack: 10, release: 120, makeup: 3, peak: true }),
      rev({ decay: 1.5, size: 2, wet: 0.18 }),
    ],
  },
  {
    id: 'i-synth-lead', name: 'Synth Lead / Keys', group: 'Instruments',
    desc: 'HPF 60, harsh ~2.5 kHz dip, light compression, warmth, ping-pong delay + reverb.',
    plugins: [
      eq({ hp: 60, b3: { freq: 2500, gain: -2, q: 1.4 }, hs: { freq: 11000, gain: 1.5 } }),
      comp({ thr: -16, ratio: 2, attack: 20, release: 150, makeup: 1.5 }),
      sat({ drive: 2, mix: 0.3, outDb: -1 }),
      delay({ subdiv: 8, timeL: 3, timeR: 5, fb: 0.3, wet: 0.25, pingpong: true }),
      rev({ decay: 1.8, size: 2, wet: 0.2 }),
    ],
  },
  {
    id: 'i-percussion', name: 'Percussion', group: 'Instruments',
    desc: 'HPF 100, box cut ~500, presence ~6 kHz, fast 3:1 peak compression, tiny room.',
    plugins: [
      eq({ hp: 100, b2: { freq: 500, gain: -2, q: 1.4 }, b4: { freq: 6000, gain: 2, q: 1 }, hs: { freq: 12000, gain: 1 } }),
      comp({ thr: -18, ratio: 3, attack: 8, release: 100, makeup: 2, peak: true }),
      rev({ decay: 1, size: 1, wet: 0.15 }),
    ],
  },
];

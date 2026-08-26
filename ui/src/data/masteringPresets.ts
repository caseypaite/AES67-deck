// Built-in mastering chains for the Master / Monitor mastering panel. Each
// is a Calf plugin chain (8-Band EQ → Glue Compressor → Brick-wall Limiter,
// ± Saturator) with parameters modelled on widely-published mastering
// practice: streaming loudness-normalisation targets (Spotify/Apple/YouTube
// ≈ −14 LUFS, Tidal ≈ −14, AES streaming rec.), EBU R128 broadcast
// (−23 LUFS), club masters (≈ −8…−9 LUFS), and common tonal styles.
//
// Gain/level params for Calf are linear coefficients (1.0 = 0 dB); helper
// `db()` converts. Anything not listed keeps the plugin's own default.

const EQ = 'http://calf.sourceforge.net/plugins/Equalizer8Band';
const COMP = 'http://calf.sourceforge.net/plugins/Compressor';
const LIM = 'http://calf.sourceforge.net/plugins/Limiter';
const SAT = 'http://calf.sourceforge.net/plugins/Saturator';

const db = (x: number) => Math.pow(10, x / 20);

export interface MasteringPreset {
  id: string;
  name: string;
  desc: string;
  target: string; // loudness target label
  plugins: { uri: string; params: Record<string, number> }[];
}

// shared building blocks
const hp30 = { hp_active: 1, hp_freq: 30, hp_mode: 1, hp_q: 0.7 };
const glueComp = (thrDb: number, ratio: number, makeupDb: number) => ({
  uri: COMP,
  params: {
    threshold: db(thrDb), ratio, attack: 30, release: 250, knee: 3, makeup: db(makeupDb),
    mix: 1, detection: 0, stereo_link: 1,
  },
});
const limiter = (ceilDb: number, release: number, asc: number) => ({
  uri: LIM,
  params: { limit: db(ceilDb), attack: 5, release, asc, asc_coeff: 0.5, oversampling: 4, auto_level: 1 },
});

export const MASTERING_PRESETS: MasteringPreset[] = [
  {
    id: 'stream-14',
    name: 'Streaming −14',
    desc: 'Loudness-normalised target for Spotify / Apple / YouTube / Tidal. Gentle glue + safe −1 dBTP ceiling.',
    target: '−14 LUFS · −1 dBTP',
    plugins: [
      { uri: EQ, params: { ...hp30, ls_active: 1, ls_freq: 90, ls_level: db(0.8), hs_active: 1, hs_freq: 12000, hs_level: db(0.8) } },
      glueComp(-16, 1.8, 1.5),
      limiter(-1.0, 60, 1),
    ],
  },
  {
    id: 'broadcast-23',
    name: 'Broadcast R128',
    desc: 'EBU R128 / ATSC A/85 broadcast delivery. Wide dynamics, minimal limiting, −1 dBTP true-peak cap.',
    target: '−23 LUFS · −1 dBTP',
    plugins: [
      { uri: EQ, params: { ...hp30 } },
      glueComp(-20, 1.5, 0.5),
      limiter(-1.0, 100, 1),
    ],
  },
  {
    id: 'club-9',
    name: 'Club / Loud',
    desc: 'Competitive club master. Firm compression, tilted-bright EQ, hard limiting toward −8…−9 LUFS.',
    target: '≈ −8 LUFS · −0.3 dBTP',
    plugins: [
      { uri: EQ, params: { ...hp30, ls_active: 1, ls_freq: 60, ls_level: db(1.5), p1_active: 1, p1_freq: 300, p1_level: db(-1.5), p1_q: 1.2, hs_active: 1, hs_freq: 9000, hs_level: db(1.8) } },
      { uri: SAT, params: { drive: 2.2, blend: 6, mix: 0.35, level_in: 1, level_out: db(-0.5) } },
      glueComp(-12, 3, 3),
      limiter(-0.3, 30, 1),
    ],
  },
  {
    id: 'warm',
    name: 'Warm / Analog',
    desc: 'Tube-style saturation, low-mid weight, soft top. Rounded transients, easy loudness.',
    target: '≈ −12 LUFS',
    plugins: [
      { uri: SAT, params: { drive: 3, blend: 8, mix: 0.5, lp_post_freq: 17000, level_in: 1, level_out: db(-1) } },
      { uri: EQ, params: { ...hp30, ls_active: 1, ls_freq: 110, ls_level: db(1.2), p1_active: 1, p1_freq: 250, p1_level: db(1), p1_q: 0.9, hs_active: 1, hs_freq: 10000, hs_level: db(-1) } },
      glueComp(-15, 2, 1.5),
      limiter(-1.0, 80, 1),
    ],
  },
  {
    id: 'bright',
    name: 'Bright / Air',
    desc: 'Open high end and presence lift, tight low control. Adds sparkle without harshness.',
    target: '≈ −13 LUFS',
    plugins: [
      { uri: EQ, params: { hp_active: 1, hp_freq: 35, hp_mode: 1, hp_q: 0.7, p1_active: 1, p1_freq: 3500, p1_level: db(1), p1_q: 1, hs_active: 1, hs_freq: 11000, hs_level: db(2.5) } },
      glueComp(-16, 1.8, 1.5),
      limiter(-1.0, 50, 1),
    ],
  },
  {
    id: 'punchy',
    name: 'Punchy',
    desc: 'Transient-forward compression (slower attack), low-mid scoop, snappy limiter — for drums / band mixes.',
    target: '≈ −11 LUFS',
    plugins: [
      { uri: EQ, params: { ...hp30, p1_active: 1, p1_freq: 400, p1_level: db(-2), p1_q: 1.4, hs_active: 1, hs_freq: 8000, hs_level: db(1) } },
      { uri: COMP, params: { threshold: db(-14), ratio: 2.5, attack: 45, release: 180, knee: 2, makeup: db(2), mix: 0.85, detection: 1, stereo_link: 1 } },
      limiter(-0.5, 40, 1),
    ],
  },
  {
    id: 'transparent',
    name: 'Transparent',
    desc: 'Nothing but a clean oversampled brick-wall limiter at −1 dBTP. Preserve the mix, just cap peaks.',
    target: 'mix-dependent · −1 dBTP',
    plugins: [limiter(-1.0, 60, 0)],
  },
];

// Authoritative parameter maps for every Calf LV2 plugin in PLUGIN_REGISTRY.
//
// Every `symbol` here is the real LV2 control-port symbol straight from the
// plugin's .ttl in /usr/lib/lv2/calf.lv2/ — the UI sends these verbatim as
// param keys, and engine/src/main.cpp's remap_param_symbol() passes unknown
// (i.e. already-real) symbols through untouched. Ranges / defaults / units /
// tapers / enum labels are transcribed from the same .ttl files.
//
// Calf gain ports (`level_in`, `level_out`, `makeup`, threshold, shelf/band
// levels…) are *linear coefficients* where 1.0 == 0 dB. We store and send the
// coefficient (what the plugin wants) but drive the knob in dB — that's what
// taper: 'gain' means.
//
// The plugin's own `bypass` / `on` port is deliberately NOT listed: bypass is
// the engine-level dry passthrough (`set_plugin_bypass`), driven by the
// BYPASS button, not a rack parameter.

export type ParamTaper = 'linear' | 'log' | 'gain';
export type ParamKind = 'knob' | 'toggle' | 'enum';

export interface ParamSpec {
  symbol: string;
  label: string;
  group: string;
  kind: ParamKind;
  min: number;
  max: number;
  default: number;
  taper?: ParamTaper;      // knob only, default 'linear'
  unit?: 'dB' | 'Hz' | 'ms' | 's' | '%' | 'x' | ':1' | 'BPM' | '';
  integer?: boolean;       // snap to whole numbers
  bipolar?: boolean;       // centre-detent knob (0 in the middle)
  enumLabels?: string[];   // enum only, indexed by (value - min)
}

export interface CalfPluginSpec {
  uri: string;
  shortName: string;
  /** ordered group names — controls the section order in the editor */
  groups: string[];
  params: ParamSpec[];
  /** EQ-style plugins: render a band selector instead of one flat grid */
  bandSelector?: { bands: string[]; alwaysShow: string[] };
}

// ─── shared fragments ───────────────────────────────────────────────────────

const IO_IN: ParamSpec = {
  symbol: 'level_in', label: 'In Gain', group: 'I/O', kind: 'knob',
  min: 0.015625, max: 64, default: 1, taper: 'gain', unit: 'dB',
};
const IO_OUT: ParamSpec = {
  symbol: 'level_out', label: 'Out Gain', group: 'I/O', kind: 'knob',
  min: 0.015625, max: 64, default: 1, taper: 'gain', unit: 'dB',
};

// ─── plugin specs ───────────────────────────────────────────────────────────

const SATURATOR: CalfPluginSpec = {
  uri: 'http://calf.sourceforge.net/plugins/Saturator',
  shortName: 'Saturator',
  groups: ['Drive', 'Tone', 'Filters', 'I/O'],
  params: [
    { symbol: 'drive', label: 'Saturation', group: 'Drive', kind: 'knob', min: 0.1, max: 10, default: 5, taper: 'log', unit: 'x' },
    { symbol: 'blend', label: 'Blend', group: 'Drive', kind: 'knob', min: -10, max: 10, default: 10, bipolar: true, unit: '' },
    { symbol: 'mix', label: 'Mix', group: 'Drive', kind: 'knob', min: 0, max: 1, default: 1, unit: '%' },
    { symbol: 'p_freq', label: 'Tone Freq', group: 'Tone', kind: 'knob', min: 80, max: 8000, default: 2000, taper: 'log', unit: 'Hz' },
    { symbol: 'p_level', label: 'Tone Amt', group: 'Tone', kind: 'knob', min: 0.0625, max: 16, default: 1, taper: 'gain', unit: 'dB' },
    { symbol: 'p_q', label: 'Tone Q', group: 'Tone', kind: 'knob', min: 0.1, max: 10, default: 1, taper: 'log', unit: 'x' },
    { symbol: 'pre', label: 'Pre Filters', group: 'Filters', kind: 'toggle', min: 0, max: 1, default: 0 },
    { symbol: 'hp_pre_freq', label: 'Pre HP', group: 'Filters', kind: 'knob', min: 10, max: 20000, default: 10, taper: 'log', unit: 'Hz' },
    { symbol: 'lp_pre_freq', label: 'Pre LP', group: 'Filters', kind: 'knob', min: 10, max: 20000, default: 20000, taper: 'log', unit: 'Hz' },
    { symbol: 'post', label: 'Post Filters', group: 'Filters', kind: 'toggle', min: 0, max: 1, default: 0 },
    { symbol: 'hp_post_freq', label: 'Post HP', group: 'Filters', kind: 'knob', min: 10, max: 20000, default: 10, taper: 'log', unit: 'Hz' },
    { symbol: 'lp_post_freq', label: 'Post LP', group: 'Filters', kind: 'knob', min: 10, max: 20000, default: 20000, taper: 'log', unit: 'Hz' },
    IO_IN, IO_OUT,
  ],
};

const CRUSHER: CalfPluginSpec = {
  uri: 'http://calf.sourceforge.net/plugins/Crusher',
  shortName: 'Crusher',
  groups: ['Crush', 'LFO', 'Advanced', 'I/O'],
  params: [
    { symbol: 'bits', label: 'Bit Crush', group: 'Crush', kind: 'knob', min: 1, max: 16, default: 4, taper: 'log', unit: '' },
    { symbol: 'samples', label: 'Sample Crush', group: 'Crush', kind: 'knob', min: 1, max: 250, default: 1, taper: 'log', unit: 'x' },
    { symbol: 'morph', label: 'Morph', group: 'Crush', kind: 'knob', min: 0, max: 1, default: 0.5, unit: '%' },
    { symbol: 'mode', label: 'Mode', group: 'Crush', kind: 'enum', min: 0, max: 1, default: 0, enumLabels: ['Linear', 'Log'] },
    { symbol: 'dc', label: 'DC Shift', group: 'Advanced', kind: 'knob', min: 0.25, max: 4, default: 1, taper: 'log', unit: 'x' },
    { symbol: 'anti_aliasing', label: 'Anti-Alias', group: 'Advanced', kind: 'knob', min: 0, max: 1, default: 0.5, unit: '%' },
    { symbol: 'lfo', label: 'LFO', group: 'LFO', kind: 'toggle', min: 0, max: 1, default: 0 },
    { symbol: 'lforange', label: 'LFO Depth', group: 'LFO', kind: 'knob', min: 1, max: 250, default: 20, taper: 'log', unit: '' },
    { symbol: 'lforate', label: 'LFO Rate', group: 'LFO', kind: 'knob', min: 0.01, max: 200, default: 0.3, taper: 'log', unit: 'Hz' },
    IO_IN, IO_OUT,
  ],
};

const COMPRESSOR: CalfPluginSpec = {
  uri: 'http://calf.sourceforge.net/plugins/Compressor',
  shortName: 'Compressor',
  groups: ['Compression', 'Envelope', 'Detector', 'Output'],
  params: [
    { symbol: 'threshold', label: 'Threshold', group: 'Compression', kind: 'knob', min: 0.000976563, max: 1, default: 0.125, taper: 'gain', unit: 'dB' },
    { symbol: 'ratio', label: 'Ratio', group: 'Compression', kind: 'knob', min: 1, max: 20, default: 2, taper: 'log', unit: ':1' },
    { symbol: 'knee', label: 'Knee', group: 'Compression', kind: 'knob', min: 1, max: 8, default: 2.82843, taper: 'log', unit: 'x' },
    { symbol: 'attack', label: 'Attack', group: 'Envelope', kind: 'knob', min: 0.01, max: 2000, default: 20, taper: 'log', unit: 'ms' },
    { symbol: 'release', label: 'Release', group: 'Envelope', kind: 'knob', min: 0.01, max: 2000, default: 250, taper: 'log', unit: 'ms' },
    { symbol: 'detection', label: 'Detection', group: 'Detector', kind: 'enum', min: 0, max: 1, default: 0, enumLabels: ['RMS', 'Peak'] },
    { symbol: 'stereo_link', label: 'Stereo Link', group: 'Detector', kind: 'enum', min: 0, max: 1, default: 0, enumLabels: ['Average', 'Maximum'] },
    { symbol: 'makeup', label: 'Makeup', group: 'Output', kind: 'knob', min: 1, max: 64, default: 1, taper: 'gain', unit: 'dB' },
    { symbol: 'mix', label: 'Mix', group: 'Output', kind: 'knob', min: 0, max: 1, default: 1, unit: '%' },
    { ...IO_IN, group: 'Output' },
  ],
};

const DEESSER: CalfPluginSpec = {
  uri: 'http://calf.sourceforge.net/plugins/Deesser',
  shortName: 'De-Esser',
  groups: ['De-Ess', 'Frequency', 'Detector', 'Output'],
  params: [
    { symbol: 'threshold', label: 'Threshold', group: 'De-Ess', kind: 'knob', min: 0.000976563, max: 1, default: 0.125, taper: 'gain', unit: 'dB' },
    { symbol: 'ratio', label: 'Ratio', group: 'De-Ess', kind: 'knob', min: 1, max: 20, default: 3, taper: 'log', unit: ':1' },
    { symbol: 'f2_freq', label: 'Peak Freq', group: 'Frequency', kind: 'knob', min: 10, max: 18000, default: 4500, taper: 'log', unit: 'Hz' },
    { symbol: 'f2_q', label: 'Peak Q', group: 'Frequency', kind: 'knob', min: 0.1, max: 100, default: 1, taper: 'log', unit: 'x' },
    { symbol: 'f2_level', label: 'Peak Gain', group: 'Frequency', kind: 'knob', min: 0.0625, max: 16, default: 4, taper: 'gain', unit: 'dB' },
    { symbol: 'f1_freq', label: 'Split Freq', group: 'Frequency', kind: 'knob', min: 10, max: 18000, default: 6000, taper: 'log', unit: 'Hz' },
    { symbol: 'f1_level', label: 'Split Gain', group: 'Frequency', kind: 'knob', min: 0.0625, max: 16, default: 1, taper: 'gain', unit: 'dB' },
    { symbol: 'detection', label: 'Detection', group: 'Detector', kind: 'enum', min: 0, max: 1, default: 0, enumLabels: ['RMS', 'Peak'] },
    { symbol: 'mode', label: 'Mode', group: 'Detector', kind: 'enum', min: 0, max: 1, default: 0, enumLabels: ['Wide', 'Split'] },
    { symbol: 'laxity', label: 'Laxity', group: 'Detector', kind: 'knob', min: 1, max: 100, default: 15, integer: true, unit: '' },
    { symbol: 'sc_listen', label: 'S/C Listen', group: 'Detector', kind: 'toggle', min: 0, max: 1, default: 0 },
    { symbol: 'makeup', label: 'Makeup', group: 'Output', kind: 'knob', min: 1, max: 64, default: 1, taper: 'gain', unit: 'dB' },
  ],
};

// EQ bands share the same 4-control shape (active/freq/level/q). `active` on
// Calf is a 0..5 enum (off / on / L / R / M / S); we drive it as a plain
// on-off toggle (0 / 1), which is all the operator needs here.
function eqBand(prefix: string, band: string, label: string, freqDef: number, hasLevel: boolean, defActive = 0): ParamSpec[] {
  const out: ParamSpec[] = [
    { symbol: `${prefix}_active`, label: 'On', group: band, kind: 'toggle', min: 0, max: 5, default: defActive },
    { symbol: `${prefix}_freq`, label: label + ' Freq', group: band, kind: 'knob', min: 10, max: 20000, default: freqDef, taper: 'log', unit: 'Hz' },
  ];
  if (hasLevel) out.push({ symbol: `${prefix}_level`, label: label + ' Gain', group: band, kind: 'knob', min: 0.015625, max: 64, default: 1, taper: 'gain', unit: 'dB' });
  out.push({ symbol: `${prefix}_q`, label: label + ' Q', group: band, kind: 'knob', min: 0.1, max: hasLevel ? 100 : 10, default: hasLevel ? 1 : 0.707, taper: 'log', unit: 'x' });
  return out;
}

const EQ8: CalfPluginSpec = {
  uri: 'http://calf.sourceforge.net/plugins/Equalizer8Band',
  shortName: '8-Band EQ',
  groups: ['HP', 'Low Shelf', 'Band 1', 'Band 2', 'Band 3', 'Band 4', 'High Shelf', 'LP', 'I/O'],
  bandSelector: { bands: ['HP', 'Low Shelf', 'Band 1', 'Band 2', 'Band 3', 'Band 4', 'High Shelf', 'LP'], alwaysShow: ['I/O'] },
  params: [
    { symbol: 'hp_active', label: 'On', group: 'HP', kind: 'toggle', min: 0, max: 5, default: 0 },
    { symbol: 'hp_freq', label: 'HP Freq', group: 'HP', kind: 'knob', min: 10, max: 20000, default: 30, taper: 'log', unit: 'Hz' },
    { symbol: 'hp_mode', label: 'Slope', group: 'HP', kind: 'enum', min: 0, max: 2, default: 1, enumLabels: ['12 dB', '24 dB', '36 dB'] },
    { symbol: 'hp_q', label: 'HP Q', group: 'HP', kind: 'knob', min: 0.1, max: 10, default: 0.707, taper: 'log', unit: 'x' },
    ...eqBand('ls', 'Low Shelf', 'LS', 100, true),
    ...eqBand('p1', 'Band 1', 'B1', 100, true),
    ...eqBand('p2', 'Band 2', 'B2', 500, true),
    ...eqBand('p3', 'Band 3', 'B3', 2000, true),
    ...eqBand('p4', 'Band 4', 'B4', 5000, true),
    ...eqBand('hs', 'High Shelf', 'HS', 5000, true),
    { symbol: 'lp_active', label: 'On', group: 'LP', kind: 'toggle', min: 0, max: 5, default: 0 },
    { symbol: 'lp_freq', label: 'LP Freq', group: 'LP', kind: 'knob', min: 10, max: 20000, default: 18000, taper: 'log', unit: 'Hz' },
    { symbol: 'lp_mode', label: 'Slope', group: 'LP', kind: 'enum', min: 0, max: 2, default: 1, enumLabels: ['12 dB', '24 dB', '36 dB'] },
    { symbol: 'lp_q', label: 'LP Q', group: 'LP', kind: 'knob', min: 0.1, max: 10, default: 0.707, taper: 'log', unit: 'x' },
    IO_IN, IO_OUT,
  ],
};

const EQ5: CalfPluginSpec = {
  uri: 'http://calf.sourceforge.net/plugins/Equalizer5Band',
  shortName: '5-Band EQ',
  groups: ['Low Shelf', 'Band 1', 'Band 2', 'Band 3', 'High Shelf', 'I/O'],
  bandSelector: { bands: ['Low Shelf', 'Band 1', 'Band 2', 'Band 3', 'High Shelf'], alwaysShow: ['I/O'] },
  params: [
    ...eqBand('ls', 'Low Shelf', 'LS', 100, true),
    ...eqBand('p1', 'Band 1', 'B1', 250, true),
    ...eqBand('p2', 'Band 2', 'B2', 1000, true),
    ...eqBand('p3', 'Band 3', 'B3', 4000, true),
    ...eqBand('hs', 'High Shelf', 'HS', 5000, true),
    IO_IN, IO_OUT,
  ],
};

const VINTAGE_DELAY: CalfPluginSpec = {
  uri: 'http://calf.sourceforge.net/plugins/VintageDelay',
  shortName: 'Vintage Delay',
  groups: ['Time', 'Feedback', 'Mix', 'Character', 'I/O'],
  params: [
    { symbol: 'bpm', label: 'Tempo', group: 'Time', kind: 'knob', min: 30, max: 300, default: 120, unit: 'BPM' },
    { symbol: 'subdiv', label: 'Subdivide', group: 'Time', kind: 'knob', min: 1, max: 16, default: 4, integer: true, unit: '' },
    { symbol: 'time_l', label: 'Time L', group: 'Time', kind: 'knob', min: 1, max: 16, default: 3, integer: true, unit: '' },
    { symbol: 'time_r', label: 'Time R', group: 'Time', kind: 'knob', min: 1, max: 16, default: 5, integer: true, unit: '' },
    { symbol: 'timing', label: 'Timing', group: 'Time', kind: 'enum', min: 0, max: 3, default: 0, enumLabels: ['BPM', 'ms', 'Hz', 'Sync'] },
    { symbol: 'feedback', label: 'Feedback', group: 'Feedback', kind: 'knob', min: 0, max: 1, default: 0.5, unit: '%' },
    { symbol: 'amount', label: 'Wet', group: 'Mix', kind: 'knob', min: 0, max: 4, default: 0.25, unit: 'x' },
    { symbol: 'dry', label: 'Dry', group: 'Mix', kind: 'knob', min: 0, max: 4, default: 1, unit: 'x' },
    { symbol: 'width', label: 'Width', group: 'Mix', kind: 'knob', min: -1, max: 1, default: 1, bipolar: true, unit: '%' },
    { symbol: 'mix_mode', label: 'Mode', group: 'Character', kind: 'enum', min: 0, max: 3, default: 1, enumLabels: ['Stereo', 'Ping-Pong', 'L→R', 'R→L'] },
    { symbol: 'medium', label: 'Medium', group: 'Character', kind: 'enum', min: 0, max: 2, default: 1, enumLabels: ['Plain', 'Tape', 'Old Tape'] },
    IO_IN, IO_OUT,
  ],
};

const REVERB: CalfPluginSpec = {
  uri: 'http://calf.sourceforge.net/plugins/Reverb',
  shortName: 'Reverb',
  groups: ['Reverb', 'Tone', 'Mix', 'I/O'],
  params: [
    { symbol: 'decay_time', label: 'Decay', group: 'Reverb', kind: 'knob', min: 0.4, max: 15, default: 1.5, taper: 'log', unit: 's' },
    { symbol: 'room_size', label: 'Room', group: 'Reverb', kind: 'enum', min: 0, max: 5, default: 2, enumLabels: ['Small', 'Medium', 'Large', 'Tunnel', 'Smooth', 'Exp.'] },
    { symbol: 'predelay', label: 'Pre-Delay', group: 'Reverb', kind: 'knob', min: 0, max: 500, default: 0, unit: 'ms' },
    { symbol: 'diffusion', label: 'Diffusion', group: 'Reverb', kind: 'knob', min: 0, max: 1, default: 0.5, unit: '%' },
    { symbol: 'hf_damp', label: 'HF Damp', group: 'Tone', kind: 'knob', min: 2000, max: 20000, default: 5000, taper: 'log', unit: 'Hz' },
    { symbol: 'bass_cut', label: 'Bass Cut', group: 'Tone', kind: 'knob', min: 20, max: 20000, default: 300, taper: 'log', unit: 'Hz' },
    { symbol: 'treble_cut', label: 'Treble Cut', group: 'Tone', kind: 'knob', min: 20, max: 20000, default: 5000, taper: 'log', unit: 'Hz' },
    { symbol: 'amount', label: 'Wet', group: 'Mix', kind: 'knob', min: 0, max: 2, default: 0.25, unit: 'x' },
    { symbol: 'dry', label: 'Dry', group: 'Mix', kind: 'knob', min: 0, max: 2, default: 1, unit: 'x' },
    IO_IN, IO_OUT,
  ],
};

const LIMITER: CalfPluginSpec = {
  uri: 'http://calf.sourceforge.net/plugins/Limiter',
  shortName: 'Limiter',
  groups: ['Limiter', 'ASC', 'Advanced', 'I/O'],
  params: [
    { symbol: 'limit', label: 'Ceiling', group: 'Limiter', kind: 'knob', min: 0.0625, max: 1, default: 1, taper: 'gain', unit: 'dB' },
    { symbol: 'attack', label: 'Lookahead', group: 'Limiter', kind: 'knob', min: 0.1, max: 10, default: 5, unit: 'ms' },
    { symbol: 'release', label: 'Release', group: 'Limiter', kind: 'knob', min: 1, max: 1000, default: 50, taper: 'log', unit: 'ms' },
    { symbol: 'asc', label: 'ASC', group: 'ASC', kind: 'toggle', min: 0, max: 1, default: 1 },
    { symbol: 'asc_coeff', label: 'ASC Level', group: 'ASC', kind: 'knob', min: 0, max: 1, default: 0.5, unit: '%' },
    { symbol: 'oversampling', label: 'Oversampling', group: 'Advanced', kind: 'knob', min: 1, max: 4, default: 1, integer: true, unit: 'x' },
    { symbol: 'auto_level', label: 'Auto Level', group: 'Advanced', kind: 'toggle', min: 0, max: 1, default: 1 },
    IO_IN, IO_OUT,
  ],
};

export const CALF_PLUGINS: Record<string, CalfPluginSpec> = Object.fromEntries(
  [SATURATOR, CRUSHER, COMPRESSOR, DEESSER, EQ8, EQ5, VINTAGE_DELAY, REVERB, LIMITER].map(p => [p.uri, p]),
);

export function getCalfSpec(uri: string): CalfPluginSpec | undefined {
  return CALF_PLUGINS[uri];
}

/** Default param map (symbol → stored value) for a freshly added plugin. */
export function calfDefaultParams(uri: string): Record<string, number> {
  const spec = CALF_PLUGINS[uri];
  if (!spec) return {};
  const out: Record<string, number> = {};
  for (const p of spec.params) out[p.symbol] = p.default;
  return out;
}

// ─── value <-> knob-position math ───────────────────────────────────────────

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** stored value → normalised knob position 0..1 */
export function paramToPos(spec: ParamSpec, value: number): number {
  const lo = Math.min(spec.min, spec.max);
  const hi = Math.max(spec.min, spec.max);
  const v = clamp(value, lo, hi);
  if ((spec.taper === 'log' || spec.taper === 'gain') && lo > 0) {
    return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
  }
  return (v - spec.min) / (spec.max - spec.min);
}

/** normalised knob position 0..1 → stored value */
export function posToParam(spec: ParamSpec, pos: number): number {
  const p = clamp(pos, 0, 1);
  let v: number;
  if ((spec.taper === 'log' || spec.taper === 'gain') && Math.min(spec.min, spec.max) > 0) {
    v = spec.min * Math.pow(spec.max / spec.min, p);
  } else {
    v = spec.min + p * (spec.max - spec.min);
  }
  return spec.integer ? Math.round(v) : v;
}

/** Calf gain-coefficient (1.0 = 0 dB) ↔ dB */
export const gainToDb = (coef: number) => 20 * Math.log10(Math.max(coef, 1e-6));
export const dbToGain = (db: number) => Math.pow(10, db / 20);

/** human-readable value for a knob readout */
export function formatParam(spec: ParamSpec, value: number): string {
  if (spec.kind === 'enum') return spec.enumLabels?.[Math.round(value - spec.min)] ?? String(Math.round(value));
  if (spec.kind === 'toggle') return value > 0.5 ? 'ON' : 'OFF';
  if (spec.taper === 'gain') {
    const db = gainToDb(value);
    return db <= -59.9 ? '−∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
  }
  switch (spec.unit) {
    case 'Hz': return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${value.toFixed(0)} Hz`;
    case 'ms': return `${value.toFixed(value < 10 ? 2 : 0)} ms`;
    case 's': return `${value.toFixed(2)} s`;
    case '%': return `${Math.round(value * 100)}%`;
    case ':1': return `${value.toFixed(1)}:1`;
    case 'x': return `${value.toFixed(2)}×`;
    case 'BPM': return `${value.toFixed(0)} BPM`;
    default: return spec.integer ? `${Math.round(value)}` : value.toFixed(2);
  }
}

import * as fs from 'fs';

// Minimal RIFF/WAVE reader for the float (and 16-bit PCM) files the engine
// writes, plus a min/max peak reducer at a few zoom tiers for waveform
// drawing. Everything the timeline needs is the mono-summed envelope, so
// that's all we keep — half the data of per-channel.

export const PEAK_TIERS = [256, 2048, 16384]; // frames per min/max pair

interface WavData {
  sampleRate: number;
  channels: number;
  frames: number;
  // interleaved float samples
  samples: Float32Array;
}

function readWav(path: string): WavData | null {
  const b = fs.readFileSync(path);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let fmtTag = 0, channels = 0, sampleRate = 0, bits = 0;
  let dataOff = -1, dataLen = 0;
  let i = 12;
  while (i + 8 <= b.length) {
    const id = b.toString('ascii', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    const body = i + 8;
    if (id === 'fmt ') {
      fmtTag = b.readUInt16LE(body);
      channels = b.readUInt16LE(body + 2);
      sampleRate = b.readUInt32LE(body + 4);
      bits = b.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOff = body;
      // Some writers leave the data size at 0 until close; fall back to EOF.
      dataLen = size > 0 && body + size <= b.length ? size : b.length - body;
    }
    i = body + size + (size & 1);
  }
  if (dataOff < 0 || channels < 1 || sampleRate < 1) return null;

  const bytesPerSample = bits / 8;
  const frames = Math.floor(dataLen / (bytesPerSample * channels));
  const samples = new Float32Array(frames * channels);
  if (fmtTag === 3 && bits === 32) {
    for (let s = 0; s < samples.length; s++) samples[s] = b.readFloatLE(dataOff + s * 4);
  } else if (fmtTag === 1 && bits === 16) {
    for (let s = 0; s < samples.length; s++) samples[s] = b.readInt16LE(dataOff + s * 2) / 32768;
  } else if (fmtTag === 1 && bits === 24) {
    for (let s = 0; s < samples.length; s++) {
      const o = dataOff + s * 3;
      let v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
      if (v & 0x800000) v -= 0x1000000;
      samples[s] = v / 8388608;
    }
  } else {
    return null;
  }
  return { sampleRate, channels, frames, samples };
}

export interface PeaksFile {
  version: 1;
  sampleRate: number;
  frames: number;
  tiers: Record<string, number[]>; // tier -> [min,max,min,max,...] mono
}

export function computePeaks(wavPath: string): PeaksFile | null {
  const w = readWav(wavPath);
  if (!w) return null;
  const { channels, frames, samples } = w;

  const tiers: Record<string, number[]> = {};
  for (const tier of PEAK_TIERS) {
    const buckets = Math.ceil(frames / tier);
    const out = new Array(buckets * 2);
    for (let bkt = 0; bkt < buckets; bkt++) {
      let mn = Infinity, mx = -Infinity;
      const f0 = bkt * tier;
      const f1 = Math.min(frames, f0 + tier);
      for (let f = f0; f < f1; f++) {
        // mono sum
        let v = 0;
        for (let c = 0; c < channels; c++) v += samples[f * channels + c];
        v /= channels;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (!isFinite(mn)) { mn = 0; mx = 0; }
      out[bkt * 2] = Math.round(mn * 1000) / 1000;
      out[bkt * 2 + 1] = Math.round(mx * 1000) / 1000;
    }
    tiers[String(tier)] = out;
  }
  return { version: 1, sampleRate: w.sampleRate, frames, tiers };
}

// Compute peaks for wavPath and cache next to it as <name>.peaks.json.
// Returns the cached/created peaks, or null if the wav couldn't be read.
export function ensurePeaks(wavPath: string): PeaksFile | null {
  const cachePath = wavPath.replace(/\.wav$/i, '') + '.peaks.json';
  try {
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).mtimeMs >= fs.statSync(wavPath).mtimeMs) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as PeaksFile;
    }
  } catch { /* recompute */ }
  const peaks = computePeaks(wavPath);
  if (peaks) {
    try { fs.writeFileSync(cachePath, JSON.stringify(peaks)); } catch { /* best effort */ }
  }
  return peaks;
}

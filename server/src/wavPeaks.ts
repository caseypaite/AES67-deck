import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// Minimal RIFF/WAVE reader for the float (and 16-bit PCM) files the engine
// writes, plus a min/max peak reducer at a few zoom tiers for waveform
// drawing. Everything the timeline needs is the mono-summed envelope, so
// that's all we keep — half the data of per-channel.
//
// Take files are lossless WavPack (.wv); those are decoded to a temp WAV via
// `wvunpack` before parsing (the `wavpack` package must be installed).

export const PEAK_TIERS = [256, 2048, 16384]; // frames per min/max pair

interface WavData {
  sampleRate: number;
  channels: number;
  frames: number;
  // interleaved float samples
  samples: Float32Array;
}

// Read a take file as a RIFF/WAVE buffer, decoding WavPack on the way.
function readAudio(filePath: string): WavData | null {
  if (/\.wv$/i.test(filePath)) {
    const tmp = path.join(os.tmpdir(), `aes67-peaks-${process.pid}-${Date.now()}.wav`);
    try {
      execFileSync('wvunpack', ['-y', '-q', '-w', filePath, '-o', tmp], { stdio: 'ignore' });
      const out = parseWav(fs.readFileSync(tmp));
      return out;
    } catch (e) {
      console.error(`wvunpack failed for ${filePath}`, e);
      return null;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
  return parseWav(fs.readFileSync(filePath));
}

function parseWav(b: Buffer): WavData | null {
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
  version: 2;
  sampleRate: number;
  frames: number;
  tiers: Record<string, number[]>;     // tier -> [min,max,min,max,...] mono
  rmsTiers: Record<string, number[]>;  // tier -> [rms,rms,...] mono, one per bucket
}

export function computePeaks(srcPath: string): PeaksFile | null {
  const w = readAudio(srcPath);
  if (!w) return null;
  const { channels, frames, samples } = w;

  const tiers: Record<string, number[]> = {};
  const rmsTiers: Record<string, number[]> = {};
  for (const tier of PEAK_TIERS) {
    const buckets = Math.ceil(frames / tier);
    const out = new Array(buckets * 2);
    const rms = new Array(buckets);
    for (let bkt = 0; bkt < buckets; bkt++) {
      let mn = Infinity, mx = -Infinity, sumSq = 0;
      const f0 = bkt * tier;
      const f1 = Math.min(frames, f0 + tier);
      for (let f = f0; f < f1; f++) {
        // mono sum
        let v = 0;
        for (let c = 0; c < channels; c++) v += samples[f * channels + c];
        v /= channels;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sumSq += v * v;
      }
      if (!isFinite(mn)) { mn = 0; mx = 0; }
      const n = Math.max(1, f1 - f0);
      out[bkt * 2] = Math.round(mn * 1000) / 1000;
      out[bkt * 2 + 1] = Math.round(mx * 1000) / 1000;
      rms[bkt] = Math.round(Math.sqrt(sumSq / n) * 1000) / 1000;
    }
    tiers[String(tier)] = out;
    rmsTiers[String(tier)] = rms;
  }
  return { version: 2, sampleRate: w.sampleRate, frames, tiers, rmsTiers };
}

// Compute peaks for a take file and cache next to it as <name>.peaks.json.
// Returns the cached/created peaks, or null if the file couldn't be read.
export function ensurePeaks(srcPath: string): PeaksFile | null {
  const cachePath = srcPath.replace(/\.(wav|wv)$/i, '') + '.peaks.json';
  try {
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).mtimeMs >= fs.statSync(srcPath).mtimeMs) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as PeaksFile;
      if (cached.version === 2) return cached;
      // fall through to recompute stale (v1) caches
    }
  } catch { /* recompute */ }
  const peaks = computePeaks(srcPath);
  if (peaks) {
    try { fs.writeFileSync(cachePath, JSON.stringify(peaks)); } catch { /* best effort */ }
  }
  return peaks;
}

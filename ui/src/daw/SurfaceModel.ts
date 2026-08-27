// The arrange surface: one canvas, no widgets. Holds the view transform and
// clip geometry, hit-tests in canvas space, and paints grid / lanes / clips /
// waveforms / playhead. Reads the stores directly; owns no React state.

import { useDawStore, type DawClip, type PeaksData, clipPeakKey } from '../stores/useDawStore';
import { useMixerStore, type Channel } from '../stores/useMixerStore';

export const RULER_H = 26;
export const DEFAULT_TRACK_H = 96;
const MIN_TRACK_H = 48;

export interface HitResult {
  kind: 'clip' | 'clip-left' | 'clip-right' | 'lane' | 'ruler' | 'empty';
  clipId?: string;
  trackId?: number;
  time: number;
}

interface Track { id: number; name: string; height: number; y: number; }

const CLIP_FILL: Record<string, string> = {
  'bg-red-600': '#b23b3b', 'bg-blue-600': '#3b5bb2', 'bg-green-600': '#3b8f5a',
  'bg-purple-600': '#6d4bb2', 'bg-orange-600': '#c07a2e',
};

export class SurfaceModel {
  width = 800;
  height = 600;

  private get pxPerSec() { return useDawStore.getState().zoom; }
  get scrollX() { return useDawStore.getState().scrollX; }
  get scrollY() { return useDawStore.getState().scrollY; }

  timeToX(t: number) { return t * this.pxPerSec - this.scrollX; }
  xToTime(x: number) { return (x + this.scrollX) / this.pxPerSec; }

  tracks(): Track[] {
    const chans = useMixerStore.getState().channels;
    const heights = useDawStore.getState().trackHeights;
    const inputs = Object.values(chans).filter((c: Channel) => c.type === 'input').sort((a, b) => a.id - b.id);
    let y = RULER_H - this.scrollY;
    return inputs.map((c) => {
      const h = Math.max(MIN_TRACK_H, heights[c.id] || DEFAULT_TRACK_H);
      const t = { id: c.id, name: c.name, height: h, y };
      y += h;
      return t;
    });
  }

  contentHeight(): number {
    return this.tracks().reduce((s, t) => s + t.height, 0) + RULER_H;
  }

  maxScrollY() {
    return Math.max(0, this.contentHeight() - this.height);
  }

  hitTest(px: number, py: number): HitResult {
    const time = Math.max(0, this.xToTime(px));
    if (py < RULER_H) return { kind: 'ruler', time };

    const tracks = this.tracks();
    const track = tracks.find((t) => py >= t.y && py < t.y + t.height);
    if (!track) return { kind: 'empty', time };

    const clips = Object.values(useDawStore.getState().clips).filter((c) => c.trackId === track.id);
    const EDGE = 6;
    for (const c of clips) {
      const x0 = this.timeToX(c.start);
      const x1 = this.timeToX(c.start + c.length);
      if (px >= x0 - 1 && px <= x1 + 1) {
        if (px <= x0 + EDGE) return { kind: 'clip-left', clipId: c.id, trackId: track.id, time };
        if (px >= x1 - EDGE) return { kind: 'clip-right', clipId: c.id, trackId: track.id, time };
        return { kind: 'clip', clipId: c.id, trackId: track.id, time };
      }
    }
    return { kind: 'lane', trackId: track.id, time };
  }

  // --- painting ---

  draw(ctx: CanvasRenderingContext2D) {
    const { width: w, height: h } = this;
    const pps = this.pxPerSec;
    const daw = useDawStore.getState();
    const playing = useMixerStore.getState().transportState;

    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, w, h);

    const tStart = this.xToTime(0);
    const tEnd = this.xToTime(w);

    // grid: minor at gridSize, major every 10
    const gs = daw.gridSize;
    let major = gs * 10;
    while (major * pps < 60) major *= 2;      // keep majors readable when zoomed out
    const minor = major / 10;
    ctx.lineWidth = 1;
    for (let t = Math.floor(tStart / minor) * minor; t < tEnd; t += minor) {
      const x = Math.round(this.timeToX(t)) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.strokeStyle = isMajor ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, h); ctx.stroke();
    }

    // lanes + clips
    const tracks = this.tracks();
    const selected = new Set(daw.selectedClipIds);
    for (const tr of tracks) {
      if (tr.y + tr.height < RULER_H || tr.y > h) continue;
      ctx.fillStyle = (tr.id % 2) ? '#1a1d23' : '#181b20';
      ctx.fillRect(0, tr.y, w, tr.height);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath(); ctx.moveTo(0, tr.y + tr.height - 0.5); ctx.lineTo(w, tr.y + tr.height - 0.5); ctx.stroke();

      const clips = Object.values(daw.clips).filter((c) => c.trackId === tr.id);
      for (const c of clips) {
        const x0 = this.timeToX(c.start);
        const x1 = this.timeToX(c.start + c.length);
        if (x1 < 0 || x0 > w) continue;
        this.drawClip(ctx, c, x0, x1, tr.y + 3, tr.height - 6, selected.has(c.id), daw.peaks);
      }
    }

    this.drawRuler(ctx, tStart, tEnd, major, minor);

    // playhead
    const px = this.timeToX(daw.playheadPosition);
    if (px >= 0 && px <= w) {
      ctx.strokeStyle = playing === 'recording' ? '#ef4444' : '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, h); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle as string;
      ctx.beginPath(); ctx.moveTo(px - 4, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px + 0.5, 7); ctx.fill();
    }
  }

  private drawClip(
    ctx: CanvasRenderingContext2D, c: DawClip,
    x0: number, x1: number, y: number, ch: number,
    sel: boolean, peaks: Record<string, PeaksData>,
  ) {
    const x = Math.max(x0, -2);
    const wClip = Math.min(x1, this.width + 2) - x;
    if (wClip <= 0) return;

    ctx.fillStyle = CLIP_FILL[c.color] || '#4a5568';
    ctx.beginPath();
    (ctx as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void })
      .roundRect?.(x, y, wClip, ch, 3);
    if (!(ctx as { roundRect?: unknown }).roundRect) ctx.rect(x, y, wClip, ch);
    ctx.fill();

    // waveform
    const key = clipPeakKey(c);
    const pk = key ? peaks[key] : undefined;
    if (pk) this.drawWave(ctx, c, pk, x0, x1, y, ch);
    else { useDawStore.getState().ensureClipPeaks(c); }

    ctx.strokeStyle = sel ? '#ffffff' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = sel ? 2 : 1;
    ctx.strokeRect(x + 0.5, y + 0.5, wClip - 1, ch - 1);

    if (wClip > 34) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, wClip, 14); ctx.clip();
      ctx.fillText(c.name, x + 4, y + 10);
      ctx.restore();
    }
  }

  private drawWave(
    ctx: CanvasRenderingContext2D, c: DawClip, pk: PeaksData,
    x0: number, x1: number, y: number, ch: number,
  ) {
    const sr = pk.sampleRate || c.sampleRate || 48000;
    const pps = this.pxPerSec;
    // frames of source audio per screen pixel -> nearest tier
    const framesPerPx = sr / pps;
    const tierKeys = Object.keys(pk.tiers).map(Number).sort((a, b) => a - b);
    let tier = tierKeys[0];
    for (const t of tierKeys) { if (t <= framesPerPx * 1.5) tier = t; }
    const data = pk.tiers[String(tier)];
    if (!data) return;

    const offsetFrames = (c.sourceOffset || 0) * sr;
    const mid = y + ch / 2;
    const amp = (ch / 2) * 0.9;
    const visL = Math.max(x0, 0);
    const visR = Math.min(x1, this.width);

    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.beginPath();
    ctx.moveTo(visL, mid);
    for (let px = visL; px <= visR; px++) {
      const clipT = (px - x0) / pps;                    // seconds into the clip
      const srcFrame = offsetFrames + clipT * sr;
      const bkt = Math.floor(srcFrame / tier);
      const i = bkt * 2;
      const mx = i + 1 < data.length ? data[i + 1] : 0;
      ctx.lineTo(px, mid - mx * amp);
    }
    for (let px = visR; px >= visL; px--) {
      const clipT = (px - x0) / pps;
      const srcFrame = offsetFrames + clipT * sr;
      const bkt = Math.floor(srcFrame / tier);
      const i = bkt * 2;
      const mn = i < data.length ? data[i] : 0;
      ctx.lineTo(px, mid - mn * amp);
    }
    ctx.closePath();
    ctx.fill();
  }

  private drawRuler(ctx: CanvasRenderingContext2D, tStart: number, tEnd: number, major: number, minor: number) {
    const w = this.width;
    ctx.fillStyle = '#101216';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(w, RULER_H - 0.5); ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px ui-monospace, monospace';
    for (let t = Math.floor(tStart / major) * major; t < tEnd; t += major) {
      const x = this.timeToX(t);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.moveTo(x + 0.5, RULER_H - 8); ctx.lineTo(x + 0.5, RULER_H); ctx.stroke();
      ctx.fillText(fmtRuler(t), x + 3, 11);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    for (let t = Math.floor(tStart / minor) * minor; t < tEnd; t += minor) {
      const x = this.timeToX(t);
      ctx.beginPath(); ctx.moveTo(x + 0.5, RULER_H - 4); ctx.lineTo(x + 0.5, RULER_H); ctx.stroke();
    }
  }
}

function fmtRuler(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(r < 10 ? 1 : 0).padStart(r < 10 ? 4 : 2, '0')}`;
}

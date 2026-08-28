// The arrange surface: one canvas, no widgets. Holds the view transform and
// clip geometry, hit-tests in canvas space, and paints grid / lanes / clips /
// waveforms / playhead. Reads the stores directly; owns no React state.

import { useDawStore, type DawClip, type PeaksData, clipPeakKey } from '../stores/useDawStore';
import { useMixerStore, type Channel } from '../stores/useMixerStore';

export const RULER_H = 26;
export const DEFAULT_TRACK_H = 96;
const MIN_TRACK_H = 48;

const CLIP_HEADER_H = 14;   // label strip inside the clip
const EDGE = 7;             // trim hit zone (px) — padded in hitTest for touch
const HANDLE_R = 5;         // fade / gain grip radius (px)
export const MAX_CLIP_GAIN_DB = 12;
const MIN_CLIP_GAIN_DB = -60;

export interface HitResult {
  kind:
    | 'clip' | 'clip-left' | 'clip-right'
    | 'clip-fade-in' | 'clip-fade-out' | 'clip-gain'
    | 'lane' | 'ruler' | 'marker' | 'empty'
    | 'region-in' | 'region-out' | 'region-body';
  clipId?: string;
  trackId?: number;
  markerId?: string;
  time: number;
  cursor: string;
}

interface Track { id: number; name: string; height: number; y: number; }

const CLIP_FILL: Record<string, string> = {
  'bg-red-600': '#b23b3b', 'bg-blue-600': '#3b5bb2', 'bg-green-600': '#3b8f5a',
  'bg-purple-600': '#6d4bb2', 'bg-orange-600': '#c07a2e', 'bg-yellow-600': '#b59a2e',
  'bg-teal-600': '#2e9e9e', 'bg-pink-600': '#b2477e',
};

// --- small colour helpers (hex -> rgb, lighten/darken, rgba string) ---
function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function mix([r, g, b]: [number, number, number], [r2, g2, b2]: [number, number, number], t: number): [number, number, number] {
  return [r + (r2 - r) * t, g + (g2 - g) * t, b + (b2 - b) * t];
}
function rgba([r, g, b]: [number, number, number], a: number) {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
}
const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

export function gainToDb(g: number) { return 20 * Math.log10(Math.max(1e-4, g)); }
export function dbToGain(db: number) { return Math.pow(10, db / 20); }

export class SurfaceModel {
  width = 800;
  height = 600;

  private get pxPerSec() { return useDawStore.getState().zoom; }
  get scrollX() { return useDawStore.getState().scrollX; }
  get scrollY() { return useDawStore.getState().scrollY; }

  timeToX(t: number) { return t * this.pxPerSec - this.scrollX; }
  xToTime(x: number) { return (x + this.scrollX) / this.pxPerSec; }

  private _tracksCache: { key: string; tracks: Track[] } | null = null;

  tracks(): Track[] {
    const chans = useMixerStore.getState().channels;
    const daw = useDawStore.getState();
    const heights = daw.trackHeights;
    // Cheap memo — the inputs that matter are the channel ids, the heights map
    // and scrollY. Rebuild only when one of those changes.
    const ids = Object.values(chans).filter((c: Channel) => c.type === 'input').map((c) => c.id).sort((a, b) => a - b);
    const key = ids.join(',') + '|' + JSON.stringify(heights) + '|' + daw.scrollY;
    if (this._tracksCache && this._tracksCache.key === key) return this._tracksCache.tracks;

    const byId = chans as Record<number, Channel>;
    let y = RULER_H - daw.scrollY;
    const tracks = ids.map((id) => {
      const h = Math.max(MIN_TRACK_H, heights[id] || DEFAULT_TRACK_H);
      const t = { id, name: byId[id]?.name ?? `IN ${id}`, height: h, y };
      y += h;
      return t;
    });
    this._tracksCache = { key, tracks };
    return tracks;
  }

  contentHeight(): number {
    return this.tracks().reduce((s, t) => s + t.height, 0) + RULER_H;
  }

  maxScrollY() {
    return Math.max(0, this.contentHeight() - this.height);
  }

  trackAtY(py: number): Track | undefined {
    return this.tracks().find((t) => py >= t.y && py < t.y + t.height);
  }

  // Clip ids whose on-screen rect intersects the given screen-space rectangle.
  clipsInRect(ax: number, ay: number, bx: number, by: number): string[] {
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
    const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    const clips = useDawStore.getState().clips;
    const out: string[] = [];
    for (const tr of this.tracks()) {
      if (tr.y + tr.height < y0 || tr.y > y1) continue;
      for (const c of Object.values(clips)) {
        if (c.trackId !== tr.id) continue;
        const cx0 = this.timeToX(c.start);
        const cx1 = this.timeToX(c.start + c.length);
        if (cx1 >= x0 && cx0 <= x1) out.push(c.id);
      }
    }
    return out;
  }

  // Screen-space geometry for a clip's fade / gain grips, so draw and hitTest agree.
  private grips(c: DawClip, x0: number, x1: number, y: number, ch: number) {
    const pps = this.pxPerSec;
    const waveTop = y + CLIP_HEADER_H;
    const waveH = Math.max(4, ch - CLIP_HEADER_H);
    const fadeInX = x0 + Math.max(0, (c.fadeIn || 0) * pps);
    const fadeOutX = x1 - Math.max(0, (c.fadeOut || 0) * pps);
    const gainDb = gainToDb(c.gain ?? 1);
    const gainT = 1 - (gainDb - MIN_CLIP_GAIN_DB) / (MAX_CLIP_GAIN_DB - MIN_CLIP_GAIN_DB);
    const gainY = waveTop + Math.max(0, Math.min(1, gainT)) * waveH;
    return { waveTop, waveH, fadeInX, fadeOutX, gainY };
  }

  hitTest(px: number, py: number): HitResult {
    const time = Math.max(0, this.xToTime(px));
    if (py < RULER_H) {
      // Region handles sit in the top band of the ruler (above the marker heads).
      const region = useDawStore.getState().region;
      if (region && py < RULER_H - 12) {
        const rx0 = this.timeToX(region.inSec);
        const rx1 = this.timeToX(region.outSec);
        if (Math.abs(px - rx0) <= 6) return { kind: 'region-in', time, cursor: 'ew-resize' };
        if (Math.abs(px - rx1) <= 6) return { kind: 'region-out', time, cursor: 'ew-resize' };
        if (px > rx0 && px < rx1) return { kind: 'region-body', time, cursor: 'grab' };
      }
      // Marker heads sit in the bottom half of the ruler.
      if (py >= RULER_H - 12) {
        const markers = Object.values(useDawStore.getState().markers);
        for (const m of markers) {
          if (Math.abs(this.timeToX(m.time) - px) <= 6)
            return { kind: 'marker', markerId: m.id, time, cursor: 'ew-resize' };
        }
      }
      return { kind: 'ruler', time, cursor: 'ew-resize' };
    }

    const track = this.trackAtY(py);
    if (!track) return { kind: 'empty', time, cursor: 'default' };

    const clips = Object.values(useDawStore.getState().clips).filter((c) => c.trackId === track.id);
    const y = track.y + 3;
    const ch = track.height - 6;
    // Front-most clip first (last drawn wins visually).
    for (let i = clips.length - 1; i >= 0; i--) {
      const c = clips[i];
      if (c.recording) continue; // the live take placeholder isn't editable
      const x0 = this.timeToX(c.start);
      const x1 = this.timeToX(c.start + c.length);
      if (px < x0 - 1 || px > x1 + 1) continue;
      const g = this.grips(c, x0, x1, y, ch);

      // fade grips (top edge, near the ramp end-point)
      if (py <= g.waveTop + HANDLE_R + 2) {
        if (Math.abs(px - g.fadeInX) <= HANDLE_R + 3)
          return { kind: 'clip-fade-in', clipId: c.id, trackId: track.id, time, cursor: 'ew-resize' };
        if (Math.abs(px - g.fadeOutX) <= HANDLE_R + 3)
          return { kind: 'clip-fade-out', clipId: c.id, trackId: track.id, time, cursor: 'ew-resize' };
      }
      // gain line (mid clip, away from the edges)
      if (px > x0 + EDGE + 4 && px < x1 - EDGE - 4 && Math.abs(py - g.gainY) <= HANDLE_R)
        return { kind: 'clip-gain', clipId: c.id, trackId: track.id, time, cursor: 'ns-resize' };

      if (px <= x0 + EDGE) return { kind: 'clip-left', clipId: c.id, trackId: track.id, time, cursor: 'ew-resize' };
      if (px >= x1 - EDGE) return { kind: 'clip-right', clipId: c.id, trackId: track.id, time, cursor: 'ew-resize' };
      return { kind: 'clip', clipId: c.id, trackId: track.id, time, cursor: 'grab' };
    }
    return { kind: 'lane', trackId: track.id, time, cursor: 'default' };
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
    const dropTrack = daw.dragOverTrackId;
    for (const tr of tracks) {
      if (tr.y + tr.height < RULER_H || tr.y > h) continue;
      ctx.fillStyle = (tr.id % 2) ? '#1a1d23' : '#181b20';
      ctx.fillRect(0, tr.y, w, tr.height);
      if (dropTrack === tr.id) {
        ctx.fillStyle = 'rgba(90,140,255,0.10)';
        ctx.fillRect(0, tr.y, w, tr.height);
      }
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

    // marquee selection rectangle
    if (daw.marquee) {
      const m = daw.marquee;
      ctx.strokeStyle = 'rgba(120,170,255,0.9)';
      ctx.fillStyle = 'rgba(120,170,255,0.12)';
      ctx.lineWidth = 1;
      const rx = Math.min(m.x0, m.x1), ry = Math.min(m.y0, m.y1);
      const rw = Math.abs(m.x1 - m.x0), rh = Math.abs(m.y1 - m.y0);
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
    }

    this.drawRegion(ctx);
    this.drawMarkerLines(ctx);
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

    const base = toRgb(CLIP_FILL[c.color] || '#4a5568');
    const body = mix(base, BLACK, 0.15);
    const g = this.grips(c, x0, x1, y, ch);

    // body
    ctx.fillStyle = rgba(body, 0.92);
    this.roundRectPath(ctx, x, y, wClip, ch, 3);
    ctx.fill();

    // header strip
    ctx.fillStyle = rgba(mix(base, BLACK, 0.45), 0.85);
    ctx.save();
    this.roundRectPath(ctx, x, y, wClip, Math.min(CLIP_HEADER_H, ch), 3);
    ctx.clip();
    ctx.fillRect(x, y, wClip, CLIP_HEADER_H);
    ctx.restore();

    // waveform (clipped to the wave area)
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, g.waveTop, wClip, g.waveH);
    ctx.clip();
    if (c.recording) {
      this.drawLiveWave(ctx, c, x0, x1, g.waveTop, g.waveH, base);
    } else {
      const key = clipPeakKey(c);
      const pk = key ? peaks[key] : undefined;
      if (pk) this.drawWave(ctx, c, pk, x0, x1, g.waveTop, g.waveH, base);
      else useDawStore.getState().ensureClipPeaks(c);
    }

    // fade ramps (drawn over the waveform, darkening the ramp region)
    this.drawFades(ctx, c, x0, x1, g.waveTop, g.waveH);

    // clip-gain line
    if ((c.gain ?? 1) !== 1 || sel) {
      ctx.strokeStyle = sel ? 'rgba(255,220,120,0.95)' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.max(x, x0), g.gainY + 0.5);
      ctx.lineTo(Math.min(x + wClip, x1), g.gainY + 0.5);
      ctx.stroke();
    }
    ctx.restore();

    // border — recording placeholders pulse
    if (c.recording) {
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 180);
      ctx.strokeStyle = `rgba(255,90,90,${pulse.toFixed(3)})`;
      ctx.lineWidth = 2;
    } else {
      ctx.strokeStyle = sel ? '#ffffff' : rgba(mix(base, WHITE, 0.25), 0.5);
      ctx.lineWidth = sel ? 1.5 : 1;
    }
    this.roundRectPath(ctx, x + 0.75, y + 0.75, wClip - 1.5, ch - 1.5, 3);
    ctx.stroke();

    // fade grips + gain grip (only when selected — keeps idle clips clean)
    if (sel) {
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      for (const hx of [g.fadeInX, g.fadeOutX]) {
        if (hx > x0 - 2 && hx < x1 + 2) {
          ctx.beginPath(); ctx.arc(hx, g.waveTop, HANDLE_R - 1, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // label — pinned to the visible left edge of the clip
    if (wClip > 22) {
      const labelX = Math.max(x0, 4) + 4;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, wClip, CLIP_HEADER_H); ctx.clip();
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const midY = y + CLIP_HEADER_H / 2 + 0.5;
      if (c.recording) {
        ctx.fillStyle = `rgba(255,80,80,${(0.5 + 0.5 * Math.sin(performance.now() / 180)).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(labelX + 3, midY, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillText('REC', labelX + 10, midY);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillText(c.name, labelX, midY);
      }
      ctx.restore();
      ctx.textBaseline = 'alphabetic';
    }
  }

  private drawFades(
    ctx: CanvasRenderingContext2D, c: DawClip,
    x0: number, x1: number, waveTop: number, waveH: number,
  ) {
    const pps = this.pxPerSec;
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    const fi = Math.max(0, (c.fadeIn || 0) * pps);
    if (fi > 1) {
      ctx.beginPath();
      ctx.moveTo(x0, waveTop);
      ctx.lineTo(x0 + fi, waveTop);
      ctx.lineTo(x0, waveTop + waveH);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath(); ctx.moveTo(x0, waveTop + waveH); ctx.lineTo(x0 + fi, waveTop); ctx.stroke();
    }
    const fo = Math.max(0, (c.fadeOut || 0) * pps);
    if (fo > 1) {
      ctx.beginPath();
      ctx.moveTo(x1, waveTop);
      ctx.lineTo(x1 - fo, waveTop);
      ctx.lineTo(x1, waveTop + waveH);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath(); ctx.moveTo(x1 - fo, waveTop); ctx.lineTo(x1, waveTop + waveH); ctx.stroke();
    }
  }

  // Growing waveform during a live take: the coarse min/max envelope streamed
  // on the metering frame, mapped evenly across the clip's current span.
  private drawLiveWave(
    ctx: CanvasRenderingContext2D, c: DawClip,
    x0: number, x1: number, waveTop: number, waveH: number,
    base: [number, number, number],
  ) {
    const lp = useDawStore.getState().livePeaks[c.id];
    if (!lp || lp.length < 4) return;
    const n = lp.length / 2;                    // min/max pairs
    const span = Math.max(1, x1 - x0);
    const mid = waveTop + waveH / 2;
    const amp = (waveH / 2) * 0.92;
    const visL = Math.max(Math.floor(x0), 0);
    const visR = Math.min(Math.ceil(x1), this.width);
    const at = (px: number) => {
      const i = Math.min(n - 1, Math.max(0, Math.floor(((px - x0) / span) * n)));
      return { mn: lp[i * 2], mx: lp[i * 2 + 1] };
    };

    ctx.fillStyle = rgba(mix(base, WHITE, 0.7), 0.9);
    ctx.beginPath();
    ctx.moveTo(visL, mid - at(visL).mx * amp);
    for (let px = visL + 1; px <= visR; px++) ctx.lineTo(px, mid - at(px).mx * amp);
    for (let px = visR; px >= visL; px--) ctx.lineTo(px, mid - at(px).mn * amp);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(visL, mid + 0.5); ctx.lineTo(visR, mid + 0.5); ctx.stroke();
  }

  private drawWave(
    ctx: CanvasRenderingContext2D, c: DawClip, pk: PeaksData,
    x0: number, x1: number, waveTop: number, waveH: number,
    base: [number, number, number],
  ) {
    const sr = pk.sampleRate || c.sampleRate || 48000;
    const pps = this.pxPerSec;
    const framesPerPx = sr / pps;
    const tierKeys = Object.keys(pk.tiers).map(Number).sort((a, b) => a - b);
    let tier = tierKeys[0];
    for (const t of tierKeys) { if (t <= framesPerPx * 1.5) tier = t; }
    const mm = pk.tiers[String(tier)];
    const rms = pk.rmsTiers?.[String(tier)];
    if (!mm) return;

    const offsetFrames = (c.sourceOffset || 0) * sr;
    const mid = waveTop + waveH / 2;
    const amp = (waveH / 2) * 0.92;
    const visL = Math.max(Math.floor(x0), 0);
    const visR = Math.min(Math.ceil(x1), this.width);

    const sampleAt = (px: number) => {
      const srcFrame = offsetFrames + ((px - x0) / pps) * sr;
      const bkt = Math.max(0, Math.floor(srcFrame / tier));
      const i = bkt * 2;
      const mn = i < mm.length ? mm[i] : 0;
      const mx = i + 1 < mm.length ? mm[i + 1] : 0;
      const rv = rms && bkt < rms.length ? rms[bkt] : Math.max(Math.abs(mn), Math.abs(mx)) * 0.6;
      return { mn, mx, rv };
    };

    // peak envelope (lighter)
    const peakCol = mix(base, WHITE, 0.62);
    ctx.fillStyle = rgba(peakCol, 0.85);
    ctx.beginPath();
    ctx.moveTo(visL, mid - sampleAt(visL).mx * amp);
    for (let px = visL + 1; px <= visR; px++) ctx.lineTo(px, mid - sampleAt(px).mx * amp);
    for (let px = visR; px >= visL; px--) ctx.lineTo(px, mid - sampleAt(px).mn * amp);
    ctx.closePath();
    ctx.fill();

    // rms band (denser, brighter core)
    ctx.fillStyle = rgba(mix(base, WHITE, 0.92), 0.5);
    ctx.beginPath();
    ctx.moveTo(visL, mid - sampleAt(visL).rv * amp);
    for (let px = visL + 1; px <= visR; px++) ctx.lineTo(px, mid - sampleAt(px).rv * amp);
    for (let px = visR; px >= visL; px--) ctx.lineTo(px, mid + sampleAt(px).rv * amp);
    ctx.closePath();
    ctx.fill();

    // zero line
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(visL, mid + 0.5); ctx.lineTo(visR, mid + 0.5); ctx.stroke();
  }

  private roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    const anyCtx = ctx as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
    if (typeof anyCtx.roundRect === 'function') { anyCtx.roundRect(x, y, w, h, rr); return; }
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
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

    // markers — a small flag + label in the lower ruler band, a hairline down
    // the surface handled by draw() below via drawMarkerLines().
    const markers = Object.values(useDawStore.getState().markers);
    for (const m of markers) {
      const x = this.timeToX(m.time);
      if (x < -40 || x > w + 4) continue;
      const col = m.color || '#f4b23e';
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 12);
      ctx.lineTo(x + 8, RULER_H - 12);
      ctx.lineTo(x + 8, RULER_H - 6);
      ctx.lineTo(x + 2, RULER_H - 6);
      ctx.lineTo(x + 2, RULER_H);
      ctx.lineTo(x, RULER_H);
      ctx.closePath();
      ctx.fill();
      if (m.name) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(m.name, x + 11, RULER_H - 4);
      }
    }
  }

  // Phase 3e — the shared loop / punch region: a tinted span across the lanes
  // plus a band with drag handles in the ruler. Colour follows what it drives.
  private drawRegion(ctx: CanvasRenderingContext2D) {
    const s = useDawStore.getState();
    if (!s.region) return;
    const x0 = this.timeToX(s.region.inSec);
    const x1 = this.timeToX(s.region.outSec);
    if (x1 < 0 || x0 > this.width) return;
    const w = Math.max(1, x1 - x0);

    // punch (recording) wins the colour; else loop; else a neutral selection.
    const c = s.punchEnabled ? [239, 68, 68] : s.loopEnabled ? [56, 189, 219] : [148, 163, 184];
    const rgb = (a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

    ctx.fillStyle = rgb(s.punchEnabled || s.loopEnabled ? 0.09 : 0.05);
    ctx.fillRect(x0, RULER_H, w, this.height - RULER_H);
    ctx.strokeStyle = rgb(0.5);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0 + 0.5, RULER_H); ctx.lineTo(x0 + 0.5, this.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1 - 0.5, RULER_H); ctx.lineTo(x1 - 0.5, this.height); ctx.stroke();

    // ruler band + end caps
    ctx.fillStyle = rgb(s.punchEnabled || s.loopEnabled ? 0.85 : 0.4);
    ctx.fillRect(x0, 0, w, 4);
    ctx.fillRect(x0, 0, 3, RULER_H - 12);
    ctx.fillRect(x1 - 3, 0, 3, RULER_H - 12);
    if (s.punchEnabled || s.loopEnabled) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '8px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(s.punchEnabled ? 'PUNCH' : 'LOOP', x0 + 5, 12);
    }
  }

  // Vertical marker guide lines across the lane area (called from draw()).
  private drawMarkerLines(ctx: CanvasRenderingContext2D) {
    const markers = Object.values(useDawStore.getState().markers);
    for (const m of markers) {
      const x = this.timeToX(m.time);
      if (x < 0 || x > this.width) continue;
      ctx.strokeStyle = 'rgba(244,178,62,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 0.5, RULER_H); ctx.lineTo(x + 0.5, this.height); ctx.stroke();
    }
  }
}

function fmtRuler(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(r < 10 ? 1 : 0).padStart(r < 10 ? 4 : 2, '0')}`;
}

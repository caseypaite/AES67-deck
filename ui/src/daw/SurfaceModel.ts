// The arrange surface: one canvas, no widgets. Holds the view transform and
// clip geometry, hit-tests in canvas space, and paints grid / lanes / clips /
// waveforms / playhead. Reads the stores directly; owns no React state.

import { useDawStore, type DawClip, type PeaksData, type AutoLane, clipPeakKey, musicalGrid, secToBBT } from '../stores/useDawStore';
import { useMixerStore, type Channel } from '../stores/useMixerStore';

export const RULER_H = 26;
export const DEFAULT_TRACK_H = 96;
const MIN_TRACK_H = 48;
export const LANE_H = 60;   // height of one take lane on an expanded track
export const AUTO_LANE_H = 46;   // height of one automation lane

// Track-row backgrounds — shared by the canvas and the TrackPanel so the two
// stay aligned. Kept a clear step apart for legible alternation.
export const TRACK_BG_ODD = '#242a35';
export const TRACK_BG_EVEN = '#1b2028';

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
    | 'take-lane'
    | 'auto-point' | 'auto-lane'
    | 'region-in' | 'region-out' | 'region-body';
  clipId?: string;
  trackId?: number;
  lane?: number;         // which lane within the track the hit landed in (0 = comp)
  laneId?: string;       // automation lane id (auto-* hits)
  pointIdx?: number;     // automation breakpoint index (auto-point)
  markerId?: string;
  time: number;
  cursor: string;
}

interface Track {
  id: number; name: string; height: number; y: number;
  expanded: boolean;     // take lanes shown
  lanes: number;         // number of take lanes (highest lane index in use)
  compH: number;         // height of the comp band (row 0); take lanes are LANE_H each
  autoExpanded: boolean;
  autoLaneIds: string[]; // automation lane ids on this track, in order
}

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

  // paint counters (perf visibility): scene repaints only on edits/view change,
  // overlay every frame while rolling.
  sceneDraws = 0;
  overlayDraws = 0;

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
    const ids = Object.values(chans).filter((c: Channel) => c.type === 'input').map((c) => c.id).sort((a, b) => a - b);

    // Take-lane count per track, derived from the clips.
    const laneCounts: Record<number, number> = {};
    for (const c of Object.values(daw.clips)) {
      if (c.recording) continue;
      const L = c.lane || 0;
      if (L > (laneCounts[c.trackId] || 0)) laneCounts[c.trackId] = L;
    }
    // Automation lane ids per track (channel).
    const autoByTrack: Record<number, string[]> = {};
    for (const lane of Object.values(daw.automation)) {
      (autoByTrack[lane.target.channelId] ||= []).push(lane.id);
    }

    // Cheap memo — rebuild only when the geometry inputs change.
    const key = ids.join(',') + '|' + JSON.stringify(heights) + '|' + daw.scrollY
      + '|' + JSON.stringify(daw.laneExpand) + '|' + JSON.stringify(laneCounts)
      + '|' + JSON.stringify(daw.autoExpand) + '|' + JSON.stringify(autoByTrack);
    if (this._tracksCache && this._tracksCache.key === key) return this._tracksCache.tracks;

    const byId = chans as Record<number, Channel>;
    let y = RULER_H - daw.scrollY;
    const tracks = ids.map((id) => {
      const compH = Math.max(MIN_TRACK_H, heights[id] || DEFAULT_TRACK_H);
      const lanes = laneCounts[id] || 0;
      const expanded = !!daw.laneExpand[id] && lanes > 0;
      const autoLaneIds = autoByTrack[id] || [];
      const autoExpanded = !!daw.autoExpand[id] && autoLaneIds.length > 0;
      const height = compH + (expanded ? LANE_H * lanes : 0)
        + (autoExpanded ? AUTO_LANE_H * autoLaneIds.length : 0);
      const t = { id, name: byId[id]?.name ?? `IN ${id}`, height, y, expanded, lanes, compH, autoExpanded, autoLaneIds };
      y += height;
      return t;
    });
    this._tracksCache = { key, tracks };
    return tracks;
  }

  // y-bands for a track's lanes: index 0 = comp band, 1..lanes = take lanes.
  laneRects(t: Track): Array<{ lane: number; y: number; h: number }> {
    const out = [{ lane: 0, y: t.y, h: t.compH }];
    if (t.expanded) {
      for (let k = 1; k <= t.lanes; k++)
        out.push({ lane: k, y: t.y + t.compH + LANE_H * (k - 1), h: LANE_H });
    }
    return out;
  }

  laneAtY(t: Track, py: number): { lane: number; y: number; h: number } {
    const rects = this.laneRects(t);
    for (const r of rects) if (py >= r.y && py < r.y + r.h) return r;
    return rects[0];
  }

  // y-bands for a track's automation lanes (below the take lanes).
  autoBands(t: Track): Array<{ laneId: string; y: number; h: number }> {
    if (!t.autoExpanded) return [];
    const top = t.y + t.compH + (t.expanded ? LANE_H * t.lanes : 0);
    return t.autoLaneIds.map((laneId, k) => ({ laneId, y: top + AUTO_LANE_H * k, h: AUTO_LANE_H }));
  }

  // Screen py → a value in `laneId`'s domain (clamped), or null if it's not shown.
  autoLaneValueAt(laneId: string, py: number): number | null {
    const lane = useDawStore.getState().automation[laneId];
    if (!lane) return null;
    for (const t of this.tracks()) {
      for (const ab of this.autoBands(t)) {
        if (ab.laneId !== laneId) continue;
        const pad = 4, top = ab.y + pad, span = ab.h - 2 * pad;
        const f = 1 - (py - top) / Math.max(1e-9, span);
        return Math.max(lane.min, Math.min(lane.max, lane.min + f * (lane.max - lane.min)));
      }
    }
    return null;
  }

  contentHeight(): number {
    return this.tracks().reduce((s, t) => s + t.height, 0) + RULER_H;
  }

  maxScrollY() {
    return Math.max(0, this.contentHeight() - this.height);
  }

  // Vertical scrollbar geometry (screen space), or null when everything fits.
  static SCROLLBAR_W = 14;   // wide enough to be a touch target
  scrollbar(): { x: number; trackY: number; trackH: number; thumbY: number; thumbH: number } | null {
    const max = this.maxScrollY();
    if (max <= 0) return null;
    const trackY = RULER_H;
    const trackH = this.height - RULER_H;
    const viewBelow = this.height - RULER_H;
    const contentBelow = this.contentHeight() - RULER_H;
    const thumbH = Math.max(24, trackH * (viewBelow / contentBelow));
    const thumbY = trackY + (trackH - thumbH) * (this.scrollY / max);
    return { x: this.width - SurfaceModel.SCROLLBAR_W, trackY, trackH, thumbY, thumbH };
  }

  // Pointer x/y is on the scrollbar → the scrollY it maps to (dragging the
  // thumb), plus whether the press landed on the thumb itself.
  scrollbarHit(px: number, py: number): { onThumb: boolean } | null {
    const sb = this.scrollbar();
    if (!sb || px < sb.x - 2 || py < sb.trackY) return null;
    return { onThumb: py >= sb.thumbY && py <= sb.thumbY + sb.thumbH };
  }
  scrollYForThumbTop(thumbTopY: number): number {
    const sb = this.scrollbar();
    if (!sb) return 0;
    const span = sb.trackH - sb.thumbH;
    if (span <= 0) return 0;
    return Math.max(0, Math.min(this.maxScrollY(), ((thumbTopY - sb.trackY) / span) * this.maxScrollY()));
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
        if (c.trackId !== tr.id || (c.lane || 0) !== 0) continue;  // comp lane only
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

    // Automation lanes (below the take lanes).
    for (const ab of this.autoBands(track)) {
      if (py < ab.y || py >= ab.y + ab.h) continue;
      const lane = useDawStore.getState().automation[ab.laneId];
      if (!lane) return { kind: 'auto-lane', trackId: track.id, laneId: ab.laneId, time, cursor: 'crosshair' };
      const pad = 4;
      for (let i = 0; i < lane.points.length; i++) {
        const p = lane.points[i];
        const px2 = this.timeToX(p.t);
        const py2 = ab.y + pad + (ab.h - 2 * pad) * (1 - (p.v - lane.min) / Math.max(1e-9, lane.max - lane.min));
        if (Math.abs(px - px2) <= 6 && Math.abs(py - py2) <= 6)
          return { kind: 'auto-point', trackId: track.id, laneId: ab.laneId, pointIdx: i, time, cursor: 'move' };
      }
      return { kind: 'auto-lane', trackId: track.id, laneId: ab.laneId, time, cursor: 'crosshair' };
    }

    const band = this.laneAtY(track, py);
    const clips = Object.values(useDawStore.getState().clips)
      .filter((c) => c.trackId === track.id && (c.lane || 0) === band.lane);
    const y = band.y + 3;
    const ch = band.h - 6;
    // Front-most clip first (last drawn wins visually).
    for (let i = clips.length - 1; i >= 0; i--) {
      const c = clips[i];
      if (c.recording) continue; // the live take placeholder isn't editable
      const x0 = this.timeToX(c.start);
      const x1 = this.timeToX(c.start + c.length);
      if (px < x0 - 1 || px > x1 + 1) continue;
      const base = { clipId: c.id, trackId: track.id, lane: band.lane, time };
      if (c.locked) return { kind: 'clip', ...base, cursor: 'default' };
      const g = this.grips(c, x0, x1, y, ch);

      // fade grips (top edge, near the ramp end-point) — comp lane only
      if (band.lane === 0 && py <= g.waveTop + HANDLE_R + 2) {
        if (Math.abs(px - g.fadeInX) <= HANDLE_R + 3)
          return { kind: 'clip-fade-in', ...base, cursor: 'ew-resize' };
        if (Math.abs(px - g.fadeOutX) <= HANDLE_R + 3)
          return { kind: 'clip-fade-out', ...base, cursor: 'ew-resize' };
      }
      // gain line (mid clip, away from the edges) — comp lane only
      if (band.lane === 0 && px > x0 + EDGE + 4 && px < x1 - EDGE - 4 && Math.abs(py - g.gainY) <= HANDLE_R)
        return { kind: 'clip-gain', ...base, cursor: 'ns-resize' };

      if (band.lane === 0 && px <= x0 + EDGE) return { kind: 'clip-left', ...base, cursor: 'ew-resize' };
      if (band.lane === 0 && px >= x1 - EDGE) return { kind: 'clip-right', ...base, cursor: 'ew-resize' };
      return { kind: 'clip', ...base, cursor: band.lane === 0 ? 'grab' : 'pointer' };
    }
    return {
      kind: band.lane === 0 ? 'lane' : 'take-lane',
      trackId: track.id, lane: band.lane, time,
      cursor: band.lane === 0 ? 'default' : 'crosshair',
    };
  }

  // --- painting ---
  // Two layers: the scene (grid / tracks / clips / waveforms / region /
  // markers) repaints only on an edit or view change; the overlay (playhead)
  // repaints every frame while the transport rolls. Keeps steady-state
  // playback at one thin line per frame instead of the whole arrange view.

  // Playhead line + head, on the transparent overlay canvas.
  drawOverlay(ctx: CanvasRenderingContext2D) {
    this.overlayDraws++;
    const { width: w, height: h } = this;
    ctx.clearRect(0, 0, w, h);
    const daw = useDawStore.getState();
    const recording = useMixerStore.getState().transportState === 'recording';
    const px = this.timeToX(daw.playheadPosition);
    if (px >= 0 && px <= w) {
      ctx.strokeStyle = recording ? '#ef4444' : '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, h); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle as string;
      ctx.beginPath(); ctx.moveTo(px - 4, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px + 0.5, 7); ctx.fill();
    }

    // vertical scrollbar (only when the track stack overflows the viewport)
    const sb = this.scrollbar();
    if (sb) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(sb.x, sb.trackY, SurfaceModel.SCROLLBAR_W, sb.trackH);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(sb.x, sb.trackY, 1, sb.trackH);
      ctx.fillStyle = 'rgba(255,255,255,0.40)';
      this.roundRectPath(ctx, sb.x + 3, sb.thumbY, SurfaceModel.SCROLLBAR_W - 6, sb.thumbH, 3);
      ctx.fill();
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    this.sceneDraws++;
    const { width: w, height: h } = this;
    const pps = this.pxPerSec;
    const daw = useDawStore.getState();

    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, w, h);

    const tStart = this.xToTime(0);
    const tEnd = this.xToTime(w);

    // grid — seconds (minor at gridSize, major every 10) or bars/beats
    let minor: number, major: number;
    if (daw.gridMode === 'bars') {
      const { beat, bar } = musicalGrid(daw.tempo, daw.timeSig.num);
      minor = beat; major = bar;
      while (minor * pps < 7 && minor < major) minor *= 2;   // thin out beats when zoomed out
    } else {
      major = daw.gridSize * 10;
      while (major * pps < 60) major *= 2;
      minor = major / 10;
    }
    ctx.lineWidth = 1;
    for (let t = Math.floor(tStart / minor) * minor; t < tEnd; t += minor) {
      const x = Math.round(this.timeToX(t)) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.strokeStyle = isMajor ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.08)';
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, h); ctx.stroke();
    }

    // lanes + clips
    const tracks = this.tracks();
    const selected = new Set(daw.selectedClipIds);
    const dropTrack = daw.dragOverTrackId;
    const clipsByTrack = new Map<number, DawClip[]>();
    for (const c of Object.values(daw.clips)) {
      const a = clipsByTrack.get(c.trackId);
      if (a) a.push(c); else clipsByTrack.set(c.trackId, [c]);
    }
    for (const tr of tracks) {
      if (tr.y + tr.height < RULER_H || tr.y > h) continue;
      ctx.fillStyle = (tr.id % 2) ? TRACK_BG_ODD : TRACK_BG_EVEN;
      ctx.fillRect(0, tr.y, w, tr.height);
      if (dropTrack === tr.id && daw.dragOverLane == null) {
        ctx.fillStyle = 'rgba(90,140,255,0.10)';
        ctx.fillRect(0, tr.y, w, tr.height);
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.beginPath(); ctx.moveTo(0, tr.y + tr.height - 0.5); ctx.lineTo(w, tr.y + tr.height - 0.5); ctx.stroke();

      const trackClips = clipsByTrack.get(tr.id) || [];

      // Which spans of each take lane are currently the active comp — a comp-lane
      // clip that references the same source with a matching source offset.
      const compSrc = trackClips.filter((c) => (c.lane || 0) === 0 && c.takeDir && c.file);
      const activeByLane: Record<number, Array<[number, number]>> = {};
      for (const tc of trackClips) {
        const L = tc.lane || 0;
        if (L === 0) continue;
        for (const cc of compSrc) {
          if (cc.takeDir !== tc.takeDir || cc.file !== tc.file) continue;
          const expected = (tc.sourceOffset || 0) + (cc.start - tc.start);
          if (Math.abs((cc.sourceOffset || 0) - expected) > 0.01) continue;
          const from = Math.max(cc.start, tc.start);
          const to = Math.min(cc.start + cc.length, tc.start + tc.length);
          if (to > from) (activeByLane[L] ||= []).push([from, to]);
        }
      }

      for (const band of this.laneRects(tr)) {
        const laneClips = trackClips.filter((c) => (c.lane || 0) === band.lane);

        if (band.lane > 0) {
          // take lane: separator + a wash so the comp lane reads as primary
          ctx.fillStyle = 'rgba(0,0,0,0.30)';
          ctx.fillRect(0, band.y, w, band.h);
          ctx.strokeStyle = 'rgba(255,255,255,0.12)';
          ctx.beginPath(); ctx.moveTo(0, band.y + 0.5); ctx.lineTo(w, band.y + 0.5); ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
          ctx.textBaseline = 'top';
          ctx.fillText(String(band.lane), 4, band.y + 3);
          ctx.textBaseline = 'alphabetic';
        }

        // vertical-move drop target (lane-aware)
        if (dropTrack === tr.id && daw.dragOverLane === band.lane) {
          ctx.fillStyle = 'rgba(90,140,255,0.16)';
          ctx.fillRect(0, band.y, w, band.h);
          ctx.strokeStyle = 'rgba(120,170,255,0.7)';
          ctx.lineWidth = 1;
          ctx.strokeRect(0.5, band.y + 0.5, w - 1, band.h - 1);
        }

        for (const c of laneClips) {
          const x0 = this.timeToX(c.start);
          const x1 = this.timeToX(c.start + c.length);
          if (x1 < 0 || x0 > w) continue;
          this.drawClip(ctx, c, x0, x1, band.y + 3, band.h - 6, selected.has(c.id), daw.peaks);
        }

        // "this take is the active comp here" — green wash + top accent
        for (const [from, to] of activeByLane[band.lane] || []) {
          const gx = this.timeToX(from);
          const gw = this.timeToX(to) - gx;
          if (gw <= 0) continue;
          ctx.fillStyle = 'rgba(110,210,130,0.16)';
          ctx.fillRect(gx, band.y, gw, band.h);
          ctx.fillStyle = 'rgba(140,235,160,0.95)';
          ctx.fillRect(gx, band.y, gw, 2);
        }

        // Crossfades: adjacent overlapping clips in this lane get the X marker.
        const sorted = laneClips.filter((c) => !c.recording).sort((a, b) => a.start - b.start);
        for (let i = 1; i < sorted.length; i++) {
          const a = sorted[i - 1], b = sorted[i];
          const ovEnd = Math.min(a.start + a.length, b.start + b.length);
          if (ovEnd <= b.start) continue;
          this.drawCrossfade(ctx, this.timeToX(b.start), this.timeToX(ovEnd), band.y + 3, band.h - 6);
        }
      }

      // Automation lanes (below the take lanes).
      for (const ab of this.autoBands(tr)) {
        const lane = daw.automation[ab.laneId];
        if (lane) this.drawAutomationLane(ctx, lane, ab.y, ab.h, daw.playheadPosition);
      }

      // Comp swipe preview: highlight the span on the source lane + comp lane.
      const cp = daw.compPreview;
      if (cp && cp.trackId === tr.id && cp.toSec > cp.fromSec) {
        const px0 = this.timeToX(cp.fromSec);
        const pw = this.timeToX(cp.toSec) - px0;
        for (const band of this.laneRects(tr)) {
          if (band.lane !== 0 && band.lane !== cp.lane) continue;
          ctx.fillStyle = band.lane === cp.lane ? 'rgba(120,200,120,0.30)' : 'rgba(120,200,120,0.14)';
          ctx.fillRect(px0, band.y, pw, band.h);
          ctx.strokeStyle = 'rgba(150,230,150,0.9)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px0 + 0.5, band.y + 0.5, pw, band.h - 1);
        }
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
    // playhead is drawn on the overlay canvas (drawOverlay)
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

    // border — recording placeholders pulse; grouped clips get a coloured edge
    if (c.recording) {
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 180);
      ctx.strokeStyle = `rgba(255,90,90,${pulse.toFixed(3)})`;
      ctx.lineWidth = 2;
    } else if (c.group && !sel) {
      const hue = (parseInt(c.group.slice(0, 6), 36) || 0) % 360;
      ctx.strokeStyle = `hsla(${hue},70%,65%,0.9)`;
      ctx.lineWidth = 1.5;
    } else {
      ctx.strokeStyle = sel ? '#ffffff' : rgba(mix(base, WHITE, 0.25), 0.5);
      ctx.lineWidth = sel ? 1.5 : 1;
    }
    this.roundRectPath(ctx, x + 0.75, y + 0.75, wClip - 1.5, ch - 1.5, 3);
    ctx.stroke();

    // lock: hatch wash + a padlock tick at the right edge of the header
    if (c.locked) {
      ctx.save();
      this.roundRectPath(ctx, x, y, wClip, ch, 3);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      for (let hx = x - ch; hx < x + wClip; hx += 7) {
        ctx.beginPath(); ctx.moveTo(hx, y + ch); ctx.lineTo(hx + ch, y); ctx.stroke();
      }
      if (wClip > 16) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillRect(x + wClip - 8, y + 4, 5, 4);
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.beginPath(); ctx.arc(x + wClip - 5.5, y + 4, 2, Math.PI, 0); ctx.stroke();
      }
      ctx.restore();
    }

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

  // Equal-power crossfade marker over a clip overlap: a dark wash plus the
  // classic crossing X (rising = incoming clip, falling = outgoing).
  private drawCrossfade(
    ctx: CanvasRenderingContext2D,
    x0: number, x1: number, y: number, h: number,
  ) {
    const xa = Math.max(x0, -2);
    const xb = Math.min(x1, this.width + 2);
    if (xb - xa < 1) return;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fillRect(xa, y, xb - xa, h);
    ctx.strokeStyle = 'rgba(255,210,120,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xa, y + h - 0.5); ctx.lineTo(xb, y + 0.5);
    ctx.moveTo(xa, y + 0.5); ctx.lineTo(xb, y + h - 0.5);
    ctx.stroke();
    ctx.restore();
  }

  private drawAutomationLane(
    ctx: CanvasRenderingContext2D, lane: AutoLane, y: number, h: number, playhead: number,
  ) {
    const pad = 4;
    const top = y + pad, span = h - 2 * pad;
    const vy = (v: number) => top + span * (1 - (v - lane.min) / Math.max(1e-9, lane.max - lane.min));
    const active = lane.enabled;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.fillRect(0, y, this.width, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(this.width, y + 0.5); ctx.stroke();
    // midline
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath(); ctx.moveTo(0, top + span / 2); ctx.lineTo(this.width, top + span / 2); ctx.stroke();

    // label
    ctx.fillStyle = active ? 'rgba(150,200,255,0.9)' : 'rgba(255,255,255,0.35)';
    ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(`⌁ ${lane.target.label}${active ? '' : '  (off)'}`, 4, y + 3);
    ctx.textBaseline = 'alphabetic';

    const col = active ? '#7cc4ff' : 'rgba(150,170,200,0.5)';
    const pts = lane.points;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (pts.length === 0) {
      // flat — nothing to draw
    } else {
      let started = false;
      const first = vy(pts[0].v);
      ctx.moveTo(-2, first); ctx.lineTo(this.timeToX(pts[0].t), first); started = true;
      for (const p of pts) ctx.lineTo(this.timeToX(p.t), vy(p.v));
      const last = pts[pts.length - 1];
      ctx.lineTo(this.width + 2, vy(last.v));
      if (started) ctx.stroke();
    }
    // points
    ctx.fillStyle = col;
    for (const p of pts) {
      const px = this.timeToX(p.t);
      if (px < -4 || px > this.width + 4) continue;
      ctx.fillRect(px - 2.5, vy(p.v) - 2.5, 5, 5);
    }
    // current value dot at the playhead
    if (pts.length) {
      const phx = this.timeToX(playhead);
      if (phx >= 0 && phx <= this.width) {
        let v = pts[0].v;
        for (let i = 0; i < pts.length; i++) {
          if (pts[i].t <= playhead) v = pts[i].v;
          if (pts[i].t > playhead && i > 0) {
            const a = pts[i - 1], b = pts[i];
            v = a.v + (b.v - a.v) * (playhead - a.t) / Math.max(1e-9, b.t - a.t);
            break;
          }
        }
        ctx.fillStyle = active ? '#ffffff' : 'rgba(255,255,255,0.5)';
        ctx.beginPath(); ctx.arc(phx, vy(v), 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
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
    ctx.fillStyle = '#0c0e12';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.beginPath(); ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(w, RULER_H - 0.5); ctx.stroke();

    const daw = useDawStore.getState();
    const bars = daw.gridMode === 'bars';
    const label = (t: number) => bars ? `${secToBBT(t, daw.tempo, daw.timeSig.num).bar}` : fmtRuler(t);

    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.font = '10px ui-monospace, monospace';
    for (let t = Math.floor(tStart / major) * major; t < tEnd; t += major) {
      const x = this.timeToX(t);
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath(); ctx.moveTo(x + 0.5, RULER_H - 8); ctx.lineTo(x + 0.5, RULER_H); ctx.stroke();
      ctx.fillText(label(t), x + 3, 11);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
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

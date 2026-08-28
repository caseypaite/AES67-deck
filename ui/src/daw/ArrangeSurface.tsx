import { useEffect, useRef, useState } from 'react';
import { useDawStore } from '../stores/useDawStore';
import { useMixerStore } from '../stores/useMixerStore';
import { SurfaceModel, RULER_H } from './SurfaceModel';

// Canvas arrange surface. React mounts it once; all drawing and interaction
// happen outside React — a single rAF loop paints the SurfaceModel, pointer
// handlers mutate the store, and a store subscription just flips a dirty flag.
// The only React state here is the two transient DOM overlays (context menu,
// inline rename) that genuinely need the DOM.

interface MenuState { x: number; y: number; clipId: string; time: number }
interface RenameState { x: number; y: number; w: number; clipId: string; value: string }

export function ArrangeSurface() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef<SurfaceModel | null>(null);
  const dirtyRef = useRef(true);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);

  if (!modelRef.current) modelRef.current = new SurfaceModel();
  const model = modelRef.current;

  // --- sizing (DPR-aware) ---
  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      model.width = r.width;
      model.height = r.height;
      dirtyRef.current = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [model]);

  // --- render loop (the only rAF loop in the timeline) ---
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const frame = () => {
      const rolling = useMixerStore.getState().transportState !== 'stopped';
      if (rolling) useDawStore.getState().tickPlayhead(); // interpolate engine clock
      if (dirtyRef.current || rolling) {
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        model.draw(ctx);
        dirtyRef.current = false;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // Any DAW-store change (clips, selection, scroll, zoom, playhead, peaks,
    // marquee, drag target) flags a repaint.
    const unsub = useDawStore.subscribe(() => { dirtyRef.current = true; });
    return () => { cancelAnimationFrame(raf); unsub(); };
  }, [model]);

  // --- pointer interaction ---
  useEffect(() => {
    const canvas = canvasRef.current!;
    const daw = useDawStore;

    const snap = (t: number) => {
      const s = daw.getState();
      return s.snapToGrid ? Math.round(t / s.gridSize) * s.gridSize : t;
    };
    const pt = (e: PointerEvent | MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { px: e.clientX - rect.left, py: e.clientY - rect.top, rect };
    };
    const drag = (move: (e: PointerEvent) => void, end?: () => void) => {
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        end?.();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };

    // hover cursor feedback
    const onPointerMove = (e: PointerEvent) => {
      if (e.buttons) return;
      const { px, py } = pt(e);
      canvas.style.cursor = model.hitTest(px, py).cursor;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 2) return; // context menu handled separately
      setMenu(null);
      const { px, py, rect } = pt(e);
      const hit = model.hitTest(px, py);
      const s = daw.getState();

      if (hit.kind === 'marker' && hit.markerId) {
        const id = hit.markerId;
        let movedM = false;
        drag(
          (ev) => { movedM = true; daw.getState().updateMarker(id, { time: snap(Math.max(0, model.xToTime(ev.clientX - rect.left))) }); },
          () => { if (!movedM) { const m = daw.getState().markers[id]; if (m) s.locate(m.time); } },
        );
        return;
      }

      // Phase 3e — loop/punch region: drag the in/out handles or the whole span.
      if (hit.kind === 'region-in' || hit.kind === 'region-out' || hit.kind === 'region-body') {
        const r0 = daw.getState().region;
        if (!r0) return;
        const startT = model.xToTime(e.clientX - rect.left);
        drag((ev) => {
          const t = snap(Math.max(0, model.xToTime(ev.clientX - rect.left)));
          const r = daw.getState().region ?? r0;
          if (hit.kind === 'region-in') daw.getState().setRegion(t, r.outSec);
          else if (hit.kind === 'region-out') daw.getState().setRegion(r.inSec, t);
          else {
            const dt = snap(model.xToTime(ev.clientX - rect.left) - startT + r0.inSec) - r0.inSec;
            daw.getState().setRegion(Math.max(0, r0.inSec + dt), Math.max(0.01, r0.outSec + dt));
          }
        });
        return;
      }

      if (hit.kind === 'ruler') {
        if (e.shiftKey) { s.addMarker(snap(Math.max(0, model.xToTime(e.clientX - rect.left)))); return; }
        // Alt-drag paints a new loop/punch region.
        if (e.altKey) {
          const a = snap(Math.max(0, model.xToTime(e.clientX - rect.left)));
          let dragged = false;
          drag(
            (ev) => { dragged = true; const b = snap(Math.max(0, model.xToTime(ev.clientX - rect.left))); daw.getState().setRegion(Math.min(a, b), Math.max(a, b)); },
            () => { if (!dragged) daw.getState().setRegion(a, a + Math.max(1, daw.getState().gridSize * 4)); },
          );
          return;
        }
        const scrub = (cx: number) => s.locate(snap(Math.max(0, model.xToTime(cx - rect.left))));
        scrub(e.clientX);
        drag((ev) => scrub(ev.clientX));
        return;
      }

      if (hit.kind === 'lane' || hit.kind === 'empty') {
        if (!e.shiftKey) s.clearSelection();
        // marquee select
        const startPx = px, startPy = py;
        const baseSel = e.shiftKey ? [...s.selectedClipIds] : [];
        const move = (ev: PointerEvent) => {
          const p = pt(ev);
          daw.getState().setMarquee({ x0: startPx, y0: startPy, x1: p.px, y1: p.py });
          daw.getState().setSelectedClips(uniq([...baseSel, ...model.clipsInRect(startPx, startPy, p.px, p.py)]));
        };
        drag(move, () => daw.getState().setMarquee(null));
        return;
      }

      // Phase 4 — take comping: swipe horizontally across a take lane (empty
      // area or a take clip) to make that take the active one over the range.
      if ((hit.kind === 'take-lane' || (hit.kind === 'clip' && (hit.lane ?? 0) > 0))
          && hit.trackId != null && hit.lane) {
        const trackId = hit.trackId, lane = hit.lane;
        const t0 = model.xToTime(e.clientX - rect.left);
        let a = t0, b = t0, swiped = false;
        drag(
          (ev) => {
            swiped = true;
            const t = Math.max(0, model.xToTime(ev.clientX - rect.left));
            a = Math.min(t0, t); b = Math.max(t0, t);
            daw.getState().setCompPreview({ trackId, lane, fromSec: a, toSec: b });
          },
          () => {
            daw.getState().setCompPreview(null);
            if (swiped && b - a > 0.03) daw.getState().compPick(trackId, a, b, lane);
            else if (hit.clipId) s.setSelectedClips([hit.clipId]);
          },
        );
        return;
      }

      const clip = hit.clipId ? s.clips[hit.clipId] : undefined;
      if (!clip) return;

      // selection
      let sel = s.selectedClipIds;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        s.toggleClipSelection(clip.id);
        sel = sel.includes(clip.id) ? sel.filter((i) => i !== clip.id) : [...sel, clip.id];
      } else if (!sel.includes(clip.id)) {
        s.setSelectedClips([clip.id]);
        sel = [clip.id];
      }

      const startX = e.clientX;
      const startY = e.clientY;
      const zoomAt = () => daw.getState().zoom;

      if (hit.kind === 'clip-fade-in' || hit.kind === 'clip-fade-out') {
        const edge = hit.kind === 'clip-fade-in' ? 'in' : 'out';
        const base = edge === 'in' ? (clip.fadeIn || 0) : (clip.fadeOut || 0);
        drag((ev) => {
          const dt = (ev.clientX - startX) / zoomAt();
          daw.getState().setClipFade(clip.id, edge, edge === 'in' ? base + dt : base - dt);
        });
        return;
      }

      if (hit.kind === 'clip-gain') {
        const laneH = Math.max(20, (model.trackAtY(py)?.height ?? 96) - 20);
        const baseDb = 20 * Math.log10(Math.max(1e-4, clip.gain ?? 1));
        drag((ev) => {
          const dy = ev.clientY - startY;
          const db = baseDb - (dy / laneH) * 72; // dragging the full lane ≈ 72 dB
          daw.getState().setClipGain(clip.id, Math.pow(10, Math.max(-60, Math.min(12, db)) / 20));
        });
        return;
      }

      if (hit.kind === 'clip-left') {
        const c0 = { ...clip };
        drag((ev) => {
          const dt = (ev.clientX - startX) / zoomAt();
          let newStart = snap(c0.start + dt);
          newStart = Math.max(0, Math.min(c0.start + c0.length - 0.05, newStart));
          const shift = newStart - c0.start;
          daw.getState().updateClip(c0.id, {
            start: newStart, length: c0.length - shift,
            sourceOffset: Math.max(0, (c0.sourceOffset || 0) + shift),
          });
        });
        return;
      }
      if (hit.kind === 'clip-right') {
        const c0 = { ...clip };
        drag((ev) => {
          const dt = (ev.clientX - startX) / zoomAt();
          const newLen = Math.max(0.05, snap(c0.start + c0.length + dt) - c0.start);
          daw.getState().updateClip(c0.id, { length: newLen });
        });
        return;
      }

      // move (whole selection), with vertical retarget for a lone clip
      const starts: Record<string, number> = {};
      sel.forEach((id) => { const c = s.clips[id]; if (c) starts[id] = c.start; });
      const originTrack = clip.trackId;
      let moved = false;
      const move = (ev: PointerEvent) => {
        moved = true;
        const dt = (ev.clientX - startX) / zoomAt();
        const snapped = snap(starts[clip.id] + dt) - starts[clip.id];
        let delta = snapped;
        Object.keys(starts).forEach((id) => { if (starts[id] + delta < 0) delta = -starts[id]; });
        sel.forEach((id) => daw.getState().updateClip(id, { start: starts[id] + delta }));

        if (sel.length === 1) {
          const p = pt(ev);
          const tgt = model.trackAtY(p.py);
          daw.getState().setDragOverTrack(tgt && tgt.id !== originTrack ? tgt.id : null);
        }
      };
      drag(move, () => {
        const over = daw.getState().dragOverTrackId;
        if (moved && sel.length === 1 && over != null && over !== originTrack) {
          daw.getState().updateClip(clip.id, { trackId: over });
        }
        daw.getState().setDragOverTrack(null);
      });
    };

    const onDblClick = (e: MouseEvent) => {
      const { px, py } = pt(e);
      const hit = model.hitTest(px, py);
      if ((hit.kind === 'clip' || hit.kind === 'clip-gain') && hit.clipId) {
        const c = daw.getState().clips[hit.clipId];
        if (!c) return;
        setRename({
          x: Math.max(model.timeToX(c.start), 2),
          y: model.trackAtY(py)?.y ?? py,
          w: 160,
          clipId: c.id,
          value: c.name,
        });
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const { px, py } = pt(e);
      const hit = model.hitTest(px, py);
      if (hit.kind === 'marker' && hit.markerId) {
        daw.getState().removeMarker(hit.markerId);
        setMenu(null);
        return;
      }
      if (hit.clipId) {
        if (!daw.getState().selectedClipIds.includes(hit.clipId)) daw.getState().setSelectedClips([hit.clipId]);
        setMenu({ x: e.clientX, y: e.clientY, clipId: hit.clipId, time: hit.time });
      } else {
        setMenu(null);
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = daw.getState();
      if (e.ctrlKey || e.metaKey) {
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const tUnder = model.xToTime(cx);
        s.setZoom(s.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
        s.setScroll(tUnder * daw.getState().zoom - cx, s.scrollY);
      } else {
        const dx = e.shiftKey ? e.deltaY : e.deltaX;
        const dy = e.shiftKey ? 0 : e.deltaY;
        s.setScroll(s.scrollX + dx, Math.min(s.scrollY + dy, model.maxScrollY()));
      }
      dirtyRef.current = true;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [model]);

  // fetch peaks only when the set of source files changes
  useEffect(() => {
    let lastKeys = '';
    const run = () => {
      const clips = Object.values(useDawStore.getState().clips);
      const keys = clips.map((c) => `${c.takeDir}/${c.file}`).sort().join('|');
      if (keys === lastKeys) return;
      lastKeys = keys;
      clips.forEach((c) => useDawStore.getState().ensureClipPeaks(c));
    };
    run();
    return useDawStore.subscribe(run);
  }, []);

  const menuClip = menu ? useDawStore.getState().clips[menu.clipId] : undefined;

  return (
    <div ref={wrapRef} className="flex-1 relative overflow-hidden bg-[#16181d]">
      <canvas ref={canvasRef} className="absolute inset-0 block" />
      <div className="pointer-events-none absolute left-0 right-0 top-0" style={{ height: RULER_H }} />

      {menu && menuClip && (
        <>
          <div className="fixed inset-0 z-40" onPointerDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="fixed z-50 min-w-[168px] bg-[#1c1e24] border border-[#3a3d45] rounded-md shadow-2xl py-1 text-xs text-gray-200"
            style={{ left: menu.x, top: menu.y }}
          >
            {[
              { label: 'Split at cursor', fn: () => useDawStore.getState().splitClipAt(menu.clipId, menu.time) },
              { label: 'Rename…', fn: () => setRename({ x: Math.max(model.timeToX(menuClip.start), 2), y: (model.tracks().find((t) => t.id === menuClip.trackId)?.y ?? 40), w: 160, clipId: menu.clipId, value: menuClip.name }) },
              { label: 'Reset gain', fn: () => useDawStore.getState().setClipGain(menu.clipId, 1) },
              { label: 'Clear fades', fn: () => { useDawStore.getState().setClipFade(menu.clipId, 'in', 0); useDawStore.getState().setClipFade(menu.clipId, 'out', 0); } },
              ...((menuClip.lane ?? 0) > 0
                ? [
                    { label: 'Promote lane to comp', fn: () => useDawStore.getState().compPick(menuClip.trackId, menuClip.start, menuClip.start + menuClip.length, menuClip.lane || 0) },
                    { label: 'Move to comp lane', fn: () => useDawStore.getState().moveClipToLane(menu.clipId, 0) },
                  ]
                : [
                    { label: 'Send to new take lane', fn: () => useDawStore.getState().moveClipToLane(menu.clipId, useDawStore.getState().laneCountFor(menuClip.trackId) + 1) },
                  ]),
              { label: 'Delete', fn: () => { useDawStore.getState().setSelectedClips([menu.clipId]); useDawStore.getState().deleteSelected(); }, danger: true },
            ].map((item) => (
              <button
                key={item.label}
                className={`block w-full text-left px-3 py-1.5 hover:bg-[#2a2d35] ${item.danger ? 'text-red-400' : ''}`}
                onClick={() => { item.fn(); setMenu(null); }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}

      {rename && (
        <input
          autoFocus
          className="absolute z-50 h-[15px] px-1 text-[10px] bg-[#111] text-white border border-blue-500 rounded-sm outline-none"
          style={{ left: rename.x, top: rename.y + 3, width: rename.w }}
          value={rename.value}
          onChange={(e) => setRename({ ...rename, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { useDawStore.getState().renameClip(rename.clipId, rename.value.trim() || 'Clip'); setRename(null); }
            else if (e.key === 'Escape') setRename(null);
          }}
          onBlur={() => { useDawStore.getState().renameClip(rename.clipId, rename.value.trim() || 'Clip'); setRename(null); }}
        />
      )}
    </div>
  );
}

function uniq(a: string[]): string[] { return [...new Set(a)]; }

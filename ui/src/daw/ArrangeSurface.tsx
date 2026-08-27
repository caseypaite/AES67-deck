import { useEffect, useRef } from 'react';
import { useDawStore } from '../stores/useDawStore';
import { useMixerStore } from '../stores/useMixerStore';
import { SurfaceModel, RULER_H } from './SurfaceModel';

// Canvas arrange surface. React mounts it once; all drawing and interaction
// happen outside React — a single rAF loop paints the SurfaceModel, pointer
// handlers mutate the store, and a store subscription just flips a dirty flag.
export function ArrangeSurface() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef<SurfaceModel | null>(null);
  const dirtyRef = useRef(true);

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

  // --- render loop ---
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const frame = () => {
      const playing = useMixerStore.getState().transportState !== 'stopped';
      if (dirtyRef.current || playing) {
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        model.draw(ctx);
        dirtyRef.current = false;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // The DAW store carries everything the surface draws (clips, selection,
    // scroll, zoom, playhead, peaks); a change there flags a repaint. Transport
    // state is polled in the loop above to keep repainting while it rolls.
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

    const onPointerDown = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const hit = model.hitTest(px, py);
      const s = daw.getState();

      if (hit.kind === 'ruler') {
        const scrub = (cx: number) => {
          const t = Math.max(0, model.xToTime(cx - rect.left));
          daw.getState().locate(snap(t));
        };
        scrub(e.clientX);
        const move = (ev: PointerEvent) => scrub(ev.clientX);
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        return;
      }

      if (hit.kind === 'lane' || hit.kind === 'empty') {
        if (!e.shiftKey) s.clearSelection();
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

      if (hit.kind === 'clip-left') {
        const c0 = { ...clip };
        const move = (ev: PointerEvent) => {
          const dt = (ev.clientX - startX) / daw.getState().zoom;
          let newStart = snap(c0.start + dt);
          newStart = Math.max(0, Math.min(c0.start + c0.length - 0.05, newStart));
          const shift = newStart - c0.start;
          daw.getState().updateClip(c0.id, {
            start: newStart, length: c0.length - shift,
            sourceOffset: Math.max(0, (c0.sourceOffset || 0) + shift),
          });
        };
        drag(move);
        return;
      }
      if (hit.kind === 'clip-right') {
        const c0 = { ...clip };
        const move = (ev: PointerEvent) => {
          const dt = (ev.clientX - startX) / daw.getState().zoom;
          const newLen = Math.max(0.05, snap(c0.start + c0.length + dt) - c0.start);
          daw.getState().updateClip(c0.id, { length: newLen });
        };
        drag(move);
        return;
      }

      // move (whole selection)
      const starts: Record<string, number> = {};
      sel.forEach((id) => { const c = s.clips[id]; if (c) starts[id] = c.start; });
      const move = (ev: PointerEvent) => {
        const dt = (ev.clientX - startX) / daw.getState().zoom;
        const snapped = snap(starts[clip.id] + dt) - starts[clip.id];
        let delta = snapped;
        sel.forEach((id) => { if (starts[id] + delta < 0) delta = -starts[id]; });
        sel.forEach((id) => daw.getState().updateClip(id, { start: starts[id] + delta }));
      };
      drag(move);
    };

    const drag = (move: (e: PointerEvent) => void) => {
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
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
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [model]);

  // fetch peaks for any clip that lacks them whenever the clip set changes
  useEffect(() => {
    const run = () => Object.values(useDawStore.getState().clips).forEach((c) => useDawStore.getState().ensureClipPeaks(c));
    run();
    return useDawStore.subscribe(run);
  }, []);

  return (
    <div ref={wrapRef} className="flex-1 relative overflow-hidden bg-[#16181d]">
      <canvas ref={canvasRef} className="absolute inset-0 block" style={{ cursor: 'default' }} />
      <div className="pointer-events-none absolute left-0 right-0 top-0" style={{ height: RULER_H }} />
    </div>
  );
}

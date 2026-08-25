import React, { useRef, useEffect, useState } from 'react';

export const EqGraph = ({ bands, onChange }: { bands: number[], onChange: (index: number, val: number) => void }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      ctx.beginPath(); ctx.moveTo(i * (w / 5), 0); ctx.lineTo(i * (w / 5), h); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

    // Curve
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    
    const points = bands.map((db, i) => {
       const x = (i + 0.5) * (w / 5);
       const y = h / 2 - (db / 18) * (h / 2);
       return { x, y };
    });

    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 3;

    if (points.length > 0) {
      ctx.moveTo(0, points[0].y);
      for (let i = 0; i < points.length - 1; i++) {
        const xc = (points[i].x + points[i + 1].x) / 2;
        const yc = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
      }
      ctx.lineTo(w, points[points.length - 1].y);
    }
    
    ctx.stroke();

    // Fill underneath
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
    ctx.fill();

  }, [bands]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (draggingIdx === null || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const y = e.clientY - rect.top;
      // map y (0 to h) to dB (+18 to -18)
      let db = 18 - (y / rect.height) * 36;
      db = Math.max(-18, Math.min(18, db));
      onChange(draggingIdx, db);
    };

    const handleMouseUp = () => setDraggingIdx(null);

    if (draggingIdx !== null) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingIdx, onChange]);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-[#0a0a0a] rounded border border-gray-800 select-none overflow-hidden group">
      <canvas ref={canvasRef} width={340} height={180} className="w-full h-full block" />
      
      {/* Draggable Points */}
      {bands.map((db, i) => {
        const left = `${((i + 0.5) / 5) * 100}%`;
        const top = `${50 - (db / 18) * 50}%`;
        
        return (
          <div 
            key={i}
            className="absolute w-4 h-4 -ml-2 -mt-2 bg-blue-500 rounded-full border-2 border-white shadow-[0_0_8px_rgba(59,130,246,0.8)] cursor-ns-resize hover:scale-125 transition-transform opacity-0 group-hover:opacity-100"
            style={{ left, top }}
            onMouseDown={() => setDraggingIdx(i)}
          >
             {draggingIdx === i && (
               <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-black text-white text-[9px] px-1 py-0.5 rounded pointer-events-none whitespace-nowrap z-10">
                 {db.toFixed(1)} dB
               </div>
             )}
          </div>
        );
      })}
    </div>
  );
};

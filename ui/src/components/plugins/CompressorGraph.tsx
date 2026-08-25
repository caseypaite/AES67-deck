import React, { useRef, useEffect, useState } from 'react';

export const CompressorGraph = ({ 
  threshold, ratio, makeup, onChange 
}: { 
  threshold: number, ratio: number, makeup: number,
  onChange: (key: string, val: number) => void 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [draggingPoint, setDraggingPoint] = useState<'threshold' | 'ratio' | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Draw Grid
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(i * (w / 4), 0); ctx.lineTo(i * (w / 4), h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * (h / 4)); ctx.lineTo(w, i * (h / 4)); ctx.stroke();
    }
    
    // Diagonal 1:1 reference line
    ctx.strokeStyle = '#222';
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(w, 0);
    ctx.stroke();

    const mapDb = (db: number) => {
      const normalized = (db + 60) / 60; // 0 to 1
      return { x: normalized * w, y: h - (normalized * h) };
    };

    const tPoint = mapDb(threshold);

    // Compressed line endpoint (0dB Input)
    const over = 0 - threshold; 
    const outOver = over / ratio;
    const outTotal = threshold + outOver + makeup;
    const endY = h - (((outTotal + 60) / 60) * h);

    ctx.strokeStyle = '#a855f7'; 
    ctx.lineWidth = 3;
    ctx.beginPath();
    
    // 1:1 up to threshold (shifted by makeup)
    const startY = h - (((-60 + makeup + 60) / 60) * h);
    const tY_shifted = h - (((threshold + makeup + 60) / 60) * h);

    ctx.moveTo(mapDb(-60).x, startY);
    ctx.lineTo(tPoint.x, tY_shifted);
    ctx.lineTo(w, endY);
    ctx.stroke();

    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.fillStyle = 'rgba(168, 85, 247, 0.15)';
    ctx.fill();

  }, [threshold, ratio, makeup]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingPoint || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      
      if (draggingPoint === 'threshold') {
        const x = e.clientX - rect.left;
        let db = (x / rect.width) * 60 - 60;
        db = Math.max(-60, Math.min(0, db));
        onChange('threshold', db);
      } else if (draggingPoint === 'ratio') {
        const y = e.clientY - rect.top;
        const outTotal = ((rect.height - y) / rect.height) * 60 - 60;
        // outTotal = threshold + (0 - threshold)/ratio + makeup
        // outTotal - threshold - makeup = -threshold / ratio
        // ratio = -threshold / (outTotal - threshold - makeup)
        const over = 0 - threshold;
        const targetOver = outTotal - threshold - makeup;
        if (targetOver > 0.1) {
           let r = over / targetOver;
           r = Math.max(1, Math.min(20, r));
           onChange('ratio', r);
        }
      }
    };

    const handleMouseUp = () => setDraggingPoint(null);

    if (draggingPoint) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingPoint, threshold, makeup, onChange]);

  const tX = ((threshold + 60) / 60) * 100;
  const tY = 100 - ((threshold + makeup + 60) / 60) * 100;
  
  const outTotal = threshold + (0 - threshold) / ratio + makeup;
  const endY = 100 - ((outTotal + 60) / 60) * 100;

  return (
    <div ref={containerRef} className="relative w-full h-full bg-[#0a0a0a] rounded border border-gray-800 select-none overflow-hidden group">
      <canvas ref={canvasRef} width={340} height={180} className="w-full h-full block" />
      
      {/* Threshold Point */}
      <div 
        className="absolute w-4 h-4 -ml-2 -mt-2 bg-purple-500 rounded-full border-2 border-white shadow-[0_0_8px_rgba(168,85,247,0.8)] cursor-pointer hover:scale-125 transition-transform opacity-0 group-hover:opacity-100"
        style={{ left: `${tX}%`, top: `${tY}%` }}
        onMouseDown={() => setDraggingPoint('threshold')}
      >
        {draggingPoint === 'threshold' && (
          <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-black text-white text-[9px] px-1 py-0.5 rounded pointer-events-none whitespace-nowrap z-10">
            THRESH {threshold.toFixed(1)} dB
          </div>
        )}
      </div>

      {/* Ratio Point */}
      <div 
        className="absolute w-4 h-4 -ml-2 -mt-2 bg-purple-400 rounded-full border-2 border-white shadow-[0_0_8px_rgba(168,85,247,0.8)] cursor-ns-resize hover:scale-125 transition-transform opacity-0 group-hover:opacity-100"
        style={{ left: `100%`, top: `${endY}%` }}
        onMouseDown={() => setDraggingPoint('ratio')}
      >
        {draggingPoint === 'ratio' && (
          <div className="absolute -top-6 right-0 bg-black text-white text-[9px] px-1 py-0.5 rounded pointer-events-none whitespace-nowrap z-10">
            RATIO {ratio.toFixed(1)}:1
          </div>
        )}
      </div>
    </div>
  );
};

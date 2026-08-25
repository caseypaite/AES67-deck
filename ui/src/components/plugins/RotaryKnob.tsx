import React, { useState, useRef, useEffect } from 'react';

export const RotaryKnob = ({ 
  label, 
  value, 
  min, 
  max, 
  onChange, 
  unit = '' 
}: { 
  label: string, 
  value: number, 
  min: number, 
  max: number, 
  onChange: (val: number) => void,
  unit?: string
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startY = useRef(0);
  const startVal = useRef(value);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const delta = (startY.current - e.clientY) * 0.005; // Sensitivity
      let newVal = startVal.current + delta * (max - min);
      newVal = Math.max(min, Math.min(max, newVal));
      onChange(newVal);
    };
    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, min, max, onChange]);

  // Map value to -135 to +135 degrees
  const normalized = (value - min) / (max - min);
  const rotation = normalized * 270 - 135;

  return (
    <div className="flex flex-col items-center">
      <div 
        className="w-10 h-10 rounded-full bg-[#111] border-2 border-gray-600 flex items-center justify-center relative shadow-inner cursor-ns-resize group"
        onMouseDown={(e) => {
          setIsDragging(true);
          startY.current = e.clientY;
          startVal.current = value;
        }}
      >
        <div className="absolute w-full h-full rounded-full border-[3px] border-transparent border-t-purple-500 transition-colors group-hover:border-t-purple-400" style={{ transform: `rotate(${rotation}deg)` }}/>
        <div className="w-1.5 h-1.5 rounded-full bg-gray-800" />
      </div>
      <div className="text-[9px] text-gray-400 font-bold mt-2 uppercase">{label}</div>
      <div className="text-[10px] text-cyan-400 font-mono mt-0.5">{value.toFixed(1)}{unit}</div>
    </div>
  );
};

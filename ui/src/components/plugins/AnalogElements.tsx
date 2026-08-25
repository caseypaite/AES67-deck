import React, { useState, useRef, useEffect } from 'react';

// A photorealistic Bakelite Knob
export const BakeliteKnob = ({ 
  label, value, min, max, onChange, size = 'lg', markings = true
}: { 
  label: string, value: number, min: number, max: number, onChange: (v: number) => void, size?: 'sm'|'lg', markings?: boolean 
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startY = useRef(0);
  const startVal = useRef(value);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const delta = (startY.current - e.clientY) * (max - min) * 0.003; 
      let newVal = startVal.current + delta;
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

  const normalized = (value - min) / (max - min);
  const rotation = normalized * 270 - 135; // -135 to 135

  const dim = size === 'lg' ? 'w-16 h-16' : 'w-10 h-10';

  return (
    <div className="flex flex-col items-center select-none">
      <div className="relative flex items-center justify-center">
        {/* Markings (Ticks) */}
        {markings && (
          <div className="absolute w-24 h-24 pointer-events-none">
             {[...Array(21)].map((_, i) => {
                const angle = -135 + i * (270 / 20);
                const isMajor = i === 0 || i === 10 || i === 20;
                return (
                  <div key={i} className="absolute left-1/2 top-1/2 w-[1px] origin-bottom -translate-x-1/2 -translate-y-full" style={{ transform: `rotate(${angle}deg) translateY(-24px)`, height: '24px' }}>
                     <div className={`w-full bg-gray-800 ${isMajor ? 'h-3' : 'h-1.5'}`} />
                  </div>
                );
             })}
          </div>
        )}
        
        {/* Knob Body */}
        <div 
          className={`rounded-full bg-gradient-to-br from-[#2a2d34] to-[#121316] border border-[#0d0e11] shadow-[4px_6px_10px_rgba(0,0,0,0.5),inset_0px_2px_4px_rgba(255,255,255,0.1)] flex items-center justify-center relative cursor-ns-resize group ${dim} z-10`}
          onMouseDown={(e) => { setIsDragging(true); startY.current = e.clientY; startVal.current = value; }}
        >
          {/* Inner indent */}
          <div className="w-[80%] h-[80%] rounded-full bg-gradient-to-tl from-[#1a1c22] to-[#22242a] shadow-inner" />
          {/* White indicator line */}
          <div className="absolute w-full h-full" style={{ transform: `rotate(${rotation}deg)` }}>
             <div className="absolute top-1 left-1/2 -translate-x-1/2 w-1 h-[40%] bg-white rounded-full shadow-[0_0_2px_rgba(255,255,255,0.5)]" />
          </div>
        </div>
      </div>
      <div className="mt-3 text-[10px] font-bold text-gray-800 tracking-wider font-sans">{label}</div>
    </div>
  );
};

// Horizontal Toggle Switch (OUT / IN)
export const ToggleSwitch = ({ 
  active, labelLeft, labelRight, onChange 
}: { 
  active: boolean, labelLeft: string, labelRight: string, onChange: (v: boolean) => void 
}) => {
  return (
    <div className="flex items-center gap-3">
       <span className="text-[10px] font-bold text-gray-800">{labelLeft}</span>
       <div 
         className="relative w-10 h-5 bg-[#1a1c22] rounded-full shadow-inner border border-[#333] cursor-pointer"
         onClick={() => onChange(!active)}
       >
          <div className={`absolute top-0 w-5 h-5 rounded-full bg-gradient-to-b from-[#e0e1e3] to-[#9a9ba0] shadow-[0_2px_4px_rgba(0,0,0,0.5)] transition-all ${active ? 'left-5' : 'left-0'}`} />
       </div>
       <div className="flex items-center gap-1.5">
         <span className="text-[10px] font-bold text-gray-800">{labelRight}</span>
         {/* Green LED */}
         <div className={`w-2.5 h-2.5 rounded-full border border-[#111] transition-colors ${active ? 'bg-[#76e338] shadow-[0_0_8px_#76e338]' : 'bg-[#1b330b]'}`} />
       </div>
    </div>
  );
};

// Vertical Toggle Switch
export const VerticalSwitch = ({ 
  active, label, labelTop, labelBottom, onChange 
}: { 
  active: boolean, label: string, labelTop: string, labelBottom: string, onChange: (v: boolean) => void 
}) => {
  return (
    <div className="flex flex-col items-center gap-1.5">
       <span className="text-[9px] font-bold text-gray-800 tracking-wider h-3">{labelTop}</span>
       <div 
         className="relative w-4 h-8 bg-[#1a1c22] rounded-sm shadow-inner border border-[#333] cursor-pointer flex justify-center"
         onClick={() => onChange(!active)}
       >
          <div className={`absolute w-5 h-4 bg-gradient-to-b from-[#e0e1e3] to-[#9a9ba0] shadow-[0_2px_4px_rgba(0,0,0,0.5)] transition-all ${active ? 'top-0' : 'bottom-0'}`} />
       </div>
       <span className="text-[9px] font-bold text-gray-800 tracking-wider h-3">{labelBottom}</span>
    </div>
  );
};

// Analog VU Meter (Mock)
export const AnalogVu = ({ label }: { label: string }) => {
  return (
    <div className="flex flex-col items-center">
       <div className="w-40 h-24 bg-[#1a1c22] border-4 border-[#0b0c10] rounded-sm p-2 shadow-[inset_0_0_20px_rgba(0,0,0,0.8)] relative overflow-hidden">
          {/* Faux Scale Background */}
          <div className="absolute inset-0 bg-[#2a2c30]" />
          {/* Scale Arch */}
          <div className="absolute top-12 left-1/2 -translate-x-1/2 w-48 h-48 border-t-2 border-gray-400 rounded-full" />
          {/* Markings */}
          <div className="absolute top-8 w-full text-center text-gray-400 text-[8px] font-mono tracking-widest flex justify-center gap-2">
             <span>-20</span><span>-10</span><span>-5</span><span>0</span><span className="text-red-500">+3</span>
          </div>
          {/* Needle */}
          <div className="absolute bottom-[-10px] left-1/2 w-[2px] h-20 bg-orange-500 origin-bottom rounded-full shadow-[2px_0_4px_rgba(0,0,0,0.5)] animate-[wiggle_1s_ease-in-out_infinite]" style={{ transform: 'translateX(-50%) rotate(-30deg)' }} />
       </div>
       {label && <div className="mt-2 text-[10px] font-bold text-gray-800 tracking-wider">{label}</div>}
    </div>
  );
};

// WebKnobMan Equalizer Knob (Procedural based on id 2624)
export const EqKnob = ({ 
  label, value, min, max, onChange, size = 'lg', markings = true, disabled = false
}: { 
  label: string, value: number, min: number, max: number, onChange: (v: number) => void, size?: 'sm'|'lg', markings?: boolean, disabled?: boolean 
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startY = useRef(0);
  const startVal = useRef(value);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const delta = (startY.current - e.clientY) * (max - min) * 0.003; 
      let newVal = startVal.current + delta;
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

  const normalized = (value - min) / (max - min);
  const rotation = normalized * 274 - 137; // Angle1: -137, Angle2: 137
  
  // LED Ring mask stops go from -140 to 140 (280 degrees total)
  const ledSpanDeg = 280;
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const activeLength = normalized * (ledSpanDeg / 360) * circumference;
  const dasharray = `${activeLength} ${circumference}`;

  const dim = size === 'lg' ? 'w-[91px] h-[91px]' : 'w-[57px] h-[57px]';

  return (
    <div className={`flex flex-col items-center select-none ${disabled ? 'opacity-30 pointer-events-none' : ''}`}>
      <div className="relative flex items-center justify-center">
        
        {markings && (
          <div className="absolute pointer-events-none">
             {[...Array(21)].map((_, i) => {
                const angle = -137 + i * (274 / 20);
                const isMajor = i === 0 || i === 10 || i === 20;
                const transY = size === 'lg' ? -51 : -31;
                const h = size === 'lg' ? '26px' : '16px';
                const markH = isMajor ? (size === 'lg' ? 'h-[14px]' : 'h-[8.5px]') : (size === 'lg' ? 'h-[7px]' : 'h-[4px]');
                return (
                  <div key={i} className={`absolute left-1/2 top-1/2 ${size === 'lg' ? 'w-[1.5px]' : 'w-[1px]'} origin-bottom -translate-x-1/2 -translate-y-full`} style={{ transform: `rotate(${angle}deg) translateY(${transY}px)`, height: h }}>
                     <div className={`w-full bg-gray-800 ${markH}`} />
                  </div>
                );
             })}
          </div>
        )}

        {/* Knob Body (Procedural) */}
        <div 
          className={`flex items-center justify-center relative group ${dim} z-10 cursor-ns-resize`}
          onMouseDown={(e) => { 
            if (disabled) return;
            setIsDragging(true); startY.current = e.clientY; startVal.current = value; 
          }}
        >
          {/* Layer 1 & 2: Outer Black Rim / Texture */}
          <div className="absolute inset-0 rounded-full bg-black shadow-[0_4px_8px_rgba(0,0,0,0.6),inset_0_1px_3px_rgba(255,255,255,0.2)]" />
          
          {/* Layer 3 & 4: LED Ring Track & Active LED */}
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" style={{ transform: 'rotate(140deg)' }}>
            {/* Background Track */}
            <circle cx="50" cy="50" r={radius} fill="none" stroke="#1a1a1a" strokeWidth="8" strokeDasharray={`${(ledSpanDeg / 360) * circumference} ${circumference}`} />
            {/* Active LED Ring (Col: 64, 240, 19) */}
            <circle cx="50" cy="50" r={radius} fill="none" stroke="#40f013" strokeWidth="8" strokeDasharray={dasharray} style={{ filter: 'drop-shadow(0 0 4px #40f013)' }} />
          </svg>

          {/* Layer 5: Metal Circle Cap (Col: 220, 220, 220, Emboss: -4) */}
          <div className="absolute w-[80%] h-[80%] rounded-full shadow-[0_4px_6px_rgba(0,0,0,0.8),inset_0_-2px_4px_rgba(0,0,0,0.4),inset_0_2px_6px_rgba(255,255,255,0.8)] border border-[#999]"
               style={{ background: 'conic-gradient(from 180deg at 50% 50%, #e0e0e0 0deg, #f8f8f8 45deg, #d0d0d0 90deg, #f8f8f8 135deg, #e0e0e0 180deg, #f8f8f8 225deg, #d0d0d0 270deg, #f8f8f8 315deg, #e0e0e0 360deg)' }}>
            
            {/* Layer 6: Indicator Pointer (Col: 64, 64, 64) */}
            <div className="absolute w-full h-full pointer-events-none" style={{ transform: `rotate(${rotation}deg)` }}>
               <div className="absolute top-[10%] left-1/2 -translate-x-1/2 w-[8%] h-[25%] bg-[#404040] rounded-sm shadow-[inset_0_1px_2px_rgba(0,0,0,0.8),0_1px_1px_rgba(255,255,255,0.6)]" />
            </div>
          </div>

        </div>
      </div>
      <div className="mt-3 text-[10px] font-bold text-gray-800 tracking-wider font-sans">{label}</div>
    </div>
  );
};

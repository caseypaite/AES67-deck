import React, { useRef, useEffect, useState } from 'react';
import { VuMeter } from './VuMeter';
import { useMixerStore, positionToDb } from '../../stores/useMixerStore';

const AnalogOverlay = () => (
  <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden mix-blend-overlay opacity-[0.15]">
    <div className="absolute inset-0" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noise%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.8%22 numOctaves=%224%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noise)%22/%3E%3C/svg%3E")' }} />
    <div className="absolute inset-0" style={{ background: 'repeating-linear-gradient(90deg, transparent, transparent 1px, rgba(255,255,255,0.1) 1px, rgba(255,255,255,0.1) 2px)' }} />
  </div>
);

const MiniAnalogKnob = ({ label, value, min, max, onChange, colorHex = '#e0e0e0', showCenterTick = false }: { label: string, value: number, min: number, max: number, onChange: (v: number) => void, colorHex?: string, showCenterTick?: boolean }) => {
  const startY = useRef(0);
  const startVal = useRef(value);

  const normalized = (value - min) / (max - min);
  const rotation = normalized * 270 - 135;

  return (
    <div className="flex flex-col items-center select-none group cursor-ns-resize z-10 w-full"
      onMouseDown={(e) => {
        startY.current = e.clientY;
        startVal.current = value;
        const move = (me: MouseEvent) => {
          let newVal = startVal.current - (me.clientY - startY.current) * ((max - min) * 0.005);
          onChange(Math.max(min, Math.min(max, newVal)));
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
      onDoubleClick={(e) => { e.stopPropagation(); onChange(0); }} // Reset Pan to center
    >
      <div className="relative flex items-center justify-center w-[45px] h-[45px] mb-1">
        {/* Tick marks ring */}
        <div className="absolute inset-0 pointer-events-none opacity-40">
           {Array.from({length: 13}).map((_, i) => (
             <div key={i} className="absolute w-full h-full" style={{ transform: `rotate(${(i / 12) * 270 - 135}deg)` }}>
               <div className={`mx-auto w-[2px] h-[3px] bg-black ${showCenterTick && i === 6 ? 'h-[5px] bg-red-600' : ''}`} />
             </div>
           ))}
        </div>
        
        {/* Outer Skirt */}
        <div className="w-[37px] h-[37px] rounded-full shadow-[0_4px_6px_rgba(0,0,0,0.8),inset_0_1px_2px_rgba(255,255,255,0.5)] flex items-center justify-center relative border border-black"
             style={{ background: `radial-gradient(circle at 35% 35%, ${colorHex}, #222 130%)` }}>
          
          {/* Inner metallic cap */}
          <div className="w-[25px] h-[25px] rounded-full border border-gray-600 shadow-[0_2px_4px_rgba(0,0,0,0.9),inset_0_1px_2px_rgba(255,255,255,0.7)]"
               style={{ background: 'repeating-conic-gradient(#bbb 0 10deg, #999 10deg 20deg)' }}>
            
            {/* Rotation pointer */}
            <div className="absolute w-full h-full top-0 left-0 pointer-events-none" style={{ transform: `rotate(${rotation}deg)` }}>
              <div className="absolute top-[-3px] left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-black rounded-full shadow-[inset_0_1px_2px_rgba(255,255,255,0.5)]" />
            </div>
          </div>
        </div>
      </div>
      <div className="text-[9px] font-black tracking-widest text-[#222] bg-[#a0a5aa] px-1 rounded shadow-[inset_0_1px_1px_rgba(255,255,255,0.6)] mt-2">{label}</div>
    </div>
  );
};

const TapeLabel = ({ text, onRename }: { text: string, onRename: (name: string) => void }) => {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(text);

  return (
    <div className="relative w-11/12 h-5 my-1 flex items-center justify-center z-10 shadow-sm shrink-0 cursor-text"
         onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); setVal(text); }}
         style={{ 
           background: '#e8deb3', 
           transform: 'rotate(-1deg)',
           boxShadow: '1px 2px 3px rgba(0,0,0,0.5), inset 0 0 10px rgba(0,0,0,0.1)',
           border: '1px solid rgba(0,0,0,0.1)'
         }}>
       {/* Tape ragged edges */}
       <div className="absolute top-0 -left-1 w-2 h-full bg-[#e8deb3]" style={{ clipPath: 'polygon(100% 0, 0 10%, 40% 30%, 0 50%, 50% 70%, 10% 90%, 100% 100%)' }} />
       <div className="absolute top-0 -right-1 w-2 h-full bg-[#e8deb3]" style={{ clipPath: 'polygon(0 0, 100% 15%, 60% 35%, 100% 55%, 50% 75%, 90% 95%, 0 100%)' }} />
       
       {editing ? (
         <input 
           autoFocus 
           value={val} 
           onChange={e => setVal(e.target.value)}
           onBlur={() => { setEditing(false); onRename(val || text); }}
           onKeyDown={e => { if(e.key === 'Enter'){ setEditing(false); onRename(val || text); } }}
           className="bg-transparent font-[MarkerFelt,sans-serif] text-black text-[11px] uppercase tracking-tighter opacity-80 w-full text-center outline-none" 
           style={{ transform: 'rotate(1deg)' }}
         />
       ) : (
         <span className="font-[MarkerFelt,sans-serif] text-black text-[11px] uppercase tracking-tighter opacity-80 truncate px-1 w-full text-center" style={{ transform: 'rotate(1deg)' }}>{text}</span>
       )}
    </div>
  );
};

const AnalogButton = ({ label, active, onClick, colorClass }: { label: string, active: boolean, onClick: () => void, colorClass: string }) => (
  <button 
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    className={`flex-1 h-6 rounded-[3px] border-2 flex items-center justify-center relative transition-all overflow-hidden z-10
      ${active ? `${colorClass} shadow-[inset_0_0_10px_rgba(255,255,255,0.4),0_0_8px_currentColor] scale-[0.97]` 
               : 'bg-[#2a2d33] border-[#1a1c22] text-[#666] shadow-[0_4px_4px_rgba(0,0,0,0.8),inset_0_1px_2px_rgba(255,255,255,0.1)]'}`}
    style={{ borderColor: active ? 'transparent' : '' }}
  >
    <span className="font-bold text-[9px] drop-shadow-md z-10">{label}</span>
    {active && <div className="absolute inset-0 bg-white/20 pointer-events-none" />}
  </button>
);

export const ChannelStrip = ({ id }: { id: number }) => {
  const channel = useMixerStore(state => state.channels[id]);
  const setChannelValue = useMixerStore(state => state.setChannelValue);
  const renameChannel = useMixerStore(state => state.renameChannel);
  const selectedChannelId = useMixerStore(state => state.selectedChannelId);
  const setSelectedChannel = useMixerStore(state => state.setSelectedChannel);
  
  const faderRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !faderRef.current) return;
      const rect = faderRef.current.getBoundingClientRect();
      const usableHeight = rect.height - 48; // Fader cap height is 48px
      let val = 1.0 - (e.clientY - rect.top - 24) / usableHeight;
      val = Math.max(0.0, Math.min(1.0, val));
      setChannelValue(id, 'fader', val);
    };
    const handleMouseUp = () => isDragging.current = false;
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [id, setChannelValue]);

  if (!channel) return null;

  const isMaster = channel.type === 'master';
  const isBus = channel.type === 'bus';
  const isMonitor = channel.type === 'monitor';
  const isSelected = selectedChannelId === id;

  const db = positionToDb(channel.fader);
  const dbValue = db === -Infinity ? '-∞' : db.toFixed(1);
  const topPos = `calc(${(1.0 - channel.fader)} * (100% - 48px))`;

  let stripClass = "w-[65px] bg-[#626e7a] border-[#424e5a]";
  if (isMaster) stripClass = "w-[75px] bg-[#4a2a2a] border-[#3a1a1a]";
  if (isBus) stripClass = "w-[65px] bg-[#3a4a5a] border-[#2a3a4a]";
  if (isMonitor) stripClass = "w-[75px] bg-[#2a4a3a] border-[#1a3a2a]";

  return (
    <div 
      className={`flex flex-col items-center rounded-t-md border-x-2 border-t-2 select-none shrink-0 transition-colors h-full min-h-0 relative overflow-hidden ${stripClass} ${isSelected ? 'ring-inset ring-2 ring-yellow-400/50 brightness-110' : ''}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).tagName !== 'BUTTON') {
          setSelectedChannel(id);
        }
      }}
    >
      <AnalogOverlay />
      
      {/* Route indicator */}
      <div className="w-full flex justify-center mt-2 z-10 shrink-0">
        <div className="text-[9px] font-black px-1 py-0.5 text-black opacity-40 uppercase tracking-widest">{isMaster ? 'MST' : isMonitor ? 'MON' : isBus ? 'BUS' : `CH${id}`}</div>
      </div>

      <div className="w-full h-[2px] bg-black/30 my-2 shadow-[0_1px_0_rgba(255,255,255,0.1)] z-10 shrink-0" />

      {/* Spacer to push controls to bottom, filling empty space for buses/master */}
      <div className="w-full flex flex-col justify-end items-center mb-2 shrink-0">
        {/* Pan Knob */}
        {!isMaster && !isBus && !isMonitor && (
          <div className="w-full flex justify-center mt-1">
             <MiniAnalogKnob 
               label="PAN" 
               value={channel.pan} 
               min={-1} max={1} 
               onChange={(v) => setChannelValue(id, 'pan', v)} 
               colorHex="#5a5a5a" 
               showCenterTick={true}
             />
          </div>
        )}
      </div>

      <div className="w-full h-[2px] bg-black/30 my-2 shadow-[0_1px_0_rgba(255,255,255,0.1)] z-10 shrink-0" />

      {/* Bottom Section (Fixed layout for all strips) */}
      <div className="w-full flex-1 flex flex-col items-center px-1 overflow-hidden">
        {/* Toggles */}
        <div className="flex w-full gap-1 mb-2 shrink-0">
          {!isMonitor && (
            <AnalogButton label="S" active={channel.solo} onClick={() => setChannelValue(id, 'solo', !channel.solo)} colorClass="bg-yellow-500 text-black border-yellow-700" />
          )}
          <AnalogButton label="M" active={channel.mute} onClick={() => setChannelValue(id, 'mute', !channel.mute)} colorClass="bg-orange-600 text-white border-orange-800" />
        </div>

        <TapeLabel text={channel.name} onRename={(name) => renameChannel(id, name)} />
        
        {/* Meters & Fader */}
        <div className="flex gap-3 mb-2 w-full justify-start flex-1 z-10 min-h-0 pl-0.5">
          {/* Separate VU Meter */}
          <div className="flex gap-[1px] bg-[#111] p-[1px] border border-[#222] shadow-[inset_0_2px_10px_rgba(0,0,0,1)] rounded-sm h-full w-[12px] shrink-0">
            <VuMeter level={channel.meterL} />
            <VuMeter level={channel.meterR} />
          </div>

          <div 
            ref={faderRef}
            className="relative flex-1 max-w-[12px] h-full bg-[#0a0a0a] flex justify-center shadow-[inset_0_4px_15px_rgba(0,0,0,1),0_1px_0_rgba(255,255,255,0.2)] border-x border-[#222] cursor-pointer"
            onMouseDown={(e) => {
              isDragging.current = true;
              const rect = e.currentTarget.getBoundingClientRect();
              const usableHeight = rect.height - 48; // Fader cap height is 48px
              let val = 1.0 - (e.clientY - rect.top - 24) / usableHeight;
              setChannelValue(id, 'fader', Math.max(0.0, Math.min(1.0, val)));
            }}
            onDoubleClick={(e) => { e.stopPropagation(); setChannelValue(id, 'fader', 0.75); }}
          >
             {/* Narrow Fader Track Slot */}
             <div className="absolute top-4 bottom-4 left-1/2 -translate-x-1/2 w-[2px] bg-black shadow-[inset_0_1px_3px_rgba(0,0,0,1)] pointer-events-none z-0" />

             {/* dB Scale Marks */}
             <div className="absolute top-[24px] bottom-[24px] -right-[16px] w-[16px] pointer-events-none flex flex-col justify-between z-0 hidden lg:flex">
                {[
                  { y: 1.0, label: '+10' },
                  { y: 0.75, label: '0' },
                  { y: 0.5, label: '-10' },
                  { y: 0.3, label: '-20' },
                  { y: 0.15, label: '-40' },
                  { y: 0.0, label: '-∞' }
                ].map(mark => (
                   <div key={mark.label} className="absolute w-full flex items-center gap-0.5" style={{ bottom: `${mark.y * 100}%`, transform: 'translateY(50%)' }}>
                      <div className={`w-1.5 h-[1.5px] ${mark.y === 0.75 ? 'bg-black' : 'bg-black/60'}`} />
                      <div className={`text-[8px] font-bold leading-none ${mark.y === 0.75 ? 'text-black' : 'text-black/60'}`}>{mark.label}</div>
                   </div>
                ))}
             </div>

            {/* Fader Cap - Molded Plastic Style */}
            <div 
              className={`absolute h-[48px] rounded-[2px] shadow-[0_6px_10px_rgba(0,0,0,0.8),inset_0_2px_2px_rgba(255,255,255,0.3),inset_0_-2px_4px_rgba(0,0,0,0.6)] cursor-grab active:cursor-grabbing flex items-center justify-center hover:brightness-110 active:brightness-90 z-20 overflow-hidden border border-black/80
                ${isMaster ? 'w-[28px] bg-gradient-to-b from-[#cc2222] to-[#660000]' : isMonitor ? 'w-[28px] bg-gradient-to-b from-[#22cc88] to-[#006622]' : isBus ? 'w-[28px] bg-gradient-to-b from-[#2244cc] to-[#001166]' : 'w-[28px] bg-gradient-to-b from-[#e0e0e0] to-[#888]'}`}
              style={{ top: topPos }}
              onMouseDown={(e) => {
                isDragging.current = true;
                e.stopPropagation();
              }}
              onDoubleClick={(e) => { e.stopPropagation(); setChannelValue(id, 'fader', 0.75); }}
            >
               {/* Deep finger groove */}
               <div className="w-full h-4 bg-gradient-to-b from-black/60 to-black/20 shadow-[inset_0_2px_4px_rgba(0,0,0,0.9)] flex items-center justify-center border-y border-white/10">
                  {/* Indicator Line */}
                  <div className={`w-[80%] h-[2px] ${isMaster || isBus || isMonitor ? 'bg-white' : 'bg-black'} shadow-sm`} />
               </div>
            </div>
          </div>
        </div>

        <div className={`text-[10px] font-black tracking-widest px-2 py-0.5 rounded shadow-[inset_0_1px_3px_rgba(0,0,0,0.8),0_1px_1px_rgba(255,255,255,0.2)] w-11/12 text-center z-10 border border-[#222] shrink-0 mb-1
             ${isMaster ? 'text-red-400 bg-[#3a0a0a]' : isMonitor ? 'text-emerald-400 bg-[#0a2a1a]' : isBus ? 'text-blue-400 bg-[#0a1a3a]' : 'text-[#8fcfdf] bg-[#1a2022]'}`}>
          {dbValue} dB
        </div>

        {/* Bottom Action Row (Record, Phase) — input channels only */}
        {!isMaster && !isBus && !isMonitor && (
          <div className="w-11/12 h-6 flex gap-1 shrink-0 mb-2 mt-1">
             <AnalogButton label="REC" active={channel.arm} onClick={() => setChannelValue(id, 'arm', !channel.arm)} colorClass="bg-red-600 text-white border-red-800" />
             <AnalogButton label="ø" active={!!channel.phase} onClick={() => setChannelValue(id, 'phase', !channel.phase)} colorClass="bg-blue-600 text-white border-blue-800" />
          </div>
        )}
      </div>
    </div>
  );
};

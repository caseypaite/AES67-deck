import React, { useRef, useState, useEffect } from 'react';
import { useMixerStore, PluginNode, PLUGIN_REGISTRY, PluginCategory } from '../../stores/useMixerStore';
import { EqKnob } from './AnalogElements';

const PluginSelector = ({ category, currentUri, onSelect }: { category: PluginCategory, currentUri: string, onSelect: (uri: string) => void }) => {
  const options = PLUGIN_REGISTRY.filter(p => p.category === category);
  return (
    <select 
      value={currentUri} 
      onChange={(e) => onSelect(e.target.value)}
      className="bg-black hover:bg-gray-900 text-[#00ffcc] font-black text-xs px-2 py-1 uppercase tracking-widest text-center outline-none border border-[#00ffcc] rounded shadow-[0_0_8px_rgba(0,255,204,0.3)] cursor-pointer mt-2 w-[90%] mx-auto block z-20 relative transition-all"
      style={{ WebkitAppearance: 'none', MozAppearance: 'none' }}
    >
      {options.map(o => (
        <option key={o.uri} value={o.uri} className="bg-gray-900 text-[#00ffcc] font-bold text-base py-2">
          {o.name.toUpperCase()}
        </option>
      ))}
    </select>
  );
};

const ScratchedMetalOverlay = () => (
  <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden mix-blend-overlay opacity-30">
    <div className="absolute inset-0" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noise%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.9%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noise)%22/%3E%3C/svg%3E")' }} />
    <div className="absolute inset-0" style={{ background: 'repeating-linear-gradient(75deg, transparent, transparent 2px, rgba(0,0,0,0.5) 2px, rgba(0,0,0,0.5) 3px, transparent 3px, transparent 8px, rgba(255,255,255,0.4) 8px, rgba(255,255,255,0.4) 9px)' }} />
    <div className="absolute inset-0" style={{ background: 'repeating-linear-gradient(-15deg, transparent, transparent 15px, rgba(0,0,0,0.8) 15px, rgba(0,0,0,0.8) 16px, transparent 16px, transparent 25px, rgba(255,255,255,0.6) 25px, rgba(255,255,255,0.6) 27px)' }} />
  </div>
);

const PRackKnob = ({ label, value, min, max, onChange, size = 'md', type = 'plastic' }: any) => {
  const [isDragging, setIsDragging] = useState(false);
  const startY = useRef(0);
  const startVal = useRef(value);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const delta = (startY.current - e.clientY) * 0.005;
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

  const normalized = (value - min) / (max - min);
  const rotation = normalized * 270 - 135;
  const w = size === 'sm' ? 'w-10 h-10' : size === 'xl' ? 'w-20 h-20' : size === 'lg' ? 'w-16 h-16' : 'w-14 h-14';

  return (
    <div className="flex flex-col items-center">
      <div 
        className={`${w} rounded-full bg-[#111] border-2 border-gray-600 flex items-center justify-center relative shadow-inner cursor-ns-resize`}
        onMouseDown={(e) => {
          setIsDragging(true);
          startY.current = e.clientY;
          startVal.current = value;
        }}
      >
        <div className="absolute w-full h-full rounded-full border-[3px] border-transparent border-t-white" style={{ transform: `rotate(${rotation}deg)` }}/>
      </div>
      <div className="text-[9px] text-white font-bold mt-2 uppercase">{label}</div>
    </div>
  );
};

const SaturaModule = ({ p, onChange, onReplace }: any) => (
  <div className="w-56 h-full bg-[#dbe2e6] border-x border-[#c0c6c9] shadow-[inset_0_0_10px_rgba(0,0,0,0.1)] flex flex-col items-center p-3 relative justify-around overflow-hidden">
    <ScratchedMetalOverlay />
    <div className="text-center mt-2 z-10">
      <div className="text-black font-black text-xl tracking-tighter drop-shadow-sm">{p.name.toUpperCase()}</div>
    </div>
    <PRackKnob label="DRIVE" value={p.params.drive} min={0} max={100} onChange={(v:any) => onChange('drive', v)} size="lg" type="plastic" />
    <PRackKnob label="BLEND" value={p.params.blend} min={0} max={100} onChange={(v:any) => onChange('blend', v)} size="lg" type="plastic" />
    <PRackKnob label="OUTPUT" value={p.params.out} min={-20} max={20} onChange={(v:any) => onChange('out', v)} size="lg" type="plastic" />
    <div className="mt-auto mb-2 w-full flex justify-center z-10">
      <PluginSelector category="Saturation" currentUri={p.uri} onSelect={onReplace} />
    </div>
  </div>
);

const CompressorModule = ({ p, onChange, onReplace }: any) => (
  <div className="w-64 h-full bg-[#1e2329] border-x border-[#0e1319] shadow-[inset_0_0_20px_rgba(0,0,0,0.5)] flex flex-col items-center p-3 relative overflow-hidden">
    <ScratchedMetalOverlay />
    <div className="text-center mt-2 mb-4 z-10">
      <div className="text-white font-black text-xl tracking-tighter drop-shadow-sm">{p.name.toUpperCase()}</div>
    </div>
    <div className="flex w-full justify-around z-10 mb-2">
      <PRackKnob label="THRESH" value={p.params.threshold} min={-60} max={0} onChange={(v:any) => onChange('threshold', v)} size="md" />
      <PRackKnob label="RATIO" value={p.params.ratio} min={1} max={20} onChange={(v:any) => onChange('ratio', v)} size="md" />
    </div>
    <div className="flex w-full justify-around z-10 mb-2">
      <PRackKnob label="ATTACK" value={p.params.attack} min={0} max={100} onChange={(v:any) => onChange('attack', v)} size="sm" />
      <PRackKnob label="RELEASE" value={p.params.release} min={0} max={1000} onChange={(v:any) => onChange('release', v)} size="sm" />
    </div>
    <PRackKnob label="MAKEUP" value={p.params.makeup} min={-20} max={20} onChange={(v:any) => onChange('makeup', v)} size="lg" />
    <div className="mt-auto mb-2 z-10 w-full flex justify-center">
      <PluginSelector category="Dynamics" currentUri={p.uri} onSelect={onReplace} />
    </div>
  </div>
);

const DeesserModule = ({ p, onChange, onReplace }: any) => (
  <div className="w-48 h-full bg-[#35617a] border-x border-[#25415a] shadow-[inset_0_0_20px_rgba(0,0,0,0.3)] flex flex-col items-center p-3 relative justify-around overflow-hidden">
    <ScratchedMetalOverlay />
    <div className="text-center mt-2 z-10">
      <div className="text-white font-black text-xl tracking-tighter drop-shadow-sm">{p.name.toUpperCase()}</div>
    </div>
    <PRackKnob label="THRESH" value={p.params.threshold} min={-60} max={0} onChange={(v:any) => onChange('threshold', v)} size="sm" type="plastic" />
    <PRackKnob label="FREQ" value={p.params.freq} min={2000} max={12000} onChange={(v:any) => onChange('freq', v)} size="lg" type="plastic" />
    <PRackKnob label="RATIO" value={p.params.ratio} min={1} max={20} onChange={(v:any) => onChange('ratio', v)} size="sm" type="plastic" />
    <div className="mt-auto mb-2 w-full flex justify-center z-10">
      <PluginSelector category="De-Esser" currentUri={p.uri} onSelect={onReplace} />
    </div>
  </div>
);

const EqModule = ({ p, onChange, onReplace }: any) => {
  const is5Band = p.uri.includes('5Band');
  return (
    <div className="w-56 h-full bg-[#2d3a43] border-x border-[#1d2a33] shadow-[inset_0_0_20px_rgba(0,0,0,0.4)] flex flex-col items-center p-3 relative overflow-hidden">
      <ScratchedMetalOverlay />
      <div className="text-center mt-2 mb-2 z-10">
        <div className="text-white font-black text-xl tracking-tighter drop-shadow-sm">{p.name.toUpperCase()}</div>
      </div>
      <div className="flex flex-col w-full h-full relative px-2 py-0 z-10 justify-center gap-0 mt-[-10px]">
        {Array.from({ length: 8 }).map((_, i) => {
          const isLeft = i % 2 === 0;
          let bandKey = `b${i + 1}`;
          let isDisabled = false;
          if (is5Band) {
             if (i === 0) bandKey = 'b1';
             else if (i === 2) bandKey = 'b2';
             else if (i === 3) bandKey = 'b3';
             else if (i === 4) bandKey = 'b4';
             else if (i === 6) bandKey = 'b5';
             else {
                bandKey = '';
                isDisabled = true;
             }
          }
          return (
             <div key={i} className={`w-full flex ${isLeft ? 'justify-start' : 'justify-end'} ${i < 7 ? (isLeft ? 'mb-[-40px]' : 'mb-[-28px]') : ''}`}>
               <div className={isLeft ? 'ml-0' : 'mr-2'}>
                  <EqKnob 
                    label="" 
                    value={bandKey ? (p.params[bandKey] || 0) : 0} 
                    min={-18} max={18} 
                    onChange={(v:any) => { if (bandKey) onChange(bandKey, v); }} 
                    size={isLeft ? "lg" : "sm"} 
                    markings={false}
                    disabled={isDisabled}
                  />
               </div>
             </div>
          );
        })}
      </div>
      <div className="mt-auto mb-2 w-full flex justify-center z-10">
        <PluginSelector category="Equalizer" currentUri={p.uri} onSelect={onReplace} />
      </div>
    </div>
  );
};

const DelayModule = ({ p, onChange, onReplace }: any) => (
  <div className="w-56 h-full bg-[#416859] border-x border-[#315849] shadow-[inset_0_0_20px_rgba(0,0,0,0.3)] flex flex-col items-center p-3 relative overflow-hidden">
    <ScratchedMetalOverlay />
    <div className="flex w-full justify-around mt-8 z-10">
       <PRackKnob label="DELAY L" value={p.params.time_l} min={0} max={1000} onChange={(v:any) => onChange('time_l', v)} type="metallic" />
       <PRackKnob label="DELAY R" value={p.params.time_r} min={0} max={1000} onChange={(v:any) => onChange('time_r', v)} type="metallic" />
    </div>
    <div className="flex flex-col flex-1 items-center justify-around w-full mt-4 z-10">
      <PRackKnob label="FEEDBACK" value={p.params.feedback} min={0} max={100} onChange={(v:any) => onChange('feedback', v)} size="xl" type="metallic" />
      <PRackKnob label="MIX" value={p.params.mix} min={0} max={100} onChange={(v:any) => onChange('mix', v)} size="lg" type="metallic" />
    </div>
    
    <div className="mt-auto mb-2 w-full flex justify-center z-10">
      <PluginSelector category="Delay" currentUri={p.uri} onSelect={onReplace} />
    </div>
  </div>
);

const ReverbModule = ({ p, onChange, onReplace }: { p: PluginNode, onChange: (k: string, v: number) => void, onReplace: (uri: string) => void }) => (
  <div className="w-56 h-full bg-[#35527a] border-x border-[#25426a] shadow-[inset_0_0_20px_rgba(0,0,0,0.3)] flex flex-col items-center p-3 relative overflow-hidden">
    <ScratchedMetalOverlay />
    {/* Display Screen */}
    <div className="w-40 h-14 bg-[#001122] border-4 border-blue-900 rounded mb-6 mt-8 flex flex-col items-center justify-center shadow-[0_2px_10px_rgba(0,0,0,0.8),inset_0_0_10px_rgba(0,0,0,1)] z-10">
       <span className="text-orange-500 font-mono font-black text-lg drop-shadow-[0_0_5px_#f97316]">{p.params.decay.toFixed(1)} SEC</span>
    </div>

    <div className="flex flex-col flex-1 items-center justify-around w-full z-10">
      <PRackKnob label="DECAY" value={p.params.decay} min={0.1} max={10} onChange={(v:any) => onChange('decay', v)} size="xl" type="metallic" />
      <div className="flex w-full justify-around">
         <PRackKnob label="HI CUT" value={p.params.high_cut} min={1000} max={20000} onChange={(v:any) => onChange('high_cut', v)} size="sm" type="metallic" />
         <PRackKnob label="MIX" value={p.params.mix} min={0} max={100} onChange={(v:any) => onChange('mix', v)} size="sm" type="metallic" />
      </div>
    </div>
    
    <div className="mt-auto mb-2 w-full flex justify-center z-10">
      <PluginSelector category="Reverb" currentUri={p.uri} onSelect={onReplace} />
    </div>
  </div>
);

const LimiterModule = ({ p, onChange, onReplace }: { p: PluginNode, onChange: (k: string, v: number) => void, onReplace: (uri: string) => void }) => (
  <div className="w-64 h-full bg-[#4a503a] border-x-4 border-[#3a402a] border-y border-[#3a402a] shadow-[inset_0_0_30px_rgba(0,0,0,0.9)] flex flex-col items-center p-3 relative overflow-hidden">
    <ScratchedMetalOverlay />
    <div className="absolute top-2 left-2 w-3 h-3 rounded-full border border-gray-900 bg-gray-700 shadow-inner z-10" />
    <div className="absolute top-2 right-2 w-3 h-3 rounded-full border border-gray-900 bg-gray-700 shadow-inner z-10" />
    
    <div className="text-[#caced0] font-black text-xl tracking-tighter mt-2 z-10 drop-shadow-md">{p.name.toUpperCase()}</div>
    
    <div className="flex gap-4 z-10 mt-6">
       <div className="w-24 h-16 bg-[#e0d8c0] border-4 border-[#111] rounded overflow-hidden relative shadow-[0_2px_8px_rgba(0,0,0,0.8),inset_0_0_10px_rgba(0,0,0,0.5)]">
          <div className="absolute top-2 left-0 w-full h-full border-t border-black/30 rounded-full" style={{ transform: 'scale(1.5)' }} />
          <div className="absolute bottom-[-10px] left-1/2 w-[2px] h-14 bg-black origin-bottom rotate-[-20deg]" />
       </div>
       <div className="w-24 h-16 bg-[#e0d8c0] border-4 border-[#111] rounded overflow-hidden relative shadow-[0_2px_8px_rgba(0,0,0,0.8),inset_0_0_10px_rgba(0,0,0,0.5)]">
          <div className="absolute top-2 left-0 w-full h-full border-t border-black/30 rounded-full" style={{ transform: 'scale(1.5)' }} />
          <div className="absolute bottom-[-10px] left-1/2 w-[2px] h-14 bg-black origin-bottom rotate-[-20deg]" />
       </div>
    </div>
    
    <div className="flex justify-around w-full mt-8 z-10">
       <PRackKnob label="THRESH" value={p.params.threshold} min={-20} max={0} onChange={(v:any) => onChange('threshold', v)} type="chicken" size="sm" />
       <PRackKnob label="LIMIT" value={p.params.limit} min={-20} max={0} onChange={(v:any) => onChange('limit', v)} type="chicken" size="sm" />
    </div>

    <div className="flex items-center gap-4 mt-auto mb-4 z-10">
       <PRackKnob label="GAIN" value={p.params.gain} min={-20} max={20} onChange={(v:any) => onChange('gain', v)} type="chicken" size="xl" />
    </div>
    
    <div className="mt-auto mb-2 w-full flex justify-center z-10">
      <PluginSelector category="Limiter" currentUri={p.uri} onSelect={onReplace} />
    </div>
  </div>
);

export const PRackStrip = () => {
  const selectedChannelId = useMixerStore(state => state.selectedChannelId);
  const channels = useMixerStore(state => state.channels);
  const replacePlugin = useMixerStore(state => state.replacePlugin);
  const setPluginParam = useMixerStore(state => state.setPluginParam);
  const setPluginEnabled = useMixerStore(state => state.setPluginEnabled);

  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      if (entries.length > 0) {
        const { height } = entries[0].contentRect;
        const targetHeight = 600; // Baseline module height
        setScale(height / targetHeight);
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  if (selectedChannelId === null) return null;
  const channel = channels[selectedChannelId];

  return (
    <div ref={containerRef} className="h-full w-full bg-[#050505] overflow-x-auto overflow-y-hidden custom-scrollbar shadow-[inset_0_10px_20px_rgba(0,0,0,0.5)] border-y-8 border-[#1a1c22]">
      <div 
        className="flex gap-2 p-2 origin-top-left"
        style={{ 
          height: '600px',
          width: 'max-content',
          transform: `scale(${scale})`
        }}
      >
      {channel.plugins.map(p => {
        const update = (k: string, v: number) => setPluginParam(channel.id, p.id, k, v);
        const toggle = () => setPluginEnabled(channel.id, p.id, !p.enabled);
        const onReplace = (uri: string) => replacePlugin(channel.id, p.id, uri);

        const category = PLUGIN_REGISTRY.find(e => e.uri === p.uri)?.category;

        const renderModule = () => {
           if (category === 'Saturation') return <SaturaModule p={p} onChange={update} onReplace={onReplace} />;
           if (category === 'Dynamics') return <CompressorModule p={p} onChange={update} onReplace={onReplace} />;
           if (category === 'De-Esser') return <DeesserModule p={p} onChange={update} onReplace={onReplace} />;
           if (category === 'Equalizer') return <EqModule p={p} onChange={update} onReplace={onReplace} />;
           if (category === 'Delay') return <DelayModule p={p} onChange={update} onReplace={onReplace} />;
           if (category === 'Reverb') return <ReverbModule p={p} onChange={update} onReplace={onReplace} />;
           if (category === 'Limiter') return <LimiterModule p={p} onChange={update} onReplace={onReplace} />;
           return <div className="text-white flex items-center justify-center h-full w-40 bg-gray-800">Unknown ({p.name})</div>;
        };

        return (
          <div key={p.id} className="relative group shrink-0 shadow-[8px_0_20px_rgba(0,0,0,0.9)]">
             {renderModule()}
             {/* Power Toggle Overlay */}
             <div className="absolute top-2 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                <button 
                  onClick={toggle}
                  className={`w-8 h-8 flex justify-center items-center rounded-full border-2 border-[#111] shadow-[0_4px_8px_rgba(0,0,0,0.8)] transition-all ${p.enabled ? 'bg-green-500 shadow-[0_0_15px_#22c55e]' : 'bg-red-900'}`}
                >
                  <div className="w-2 h-2 rounded-full bg-white/90" />
                </button>
             </div>
             {!p.enabled && <div className="absolute inset-0 bg-black/60 z-30 pointer-events-none transition-colors" />}
          </div>
        );
      })}
      </div>
    </div>
  );
};


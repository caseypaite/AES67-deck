import { usePatchbayStore } from '../stores/usePatchbayStore';
import React, { useEffect, useState } from 'react';
import { ChannelStrip } from '../components/mixer/ChannelStrip';
import { PRackStrip } from '../components/plugins/PRackStrip';
import { useMixerStore, positionToDb } from '../stores/useMixerStore';
import { DawView } from './DawView';
import { PatchbayView } from '../components/patchbay/PatchbayView';

const AuxSendsPanel = ({ channelId }: { channelId: number }) => {
  const channel = useMixerStore(state => state.channels[channelId]);
  const allChannels = useMixerStore(state => state.channels);
  const setAuxSend = useMixerStore(state => state.setAuxSend);

  if (!channel || channel.type !== 'input') return null;
  
  const busIds = [...Object.values(allChannels).filter(c => c.type === 'bus').map(c => c.id).sort(), 100];

  return (
    <div className="max-w-[60%] shrink-0 h-full border-l-[6px] border-[#0a0c10] bg-[#111318] flex flex-col shadow-[-10px_0_20px_rgba(0,0,0,0.5)] z-20 relative overflow-hidden">
       {/* Background noise texture */}
       <div className="absolute inset-0 pointer-events-none z-0 mix-blend-overlay opacity-10">
         <div className="absolute inset-0" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noise%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.8%22 numOctaves=%224%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noise)%22/%3E%3C/svg%3E")' }} />
       </div>
       
       <div className="text-[#a0a5aa] font-black text-[10px] tracking-widest uppercase drop-shadow-md text-center z-10 border-b-2 border-black bg-[#111] py-1 shrink-0">
         BUS SENDS <span className="text-gray-500 text-[9px]">CH {channelId}</span>
       </div>
       
       <div className="flex justify-start h-full z-10 overflow-x-auto overflow-y-hidden custom-scrollbar bg-[#050505]">
         {busIds.map((busId) => {
           const isMaster = busId === 100;
           const val = channel.auxSends[busId] !== undefined ? channel.auxSends[busId] : 0.75;
           const topPos = `calc(${(1.0 - val)} * (100% - 48px))`;

           const updateVal = (v: number) => {
             setAuxSend(channelId, busId, Math.max(0.0, Math.min(1.0, v)));
           };

           return (
             <div key={busId} className={`flex flex-col items-center h-full relative shrink-0 ${isMaster ? 'w-[72px]' : 'w-[60px]'} border-r-2 border-[#111] bg-[#2a2d34] pt-2 pb-1`}>
                <div className={`text-[10px] font-black tracking-widest mb-2 px-1 py-0.5 rounded shadow-[inset_0_1px_3px_rgba(0,0,0,0.8),0_1px_1px_rgba(255,255,255,0.2)] border border-[#222] w-11/12 text-center truncate ${isMaster ? 'bg-[#3a0a0a] text-red-400' : 'bg-[#0a1a3a] text-blue-400'}`}>
                   {isMaster ? 'MASTER' : `AUX ${busId - 100}`}
                </div>
                
                <div 
                  className="relative w-5 flex-1 bg-[#0a0a0a] flex justify-center shadow-[inset_0_4px_15px_rgba(0,0,0,1),0_1px_0_rgba(255,255,255,0.2)] border-x border-[#222] cursor-pointer ml-[-4px]"
                  onMouseDown={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const move = (me: MouseEvent) => {
                      const usableHeight = rect.height - 48; // Fader cap height is 48px
                      let v = 1.0 - (me.clientY - rect.top - 24) / usableHeight;
                      updateVal(v);
                    };
                    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
                    move(e as any);
                    window.addEventListener('mousemove', move);
                    window.addEventListener('mouseup', up);
                  }}
                  onDoubleClick={(e) => { e.stopPropagation(); updateVal(0.75); }}
                >
                  {/* Track Slot */}
                  <div className="absolute top-4 bottom-4 w-1 bg-black shadow-[inset_0_1px_3px_rgba(0,0,0,1)] pointer-events-none" />

                  {/* dB Scale Marks */}
                  <div className="absolute top-[24px] bottom-[24px] -right-[16px] w-4 pointer-events-none flex flex-col justify-between z-0">
                     {[
                       { y: 1.0, label: '+10' },
                       { y: 0.75, label: '0' },
                       { y: 0.5, label: '-10' },
                       { y: 0.3, label: '-20' },
                       { y: 0.15, label: '-40' },
                       { y: 0.0, label: '-∞' }
                     ].map(mark => (
                        <div key={mark.label} className="absolute w-full flex items-center gap-0.5" style={{ bottom: `${mark.y * 100}%`, transform: 'translateY(50%)' }}>
                           <div className={`w-1 h-[1.5px] ${mark.y === 0.75 ? 'bg-gray-400' : 'bg-gray-600'}`} />
                           <div className={`text-[6px] font-bold leading-none ${mark.y === 0.75 ? 'text-gray-400' : 'text-gray-600'}`}>{mark.label}</div>
                        </div>
                     ))}
                  </div>

                  {/* Fader Cap */}
                  <div 
                    className="absolute h-[48px] w-8 rounded-[2px] shadow-[0_6px_10px_rgba(0,0,0,0.8),inset_0_2px_2px_rgba(255,255,255,0.3),inset_0_-2px_4px_rgba(0,0,0,0.6)] cursor-grab active:cursor-grabbing flex flex-col items-center justify-center hover:brightness-110 active:brightness-90 z-20 border border-black/80 bg-gradient-to-b from-[#e0e0e0] to-[#888]"
                    style={{ top: topPos }}
                    onDoubleClick={(e) => { e.stopPropagation(); updateVal(0.75); }}
                  >
                     <div className="w-full h-4 bg-gradient-to-b from-black/60 to-black/20 shadow-[inset_0_2px_4px_rgba(0,0,0,0.9)] flex items-center justify-center border-y border-white/10">
                        <div className="w-full h-[2px] bg-black shadow-sm" />
                     </div>
                  </div>
                </div>
                
                <div className={`mt-2 font-black tracking-widest text-[9px] px-1 py-0.5 rounded shadow-[inset_0_1px_3px_rgba(0,0,0,0.8),0_1px_1px_rgba(255,255,255,0.2)] border border-[#222] w-11/12 text-center mb-1 ${isMaster ? 'text-red-400 bg-[#3a0a0a]' : 'text-blue-400 bg-[#0a1a3a]'}`}>
                  {(() => {
                     const db = positionToDb(val);
                     return db === -Infinity ? '-∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
                  })()}
                </div>
             </div>
           );
         })}
       </div>
    </div>
  );
};

export const LiveConsoleView = () => {
  const connectWebSocket = useMixerStore(state => state.connectWebSocket);
  const transportState = useMixerStore(state => state.transportState);
  const timecode = useMixerStore(state => state.timecode);
  const toggleTransport = useMixerStore(state => state.toggleTransport);
  const activeView = useMixerStore(state => state.activeView);
  const setActiveView = useMixerStore(state => state.setActiveView);
  const selectedChannelId = useMixerStore(state => state.selectedChannelId);
  const allChannels = useMixerStore(state => state.channels);

  useEffect(() => {
    connectWebSocket();
  }, [connectWebSocket]);

  const inputChannels = Object.values(allChannels).filter(c => c.type === 'input').map(c => c.id).sort((a,b) => a - b);
  const auxBuses = Object.values(allChannels).filter(c => c.type === 'bus').map(c => c.id).sort((a, b) => a - b);
  const monitorBus = Object.values(allChannels).find(c => c.type === 'monitor');
  const [channelBank, setChannelBank] = useState(0);
  const masterId = 100;
  
  const ws = useMixerStore(state => state.ws);
  const scenes = useMixerStore(state => state.scenes);
  const channels = useMixerStore(state => state.channels);

  useEffect(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'list_scenes' }));
    }
  }, [ws]);

  const handleSaveScene = () => {
    const name = prompt("Enter scene name to save:");
    if (!name) return;
    const patchbayMappings = usePatchbayStore.getState().mappings;
    const state = {
      mixer: { channels },
      patchbay: { mappings: patchbayMappings }
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'save_scene', name, state }));
    }
  };

  const handleLoadScene = (name: string) => {
    if (!name) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'load_scene', name }));
    }
  };

  return (
    <div className="h-screen flex flex-col bg-[#0b0c10] text-white overflow-hidden font-sans">
      {/* Top Toolbar */}
      <div className="h-14 bg-[#111318] border-b border-gray-800 flex items-center justify-between px-6 shrink-0 z-20 shadow-md">
        <div className="flex gap-2">
          <button 
            className={`px-4 py-1.5 rounded-sm font-bold text-xs tracking-wider transition-colors ${activeView === 'mixer' ? 'bg-blue-600 text-white' : 'bg-transparent text-gray-400 hover:bg-gray-800'}`}
            onClick={() => setActiveView('mixer')}
          >
            MIXER
          </button>
          <button 
            className={`px-4 py-1.5 rounded-sm font-bold text-xs tracking-wider transition-colors ${activeView === 'daw' ? 'bg-blue-600 text-white' : 'bg-transparent text-gray-400 hover:bg-gray-800'}`}
            onClick={() => setActiveView('daw')}
          >
            TIMELINE
          </button>
          <button 
            className={`px-4 py-1.5 rounded-sm font-bold text-xs tracking-wider transition-colors ${activeView === 'patchbay' ? 'bg-blue-600 text-white' : 'bg-transparent text-gray-400 hover:bg-gray-800'}`}
            onClick={() => setActiveView('patchbay')}
          >
            PATCHBAY
          </button>
        </div>
        
        <div className="flex gap-2 items-center">
          <button onClick={handleSaveScene} className="px-3 py-1.5 bg-[#1a1c22] hover:bg-green-700 text-white text-[10px] font-bold rounded shadow-sm border border-[#222]">SAVE SCENE</button>
          <select onChange={e => { handleLoadScene(e.target.value); e.target.value = ''; }} className="px-2 py-1.5 bg-[#1a1c22] text-white text-[10px] font-bold rounded outline-none border border-[#333] w-32 cursor-pointer shadow-sm">
             <option value="">LOAD SCENE...</option>
             {scenes.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="flex items-center gap-6 bg-[#050608] px-6 py-1.5 rounded border border-gray-800 shadow-inner">
           <div className="font-mono text-lg text-green-500 tracking-widest">{timecode}</div>
           <div className="w-px h-5 bg-gray-700" />
           <button onClick={() => toggleTransport('stop')} className="w-7 h-7 flex items-center justify-center bg-gray-800 rounded-sm hover:bg-gray-700 transition-colors">
             <div className="w-2.5 h-2.5 bg-white" />
           </button>
           <button onClick={() => toggleTransport('play')} className={`w-7 h-7 flex items-center justify-center rounded-sm transition-colors ${transportState === 'playing' ? 'bg-green-600 shadow-[0_0_10px_rgba(22,163,74,0.5)]' : 'bg-gray-800 hover:bg-gray-700'}`}>
             <div className="w-0 h-0 border-t-[6px] border-t-transparent border-l-[10px] border-l-white border-b-[6px] border-b-transparent ml-0.5" />
           </button>
           <button onClick={() => toggleTransport('record')} className={`w-7 h-7 flex items-center justify-center rounded-sm transition-colors ${transportState === 'recording' ? 'bg-red-600 animate-pulse shadow-[0_0_10px_rgba(220,38,38,0.5)]' : 'bg-gray-800 hover:bg-gray-700'}`}>
             <div className="w-3 h-3 rounded-full bg-white" />
           </button>
        </div>

        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <div className="text-gray-400 font-bold tracking-widest text-xs">AES67-DECK</div>
        </div>
      </div>

      {/* Main Workspace */}
      <div className="flex-1 flex flex-col overflow-hidden">
        
        {/* Top Area: FX Rack & Aux Sends (40% Height) */}
        {activeView === 'mixer' && (
          <div className="h-[40%] min-h-0 border-b border-gray-800 bg-[#111318] flex items-center justify-start z-10 shrink-0 overflow-hidden">
            {selectedChannelId !== null ? (
              <>
                <div className="flex-1 h-full overflow-hidden flex items-center justify-start bg-[#050505]">
                   <div className="w-full h-full">
                     <PRackStrip />
                   </div>
                </div>
                <AuxSendsPanel channelId={selectedChannelId} />
              </>
            ) : (
              <div className="w-full flex flex-col items-center justify-center text-gray-700 font-bold tracking-widest h-full">
                <div className="text-2xl mb-2">NO CHANNEL SELECTED</div>
                <div className="text-xs">Click a channel strip below to view and configure its 500-series rack.</div>
              </div>
            )}
          </div>
        )}

        {/* Bottom Area: The Mixer (60% Height) */}
        {activeView === 'mixer' && (
          <div className="flex-1 flex w-full overflow-hidden bg-[#0b0c10]">
            
            {/* Input Channels with Bank Selector */}
            <div className="flex-1 flex flex-col min-w-0">
               {/* Bank Tabs */}
               <div className="flex gap-1 px-2 pt-1 bg-[#0b0c10]">
                 {Array.from({ length: Math.ceil(inputChannels.length / 16) }).map((_, i) => (
                    <button 
                       key={i}
                       onClick={() => setChannelBank(i)}
                       className={`px-3 py-1 text-[10px] font-bold tracking-widest rounded-t-sm border-t border-x border-[#222] ${channelBank === i ? 'bg-[#1a1c22] text-blue-400' : 'bg-[#050505] text-gray-500 hover:text-gray-300'} transition-colors`}
                    >
                       CH {i * 16 + 1}-{Math.min((i + 1) * 16, inputChannels.length)}
                    </button>
                 ))}
               </div>
               
               {/* Scrollable Input Channels */}
               <div className="flex-1 overflow-x-auto overflow-y-hidden custom-scrollbar bg-[#1a1c22] border-t-2 border-[#1a1c22]">
                 <div className="flex items-end h-full w-max gap-1 p-2 pt-1">
                   {inputChannels.slice(channelBank * 16, (channelBank + 1) * 16).map(id => (
                     <ChannelStrip key={id} id={id} />
                   ))}
                   

                 </div>
               </div>
            </div>

            {/* Fixed Right Side: Aux Buses, Monitor, and Master */}
            <div className="shrink-0 flex items-end h-full p-2 bg-[#08090c] shadow-[-10px_0_15px_-5px_rgba(0,0,0,0.5)] z-20 overflow-x-auto custom-scrollbar border-l-[6px] border-[#050505]">

              {/* Aux Buses (fixed at 8) */}
              <div className="flex items-end h-full gap-1">
                {auxBuses.map(id => (
                  <ChannelStrip key={id} id={id} />
                ))}
              </div>

              {/* Divider */}
              <div className="shrink-0 w-[6px] h-full bg-[#050505] mx-1" />

              {/* Monitor: dedicated operator bus, always connected to the
                  system's audio out device */}
              {monitorBus && (
                <div className="flex items-end h-full">
                  <ChannelStrip id={monitorBus.id} />
                </div>
              )}

              {/* Master */}
              <div className="flex items-end h-full">
                <ChannelStrip id={masterId} />
              </div>
            </div>
          </div>
        )}

        {activeView === 'daw' && (
          <DawView />
        )}

        {activeView === 'patchbay' && (
          <PatchbayView />
        )}
      </div>
    </div>
  );
};

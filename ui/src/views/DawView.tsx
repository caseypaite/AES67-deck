import React, { useRef, useEffect } from 'react';
import { useMixerStore } from '../stores/useMixerStore';
import { useDawStore } from '../stores/useDawStore';

export const DawView = () => {
  const allChannels = useMixerStore(state => state.channels);
  const setChannelValue = useMixerStore(state => state.setChannelValue);
  const transportState = useMixerStore(state => state.transportState);
  
  const clips = useDawStore(state => Object.values(state.clips));
  const updateClip = useDawStore(state => state.updateClip);
  const playheadPosition = useDawStore(state => state.playheadPosition);
  const setPlayheadPosition = useDawStore(state => state.setPlayheadPosition);
  const zoom = useDawStore(state => state.zoom);
  const setZoom = useDawStore(state => state.setZoom);
  
  // Selection & Clipboard
  const selectedClipIds = useDawStore(state => state.selectedClipIds);
  const setSelectedClips = useDawStore(state => state.setSelectedClips);
  const toggleClipSelection = useDawStore(state => state.toggleClipSelection);
  const clearSelection = useDawStore(state => state.clearSelection);
  const deleteSelected = useDawStore(state => state.deleteSelected);
  const copySelected = useDawStore(state => state.copySelected);
  const pasteClipboard = useDawStore(state => state.pasteClipboard);
  const sliceSelectedAtPlayhead = useDawStore(state => state.sliceSelectedAtPlayhead);
  
  // Track Heights & Grid
  const trackHeights = useDawStore(state => state.trackHeights);
  const setTrackHeight = useDawStore(state => state.setTrackHeight);
  const snapToGrid = useDawStore(state => state.snapToGrid);
  const setSnapToGrid = useDawStore(state => state.setSnapToGrid);
  const gridSize = useDawStore(state => state.gridSize);

  const tracks = Object.values(allChannels).filter(c => c.type === 'input').sort((a, b) => a.id - b.id);
  const scrollRef = useRef<HTMLDivElement>(null);

  // --- Transport / Playhead Animation ---
  const lastTimeRef = useRef<number>(performance.now());
  const recordStartTime = useDawStore(state => state.recordStartTime);
  const setRecordStartTime = useDawStore(state => state.setRecordStartTime);
  const addClip = useDawStore(state => state.addClip);

  useEffect(() => {
    if (transportState === 'recording') {
       if (recordStartTime === null) {
          setRecordStartTime(useDawStore.getState().playheadPosition);
       }
    } else if (transportState === 'stopped') {
       if (recordStartTime !== null) {
          const endTime = useDawStore.getState().playheadPosition;
          if (endTime > recordStartTime) {
             const length = endTime - recordStartTime;
             const armedTracks = Object.values(useMixerStore.getState().channels).filter(c => c.type === 'input' && c.arm);
             armedTracks.forEach(t => {
                addClip({
                  id: crypto.randomUUID(),
                  trackId: t.id,
                  start: recordStartTime,
                  length: length,
                  color: 'bg-red-600',
                  name: `Take ${Math.floor(Math.random() * 100)}`
                });
             });
          }
          setRecordStartTime(null);
       }
    }
  }, [transportState, recordStartTime, setRecordStartTime, addClip]);
  
  useEffect(() => {
    let rafId: number;
    if (transportState === 'playing' || transportState === 'recording') {
      lastTimeRef.current = performance.now();
      const loop = () => {
        const now = performance.now();
        const delta = (now - lastTimeRef.current) / 1000.0;
        lastTimeRef.current = now;
        setPlayheadPosition(useDawStore.getState().playheadPosition + delta);
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    }
    return () => cancelAnimationFrame(rafId);
  }, [transportState, setPlayheadPosition]);

  const formatTime = (secs: number) => {
    const hh = Math.floor(secs / 3600).toString().padStart(2, '0');
    const mm = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
    const ss = Math.floor(secs % 60).toString().padStart(2, '0');
    const ff = Math.floor((secs % 1) * 30).toString().padStart(2, '0');
    return `${hh}:${mm}:${ss}:${ff}`;
  };

  useEffect(() => {
    useMixerStore.setState({ timecode: formatTime(playheadPosition) });
  }, [playheadPosition]);


  // --- Keyboard Shortcuts ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      if (e.key === 'Backspace' || e.key === 'Delete') {
        deleteSelected();
      }
      
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        copySelected();
      }
      
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        pasteClipboard();
      }
      
      if (e.key.toLowerCase() === 's') {
        sliceSelectedAtPlayhead();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteSelected, copySelected, pasteClipboard, sliceSelectedAtPlayhead]);


  // --- Snapping helper ---
  const snap = (value: number) => {
    if (!useDawStore.getState().snapToGrid) return value;
    const gs = useDawStore.getState().gridSize;
    return Math.round(value / gs) * gs;
  };

  // --- Ruler Scrubbing ---
  const handleRulerMouseDown = (e: React.MouseEvent) => {
    if (transportState !== 'stopped') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const scrollLeft = scrollRef.current ? scrollRef.current.scrollLeft : 0;
    
    // Only clientX is needed, so this accepts either the native MouseEvent
    // from the window listener below or the React.MouseEvent from the
    // initial mousedown, with no unsafe cast needed for either.
    const updateScrub = (ev: { clientX: number }) => {
      const clickX = ev.clientX - rect.left + scrollLeft;
      const newSec = Math.max(0, clickX / zoom);

      // If snapping is on, maybe we want to snap playhead too? Optional.
      // Let's snap playhead if shift is NOT held, to match standard DAW behavior?
      // Actually, playhead scrubbing usually doesn't snap unless explicitly moving it on grid.
      // We'll snap playhead during scrub.
      setPlayheadPosition(snap(newSec));
    };

    const up = () => {
      window.removeEventListener('mousemove', updateScrub);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', updateScrub);
    window.addEventListener('mouseup', up);
    updateScrub(e);
  };

  const handleBackgroundClick = () => {
    clearSelection();
  };

  return (
    <div className="w-full h-full flex bg-[#1e1e24] overflow-hidden text-sm select-none font-sans outline-none" tabIndex={0}>
      
      {/* Track Headers (Left Column) */}
      <div className="w-64 bg-[#181a1f] border-r border-[#111] flex flex-col shrink-0 z-20 shadow-xl relative">
        <div className="h-8 border-b border-[#111] bg-[#141519] flex items-center px-4 shrink-0 text-xs text-gray-500 font-bold tracking-widest justify-between">
          <span>TRACKS</span>
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col pt-1" onScroll={(e) => {
          const rightPane = document.getElementById('daw-tracks-pane');
          if (rightPane) rightPane.scrollTop = e.currentTarget.scrollTop;
        }}>
          {tracks.map(track => {
            const h = trackHeights[track.id] || 96;
            return (
              <div key={track.id} className="border-b border-[#222] bg-[#1c1e24] flex flex-col p-2 shrink-0 group relative" style={{ height: h }}>
                <div className="flex justify-between items-center mb-2">
                  <span className="font-bold text-gray-200 truncate pr-2">{track.name}</span>
                  <span className="text-[10px] text-gray-600 bg-black/40 px-1.5 py-0.5 rounded shrink-0">CH {track.id}</span>
                </div>
                
                <div className="flex gap-1 mb-2">
                  <button onClick={() => setChannelValue(track.id, 'arm', !track.arm)} className={`w-6 h-6 rounded flex items-center justify-center font-bold text-[10px] transition-colors ${track.arm ? 'bg-red-600 text-white shadow-[0_0_8px_rgba(220,38,38,0.6)]' : 'bg-[#2a2c33] text-gray-400 hover:bg-[#333]'}`}>R</button>
                  <button onClick={() => setChannelValue(track.id, 'solo', !track.solo)} className={`w-6 h-6 rounded flex items-center justify-center font-bold text-[10px] transition-colors ${track.solo ? 'bg-yellow-500 text-black shadow-[0_0_8px_rgba(234,179,8,0.6)]' : 'bg-[#2a2c33] text-gray-400 hover:bg-[#333]'}`}>S</button>
                  <button onClick={() => setChannelValue(track.id, 'mute', !track.mute)} className={`w-6 h-6 rounded flex items-center justify-center font-bold text-[10px] transition-colors ${track.mute ? 'bg-orange-600 text-white shadow-[0_0_8px_rgba(234,88,12,0.6)]' : 'bg-[#2a2c33] text-gray-400 hover:bg-[#333]'}`}>M</button>
                </div>
                
                <div className="mt-auto h-2 bg-black rounded-sm overflow-hidden flex flex-col justify-end gap-[1px]">
                   <div className="h-[1px] bg-green-500 transition-all duration-75" style={{ width: `${Math.max(0, (track.meterL + 60) / 60 * 100)}%` }} />
                   <div className="h-[1px] bg-green-500 transition-all duration-75" style={{ width: `${Math.max(0, (track.meterR + 60) / 60 * 100)}%` }} />
                </div>
                
                {/* Resize Handle */}
                <div 
                  className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize hover:bg-white/10 z-10"
                  onMouseDown={(e) => {
                    const initialY = e.clientY;
                    const initialH = h;
                    const move = (ev: MouseEvent) => {
                      const deltaY = ev.clientY - initialY;
                      setTrackHeight(track.id, initialH + deltaY);
                    };
                    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
                    window.addEventListener('mousemove', move);
                    window.addEventListener('mouseup', up);
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Timeline Area (Right Column) */}
      <div className="flex-1 flex flex-col relative bg-[#1a1c22] overflow-hidden">
        
        {/* Ruler */}
        <div 
          className="h-8 bg-[#141519] border-b border-[#111] flex items-end shrink-0 relative overflow-hidden cursor-crosshair" 
          ref={scrollRef}
          onMouseDown={handleRulerMouseDown}
        >
          <div className="absolute inset-0 pointer-events-none" style={{ left: 0 }}>
             {/* Dynamic background grid depending on snap and zoom */}
             <div className="w-[100000px] h-full" style={{ backgroundImage: `repeating-linear-gradient(to right, transparent, transparent ${zoom * gridSize - 1}px, #333 ${zoom * gridSize - 1}px, #333 ${zoom * gridSize}px)` }} />
             <div className="absolute top-0 w-[100000px] h-full" style={{ backgroundImage: `repeating-linear-gradient(to right, transparent, transparent ${zoom * gridSize * 10 - 1}px, #666 ${zoom * gridSize * 10 - 1}px, #666 ${zoom * gridSize * 10}px)` }} />
          </div>
        </div>

        {/* Tracks Grid */}
        <div 
          id="daw-tracks-pane"
          className="flex-1 overflow-auto custom-scrollbar relative bg-[#1a1c22]" 
          onScroll={(e) => {
            if (scrollRef.current) scrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
            const leftPane = e.currentTarget.parentElement?.previousElementSibling?.lastElementChild as HTMLDivElement;
            if (leftPane) leftPane.scrollTop = e.currentTarget.scrollTop;
          }}
          onMouseDown={handleBackgroundClick}
        >
          <div className="w-[100000px] flex flex-col pt-1 pb-20 relative">
            
            {/* Playhead Line */}
            <div 
              className="absolute top-0 bottom-0 w-px bg-white z-30 shadow-[0_0_4px_rgba(255,255,255,0.8)] pointer-events-none"
              style={{ left: playheadPosition * zoom }}
            >
               <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] border-t-white" />
            </div>

            {/* Track Lanes */}
            {tracks.map(track => {
              const trackClips = clips.filter(c => c.trackId === track.id);
              const isRecording = transportState === 'recording' && track.arm;
              const h = trackHeights[track.id] || 96;
              
              return (
                <div key={track.id} className="border-b border-[#222]/50 relative group bg-[#1c1e24]/40 hover:bg-[#1c1e24]/80 transition-colors" style={{ height: h }}>
                  <div className="absolute inset-0 pointer-events-none opacity-20" style={{ backgroundImage: `repeating-linear-gradient(to right, transparent, transparent ${zoom * gridSize * 10 - 1}px, #fff ${zoom * gridSize * 10 - 1}px, #fff ${zoom * gridSize * 10}px)` }} />
                  
                  {isRecording && recordStartTime !== null && playheadPosition > recordStartTime && (
                    <div 
                      className="absolute top-2 bottom-2 rounded border border-red-400 bg-red-600/40 z-20 pointer-events-none overflow-hidden"
                      style={{ 
                        left: recordStartTime * zoom,
                        width: (playheadPosition - recordStartTime) * zoom
                      }}
                    >
                      <div className="absolute inset-0 bg-[linear-gradient(45deg,transparent_25%,rgba(255,255,255,0.1)_50%,transparent_75%)] bg-[length:20px_20px] animate-[slide_1s_linear_infinite]" />
                    </div>
                  )}
                  
                  {/* Clips */}
                  {trackClips.map(clip => {
                    const startPx = clip.start * zoom;
                    const widthPx = clip.length * zoom;
                    const isSelected = selectedClipIds.includes(clip.id);
                    
                    return (
                      <div 
                        key={clip.id}
                        className={`absolute top-2 bottom-2 rounded shadow-md opacity-90 hover:opacity-100 overflow-hidden ${clip.color} z-10 transition-[box-shadow] ${isSelected ? 'border-2 border-white ring-2 ring-white/50 z-20' : 'border border-white/30'}`}
                        style={{ left: startPx, width: widthPx }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          
                          let currentSelection = selectedClipIds;
                          if (e.shiftKey || e.metaKey || e.ctrlKey) {
                            toggleClipSelection(clip.id);
                            currentSelection = selectedClipIds.includes(clip.id) ? selectedClipIds.filter(id => id !== clip.id) : [...selectedClipIds, clip.id];
                          } else {
                            if (!selectedClipIds.includes(clip.id)) {
                              setSelectedClips([clip.id]);
                              currentSelection = [clip.id];
                            }
                          }
                          
                          const initialX = e.clientX;
                          const initialStarts: Record<string, number> = {};
                          currentSelection.forEach(id => {
                            const c = useDawStore.getState().clips[id];
                            if (c) initialStarts[id] = c.start;
                          });
                          
                          const move = (ev: MouseEvent) => {
                            const deltaX = ev.clientX - initialX;
                            const deltaSec = deltaX / zoom;
                            
                            // Calculate snapped delta based on the primary clicked clip
                            const rawNewStart = initialStarts[clip.id] + deltaSec;
                            const snappedNewStart = snap(rawNewStart);
                            const snappedDeltaSec = snappedNewStart - initialStarts[clip.id];

                            let finalDelta = snappedDeltaSec;
                            // Clamp so no clip goes below 0
                            currentSelection.forEach(id => {
                              if (initialStarts[id] + finalDelta < 0) {
                                finalDelta = -initialStarts[id]; // this might break snap alignment, but prevents <0
                              }
                            });
                            
                            currentSelection.forEach(id => {
                              updateClip(id, { start: initialStarts[id] + finalDelta });
                            });
                          };
                          const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
                          window.addEventListener('mousemove', move);
                          window.addEventListener('mouseup', up);
                        }}
                      >
                        {/* Waveform Mock (SVG) */}
                        <svg className="absolute inset-0 w-full h-full opacity-40 pointer-events-none preserve-3d" preserveAspectRatio="none" viewBox="0 0 100 100">
                           <path d="M0,50 Q10,10 20,50 T40,50 T60,50 T80,50 T100,50" stroke="white" strokeWidth="2" fill="none" vectorEffect="non-scaling-stroke" />
                        </svg>
                        
                        <div className="absolute top-1 left-1.5 text-[10px] font-bold text-white shadow-black drop-shadow-md pointer-events-none z-10 truncate right-1">
                          {clip.name}
                        </div>
                        
                        {/* Resize Left */}
                        <div 
                          className="absolute top-0 bottom-0 left-0 w-2 hover:bg-white/40 cursor-ew-resize z-20"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            const initialX = e.clientX;
                            const initialStart = clip.start;
                            const initialLength = clip.length;
                            
                            const move = (ev: MouseEvent) => {
                              const deltaX = ev.clientX - initialX;
                              const deltaSec = deltaX / zoom;
                              
                              const rawNewStart = initialStart + deltaSec;
                              let newStart = snap(rawNewStart);
                              newStart = Math.max(0, Math.min(initialStart + initialLength - 0.1, newStart));
                              
                              const newLength = initialLength - (newStart - initialStart);
                              updateClip(clip.id, { start: newStart, length: newLength });
                            };
                            const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
                            window.addEventListener('mousemove', move);
                            window.addEventListener('mouseup', up);
                          }}
                        />

                        {/* Resize Right */}
                        <div 
                          className="absolute top-0 bottom-0 right-0 w-2 hover:bg-white/40 cursor-ew-resize z-20"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            const initialX = e.clientX;
                            const initialLength = clip.length;
                            const initialStart = clip.start;
                            
                            const move = (ev: MouseEvent) => {
                              const deltaX = ev.clientX - initialX;
                              const deltaSec = deltaX / zoom;
                              
                              const rawEnd = initialStart + initialLength + deltaSec;
                              const newEnd = snap(rawEnd);
                              
                              const newLength = Math.max(0.1, newEnd - initialStart);
                              updateClip(clip.id, { length: newLength });
                            };
                            const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
                            window.addEventListener('mousemove', move);
                            window.addEventListener('mouseup', up);
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Utilities / Zoom Controls */}
      <div className="absolute bottom-6 right-8 flex items-center bg-[#111] rounded-lg shadow-xl border border-[#333] p-1 z-40 gap-1">
        <button 
          onClick={() => setSnapToGrid(!snapToGrid)}
          className={`px-3 py-1 text-xs font-bold rounded transition-colors ${snapToGrid ? 'bg-blue-600 text-white' : 'bg-[#222] text-gray-500 hover:text-gray-300'}`}
        >
          SNAP
        </button>
        <div className="w-px h-6 bg-[#333] mx-1" />
        <button className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white hover:bg-[#222] rounded transition-colors" onClick={() => setZoom(zoom - 5)}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7" /></svg>
        </button>
        <button className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white hover:bg-[#222] rounded transition-colors" onClick={() => setZoom(zoom + 5)}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" /></svg>
        </button>
      </div>
    </div>
  );
};

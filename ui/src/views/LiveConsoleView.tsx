import { usePatchbayStore } from '../stores/usePatchbayStore';
import React, { useEffect, useRef, useState } from 'react';
import { ChannelStrip } from '../components/mixer/ChannelStrip';
import { FxRackCard } from '../components/plugins/FxRackCard';
import { useMixerStore, positionToDb } from '../stores/useMixerStore';
import { useDawStore } from '../stores/useDawStore';
import { DawView } from './DawView';
import { PatchbayView } from '../components/patchbay/PatchbayView';
import { Screw } from '../components/analog/Screw';
import { LufsPanel } from '../components/mixer/LufsPanel';
import { MasteringPanel } from '../components/mixer/MasteringPanel';
import { SaveDialog, ConfirmDialog } from '../components/common/SaveDialog';
import { VscToolbar } from '../components/daw/VscToolbar';

// Compact box/engine telemetry for the right end of the toolbar:
// CPU load and RAM from the server, audio round-trip latency from the engine.
const StatCell = ({ label, value, tone }: { label: string; value: string; tone: string }) => (
  <div className="flex flex-col items-end leading-none">
    <span className="text-[10px] font-black tracking-widest text-gray-500">{label}</span>
    <span className={`text-[12px] font-mono font-bold ${tone}`}>{value}</span>
  </div>
);
const tone = (v: number | null, warn: number, bad: number) =>
  v == null ? 'text-gray-600' : v >= bad ? 'text-red-400' : v >= warn ? 'text-amber-400' : 'text-green-400';

const ServerStats = ({ stats, latencyMs }: {
  stats: { cpu: number | null; memUsedMB: number | null; memTotalMB: number | null } | null;
  latencyMs: number | null;
}) => {
  const cpu = stats?.cpu ?? null;
  const used = stats?.memUsedMB ?? null;
  const total = stats?.memTotalMB ?? null;
  const memPct = used != null && total ? (used / total) * 100 : null;
  return (
    <div className="flex items-center gap-2 bg-[#050608] px-1.5 py-0.5 rounded border border-gray-800 shadow-inner">
      <StatCell label="CPU" value={cpu == null ? '—' : `${cpu.toFixed(0)}%`} tone={tone(cpu, 60, 85)} />
      <StatCell
        label="RAM"
        value={used == null || !total ? '—' : `${(used / 1024).toFixed(1)}/${(total / 1024).toFixed(1)}G`}
        tone={tone(memPct, 75, 90)}
      />
      <StatCell label="LAT" value={latencyMs == null ? '—' : `${latencyMs.toFixed(1)}ms`} tone={tone(latencyMs, 12, 25)} />
    </div>
  );
};

// One vertical send fader — shared by AuxSendsPanel (columns = destination
// buses, for a selected input channel) and SourceSendsPanel (columns =
// source input channels, for a selected bus) since both are just "pick a
// 0..1 send level and show it as a draggable fader", differing only in
// what each column represents and how its value round-trips to the store.
const SendFaderColumn = ({ label, value, colorClass, widthClass = 'w-[60px]', onChange }: {
  label: string;
  value: number;
  colorClass: string;
  widthClass?: string;
  onChange: (v: number) => void;
}) => {
  const topPos = `calc(${(1.0 - value)} * (100% - 48px))`;
  const updateVal = (v: number) => onChange(Math.max(0.0, Math.min(1.0, v)));

  return (
    <div className={`flex flex-col items-center h-full relative shrink-0 ${widthClass} border-r-2 border-[#111] bg-[#2a2d34] pt-2 pb-1`}>
       <div className={`text-[10px] font-black tracking-widest mb-2 px-1 py-0.5 rounded shadow-[inset_0_1px_3px_rgba(0,0,0,0.8),0_1px_1px_rgba(255,255,255,0.2)] border border-[#222] w-11/12 text-center truncate ${colorClass}`}>
          {label}
       </div>

       <div
         className="relative w-5 flex-1 bg-[#0a0a0a] flex justify-center shadow-[inset_0_4px_15px_rgba(0,0,0,1),0_1px_0_rgba(255,255,255,0.2)] border-x border-[#222] cursor-pointer ml-[-4px]"
         onMouseDown={(e) => {
           const rect = e.currentTarget.getBoundingClientRect();
           // Only clientY is needed, so this accepts either the
           // native MouseEvent from the window listener below or
           // the initial React.MouseEvent, with no unsafe cast.
           const move = (me: { clientY: number }) => {
             const usableHeight = rect.height - 48; // Fader cap height is 48px
             const v = 1.0 - (me.clientY - rect.top - 24) / usableHeight;
             updateVal(v);
           };
           const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
           move(e);
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

       <div className={`mt-2 font-black tracking-widest text-[9px] px-1 py-0.5 rounded shadow-[inset_0_1px_3px_rgba(0,0,0,0.8),0_1px_1px_rgba(255,255,255,0.2)] border border-[#222] w-11/12 text-center mb-1 ${colorClass}`}>
         {(() => {
            const db = positionToDb(value);
            return db === -Infinity ? '-∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
         })()}
       </div>
    </div>
  );
};

// The panel shell both AuxSendsPanel and SourceSendsPanel share — same
// frame, header bar, optional bank-tab row, and horizontally-scrolling
// fader row.
const SendsPanelShell = ({ title, subtitle, tabs, children }: { title: string; subtitle: string; tabs?: React.ReactNode; children: React.ReactNode }) => (
  <div className="w-full shrink-0 h-full border-l-[6px] border-[#0a0c10] bg-[#111318] flex flex-col shadow-[-10px_0_20px_rgba(0,0,0,0.5)] z-20 relative overflow-hidden">
     {/* Background noise texture */}
     <div className="absolute inset-0 pointer-events-none z-0 mix-blend-overlay opacity-10">
       <div className="absolute inset-0" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noise%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.8%22 numOctaves=%224%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noise)%22/%3E%3C/svg%3E")' }} />
     </div>

     <div className="text-[#a0a5aa] font-black text-[10px] tracking-widest uppercase drop-shadow-md text-center z-10 border-b-2 border-black bg-[#111] py-1 shrink-0">
       {title} <span className="text-gray-500 text-[9px]">{subtitle}</span>
     </div>

     {tabs}

     <div className="flex justify-start h-full z-10 overflow-x-auto overflow-y-hidden custom-scrollbar bg-[#050505]">
       {children}
     </div>
  </div>
);

// Selected channel is an input: one fader per destination bus (+ Master),
// showing/adjusting how much of this channel feeds each.
const AuxSendsPanel = ({ channelId }: { channelId: number }) => {
  const channel = useMixerStore(state => state.channels[channelId]);
  const allChannels = useMixerStore(state => state.channels);
  const setAuxSend = useMixerStore(state => state.setAuxSend);

  if (!channel || channel.type !== 'input') return null;

  const busIds = [...Object.values(allChannels).filter(c => c.type === 'bus').map(c => c.id).sort(), 100];

  return (
    <SendsPanelShell title="BUS SENDS" subtitle={`CH ${channelId}`}>
      {busIds.map((busId) => {
        const isMaster = busId === 100;
        const val = channel.auxSends[busId] !== undefined ? channel.auxSends[busId] : 0.75;
        return (
          <SendFaderColumn
            key={busId}
            label={isMaster ? 'MASTER' : `AUX ${busId - 100}`}
            value={val}
            widthClass={isMaster ? 'w-[72px]' : 'w-[60px]'}
            colorClass={isMaster ? 'bg-[#3a0a0a] text-red-400' : 'bg-[#0a1a3a] text-blue-400'}
            onChange={(v) => setAuxSend(channelId, busId, v)}
          />
        );
      })}
      <LufsPanel />
    </SendsPanelShell>
  );
};

const SOURCE_BANK_SIZE = 16;
// Explicit fixed width, to help 16-per-bank fit in the fixed-width
// (SENDS_SIDEBAR_WIDTH) sends sidebar.
const SOURCE_FADER_WIDTH_CLASS = 'w-[48px]';

// Selected channel is a bus: the inverse view — one fader per source input
// channel, showing/adjusting how much of that source feeds *this* bus.
// Same auxSends[busId] data as AuxSendsPanel, just read/written from the
// source channel's side instead of iterating a single channel's own sends.
// Grouped into banks (its own tab row, independent of the main input
// strip area's tabs below) since all sources at once would need a wide
// horizontal scroll in the fixed-width sends sidebar.
const SourceSendsPanel = ({ busId }: { busId: number }) => {
  const bus = useMixerStore(state => state.channels[busId]);
  const allChannels = useMixerStore(state => state.channels);
  const setAuxSend = useMixerStore(state => state.setAuxSend);
  const [sourceBank, setSourceBank] = useState(0);

  if (!bus || bus.type !== 'bus') return null;

  const inputChannels = Object.values(allChannels).filter(c => c.type === 'input').sort((a, b) => a.id - b.id);
  const bankCount = Math.ceil(inputChannels.length / SOURCE_BANK_SIZE);
  const bankedChannels = inputChannels.slice(sourceBank * SOURCE_BANK_SIZE, (sourceBank + 1) * SOURCE_BANK_SIZE);

  const tabs = bankCount > 1 && (
    <div className="flex gap-1 px-2 pt-1 bg-[#111318] shrink-0">
      {Array.from({ length: bankCount }).map((_, i) => (
        <button
          key={i}
          onClick={() => setSourceBank(i)}
          className={`px-2 py-1 text-[9px] font-bold tracking-widest rounded-t-sm border-t border-x border-[#222] ${sourceBank === i ? 'bg-[#2a2d34] text-blue-400' : 'bg-[#0a0a0a] text-gray-500 hover:text-gray-300'} transition-colors`}
        >
          {i * SOURCE_BANK_SIZE + 1}-{Math.min((i + 1) * SOURCE_BANK_SIZE, inputChannels.length)}
        </button>
      ))}
    </div>
  );

  return (
    <SendsPanelShell title="SOURCES" subtitle={bus.name || `AUX ${busId - 100}`} tabs={tabs}>
      {bankedChannels.map((ic) => {
        const val = ic.auxSends[busId] !== undefined ? ic.auxSends[busId] : 0.75;
        return (
          <SendFaderColumn
            key={ic.id}
            label={ic.name || `CH${ic.id}`}
            value={val}
            widthClass={SOURCE_FADER_WIDTH_CLASS}
            colorClass="bg-[#1a2022] text-[#8fcfdf]"
            onChange={(v) => setAuxSend(ic.id, busId, v)}
          />
        );
      })}
    </SendsPanelShell>
  );
};
// Width of the bottom mixer's right cluster — the BUS (aux) channel-strip
// group + the monitor/master group + the gap-3 between them. The sends
// sidebar is pinned to this width and right-anchored (ml-auto), so its left
// edge lands exactly on the BUS channel-strip group directly below it. All
// three strip groups are fixed-layout, so this stays stable:
//   aux group      p-2(16) + 8×w-[65px] + 7×gap-1(4)  = 564
//   + gap-3                                            =  12
//   monitor/master p-2(16) + 2×w-[87px] + 1×gap-1(4)   = 194
//                                                      = 770
const SENDS_SIDEBAR_WIDTH = 770;

// The top 40%-height panel that holds the FX Rack Card + the sends sidebar.
// A ResizeObserver keeps --rack-width equal to 2/3 of clientHeight so the
// rack card is always proportionally narrower than it is tall.
const FxPanelRow = ({
  selectedChannelId,
  channels,
}: {
  selectedChannelId: number | null;
  channels: ReturnType<typeof useMixerStore.getState>['channels'];
}) => {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const sync = () => el.style.setProperty('--rack-width', `${Math.round(el.clientHeight * 2 / 3)}px`);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={panelRef}
      className="h-[40%] min-h-0 border-b-2 border-black/70 metal-face metal-grain flex z-10 shrink-0 overflow-hidden px-2"
    >
      {/* mounting screws */}
      <Screw seed={0} className="absolute top-1.5 left-1.5 z-30" />
      <Screw seed={1} className="absolute top-1.5 right-1.5 z-30" />
      <Screw seed={2} className="absolute bottom-1.5 left-1.5 z-30" />
      <Screw seed={3} className="absolute bottom-1.5 right-1.5 z-30" />

      {selectedChannelId !== null ? (
        <>
          {/* Left: square FX Rack Card + detail panel. Capped at 1116px so
              the FX rack + plugin UI never grows wider than a full 16-channel
              input bank below it (16×65 + 15×4 gap + 16 padding). */}
          <div className="flex-1 h-full overflow-hidden flex max-w-[1116px]">
            <FxRackCard />
          </div>

          {/* Right: Aux / Source sends sidebar. Fixed to SENDS_SIDEBAR_WIDTH
              and right-anchored (ml-auto) so its left edge sits directly over
              the BUS channel-strip group in the mixer below. ml-auto also
              provides the gap after the FX panel. */}
          <div
            className="shrink-0 ml-auto h-full flex"
            style={{ width: SENDS_SIDEBAR_WIDTH }}
          >
            {(() => {
              const t = channels[selectedChannelId]?.type;
              if (t === 'master' || t === 'monitor')
                return <MasteringPanel channelId={selectedChannelId} />;
              if (t === 'bus') return <SourceSendsPanel busId={selectedChannelId} />;
              return <AuxSendsPanel channelId={selectedChannelId} />;
            })()}
          </div>
        </>
      ) : (
        <div className="w-full flex flex-col items-center justify-center font-black tracking-[0.2em] h-full text-engrave">
          <div className="text-2xl mb-2">NO CHANNEL SELECTED</div>
          <div className="text-xs font-bold tracking-widest opacity-70">Click a channel strip below to select a channel.</div>
        </div>
      )}
    </div>
  );
};

export const LiveConsoleView = () => {
  const connectWebSocket = useMixerStore(state => state.connectWebSocket);
  const transportState = useMixerStore(state => state.transportState);
  const ltcChaseLocked = useDawStore(state => state.ltcChaseLocked);
  const timecode = useDawStore(state => state.timecode);
  const recordingProjects = useDawStore(state => state.recordingProjects);
  const activeRecordingProject = useDawStore(state => state.activeRecordingProject);
  const saveRecordingProject = useDawStore(state => state.saveRecordingProject);
  const openRecordingProject = useDawStore(state => state.openRecordingProject);
  const refreshRecordingProjects = useDawStore(state => state.refreshRecordingProjects);
  const toggleTransport = useMixerStore(state => state.toggleTransport);
  const serverStats = useMixerStore(state => state.serverStats);
  const audioLatencyMs = useMixerStore(state => state.audioLatencyMs);
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
      ws.send(JSON.stringify({ type: 'list_recording_projects' }));
    }
  }, [ws]);

  const recordingProjectError = useDawStore(state => state.recordingProjectError);
  const setRecordingProjectError = useDawStore(state => state.setRecordingProjectError);
  useEffect(() => {
    if (!recordingProjectError) return;
    const t = setTimeout(() => setRecordingProjectError(null), 4000);
    return () => clearTimeout(t);
  }, [recordingProjectError, setRecordingProjectError]);

  // null = closed; 'scene' | 'project' selects which save dialog is open.
  const [saveDialog, setSaveDialog] = useState<null | 'scene' | 'project'>(null);
  const [pendingOpenProject, setPendingOpenProject] = useState<string | null>(null);
  const [sceneSel, setSceneSel] = useState('');
  const [pendingDeleteScene, setPendingDeleteScene] = useState<string | null>(null);
  const deleteScene = useMixerStore(state => state.deleteScene);

  // Keep the selection valid as the scene list changes (e.g. after a delete).
  useEffect(() => {
    if (sceneSel && !scenes.includes(sceneSel)) setSceneSel('');
  }, [scenes, sceneSel]);

  const doSaveScene = (name: string) => {
    if (!name.trim() || !ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('save scene: no name or socket not open');
      return;
    }
    const patchbayMappings = usePatchbayStore.getState().mappings;
    // Drop the transient meter readings so a scene file is just the settings.
    const cleanChannels = Object.fromEntries(
      Object.values(channels).map((c) => [c.id, { ...c, meterL: -100, meterR: -100 }]),
    );
    const state = { mixer: { channels: cleanChannels }, patchbay: { mappings: patchbayMappings } };
    ws.send(JSON.stringify({ type: 'save_scene', name: name.trim(), state }));
  };

  const handleLoadScene = (name: string) => {
    if (!name) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'load_scene', name }));
    }
  };

  const handleOpenProject = (name: string) => {
    if (!name || name === activeRecordingProject) return;
    setPendingOpenProject(name);
  };

  return (
    <div className="h-screen flex flex-col bg-[#0b0c10] text-white overflow-hidden font-sans">
      {recordingProjectError && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-red-700 text-white text-xs font-bold rounded shadow-xl border border-red-400">
          Recording project: {recordingProjectError}
        </div>
      )}

      {saveDialog === 'scene' && (
        <SaveDialog
          title="Save scene"
          label="Scene name"
          existing={scenes}
          existingLabel="scenes"
          onSave={doSaveScene}
          onClose={() => setSaveDialog(null)}
        />
      )}
      {saveDialog === 'project' && (
        <SaveDialog
          title="Save recording project"
          label="Project name"
          existing={recordingProjects}
          initialName={activeRecordingProject ?? ''}
          existingLabel="projects"
          onSave={saveRecordingProject}
          onClose={() => setSaveDialog(null)}
        />
      )}
      {pendingDeleteScene && (
        <ConfirmDialog
          title="Delete scene"
          message={`Delete scene "${pendingDeleteScene}"? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => { deleteScene(pendingDeleteScene); setSceneSel(''); }}
          onClose={() => setPendingDeleteScene(null)}
        />
      )}
      {pendingOpenProject && (
        <ConfirmDialog
          title="Open recording project"
          message={`Open "${pendingOpenProject}"? The current timeline will be replaced${activeRecordingProject ? '' : ' and any unsaved takes left in the scratch session'}.`}
          confirmLabel="Open"
          onConfirm={() => openRecordingProject(pendingOpenProject)}
          onClose={() => setPendingOpenProject(null)}
        />
      )}
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
          {activeView === 'daw' ? (
            <>
              <VscToolbar />
              <button
                onClick={() => setSaveDialog('project')}
                title={activeRecordingProject ? `Saving to records/${activeRecordingProject}/` : 'Consolidate takes into a REAPER project'}
                className="px-3 py-1.5 bg-[#1a1c22] hover:bg-blue-700 text-white text-[10px] font-bold rounded shadow-sm border border-[#222]"
              >
                SAVE PROJECT
              </button>
              <select
                onFocus={refreshRecordingProjects}
                value={activeRecordingProject ?? ''}
                onChange={e => { handleOpenProject(e.target.value); }}
                className="px-2 py-1.5 bg-[#1a1c22] text-white text-[10px] font-bold rounded outline-none border border-[#333] w-40 cursor-pointer shadow-sm"
              >
                <option value="">OPEN PROJECT…</option>
                {recordingProjects.map((p: string) => <option key={p} value={p}>{p}</option>)}
              </select>
            </>
          ) : (
            <>
              <button onClick={() => setSaveDialog('scene')} className="px-3 py-1.5 bg-[#1a1c22] hover:bg-green-700 text-white text-[10px] font-bold rounded shadow-sm border border-[#222]">SAVE SCENE</button>
              <select
                value={sceneSel}
                onChange={e => { const v = e.target.value; setSceneSel(v); handleLoadScene(v); }}
                className="px-2 py-1.5 bg-[#1a1c22] text-white text-[10px] font-bold rounded outline-none border border-[#333] w-32 cursor-pointer shadow-sm"
              >
                 <option value="">LOAD SCENE...</option>
                 {scenes.map((s: string) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button
                onClick={() => sceneSel && setPendingDeleteScene(sceneSel)}
                disabled={!sceneSel}
                title={sceneSel ? `Delete scene "${sceneSel}"` : 'Select a scene to delete'}
                className="px-2 py-1.5 bg-[#1a1c22] text-gray-400 text-[10px] font-bold rounded shadow-sm border border-[#333] enabled:hover:bg-red-700 enabled:hover:text-white disabled:opacity-40"
              >
                🗑
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-6 bg-[#050608] px-6 py-1.5 rounded border border-gray-800 shadow-inner">
           <div className="font-mono text-lg text-green-500 tracking-widest">{timecode}</div>
           <div className="w-px h-5 bg-gray-700" />
           {ltcChaseLocked && (
             <div className="text-[10px] font-black tracking-widest text-emerald-400 px-1.5 py-0.5 rounded bg-emerald-950 border border-emerald-700" title="Chasing external LTC — the engine owns the transport">
               CHASE
             </div>
           )}
           <button onClick={() => toggleTransport('stop')} disabled={ltcChaseLocked}
             className={`w-7 h-7 flex items-center justify-center bg-gray-800 rounded-sm transition-colors ${ltcChaseLocked ? 'opacity-40' : 'hover:bg-gray-700'}`}>
             <div className="w-2.5 h-2.5 bg-white" />
           </button>
           <button onClick={() => toggleTransport('play')} disabled={ltcChaseLocked}
             className={`w-7 h-7 flex items-center justify-center rounded-sm transition-colors ${ltcChaseLocked ? 'opacity-40 bg-gray-800' : transportState === 'playing' ? 'bg-green-600 shadow-[0_0_10px_rgba(22,163,74,0.5)]' : 'bg-gray-800 hover:bg-gray-700'}`}>
             <div className="w-0 h-0 border-t-[6px] border-t-transparent border-l-[10px] border-l-white border-b-[6px] border-b-transparent ml-0.5" />
           </button>
           <button onClick={() => toggleTransport('record')} disabled={ltcChaseLocked}
             className={`w-7 h-7 flex items-center justify-center rounded-sm transition-colors ${ltcChaseLocked ? 'opacity-40 bg-gray-800' : transportState === 'recording' ? 'bg-red-600 animate-pulse shadow-[0_0_10px_rgba(220,38,38,0.5)]' : 'bg-gray-800 hover:bg-gray-700'}`}>
             <div className="w-3 h-3 rounded-full bg-white" />
           </button>
        </div>

        <div className="flex items-center gap-3">
          <ServerStats stats={serverStats} latencyMs={audioLatencyMs} />
          <div className="w-px h-5 bg-gray-700" />
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <div className="text-gray-400 font-bold tracking-widest text-xs">AES67-DECK</div>
          </div>
        </div>
      </div>

      {/* Main Workspace */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top Area: FX Rack & Aux Sends (40% Height) */}
        {activeView === 'mixer' && (
          <FxPanelRow selectedChannelId={selectedChannelId} channels={channels} />
        )}

        {/* Bottom Area: The Mixer (60% Height) */}
        {activeView === 'mixer' && (
          // gap-3 here is the one spacing unit used to separate all four
          // groups — input channels, aux buses, monitor, master — evenly,
          // whether they're direct siblings of this row (input vs. the
          // fixed-right-side wrapper) or siblings inside that wrapper
          // (aux/monitor/master). Each group also gets its own lighter,
          // tinted background instead of sharing one dark panel color, so
          // the grouping reads at a glance without needing divider bars.
          <div className="flex-1 flex w-full overflow-hidden bg-[#0b0c10] gap-3 p-2">

            {/* Input Channels with Bank Selector */}
            <div className="flex-1 flex flex-col min-w-0 bg-[#242832] rounded-sm overflow-hidden">
               {/* Bank Tabs */}
               <div className="flex gap-1 px-2 pt-1">
                 {Array.from({ length: Math.ceil(inputChannels.length / 16) }).map((_, i) => (
                    <button
                       key={i}
                       onClick={() => setChannelBank(i)}
                       className={`px-3 py-1 text-[10px] font-bold tracking-widest rounded-t-sm border-t border-x border-[#222] ${channelBank === i ? 'bg-[#2a2f3a] text-blue-400' : 'bg-[#1a1c22] text-gray-500 hover:text-gray-300'} transition-colors`}
                    >
                       CH {i * 16 + 1}-{Math.min((i + 1) * 16, inputChannels.length)}
                    </button>
                 ))}
               </div>

               {/* Scrollable Input Channels */}
               <div className="flex-1 overflow-x-auto overflow-y-hidden custom-scrollbar border-t-2 border-[#1a1c22]">
                 <div className="flex items-end h-full w-max gap-1 p-2 pt-1">
                   {inputChannels.slice(channelBank * 16, (channelBank + 1) * 16).map(id => (
                     <ChannelStrip key={id} id={id} />
                   ))}
                 </div>
               </div>
            </div>

            {/* Fixed Right Side: Aux Buses, Monitor, and Master, each its
                own section, evenly gapped via the same gap-3 as above */}
            <div className="shrink-0 flex items-end h-full gap-3 z-20 overflow-x-auto custom-scrollbar">

              {/* Aux Buses (fixed at 8) */}
              <div className="shrink-0 flex items-end h-full gap-1 p-2 bg-[#1e2733] rounded-sm">
                {auxBuses.map(id => (
                  <ChannelStrip key={id} id={id} />
                ))}
              </div>

              {/* Monitor + Master, grouped into one shared section (tight
                  gap-1 between them, not the gap-3 used between groups) —
                  the operator reads these two together anyway, and folding
                  them into a single section removes a redundant padding +
                  gap pair. That's the horizontal room a full 16-channel
                  input bank needs to fit without a scrollbar at 1080p. */}
              <div className="shrink-0 flex items-end h-full gap-1 p-2 bg-[#20222a] rounded-sm">
                {monitorBus && <ChannelStrip id={monitorBus.id} />}
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

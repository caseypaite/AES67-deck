import React, { useState } from 'react';
import { useMixerStore, PluginNode } from '../../stores/useMixerStore';
import { RotaryKnob } from './RotaryKnob';
import { CompressorGraph } from './CompressorGraph';
import { EqGraph } from './EqGraph';

const AVAILABLE_PLUGINS = [
  { name: 'Calf Equalizer 5 Band', uri: 'http://calf.sourceforge.net/plugins/Equalizer5Band', shortName: 'EQ5' },
  { name: 'Calf Compressor', uri: 'http://calf.sourceforge.net/plugins/Compressor', shortName: 'COMP' },
  { name: 'LSP Gate Stereo', uri: 'http://lsp-plug.in/plugins/lv2/sc_gate_stereo', shortName: 'GATE' },
  { name: 'Calf Reverb', uri: 'http://calf.sourceforge.net/plugins/Reverb', shortName: 'VERB' },
];

const PluginGUI = ({ channelId, plugin }: { channelId: number, plugin: PluginNode }) => {
  const setPluginParam = useMixerStore(state => state.setPluginParam);
  const handleParam = (key: string, val: number) => setPluginParam(channelId, plugin.id, key, val);

  if (plugin.uri.includes('Compressor')) {
    return (
      <div className="w-full h-full p-2">
        <CompressorGraph 
          threshold={plugin.params.threshold} 
          ratio={plugin.params.ratio} 
          makeup={plugin.params.makeup} 
          onChange={handleParam}
        />
      </div>
    );
  }

  if (plugin.uri.includes('Equalizer')) {
    const p = plugin.params;
    return (
      <div className="w-full h-full p-2">
        <EqGraph 
          bands={[p.low, p.lowMid, p.mid, p.highMid, p.high]} 
          onChange={(idx, val) => {
            const keys = ['low', 'lowMid', 'mid', 'highMid', 'high'];
            handleParam(keys[idx], val);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex gap-4 items-center justify-center h-full">
       <RotaryKnob label="MIX" value={plugin.params.mix} min={0} max={100} onChange={v => handleParam('mix', v)} unit="%" />
       <RotaryKnob label="LEVEL" value={plugin.params.level} min={-24} max={12} onChange={v => handleParam('level', v)} unit="dB" />
    </div>
  );
};

const PluginCard = ({ 
  plugin, index, channelId, draggedIdx, setDraggedIdx 
}: { 
  plugin: PluginNode, index: number, channelId: number, 
  draggedIdx: number | null, setDraggedIdx: (i: number | null) => void 
}) => {
  const removePlugin = useMixerStore(state => state.removePlugin);
  const reorderPlugin = useMixerStore(state => state.reorderPlugin);
  
  const [isDraggable, setIsDraggable] = useState(false);
  const isDragging = draggedIdx === index;

  return (
    <div 
      draggable={isDraggable}
      onDragStart={(e) => {
        setDraggedIdx(index);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (draggedIdx !== null && draggedIdx !== index) {
          reorderPlugin(channelId, draggedIdx, index);
        }
        setDraggedIdx(null);
      }}
      onDragEnd={() => setDraggedIdx(null)}
      className={`w-[360px] rounded-lg border shadow-xl shrink-0 flex flex-col h-full min-h-[260px] transition-all ${isDragging ? 'opacity-50 scale-95 border-purple-500' : 'bg-[#1a1c23] border-gray-700 hover:border-gray-500'}`}
    >
      <div 
        className="p-2 border-b border-gray-700 flex justify-between items-center bg-[#252830] rounded-t-lg cursor-grab active:cursor-grabbing"
        onMouseEnter={() => setIsDraggable(true)}
        onMouseLeave={() => setIsDraggable(false)}
      >
        <div className="flex items-center gap-2 pointer-events-none">
          <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_5px_#22c55e]" />
          <span className="text-[10px] font-bold text-gray-200 tracking-wider">
            SLOT {index + 1} - {AVAILABLE_PLUGINS.find(p => p.uri === plugin.uri)?.shortName || 'FX'}
          </span>
        </div>
        <button 
          onMouseEnter={(e) => e.stopPropagation()} // don't drag if hovering delete button
          onClick={() => removePlugin(channelId, plugin.id)}
          className="text-gray-500 hover:text-red-400 text-[10px] font-bold bg-[#1a1c23] px-2 py-0.5 rounded border border-gray-600 transition-colors cursor-pointer"
        >
          REMOVE
        </button>
      </div>
      <div className="p-3 flex-1 flex flex-col">
        <div className="text-xs font-bold text-white mb-2 truncate">{plugin.name}</div>
        <div className="flex-1 flex items-center justify-center rounded bg-[#0b0c10] shadow-inner overflow-hidden border border-[#222]">
           <PluginGUI channelId={channelId} plugin={plugin} />
        </div>
      </div>
    </div>
  );
};

export const TopPluginRack = () => {
  const selectedChannelId = useMixerStore(state => state.selectedChannelId);
  const channels = useMixerStore(state => state.channels);
  const addPlugin = useMixerStore(state => state.addPlugin);
  
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  if (selectedChannelId === null) return null;
  const channel = channels[selectedChannelId];

  return (
    <div className="flex w-full h-full p-2 gap-4">
      {/* Left info panel */}
      <div className="w-48 bg-[#0b0c10] border border-gray-800 rounded p-4 flex flex-col shadow-inner shrink-0">
        <div className="text-xs text-gray-500 font-bold tracking-wider mb-1">EFFECTS CHAIN</div>
        <div className="text-xl text-white font-bold mb-4">{channel.name}</div>
        
        <div className="text-[10px] text-gray-500 font-bold mb-2">ADD PLUGIN</div>
        <div className="flex flex-col gap-1 overflow-y-auto custom-scrollbar flex-1 pr-1">
          {AVAILABLE_PLUGINS.map(p => (
            <button 
              key={p.uri}
              onClick={() => addPlugin(channel.id, { name: p.name, uri: p.uri, enabled: true })}
              className="text-left px-2 py-1 bg-[#1a1c23] hover:bg-[#252830] border border-gray-700 rounded text-[10px] font-bold text-gray-300 transition-colors"
            >
              + {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* Horizontal Plugin Chain */}
      <div className="flex-1 flex gap-3 overflow-x-auto custom-scrollbar pb-2 items-start h-full">
        {channel.plugins.map((plugin, index) => (
          <PluginCard 
            key={plugin.id} 
            plugin={plugin} 
            index={index} 
            channelId={channel.id} 
            draggedIdx={draggedIdx} 
            setDraggedIdx={setDraggedIdx} 
          />
        ))}
        {channel.plugins.length === 0 && (
          <div className="w-full h-full flex flex-col items-center justify-center text-gray-700 border-2 border-dashed border-gray-800 rounded-lg">
            <span className="text-lg font-bold mb-2">EMPTY RACK</span>
            <span className="text-xs">Select a plugin from the left to insert it into the audio chain.</span>
          </div>
        )}
      </div>
    </div>
  );
};

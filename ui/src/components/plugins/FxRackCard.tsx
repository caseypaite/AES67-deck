import React, { useState } from 'react';
import {
  useMixerStore,
  PluginNode,
  PLUGIN_REGISTRY,
  PluginCategory,
} from '../../stores/useMixerStore';
import { PluginDetail } from './PluginDetail';
import { Screw } from '../analog/Screw';

// ─── helpers ────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<PluginCategory, string> = {
  Saturation : 'bg-orange-900/60  text-orange-300  border-orange-700',
  Dynamics   : 'bg-blue-900/60    text-blue-300    border-blue-700',
  'De-Esser' : 'bg-purple-900/60  text-purple-300  border-purple-700',
  Equalizer  : 'bg-teal-900/60    text-teal-300    border-teal-700',
  Delay      : 'bg-indigo-900/60  text-indigo-300  border-indigo-700',
  Reverb     : 'bg-cyan-900/60    text-cyan-300    border-cyan-700',
  Limiter    : 'bg-red-900/60     text-red-300     border-red-700',
};

const CAT_HEX: Record<PluginCategory, string> = {
  Saturation : '#f97316',
  Dynamics   : '#3b82f6',
  'De-Esser' : '#a855f7',
  Equalizer  : '#14b8a6',
  Delay      : '#6366f1',
  Reverb     : '#06b6d4',
  Limiter    : '#ef4444',
};

function categoryOf(uri: string): PluginCategory | null {
  return PLUGIN_REGISTRY.find(e => e.uri === uri)?.category ?? null;
}

function shortName(name: string): string {
  // Keep at most 3 words
  return name.split(' ').slice(0, 3).join(' ');
}

// ─── Add-Effect popover ──────────────────────────────────────────────────────

const CATEGORIES: PluginCategory[] = [
  'Saturation', 'Dynamics', 'De-Esser', 'Equalizer', 'Delay', 'Reverb', 'Limiter',
];

const AddEffectPopover = ({
  onAdd,
  onClose,
}: {
  onAdd: (uri: string, name: string) => void;
  onClose: () => void;
}) => {
  const [activeCategory, setActiveCategory] = useState<PluginCategory>('Dynamics');
  const options = PLUGIN_REGISTRY.filter(e => e.category === activeCategory);

  return (
    <div className="metal-face metal-grain absolute bottom-full left-0 mb-1 z-50 w-[260px] border border-black/70 rounded shadow-2xl overflow-hidden">
      {/* Category tabs */}
      <div className="flex flex-wrap gap-0.5 p-1.5 border-b-2 border-black/50 metal-face-rack">
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-2 py-0.5 text-[9px] font-bold tracking-wide rounded border transition-colors ${
              activeCategory === cat
                ? CATEGORY_COLORS[cat]
                : 'bg-transparent text-gray-500 border-transparent hover:text-gray-300'
            }`}
          >
            {cat.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Plugin list */}
      <div className="flex flex-col max-h-[200px] overflow-y-auto custom-scrollbar metal-well">
        {options.map(opt => (
          <button
            key={opt.uri}
            onClick={() => { onAdd(opt.uri, opt.name); onClose(); }}
            className="text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/5 hover:text-white border-b border-black/40 transition-colors last:border-0"
          >
            {opt.name}
          </button>
        ))}
      </div>

      {/* Dismiss */}
      <div className="p-1.5 border-t-2 border-black/50 metal-face-rack flex justify-end">
        <button
          onClick={onClose}
          className="text-[9px] text-gray-500 hover:text-gray-300 font-bold tracking-widest px-2 py-0.5"
        >
          CANCEL
        </button>
      </div>
    </div>
  );
};

// ─── Single slot row ─────────────────────────────────────────────────────────

const PluginSlot = ({
  plugin,
  index,
  channelId,
  isSelected,
  draggedIdx,
  onSelect,
  onDragStart,
  onDrop,
  onDragEnd,
}: {
  plugin: PluginNode;
  index: number;
  channelId: number;
  isSelected: boolean;
  draggedIdx: number | null;
  onSelect: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) => {
  const removePlugin     = useMixerStore(s => s.removePlugin);
  const setPluginEnabled = useMixerStore(s => s.setPluginEnabled);
  const cat              = categoryOf(plugin.uri);
  const colorCls         = cat ? CATEGORY_COLORS[cat] : 'bg-gray-800 text-gray-400 border-gray-600';
  const accent           = cat ? CAT_HEX[cat] : '#64748b';
  const isDragging       = draggedIdx === index;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={e => e.preventDefault()}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      className={`metal-btn relative flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-[3px] cursor-pointer select-none group overflow-hidden ${
        isDragging ? 'opacity-40' : ''
      } ${!plugin.enabled ? 'saturate-50' : ''}`}
      style={
        isSelected
          ? { boxShadow: `0 0 0 1px ${accent}, 0 0 12px ${accent}55, inset 0 1px 0 rgba(255,255,255,0.22)` }
          : undefined
      }
    >
      {/* category accent stripe */}
      <span
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ background: accent, boxShadow: `0 0 6px ${accent}` }}
      />

      {/* Drag handle */}
      <div className="flex flex-col gap-[3px] opacity-30 group-hover:opacity-70 cursor-grab active:cursor-grabbing shrink-0">
        {[0, 1, 2].map(i => (
          <div key={i} className="w-3 h-[2px] bg-gray-300 rounded shadow-[0_1px_0_rgba(0,0,0,0.6)]" />
        ))}
      </div>

      {/* Category badge */}
      <div className={`text-[8px] font-black tracking-widest px-1 py-0.5 rounded border shrink-0 ${colorCls}`}>
        {cat ? cat.slice(0, 3).toUpperCase() : 'FX'}
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        <div className={`text-[10px] font-bold truncate [text-shadow:0_-1px_1px_rgba(0,0,0,0.7)] ${plugin.enabled ? 'text-gray-100' : 'text-gray-500 line-through'}`}>
          {shortName(plugin.name)}
        </div>
      </div>

      {/* Bypass toggle */}
      <button
        onClick={e => { e.stopPropagation(); setPluginEnabled(channelId, plugin.id, !plugin.enabled); }}
        title={plugin.enabled ? 'Bypass this effect' : 'Effect bypassed — click to enable'}
        className={`metal-btn shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-[3px] text-[8px] font-black tracking-widest ${
          plugin.enabled
            ? 'text-gray-400'
            : 'text-red-200 shadow-[0_0_7px_rgba(239,68,68,0.55),inset_0_0_0_1px_rgba(239,68,68,0.7)]'
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            plugin.enabled ? 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.8)]' : 'bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.9)]'
          }`}
        />
        {plugin.enabled ? 'ON' : 'BYP'}
      </button>

      {/* Remove */}
      <button
        onClick={e => { e.stopPropagation(); removePlugin(channelId, plugin.id); }}
        className="text-gray-500 hover:text-red-400 text-[10px] font-bold shrink-0 transition-colors leading-none"
        title="Remove"
      >
        ✕
      </button>
    </div>
  );
};

// ─── Main FxRackCard ─────────────────────────────────────────────────────────

export const FxRackCard = () => {
  const selectedChannelId = useMixerStore(s => s.selectedChannelId);
  const channels          = useMixerStore(s => s.channels);
  const addPlugin         = useMixerStore(s => s.addPlugin);
  const reorderPlugin     = useMixerStore(s => s.reorderPlugin);
  const rackPresets       = useMixerStore(s => s.rackPresets);
  const saveRackPreset    = useMixerStore(s => s.saveRackPreset);
  const loadRackPreset    = useMixerStore(s => s.loadRackPreset);
  const deleteRackPreset  = useMixerStore(s => s.deleteRackPreset);
  const listRackPresets   = useMixerStore(s => s.listRackPresets);

  const [showAdd,      setShowAdd]      = useState(false);
  const [showPresets,  setShowPresets]  = useState(false);
  const [draggedIdx,   setDraggedIdx]   = useState<number | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null); // plugin.id

  // Request preset list whenever the popover opens
  const handleOpenPresets = () => {
    listRackPresets();
    setShowPresets(true);
  };

  if (selectedChannelId === null) return null;

  const channel = channels[selectedChannelId];
  if (!channel) return null;

  const plugins = channel.plugins;
  const selectedPlugin = selectedSlot ? plugins.find(p => p.id === selectedSlot) ?? null : null;

  const handleSave = () => {
    const name = prompt('Save FX preset as:');
    if (!name?.trim()) return;
    saveRackPreset(selectedChannelId, name.trim());
    // Re-list after save so the popover stays fresh
    setTimeout(() => listRackPresets(), 300);
  };

  return (
    <div className="flex h-full w-full">
      {/* ── Rack Card (square / fixed width = full panel height) ── */}
      <div className="metal-face-rack metal-grain relative flex flex-col border-r-2 border-black/70 shrink-0"
           style={{ width: 'var(--rack-width, 200px)' }}>

        {/* Nameplate header */}
        <div className="metal-face relative flex items-center gap-1.5 px-2 py-2 border-b-2 border-black/60 shrink-0">
          <Screw seed={0} />
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.9)]" />
          <span className="text-[9px] font-black tracking-[0.22em] text-engrave">FX RACK</span>
          <span className="ml-auto text-[8px] font-bold text-gray-500 truncate max-w-[62px] text-engrave">{channel.name}</span>
          <Screw seed={3} />
        </div>

        {/* Preset toolbar */}
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b-2 border-black/50 shrink-0">
          <button
            onClick={handleSave}
            className="metal-btn flex-1 text-[8px] font-black tracking-widest text-emerald-300 rounded-[3px] px-1 py-1"
          >
            SAVE
          </button>
          <div className="relative flex-1">
            <button
              onClick={handleOpenPresets}
              className="metal-btn w-full text-[8px] font-black tracking-widest text-amber-300 rounded-[3px] px-1 py-1"
            >
              LOAD
            </button>
            {showPresets && (
              <div className="metal-face metal-grain absolute top-full left-0 mt-1 z-50 w-[200px] border border-black/70 rounded shadow-2xl overflow-hidden">
                <div className="text-[8px] font-black tracking-widest text-engrave px-2 py-1.5 border-b-2 border-black/50">
                  RACK PRESETS
                </div>
                <div className="flex flex-col max-h-[180px] overflow-y-auto custom-scrollbar metal-well">
                  {rackPresets.length === 0 ? (
                    <div className="text-[9px] text-gray-600 px-3 py-3 text-center">No saved presets.</div>
                  ) : (
                    rackPresets.map(name => (
                      <div key={name} className="flex items-center border-b border-black/40 last:border-0">
                        <button
                          onClick={() => { loadRackPreset(name); setShowPresets(false); }}
                          className="flex-1 text-left px-3 py-1.5 text-[10px] text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                        >
                          {name}
                        </button>
                        <button
                          onClick={() => deleteRackPreset(name)}
                          className="px-2 py-1.5 text-[9px] text-gray-600 hover:text-red-400 transition-colors"
                          title="Delete preset"
                        >
                          ✕
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <div className="p-1.5 border-t-2 border-black/50 metal-face-rack flex justify-end">
                  <button
                    onClick={() => setShowPresets(false)}
                    className="text-[8px] text-gray-500 hover:text-gray-300 font-bold tracking-widest px-2"
                  >
                    CLOSE
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Plugin slots */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-1.5 flex flex-col gap-1.5 metal-well">
          {plugins.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-600 text-[9px] font-black tracking-widest text-center gap-1 border border-dashed border-white/10 rounded m-1">
              <div>EMPTY RACK</div>
              <div className="text-[8px] font-normal text-gray-700">Insert an effect below</div>
            </div>
          )}
          {plugins.map((plugin, idx) => (
            <PluginSlot
              key={plugin.id}
              plugin={plugin}
              index={idx}
              channelId={selectedChannelId}
              isSelected={selectedSlot === plugin.id}
              draggedIdx={draggedIdx}
              onSelect={() => setSelectedSlot(prev => prev === plugin.id ? null : plugin.id)}
              onDragStart={() => setDraggedIdx(idx)}
              onDrop={() => {
                if (draggedIdx !== null && draggedIdx !== idx) {
                  reorderPlugin(selectedChannelId, draggedIdx, idx);
                }
                setDraggedIdx(null);
              }}
              onDragEnd={() => setDraggedIdx(null)}
            />
          ))}
        </div>

        {/* Add effect button */}
        <div className="metal-face relative px-2 py-2 border-t-2 border-black/60 shrink-0">
          <button
            onClick={() => setShowAdd(v => !v)}
            className="metal-btn w-full text-[9px] font-black tracking-widest text-sky-300 rounded-[3px] py-1.5 flex items-center justify-center gap-1"
          >
            <span className="text-sm leading-none">+</span>
            INSERT EFFECT
          </button>
          {showAdd && (
            <AddEffectPopover
              onAdd={(uri, name) => addPlugin(selectedChannelId, { name, uri, enabled: true })}
              onClose={() => setShowAdd(false)}
            />
          )}
        </div>
      </div>

      {/* ── Detail panel (right of rack) ── */}
      {selectedPlugin ? (
        <PluginDetail plugin={selectedPlugin} channelId={selectedChannelId} />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-600 text-[10px] font-black tracking-[0.2em] text-center gap-1 metal-well">
          <div>SELECT AN EFFECT</div>
          <div className="text-[8px] font-normal tracking-normal text-gray-700">Click a slot to inspect its parameters.</div>
        </div>
      )}
    </div>
  );
};

import React, { useEffect } from 'react';
import { useMixerStore, PluginNode, PLUGIN_REGISTRY, PluginCategory } from '../../stores/useMixerStore';
import { getCalfSpec, ParamSpec } from '../../data/calfPlugins';
import { AnalogKnob } from '../analog/AnalogKnob';

const MIN_DB = -60;
const MAX_DB = 6;
const GRAD =
  'linear-gradient(to top, #00cc99 0%, #00cc99 63%, #eab308 63%, #eab308 82%, #f97316 82%, #f97316 91%, #ef4444 91%, #ef4444 100%)';

const pct = (db: number) => ((Math.max(MIN_DB, Math.min(MAX_DB, db)) - MIN_DB) / (MAX_DB - MIN_DB)) * 100;

// Stereo vertical meter bar with dB scale and clip indicators
const RackSignalMeter = ({
  label,
  l,
  r,
}: {
  label: string;
  l: number;
  r: number;
}) => {
  const peakMax = Math.max(l, r);
  const isClipped = peakMax >= 0;
  const dbText = peakMax <= -59 ? '-∞' : `${peakMax.toFixed(1)} dB`;

  return (
    <div className="flex flex-col items-center gap-1.5 h-full w-[44px] shrink-0 py-2 px-1 bg-[#0c0d11] border-r border-[#1a1c22] last:border-r-0 last:border-l select-none">
      <div className="text-[8px] font-black tracking-widest text-gray-400 uppercase text-center">
        {label}
      </div>

      {/* Clip LED */}
      <div className={`w-2.5 h-1.5 rounded-[1px] transition-colors ${isClipped ? 'bg-red-500 shadow-[0_0_6px_#ef4444]' : 'bg-red-950/40 border border-red-900/50'}`} />

      {/* Meter Bars Container */}
      <div className="flex gap-[3px] w-full flex-1 min-h-0 border border-[#1e2028] rounded-[2px] p-[2px] bg-[#050507] shadow-inner relative">
        {/* Left Bar */}
        <div className="relative flex-1 h-full bg-[#08080a] rounded-[1px] overflow-hidden">
          <div className="absolute inset-0" style={{ background: GRAD, opacity: 0.95 }} />
          <div
            className="absolute top-0 left-0 right-0 bg-[#08080a] transition-[height] duration-[120ms] ease-out"
            style={{ height: `${100 - pct(l)}%` }}
          />
        </div>
        {/* Right Bar */}
        <div className="relative flex-1 h-full bg-[#08080a] rounded-[1px] overflow-hidden">
          <div className="absolute inset-0" style={{ background: GRAD, opacity: 0.95 }} />
          <div
            className="absolute top-0 left-0 right-0 bg-[#08080a] transition-[height] duration-[120ms] ease-out"
            style={{ height: `${100 - pct(r)}%` }}
          />
        </div>
      </div>

      {/* Live dB Readout */}
      <div className="text-[8px] font-mono font-bold text-gray-300 text-center leading-none mt-0.5">
        {dbText}
      </div>
    </div>
  );
};

const CATEGORY_COLORS: Record<PluginCategory, string> = {
  Saturation: 'bg-orange-900/60 text-orange-300 border-orange-700',
  Dynamics:   'bg-blue-900/60 text-blue-300 border-blue-700',
  'De-Esser': 'bg-purple-900/60 text-purple-300 border-purple-700',
  Equalizer:  'bg-teal-900/60 text-teal-300 border-teal-700',
  Delay:      'bg-indigo-900/60 text-indigo-300 border-indigo-700',
  Reverb:     'bg-cyan-900/60 text-cyan-300 border-cyan-700',
  Limiter:    'bg-red-900/60 text-red-300 border-red-700',
};

const ACCENT: Record<PluginCategory, string> = {
  Saturation: '#f97316',
  Dynamics:   '#3b82f6',
  'De-Esser': '#a855f7',
  Equalizer:  '#14b8a6',
  Delay:      '#6366f1',
  Reverb:     '#06b6d4',
  Limiter:    '#ef4444',
};

function categoryOf(uri: string): PluginCategory {
  return PLUGIN_REGISTRY.find(e => e.uri === uri)?.category ?? 'Dynamics';
}

// Selects up to 6 primary parameters (2 rows of 3 knobs) for compact chain display
function getPrimaryParams(plugin: PluginNode): ParamSpec[] {
  const spec = getCalfSpec(plugin.uri);
  if (!spec) return [];

  // Tailored key parameters for top Calf plugins
  if (plugin.uri.includes('Compressor')) {
    const symbols = ['threshold', 'ratio', 'makeup', 'attack', 'release', 'knee'];
    return symbols.map(s => spec.params.find(p => p.symbol === s)).filter((p): p is ParamSpec => p !== undefined);
  }
  if (plugin.uri.includes('Equalizer8Band')) {
    const symbols = ['ls_level', 'p1_level', 'p2_level', 'p3_level', 'p4_level', 'hs_level'];
    const found = symbols.map(s => spec.params.find(p => p.symbol === s)).filter((p): p is ParamSpec => p !== undefined);
    if (found.length > 0) return found;
  }
  if (plugin.uri.includes('Equalizer5Band')) {
    const symbols = ['ls_level', 'p1_level', 'p2_level', 'p3_level', 'hs_level', 'level_out'];
    const found = symbols.map(s => spec.params.find(p => p.symbol === s)).filter((p): p is ParamSpec => p !== undefined);
    if (found.length > 0) return found;
  }
  if (plugin.uri.includes('Saturator')) {
    const symbols = ['drive', 'blend', 'mix', 'p_freq', 'p_level', 'p_q'];
    return symbols.map(s => spec.params.find(p => p.symbol === s)).filter((p): p is ParamSpec => p !== undefined);
  }
  if (plugin.uri.includes('Limiter')) {
    const symbols = ['limit', 'attack', 'release', 'asc_coeff', 'oversampling', 'level_out'];
    return symbols.map(s => spec.params.find(p => p.symbol === s)).filter((p): p is ParamSpec => p !== undefined);
  }
  if (plugin.uri.includes('Deesser')) {
    const symbols = ['threshold', 'ratio', 'f2_freq', 'f2_level', 'laxity', 'makeup'];
    return symbols.map(s => spec.params.find(p => p.symbol === s)).filter((p): p is ParamSpec => p !== undefined);
  }
  if (plugin.uri.includes('VintageDelay')) {
    const symbols = ['time_l', 'time_r', 'feedback', 'bpm', 'amount', 'width'];
    return symbols.map(s => spec.params.find(p => p.symbol === s)).filter((p): p is ParamSpec => p !== undefined);
  }
  if (plugin.uri.includes('Reverb')) {
    const symbols = ['decay_time', 'predelay', 'amount', 'hf_damp', 'bass_cut', 'treble_cut'];
    return symbols.map(s => spec.params.find(p => p.symbol === s)).filter((p): p is ParamSpec => p !== undefined);
  }
  if (plugin.uri.includes('Crusher')) {
    const symbols = ['bits', 'samples', 'morph', 'dc', 'anti_aliasing', 'lforange'];
    return symbols.map(s => spec.params.find(p => p.symbol === s)).filter((p): p is ParamSpec => p !== undefined);
  }

  // Fallback: first 6 knob parameters (excluding level_in)
  return spec.params
    .filter(p => p.kind === 'knob' && p.symbol !== 'level_in')
    .slice(0, 6);
}

// Single effect summary card with interactive primary knobs (3 per row)
const ChainPluginCard = ({
  plugin,
  index,
  channelId,
  onSelectSlot,
}: {
  plugin: PluginNode;
  index: number;
  channelId: number;
  onSelectSlot: () => void;
}) => {
  const setPluginParam = useMixerStore(s => s.setPluginParam);
  const setPluginEnabled = useMixerStore(s => s.setPluginEnabled);
  const removePlugin = useMixerStore(s => s.removePlugin);

  const cat = categoryOf(plugin.uri);
  const accent = ACCENT[cat] || '#3b82f6';
  const catColor = CATEGORY_COLORS[cat] || 'bg-gray-800 text-gray-300 border-gray-700';
  const primaryParams = getPrimaryParams(plugin);

  return (
    <div className={`flex flex-col bg-[#14161d] border border-[#232733] rounded-[4px] shadow-md overflow-hidden w-[290px] min-w-[290px] shrink-0 ${!plugin.enabled ? 'opacity-65 saturate-50' : ''}`}>
      {/* Card Header */}
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-[#1b1e28] border-b border-[#2a2e3d]">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[9px] font-mono font-bold text-gray-400 bg-black/40 px-1 py-0.5 rounded">
            #{index + 1}
          </span>
          <span className="text-[11px] font-bold text-white truncate" title={plugin.name}>
            {plugin.name}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-1">
          {/* Category Tag */}
          <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-[2px] border ${catColor}`}>
            {cat}
          </span>

          {/* Active / Bypass Toggle */}
          <button
            onClick={() => setPluginEnabled(channelId, plugin.id, !plugin.enabled)}
            className={`text-[8px] font-black tracking-wider px-1.5 py-0.5 rounded-[2px] transition-colors border ${
              plugin.enabled
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30'
                : 'bg-amber-950/40 text-amber-400 border-amber-800 hover:bg-amber-900/40'
            }`}
            title={plugin.enabled ? 'Click to bypass effect' : 'Click to enable effect'}
          >
            {plugin.enabled ? 'ACTIVE' : 'BYPASS'}
          </button>

          {/* Remove */}
          <button
            onClick={() => removePlugin(channelId, plugin.id)}
            className="text-gray-500 hover:text-red-400 text-[10px] px-1 font-bold transition-colors"
            title="Remove effect from chain"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Main Parameters: 3 Knobs per row, bigger size (54px) */}
      <div className="flex-1 p-2.5 grid grid-cols-3 gap-x-2 gap-y-2.5 bg-[#0e1017] items-center justify-items-center overflow-y-auto custom-scrollbar">
        {primaryParams.length === 0 ? (
          <div className="col-span-3 text-[9px] text-gray-500 italic py-4 text-center w-full">
            No primary parameters exposed.
          </div>
        ) : (
          primaryParams.map(param => {
            const val = typeof plugin.params[param.symbol] === 'number'
              ? plugin.params[param.symbol]
              : param.default;

            return (
              <div key={param.symbol} className="flex flex-col items-center">
                <AnalogKnob
                  spec={param}
                  value={val}
                  accent={accent}
                  size={54}
                  onChange={(newVal) => setPluginParam(channelId, plugin.id, param.symbol, newVal)}
                />
              </div>
            );
          })
        )}
      </div>

      {/* Card Footer: Detail view button */}
      <button
        onClick={onSelectSlot}
        className="w-full py-1 bg-[#181a24] hover:bg-[#202330] text-[8px] font-black tracking-widest text-sky-400 border-t border-[#232733] transition-colors uppercase flex items-center justify-center gap-1 shrink-0"
      >
        <span>OPEN FULL EDITOR</span>
        <span className="text-[10px]">▶</span>
      </button>
    </div>
  );
};

export const FxChainOverview = ({
  channelId,
  onSelectSlot,
}: {
  channelId: number;
  onSelectSlot: (pluginId: string) => void;
}) => {
  const channels = useMixerStore(s => s.channels);
  const fxMeter = useMixerStore(s => s.fxMeter);
  const setFxFocus = useMixerStore(s => s.setFxFocus);
  const addPlugin = useMixerStore(s => s.addPlugin);

  // Focus engine on the whole rack (-1) for this channel
  useEffect(() => {
    setFxFocus(channelId, -1);
  }, [channelId, setFxFocus]);

  const channel = channels[channelId];
  if (!channel) return null;

  const plugins = channel.plugins;

  // Signal meters: read fxMeter from engine, falling back to channel meter if empty/dry
  const inL = (fxMeter && fxMeter.channel === channelId) ? fxMeter.inL : channel.meterL;
  const inR = (fxMeter && fxMeter.channel === channelId) ? fxMeter.inR : channel.meterR;
  const outL = (fxMeter && fxMeter.channel === channelId) ? fxMeter.outL : channel.meterL;
  const outR = (fxMeter && fxMeter.channel === channelId) ? fxMeter.outR : channel.meterR;

  const quickAdd = (uri: string, name: string) => {
    addPlugin(channelId, { name, uri, enabled: true });
  };

  return (
    <div className="flex h-full w-full bg-[#0e1017] metal-grain select-none overflow-hidden">
      {/* ── Left: Rack Input Signal Meter ── */}
      <RackSignalMeter label="IN" l={inL} r={inR} />

      {/* ── Center: FX Chain Overview Content ── */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Header Bar */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#14161f] border-b border-[#232733] shrink-0 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black tracking-widest text-engrave uppercase">
              {channel.name}
            </span>
            <span className="text-[9px] font-mono text-gray-500">
              · FX INSERT CHAIN
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[9px] font-mono bg-black/40 text-sky-400 px-2 py-0.5 rounded border border-white/5 font-bold">
              {plugins.length} {plugins.length === 1 ? 'INSERT' : 'INSERTS'} LOADED
            </span>
          </div>
        </div>

        {/* Scrollable Plugins Chain Cards */}
        <div className="flex-1 overflow-x-auto overflow-y-hidden custom-scrollbar p-3 flex gap-3 items-stretch min-h-0 bg-[#090a0f]">
          {plugins.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-4 m-auto text-center border border-dashed border-white/10 rounded-md max-w-[520px]">
              <div className="text-[11px] font-black tracking-widest text-gray-400 mb-1">
                INSERT CHAIN EMPTY
              </div>
              <div className="text-[9px] text-gray-500 mb-3">
                No effects are processing {channel.name}. Insert an effect from the rack or pick a quick processor below:
              </div>

              <div className="flex flex-wrap justify-center gap-1.5 max-w-[420px]">
                <button
                  onClick={() => quickAdd('http://calf.sourceforge.net/plugins/Compressor', 'Calf Compressor')}
                  className="px-2.5 py-1 rounded bg-[#181b24] hover:bg-blue-600/30 text-blue-300 border border-blue-500/40 text-[9px] font-bold transition-colors"
                >
                  + Compressor
                </button>
                <button
                  onClick={() => quickAdd('http://calf.sourceforge.net/plugins/Equalizer8Band', 'Calf 8-Band EQ')}
                  className="px-2.5 py-1 rounded bg-[#181b24] hover:bg-teal-600/30 text-teal-300 border border-teal-500/40 text-[9px] font-bold transition-colors"
                >
                  + 8-Band EQ
                </button>
                <button
                  onClick={() => quickAdd('http://calf.sourceforge.net/plugins/Saturator', 'Calf Saturator')}
                  className="px-2.5 py-1 rounded bg-[#181b24] hover:bg-orange-600/30 text-orange-300 border border-orange-500/40 text-[9px] font-bold transition-colors"
                >
                  + Saturator
                </button>
                <button
                  onClick={() => quickAdd('http://calf.sourceforge.net/plugins/VintageDelay', 'Vintage Delay')}
                  className="px-2.5 py-1 rounded bg-[#181b24] hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 text-[9px] font-bold transition-colors"
                >
                  + Delay
                </button>
                <button
                  onClick={() => quickAdd('http://calf.sourceforge.net/plugins/Reverb', 'Studio Reverb')}
                  className="px-2.5 py-1 rounded bg-[#181b24] hover:bg-cyan-600/30 text-cyan-300 border border-cyan-500/40 text-[9px] font-bold transition-colors"
                >
                  + Reverb
                </button>
                <button
                  onClick={() => quickAdd('http://calf.sourceforge.net/plugins/Limiter', 'Calf Limiter')}
                  className="px-2.5 py-1 rounded bg-[#181b24] hover:bg-red-600/30 text-red-300 border border-red-500/40 text-[9px] font-bold transition-colors"
                >
                  + Limiter
                </button>
              </div>
            </div>
          ) : (
            plugins.map((plugin, idx) => (
              <ChainPluginCard
                key={plugin.id}
                plugin={plugin}
                index={idx}
                channelId={channelId}
                onSelectSlot={() => onSelectSlot(plugin.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* ── Right: Rack Output Signal Meter ── */}
      <RackSignalMeter label="OUT" l={outL} r={outR} />
    </div>
  );
};

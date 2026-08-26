import React, { useEffect, useMemo, useState } from 'react';
import { useMixerStore, PluginNode, PLUGIN_REGISTRY, PluginCategory } from '../../stores/useMixerStore';
import { getCalfSpec, ParamSpec } from '../../data/calfPlugins';
import { AnalogKnob } from '../analog/AnalogKnob';
import { ToggleControl, SegmentedControl } from '../analog/Switch';
import { MeterRail } from './fx/MeterRail';
import { FxEditorProps } from './fx/fxShared';
import { CompressorEditor } from './fx/editors/CompressorEditor';
import { SaturatorEditor } from './fx/editors/SaturatorEditor';
import { CrusherEditor } from './fx/editors/CrusherEditor';
import { LimiterEditor } from './fx/editors/LimiterEditor';
import { DeEsserEditor } from './fx/editors/DeEsserEditor';
import { EqEditor } from './fx/editors/EqEditor';
import { DelayEditor } from './fx/editors/DelayEditor';
import { ReverbEditor } from './fx/editors/ReverbEditor';

// Hand-built editors per Calf plugin (docs/fx-ui-design.md), all following
// the Calf Compressor reference layout via FxEditorShell.
const CALF_EDITORS: Record<string, React.FC<FxEditorProps>> = {
  'http://calf.sourceforge.net/plugins/Compressor': CompressorEditor,
  'http://calf.sourceforge.net/plugins/Saturator': SaturatorEditor,
  'http://calf.sourceforge.net/plugins/Crusher': CrusherEditor,
  'http://calf.sourceforge.net/plugins/Limiter': LimiterEditor,
  'http://calf.sourceforge.net/plugins/Deesser': DeEsserEditor,
  'http://calf.sourceforge.net/plugins/Equalizer8Band': EqEditor,
  'http://calf.sourceforge.net/plugins/Equalizer5Band': EqEditor,
  'http://calf.sourceforge.net/plugins/VintageDelay': DelayEditor,
  'http://calf.sourceforge.net/plugins/Reverb': ReverbEditor,
};

// Editors that take the full body width — the in/out meter rails are hidden
// and these carry their own metering.
const FULL_WIDTH_EDITOR_URIS = new Set([
  'http://calf.sourceforge.net/plugins/Equalizer8Band',
  'http://calf.sourceforge.net/plugins/Equalizer5Band',
]);

// The FX editor: three columns (input rail · body · output rail) per
// docs/fx-ui-design.md §2. The body is metadata-driven from
// data/calfPlugins.ts so every Calf plugin maps to its real LV2 ports.
// Category-specific graph editors (EQ curve, dynamics transfer graph) are
// the next step — this is the analog knob panel they build on.

const ACCENT: Record<PluginCategory, string> = {
  Saturation: '#f97316',
  Dynamics: '#3b82f6',
  'De-Esser': '#a855f7',
  Equalizer: '#14b8a6',
  Delay: '#6366f1',
  Reverb: '#06b6d4',
  Limiter: '#ef4444',
};

function categoryOf(uri: string): PluginCategory | null {
  return PLUGIN_REGISTRY.find(e => e.uri === uri)?.category ?? null;
}

const ParamControl = ({
  spec,
  value,
  accent,
  onChange,
}: {
  spec: ParamSpec;
  value: number;
  accent: string;
  onChange: (v: number) => void;
}) => {
  if (spec.kind === 'toggle') return <ToggleControl spec={spec} value={value} accent={accent} onChange={onChange} />;
  if (spec.kind === 'enum') return <SegmentedControl spec={spec} value={value} accent={accent} onChange={onChange} />;
  return <AnalogKnob spec={spec} value={value} accent={accent} onChange={onChange} />;
};

// ─── Calf: metadata-driven panel ────────────────────────────────────────────

const CalfBody = ({
  plugin,
  channelId,
  accent,
}: {
  plugin: PluginNode;
  channelId: number;
  accent: string;
}) => {
  const spec = getCalfSpec(plugin.uri)!;
  const setPluginParam = useMixerStore(s => s.setPluginParam);
  const [band, setBand] = useState(spec.bandSelector?.bands[0] ?? '');

  const val = (p: ParamSpec) => (typeof plugin.params[p.symbol] === 'number' ? plugin.params[p.symbol] : p.default);
  const set = (p: ParamSpec, v: number) => setPluginParam(channelId, plugin.id, p.symbol, v);

  const visibleGroups = spec.bandSelector
    ? [band, ...spec.bandSelector.alwaysShow]
    : spec.groups;

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      {spec.bandSelector && (
        <div className="flex gap-1 px-2 py-1.5 border-b border-gray-800 bg-[#0e0f12] shrink-0 overflow-x-auto custom-scrollbar">
          {spec.bandSelector.bands.map(b => {
            const active = b === band;
            // dim the tab when every band-param is at default / the band is off
            return (
              <button
                key={b}
                onClick={() => setBand(b)}
                className="px-2 py-1 text-[9px] font-black tracking-widest uppercase rounded-sm border transition-colors shrink-0"
                style={{
                  background: active ? accent : '#16171b',
                  color: active ? '#0b0c10' : '#8b8f98',
                  borderColor: active ? accent : '#2a2c31',
                }}
              >
                {b}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto custom-scrollbar p-2 flex flex-col gap-2">
        {visibleGroups.map(group => {
          const items = spec.params.filter(p => p.group === group);
          if (!items.length) return null;
          return (
            <div key={group}>
              <div className="text-[8px] font-black tracking-[0.2em] text-gray-600 uppercase mb-1.5 border-b border-gray-800/60 pb-0.5">
                {group}
              </div>
              <div className="flex flex-wrap gap-x-2 gap-y-3">
                {items.map(p => (
                  <ParamControl key={p.symbol} spec={p} value={val(p)} accent={accent} onChange={v => set(p, v)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Fallback: live LV2 port data, else raw params ──────────────────────────

const GenericBody = ({
  plugin,
  channelId,
  accent,
}: {
  plugin: PluginNode;
  channelId: number;
  accent: string;
}) => {
  const setPluginParam = useMixerStore(s => s.setPluginParam);
  const availablePlugins = useMixerStore(s => s.availablePlugins);

  const specs: ParamSpec[] = useMemo(() => {
    const info = availablePlugins.find(p => p.uri === plugin.uri);
    if (info?.controlPorts.length) {
      return info.controlPorts.map(cp => ({
        symbol: cp.symbol,
        label: cp.name || cp.symbol,
        group: 'Parameters',
        kind: 'knob' as const,
        min: cp.min,
        max: cp.max,
        default: cp.default,
        taper: 'linear' as const,
        unit: '' as const,
      }));
    }
    return Object.keys(plugin.params).map(k => ({
      symbol: k,
      label: k,
      group: 'Parameters',
      kind: 'knob' as const,
      min: 0,
      max: Math.max(1, (plugin.params[k] || 0) * 2),
      default: plugin.params[k] ?? 0,
      taper: 'linear' as const,
      unit: '' as const,
    }));
  }, [availablePlugins, plugin.uri, plugin.params]);

  if (!specs.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-700 text-[10px] font-bold tracking-widest text-center gap-1 px-4">
        <div>NO PARAMETER DATA</div>
        <div className="text-[8px] font-normal text-gray-800">Curated map pending for this plugin; engine scan has no ports for it.</div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 overflow-y-auto custom-scrollbar p-2">
      <div className="flex flex-wrap gap-x-2 gap-y-3">
        {specs.map(p => (
          <AnalogKnob
            key={p.symbol}
            spec={p}
            accent={accent}
            value={typeof plugin.params[p.symbol] === 'number' ? plugin.params[p.symbol] : p.default}
            onChange={v => setPluginParam(channelId, plugin.id, p.symbol, v)}
          />
        ))}
      </div>
    </div>
  );
};

// ─── Shell ─────────────────────────────────────────────────────────────────

export const PluginDetail = ({
  plugin,
  channelId,
}: {
  plugin: PluginNode;
  channelId: number;
}) => {
  const setPluginEnabled = useMixerStore(s => s.setPluginEnabled);
  const setFxFocus = useMixerStore(s => s.setFxFocus);
  const channel = useMixerStore(s => s.channels[channelId]);
  const fxMeter = useMixerStore(s => s.fxMeter);
  const cat = categoryOf(plugin.uri);
  const accent = cat ? ACCENT[cat] : '#64748b';
  const isCalf = !!getCalfSpec(plugin.uri);
  const Editor = CALF_EDITORS[plugin.uri];
  const fullWidth = FULL_WIDTH_EDITOR_URIS.has(plugin.uri);

  const pluginIndex = channel?.plugins.findIndex(p => p.id === plugin.id) ?? -1;

  // Tell the engine which slot to meter; clear on unmount / slot change.
  useEffect(() => {
    if (pluginIndex < 0) return;
    setFxFocus(channelId, pluginIndex);
    return () => setFxFocus(null, null);
  }, [channelId, pluginIndex, setFxFocus]);

  const live = fxMeter && fxMeter.channel === channelId && fxMeter.pluginIndex === pluginIndex ? fxMeter : null;
  const chL = channel?.meterL ?? -100;
  const chR = channel?.meterR ?? -100;
  const inL = live ? live.inL : chL;
  const inR = live ? live.inR : chR;
  const outL = live ? live.outL : chL;
  const outR = live ? live.outR : chR;

  return (
    <div className="flex-1 h-full flex flex-col bg-[#0b0c10] border-l-2 border-black/70 overflow-hidden">
      {/* Header */}
      <div className="metal-face metal-grain relative flex items-center gap-2 px-3 py-2 border-b-2 border-black/60 shrink-0">
        <div
          className="text-[9px] font-black tracking-widest px-1.5 py-0.5 rounded shadow-[0_1px_2px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.35)]"
          style={{ background: accent, color: '#0b0c10' }}
        >
          {cat?.toUpperCase() ?? 'FX'}
        </div>
        <div className="text-xs font-bold text-gray-100 truncate [text-shadow:0_-1px_1px_rgba(0,0,0,0.75)]">{plugin.name}</div>

        <button
          onClick={() => setPluginEnabled(channelId, plugin.id, !plugin.enabled)}
          className={`ml-auto relative px-3 py-1 rounded-[3px] text-[9px] font-black tracking-widest shrink-0 ${plugin.enabled ? 'metal-btn text-gray-400' : ''}`}
          style={
            plugin.enabled
              ? undefined
              : { background: 'linear-gradient(#c81e1e,#7f1010)', border: '1px solid #ef4444', color: '#fff', boxShadow: '0 0 12px rgba(239,68,68,0.7), inset 0 1px 1px rgba(255,255,255,0.3)' }
          }
          title={plugin.enabled ? 'Bypass this effect' : 'Effect is bypassed — click to enable'}
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
            style={{ background: plugin.enabled ? '#3a3c42' : '#fca5a5', boxShadow: plugin.enabled ? 'none' : '0 0 4px #fff' }}
          />
          {plugin.enabled ? 'BYPASS' : 'BYPASSED'}
        </button>
      </div>

      {/* Body: input rail · editor · output rail (rails hidden for
          full-width editors, which carry their own metering) */}
      <div className="flex-1 flex min-h-0">
        {!fullWidth && <MeterRail label="IN" l={inL} r={inR} />}
        <div className={`flex-1 flex min-w-0 ${plugin.enabled ? '' : 'opacity-45 pointer-events-none'}`}>
          {Editor
            ? <Editor plugin={plugin} channelId={channelId} accent={accent} live={live} />
            : isCalf
              ? <CalfBody plugin={plugin} channelId={channelId} accent={accent} />
              : <GenericBody plugin={plugin} channelId={channelId} accent={accent} />}
        </div>
        {!fullWidth && <MeterRail label="OUT" l={outL} r={outR} />}
      </div>

      {/* URI */}
      <div className="metal-face relative px-3 py-1 border-t-2 border-black/60 shrink-0">
        <div className="text-[8px] text-gray-600 font-mono truncate">{plugin.uri}</div>
      </div>
    </div>
  );
};

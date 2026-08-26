import { useMemo } from 'react';
import { PluginNode, useMixerStore } from '../../../stores/useMixerStore';
import { getCalfSpec, ParamSpec } from '../../../data/calfPlugins';

// Shared types/hooks for the Calf plugin editors (kept out of the component
// files so Fast Refresh stays happy).

export interface FxEditorProps {
  plugin: PluginNode;
  channelId: number;
  accent: string;
  live: { inL: number; inR: number; outL: number; outR: number; rta?: number[] } | null;
}

// One knob size across the whole Calf editor set (see FxEditorShell).
export const KNOB_SIZE = 56;

/** param helpers shared by an editor and its screen */
export function useCalfParams(plugin: PluginNode, channelId: number) {
  const setParam = useMixerStore(s => s.setPluginParam);
  const spec = getCalfSpec(plugin.uri)!;
  const byId = useMemo(
    () => Object.fromEntries(spec.params.map(p => [p.symbol, p] as [string, ParamSpec])),
    [spec],
  );
  const val = (s: string) => (typeof plugin.params[s] === 'number' ? plugin.params[s] : byId[s]?.default ?? 0);
  const set = (s: string, v: number) => setParam(channelId, plugin.id, s, v);
  return { spec, byId, val, set };
}

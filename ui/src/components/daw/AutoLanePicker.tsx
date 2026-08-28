import { useState } from 'react';
import { useDawStore, type AutoTarget } from '../../stores/useDawStore';
import { useMixerStore } from '../../stores/useMixerStore';

// Compact popover: pick a fader / pan / plugin-param target to automate on a
// channel. Plugin-param ranges come from the engine's real LV2 metadata
// (availablePlugins.controlPorts); unknown ports fall back to 0..1.
export function AutoLanePicker({ channelId, onClose }: { channelId: number; onClose: () => void }) {
  const channel = useMixerStore((s) => s.channels[channelId]);
  const availablePlugins = useMixerStore((s) => s.availablePlugins);
  const addAutoLane = useDawStore((s) => s.addAutoLane);
  const existing = useDawStore((s) => Object.values(s.automation).filter((l) => l.target.channelId === channelId));
  const [openPlugin, setOpenPlugin] = useState<string | null>(null);

  const has = (t: Partial<AutoTarget>) => existing.some((l) =>
    l.target.kind === t.kind && l.target.pluginId === t.pluginId && l.target.paramSymbol === t.paramSymbol);

  const add = (target: AutoTarget, min: number, max: number) => {
    if (!has(target)) addAutoLane(target, min, max);
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onPointerDown={onClose} />
      <div className="absolute z-50 left-2 top-8 w-52 max-h-72 overflow-y-auto rounded-md border border-[#2c313b] bg-[#0d0f13] shadow-2xl p-1 text-gray-200">
        <div className="text-[9px] font-black tracking-widest text-gray-500 px-1.5 py-1">AUTOMATE · {channel?.name ?? channelId}</div>
        <button
          disabled={has({ kind: 'fader' })}
          onClick={() => add({ kind: 'fader', channelId, label: 'Fader' }, 0, 1)}
          className="w-full text-left text-[11px] px-1.5 py-1 rounded hover:bg-[#1c2330] disabled:opacity-40"
        >Fader</button>
        <button
          disabled={has({ kind: 'pan' })}
          onClick={() => add({ kind: 'pan', channelId, label: 'Pan' }, -1, 1)}
          className="w-full text-left text-[11px] px-1.5 py-1 rounded hover:bg-[#1c2330] disabled:opacity-40"
        >Pan</button>

        {(channel?.plugins ?? []).map((node, idx) => {
          const info = availablePlugins.find((p) => p.uri === node.uri);
          const keys = Object.keys(node.params ?? {});
          return (
            <div key={node.id} className="mt-0.5">
              <button
                onClick={() => setOpenPlugin(openPlugin === node.id ? null : node.id)}
                className="w-full text-left text-[10px] font-bold text-sky-300 px-1.5 py-1 rounded hover:bg-[#1c2330]"
              >
                {openPlugin === node.id ? '▾' : '▸'} {node.name} <span className="text-gray-600">#{idx + 1}</span>
              </button>
              {openPlugin === node.id && (keys.length ? keys : (info?.controlPorts ?? []).map((c) => c.symbol)).map((sym) => {
                const port = info?.controlPorts.find((c) => c.symbol === sym);
                const min = port?.min ?? 0, max = port?.max ?? 1;
                const target: AutoTarget = {
                  kind: 'plugin', channelId, pluginId: node.id, pluginIndex: idx,
                  paramSymbol: sym, label: `${node.name}: ${port?.name ?? sym}`,
                };
                return (
                  <button
                    key={sym}
                    disabled={has(target)}
                    onClick={() => add(target, min, max)}
                    className="w-full text-left text-[11px] pl-5 pr-1.5 py-0.5 rounded hover:bg-[#1c2330] disabled:opacity-40"
                  >{port?.name ?? sym}</button>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

import React, { useMemo, useState } from 'react';
import { gainToDb, dbToGain } from '../../../../data/calfPlugins';
import { FxEditorProps, KNOB_SIZE, useCalfParams } from '../fxShared';
import { AnalogKnob } from '../../../analog/AnalogKnob';
import { ToggleControl, SegmentedControl } from '../../../analog/Switch';
import { FreqScreen, EqBand, EqBandType } from '../screens/FreqScreen';

// Calf 5-/8-Band EQ — full-width frequency-response graph (RTA gradient
// behind it) on the top half, the selected band's knobs on the bottom half.
// Pick a band by clicking its node in the graph or its chip; its Freq / Gain
// / Q / slope / on-off controls load below.

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const shortName = (g: string) =>
  g.replace('Band ', 'B').replace('Low Shelf', 'LS').replace('High Shelf', 'HS');

const METER_GRAD =
  'linear-gradient(90deg,#00cc99,#00cc99 63%,#eab308 63%,#eab308 82%,#f97316 82%,#f97316 91%,#ef4444 91%)';
const dbPct = (db: number) => (clamp(db, -60, 6) + 60) / 66 * 100;

const MiniMeter = ({ label, db }: { label: string; db: number }) => (
  <div className="flex items-center gap-1">
    <span className="text-[7px] font-black tracking-widest text-gray-500 w-5 text-right">{label}</span>
    <div className="w-[52px] h-1.5 rounded-sm bg-[#0a0a0a] border border-black/60 overflow-hidden">
      <div className="h-full transition-[width] duration-75" style={{ width: `${dbPct(db)}%`, background: METER_GRAD }} />
    </div>
  </div>
);

export const EqEditor = ({ plugin, channelId, accent, live }: FxEditorProps) => {
  const { spec, byId, val, set } = useCalfParams(plugin, channelId);
  const groups = spec.bandSelector!.bands;
  const [sel, setSel] = useState(groups[0]);

  // group → param-symbol prefix. Static per plugin spec — resolve once, not
  // on every (throttled ~60 Hz) metering re-render.
  const prefixMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of groups) {
      const p = spec.params.find(x => x.group === g && /_(active|freq)$/.test(x.symbol));
      m[g] = p ? p.symbol.replace(/_(active|freq)$/, '') : '';
    }
    return m;
  }, [spec, groups]);
  const prefixOf = (g: string): string => prefixMap[g] ?? '';
  const typeOf = (pfx: string): EqBandType =>
    pfx === 'hp' ? 'hp' : pfx === 'lp' ? 'lp' : pfx === 'ls' ? 'ls' : pfx === 'hs' ? 'hs' : 'peak';

  const bands: EqBand[] = groups.map(g => {
    const pfx = prefixOf(g);
    return {
      id: g,
      type: typeOf(pfx),
      freq: val(`${pfx}_freq`),
      gainDb: byId[`${pfx}_level`] ? clamp(gainToDb(val(`${pfx}_level`)), -18, 18) : 0,
      q: byId[`${pfx}_q`] ? val(`${pfx}_q`) : 0.7,
      slopeDb: -12 * (val(`${pfx}_mode`) + 1),
      active: val(`${pfx}_active`) > 0.5,
    };
  });

  const onBand = (id: string, patch: { freq?: number; gainDb?: number }) => {
    const pfx = prefixOf(id);
    if (patch.freq !== undefined && byId[`${pfx}_freq`]) {
      set(`${pfx}_freq`, clamp(patch.freq, byId[`${pfx}_freq`].min, byId[`${pfx}_freq`].max));
    }
    if (patch.gainDb !== undefined && byId[`${pfx}_level`]) {
      set(`${pfx}_level`, clamp(dbToGain(patch.gainDb), byId[`${pfx}_level`].min, byId[`${pfx}_level`].max));
    }
  };

  const selPfx = prefixOf(sel);
  const selBand = bands.find(b => b.id === sel)!;
  const modeSym = `${selPfx}_mode`;

  const chooseBand = (g: string) => {
    setSel(g);
    const pfx = prefixOf(g);
    if (val(`${pfx}_active`) <= 0.5) set(`${pfx}_active`, 1);
  };

  const knob = (sym: string) => (
    <AnalogKnob key={sym} spec={byId[sym]} value={val(sym)} accent={accent} onChange={v => set(sym, v)} size={KNOB_SIZE} />
  );

  const inDb = live ? Math.max(live.inL, live.inR) : -100;
  const outDb = live ? Math.max(live.outL, live.outR) : -100;

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-1.5 p-1.5 metal-face-blue metal-grain relative">
      {/* IN / OUT meters (rails are hidden for the full-width EQ) */}
      <div className="absolute top-1.5 right-2 z-20 flex flex-col gap-0.5">
        <MiniMeter label="IN" db={inDb} />
        <MiniMeter label="OUT" db={outDb} />
      </div>

      {/* Band chips */}
      <div className="shrink-0 flex flex-wrap gap-1 justify-center pr-24">
        {groups.map(g => {
          const b = bands.find(x => x.id === g)!;
          const on = g === sel;
          return (
            <button
              key={g}
              onClick={() => chooseBand(g)}
              className="px-2 py-1 text-[8px] font-black tracking-wider uppercase rounded-[3px] border transition-colors flex items-center gap-1"
              style={{
                background: on ? accent : '#16171b',
                color: on ? '#0b0c10' : '#8b8f98',
                borderColor: on ? accent : '#2a2c31',
              }}
            >
              <span
                className="w-1 h-1 rounded-full"
                style={{
                  background: b.active ? (on ? '#0b0c10' : accent) : 'transparent',
                  boxShadow: b.active && !on ? `0 0 3px ${accent}` : 'none',
                }}
              />
              {shortName(g)}
            </button>
          );
        })}
      </div>

      {/* Top half: full-width response graph + RTA */}
      <div className="flex-[1.15] min-h-0 rounded-sm overflow-hidden border border-black/60 shadow-[inset_0_2px_6px_rgba(0,0,0,0.7)]">
        <FreqScreen bands={bands} accent={accent} onBand={onBand} selected={sel} onSelect={setSel} rta={live?.rta} />
      </div>

      {/* Bottom half: selected band controls */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="shrink-0 text-center text-[8px] font-black tracking-[0.2em] text-gray-500 uppercase mb-1 text-engrave">
          {sel} · {selBand.active ? 'active' : 'bypassed'}
        </div>
        {/* fixed-slot control strip — same width for every band type */}
        <div className="flex-1 min-h-0 flex items-center justify-center gap-2">
          <div className="w-[46px] flex justify-center shrink-0">
            <ToggleControl
              spec={byId[`${selPfx}_active`]}
              value={val(`${selPfx}_active`)}
              accent={accent}
              onChange={v => set(`${selPfx}_active`, v)}
            />
          </div>
          <div className="w-[76px] flex justify-center shrink-0">{byId[`${selPfx}_freq`] && knob(`${selPfx}_freq`)}</div>
          <div className="w-[118px] flex justify-center shrink-0">
            {byId[`${selPfx}_level`]
              ? knob(`${selPfx}_level`)
              : byId[modeSym] && (
                  <SegmentedControl spec={byId[modeSym]} value={val(modeSym)} accent={accent} onChange={v => set(modeSym, v)} />
                )}
          </div>
          <div className="w-[76px] flex justify-center shrink-0">{byId[`${selPfx}_q`] && knob(`${selPfx}_q`)}</div>
          <div className="w-px self-stretch bg-black/40 mx-1 shrink-0" />
          <div className="w-[76px] flex justify-center shrink-0">{byId['level_in'] && knob('level_in')}</div>
          <div className="w-[76px] flex justify-center shrink-0">{byId['level_out'] && knob('level_out')}</div>
        </div>
      </div>
    </div>
  );
};

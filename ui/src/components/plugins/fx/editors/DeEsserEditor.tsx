import React from 'react';
import { gainToDb, dbToGain } from '../../../../data/calfPlugins';
import { FxEditorProps, useCalfParams } from '../fxShared';
import { AnalogKnob } from '../../../analog/AnalogKnob';
import { ToggleControl, SegmentedControl } from '../../../analog/Switch';
import { FreqScreen, EqBand, FreqMarker } from '../screens/FreqScreen';
import { GrBar } from '../GrBar';

// Calf De-Esser — custom layout (not FxEditorShell): sibilance detection
// filter (draggable peak node) + split-crossover marker on the screen; a
// gain-reduction meter and a bay of large knobs on the right; Detection /
// Mode stacked in the bottom-left corner and S/C Listen in the bottom-right.

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const KN = 74;

export const DeEsserEditor = ({ plugin, channelId, accent, live }: FxEditorProps) => {
  const { byId, val, set } = useCalfParams(plugin, channelId);

  const bands: EqBand[] = [
    {
      id: 'peak',
      type: 'peak',
      freq: val('f2_freq'),
      gainDb: clamp(gainToDb(val('f2_level')), -18, 18),
      q: clamp(val('f2_q'), 0.3, 8),
      slopeDb: 0,
      active: true,
    },
  ];

  const markers: FreqMarker[] = [
    {
      id: 'split',
      freq: val('f1_freq'),
      label: 'SPLIT',
      onFreq: f => set('f1_freq', clamp(f, byId['f1_freq'].min, byId['f1_freq'].max)),
    },
  ];

  const onBand = (_id: string, patch: { freq?: number; gainDb?: number }) => {
    if (patch.freq !== undefined) set('f2_freq', clamp(patch.freq, byId['f2_freq'].min, byId['f2_freq'].max));
    if (patch.gainDb !== undefined) set('f2_level', clamp(dbToGain(patch.gainDb), byId['f2_level'].min, byId['f2_level'].max));
  };

  const liveDb = live ? { inDb: Math.max(live.inL, live.inR), outDb: Math.max(live.outL, live.outR) } : null;
  const gr = liveDb && liveDb.inDb > -59 ? clamp(liveDb.inDb - liveDb.outDb, 0, 24) : 0;

  const knob = (sym: string) => (
    <AnalogKnob key={sym} spec={byId[sym]} value={val(sym)} accent={accent} onChange={v => set(sym, v)} size={KN} />
  );

  return (
    <div className="flex-1 min-w-0 flex gap-2 p-1.5 metal-face-blue metal-grain relative">
      {/* screen */}
      <div className="h-full aspect-square shrink-0 rounded-sm overflow-hidden border border-black/60 shadow-[inset_0_2px_6px_rgba(0,0,0,0.7)]">
        <FreqScreen bands={bands} accent={accent} onBand={onBand} selected="peak" markers={markers} />
      </div>

      {/* control area */}
      <div className="flex-1 min-w-0 relative flex flex-col gap-1">
        <div className="w-full shrink-0">
          <GrBar value={gr} max={18} ticks={[6, 12]} />
        </div>

        {/* knob bay — 6 per row, packed under the meter; the bottom band and
            corners stay clear for the switches */}
        <div
          className="flex-1 flex flex-wrap justify-center content-start gap-x-1 gap-y-2 min-h-0 self-center"
          style={{ maxWidth: 6 * (KN + 10) }}
        >
          {['threshold', 'ratio', 'f2_freq', 'f2_q', 'f2_level', 'f1_freq', 'f1_level', 'makeup', 'laxity'].map(knob)}
        </div>

        {/* bottom-left: Detection over Mode */}
        <div className="absolute bottom-1 left-0 flex flex-col gap-1.5 items-start">
          <SegmentedControl spec={byId['detection']} value={val('detection')} accent={accent} onChange={v => set('detection', v)} />
          <SegmentedControl spec={byId['mode']} value={val('mode')} accent={accent} onChange={v => set('mode', v)} />
        </div>

        {/* bottom-right: S/C Listen */}
        <div className="absolute bottom-1 right-2">
          <ToggleControl spec={byId['sc_listen']} value={val('sc_listen')} accent={accent} onChange={v => set('sc_listen', v)} />
        </div>
      </div>
    </div>
  );
};

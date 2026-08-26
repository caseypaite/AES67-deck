import React from 'react';
import { dbToGain } from '../../../../data/calfPlugins';
import { FxEditorShell } from '../FxEditorShell';
import { FxEditorProps, useCalfParams } from '../fxShared';
import { CurveScreen } from '../screens/CurveScreen';

// Calf Crusher — bit-reduction staircase transfer curve, bit/sample/LFO knobs.

export const CrusherEditor = (props: FxEditorProps) => {
  const { plugin, channelId, accent, live } = props;
  const { val } = useCalfParams(plugin, channelId);

  const levels = Math.pow(2, Math.max(1, val('bits')) - 1);
  const outDb = 20 * Math.log10(Math.max(val('level_out'), 1e-6));
  const curve = (xDb: number) => {
    const x = dbToGain(xDb);
    const q = Math.round(x * levels) / levels;
    return 20 * Math.log10(Math.max(Math.abs(q), 1e-5)) + outDb;
  };
  const liveDb = live ? { inDb: Math.max(live.inL, live.inR), outDb: Math.max(live.outL, live.outR) } : null;

  return (
    <FxEditorShell
      {...props}
      screen={<CurveScreen curve={curve} accent={accent} live={liveDb} caption="BIT CRUSH" />}
      knobs={['bits', 'samples', 'morph', 'anti_aliasing', 'dc', 'lforange', 'lforate', 'level_in', 'level_out']}
      switches={['mode', 'lfo']}
    />
  );
};

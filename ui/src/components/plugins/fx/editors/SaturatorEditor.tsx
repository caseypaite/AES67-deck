import React from 'react';
import { dbToGain } from '../../../../data/calfPlugins';
import { FxEditorShell } from '../FxEditorShell';
import { FxEditorProps, useCalfParams } from '../fxShared';
import { CurveScreen } from '../screens/CurveScreen';

// Calf Saturator — soft-saturation waveshaper transfer curve on the screen,
// drive / tone / pre+post filter knobs on the right.

export const SaturatorEditor = (props: FxEditorProps) => {
  const { plugin, channelId, accent, live } = props;
  const { val } = useCalfParams(plugin, channelId);

  const drive = val('drive');
  const outDb = 20 * Math.log10(Math.max(val('level_out'), 1e-6));
  const k = 1.1 + drive * 0.55; // waveshaper hardness
  const curve = (xDb: number) => {
    const x = dbToGain(xDb);
    const y = Math.tanh(x * k); // unnormalised — peaks fold toward the ceiling
    return 20 * Math.log10(Math.max(y, 1e-5)) + outDb;
  };
  const liveDb = live ? { inDb: Math.max(live.inL, live.inR), outDb: Math.max(live.outL, live.outR) } : null;

  return (
    <FxEditorShell
      {...props}
      screen={<CurveScreen curve={curve} accent={accent} live={liveDb} caption="SATURATION" />}
      knobs={['drive', 'blend', 'mix', 'p_freq', 'p_level', 'p_q', 'hp_pre_freq', 'lp_pre_freq', 'hp_post_freq', 'lp_post_freq', 'level_in', 'level_out']}
      switches={['pre', 'post']}
    />
  );
};

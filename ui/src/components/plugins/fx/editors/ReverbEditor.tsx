import React from 'react';
import { FxEditorShell } from '../FxEditorShell';
import { FxEditorProps, useCalfParams } from '../fxShared';
import { ReverbScreen } from '../screens/ReverbScreen';

// Calf Reverb — decay-envelope screen (draggable pre-delay + RT60), decay /
// tone / mix knobs, room-size selector.

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const ReverbEditor = (props: FxEditorProps) => {
  const { plugin, channelId, accent } = props;
  const { byId, val, set } = useCalfParams(plugin, channelId);

  return (
    <FxEditorShell
      {...props}
      screen={
        <ReverbScreen
          decayTime={val('decay_time')}
          predelayMs={val('predelay')}
          diffusion={val('diffusion')}
          accent={accent}
          onPredelay={ms => set('predelay', clamp(ms, byId['predelay'].min, byId['predelay'].max))}
          onDecay={s => set('decay_time', clamp(s, byId['decay_time'].min, byId['decay_time'].max))}
        />
      }
      knobs={['decay_time', 'predelay', 'diffusion', 'hf_damp', 'bass_cut', 'treble_cut', 'amount', 'dry', 'level_in', 'level_out']}
      switches={['room_size']}
    />
  );
};

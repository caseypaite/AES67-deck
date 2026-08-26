import React from 'react';
import { FxEditorShell } from '../FxEditorShell';
import { FxEditorProps, useCalfParams } from '../fxShared';
import { DelayScreen } from '../screens/DelayScreen';

// Calf Vintage Delay — tap-timeline screen, tempo / subdivision / feedback /
// mix knobs, mode / medium / timing switches.

export const DelayEditor = (props: FxEditorProps) => {
  const { plugin, channelId, accent } = props;
  const { val } = useCalfParams(plugin, channelId);

  return (
    <FxEditorShell
      {...props}
      screen={
        <DelayScreen
          bpm={val('bpm')}
          subdiv={val('subdiv')}
          timeL={val('time_l')}
          timeR={val('time_r')}
          feedback={val('feedback')}
          wet={val('amount')}
          dry={val('dry')}
          accent={accent}
        />
      }
      knobs={['bpm', 'subdiv', 'time_l', 'time_r', 'feedback', 'amount', 'dry', 'width', 'level_in', 'level_out']}
      switches={['mix_mode', 'medium', 'timing']}
    />
  );
};

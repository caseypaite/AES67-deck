import React from 'react';
import { gainToDb, dbToGain } from '../../../../data/calfPlugins';
import { FxEditorShell } from '../FxEditorShell';
import { FxEditorProps, useCalfParams } from '../fxShared';
import { CurveScreen } from '../screens/CurveScreen';
import { GrBar } from '../GrBar';

// Calf Limiter — brick-wall ceiling transfer curve (draggable ceiling line),
// attenuation meter, lookahead / release / ASC.

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const LimiterEditor = (props: FxEditorProps) => {
  const { plugin, channelId, accent, live } = props;
  const { byId, val, set } = useCalfParams(plugin, channelId);

  const ceilingDb = gainToDb(val('limit'));
  const curve = (xDb: number) => Math.min(xDb, ceilingDb);
  const liveDb = live ? { inDb: Math.max(live.inL, live.inR), outDb: Math.max(live.outL, live.outR) } : null;
  const att = liveDb && liveDb.inDb > -59 ? clamp(liveDb.inDb - liveDb.outDb, 0, 24) : 0;

  return (
    <FxEditorShell
      {...props}
      screen={
        <CurveScreen
          curve={curve}
          accent={accent}
          live={liveDb}
          caption="CEILING"
          ceilingDb={ceilingDb}
          onCeiling={db => set('limit', clamp(dbToGain(db), byId['limit'].min, byId['limit'].max))}
        />
      }
      header={<GrBar label="Attenuation" value={att} max={18} ticks={[6, 12]} />}
      knobs={['limit', 'attack', 'release', 'asc_coeff', 'oversampling', 'level_in', 'level_out']}
      switches={['asc', 'auto_level']}
    />
  );
};

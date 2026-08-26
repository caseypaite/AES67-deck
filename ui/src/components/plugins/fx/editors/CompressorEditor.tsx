import React from 'react';
import { gainToDb, dbToGain } from '../../../../data/calfPlugins';
import { FxEditorShell } from '../FxEditorShell';
import { FxEditorProps, useCalfParams } from '../fxShared';
import { TransferGraph } from '../TransferGraph';
import { GrBar } from '../GrBar';

// Calf Compressor — the reference editor: interactive transfer-function
// graph (draggable threshold / ratio nodes, live signal dot) on the screen,
// gain-reduction meter + knob bay + detector switches on the right.

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const CompressorEditor = (props: FxEditorProps) => {
  const { plugin, channelId, accent, live } = props;
  const { byId, val, set } = useCalfParams(plugin, channelId);

  const thrDb = gainToDb(val('threshold'));
  const makeupDb = gainToDb(val('makeup'));
  const ratio = val('ratio');
  const kneeDb = 20 * Math.log10(Math.max(val('knee'), 1));

  const liveDb = live ? { inDb: Math.max(live.inL, live.inR), outDb: Math.max(live.outL, live.outR) } : null;
  const gr = liveDb && liveDb.inDb > -59 ? clamp(liveDb.inDb + makeupDb - liveDb.outDb, 0, 36) : 0;

  return (
    <FxEditorShell
      {...props}
      screen={
        <TransferGraph
          thresholdDb={thrDb}
          ratio={ratio}
          kneeDb={kneeDb}
          makeupDb={makeupDb}
          live={liveDb}
          accent={accent}
          onThreshold={db => set('threshold', clamp(dbToGain(db), byId['threshold'].min, byId['threshold'].max))}
          onRatio={r => set('ratio', clamp(r, byId['ratio'].min, byId['ratio'].max))}
        />
      }
      header={<GrBar value={gr} />}
      knobs={['threshold', 'ratio', 'knee', 'attack', 'release', 'makeup', 'mix', 'level_in']}
      switches={['detection', 'stereo_link']}
    />
  );
};

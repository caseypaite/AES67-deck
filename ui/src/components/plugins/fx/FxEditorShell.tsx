import React from 'react';
import { AnalogKnob } from '../../analog/AnalogKnob';
import { ToggleControl, SegmentedControl } from '../../analog/Switch';
import { FxEditorProps, KNOB_SIZE, useCalfParams } from './fxShared';

// Shared shell for every Calf plugin editor, following the Calf Compressor
// reference layout: a square recessed "screen" on the left (the plugin's
// visualisation) and, on the right, an optional header meter → a knob bay →
// a row of toggle/enum switches, all on the dirty-blue brushed faceplate.
//
// The knob bay is a FIXED grid (KNOB_COLS × KNOB_SIZE), sized to hold the
// busiest Calf plugin (Saturator, 12 knobs). Plugins with fewer knobs leave
// empty cells rather than growing the knobs or changing the column count —
// the layout stays identical across the whole plugin set.
const KNOB_COLS = 6;
const CELL = KNOB_SIZE + 6;

export const FxEditorShell = ({
  plugin,
  channelId,
  accent,
  screen,
  knobs,
  switches = [],
  header,
}: FxEditorProps & {
  screen: React.ReactNode;
  knobs: string[];
  switches?: string[];
  header?: React.ReactNode;
}) => {
  const { byId, val, set } = useCalfParams(plugin, channelId);
  const shown = knobs.filter(s => byId[s]);

  return (
    <div className="flex-1 min-w-0 flex gap-2 p-1.5 metal-face-blue metal-grain relative">
      {/* Left: recessed screen */}
      <div className="h-full aspect-square shrink-0 rounded-sm overflow-hidden border border-black/60 shadow-[inset_0_2px_6px_rgba(0,0,0,0.7)]">
        {screen}
      </div>

      {/* Right: header · knob bay · switches */}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5 items-center">
        {header && <div className="w-full shrink-0">{header}</div>}
        {/* fixed-width knob bay: exactly KNOB_COLS per row, partial rows
            centred, empty slots when the plugin has fewer knobs */}
        <div
          className="flex-1 flex flex-wrap justify-center content-center gap-x-1 gap-y-2 min-h-0"
          style={{ maxWidth: KNOB_COLS * (CELL + 4) }}
        >
          {shown.map(s => (
            <AnalogKnob key={s} spec={byId[s]} value={val(s)} accent={accent} onChange={v => set(s, v)} size={KNOB_SIZE} />
          ))}
        </div>
        {switches.filter(s => byId[s]).length > 0 && (
          <div className="shrink-0 flex flex-wrap gap-3 justify-center">
            {switches.map(s =>
              !byId[s] ? null : byId[s].kind === 'toggle' ? (
                <ToggleControl key={s} spec={byId[s]} value={val(s)} accent={accent} onChange={v => set(s, v)} />
              ) : (
                <SegmentedControl key={s} spec={byId[s]} value={val(s)} accent={accent} onChange={v => set(s, v)} />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
};

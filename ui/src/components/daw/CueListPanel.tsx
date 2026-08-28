import { useMemo } from 'react';
import { useDawStore, formatTimecode, type DawMarker } from '../../stores/useDawStore';
import { downloadText, tsSlug, csvCell } from '../../lib/download';

// Phase 3b — operator-facing cue list for the TIMELINE view. Markers already
// exist end-to-end (drop with `M`, jump with `,`/`.`, persisted in the
// project); this panel names / colours / reorders-by-time / deletes them and
// exports an as-run CSV for post-show documentation.

const PALETTE = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#a855f7', '#94a3b8'];

export function CueListPanel() {
  const markers = useDawStore((s) => s.markers);
  const fps = useDawStore((s) => s.fps);
  const playhead = useDawStore((s) => s.playheadPosition);
  const projectName = useDawStore((s) => s.projectName);
  const updateMarker = useDawStore((s) => s.updateMarker);
  const removeMarker = useDawStore((s) => s.removeMarker);
  const addMarker = useDawStore((s) => s.addMarker);
  const locate = useDawStore((s) => s.locate);
  const setCuesOpen = useDawStore((s) => s.setCuesOpen);

  const sorted = useMemo(
    () => Object.values(markers).sort((a, b) => a.time - b.time),
    [markers],
  );

  // The cue at or just before the playhead — highlighted as "current".
  const currentId = useMemo(() => {
    let id: string | null = null;
    for (const m of sorted) {
      if (m.time <= playhead + 1e-3) id = m.id;
      else break;
    }
    return id;
  }, [sorted, playhead]);

  const exportCsv = () => {
    const { _takeStartedAtMs, _takeOriginSec } = useDawStore.getState();
    const lines = ['Cue,Name,Timecode,Seconds,WallClock'];
    sorted.forEach((m, i) => {
      const wall = _takeStartedAtMs != null
        ? new Date(_takeStartedAtMs + (m.time - _takeOriginSec) * 1000).toISOString()
        : '';
      lines.push([
        i + 1,
        csvCell(m.name),
        formatTimecode(m.time, fps),
        m.time.toFixed(3),
        wall,
      ].join(','));
    });
    downloadText(`${projectName || 'project'}-cuelist-${tsSlug()}.csv`, lines.join('\n') + '\n');
  };

  return (
    <div className="w-[264px] shrink-0 flex flex-col bg-[#0d0f13] border-l border-[#242832] text-gray-300">
      <div className="flex items-center justify-between px-3 h-9 border-b border-[#242832]">
        <span className="text-[10px] font-black tracking-widest text-gray-500">CUE LIST · {sorted.length}</span>
        <button onClick={() => setCuesOpen(false)} className="text-gray-500 hover:text-white text-xs px-1" title="Close">✕</button>
      </div>

      <button
        onClick={() => addMarker(useDawStore.getState().playheadPosition)}
        className="m-2 px-2 py-1.5 text-[10px] font-bold rounded bg-[#1a1c22] text-gray-200 hover:bg-blue-700"
      >
        ＋ ADD CUE @ PLAYHEAD
      </button>

      <div className="flex-1 overflow-y-auto px-1.5 pb-2 flex flex-col gap-0.5">
        {sorted.length === 0 && (
          <div className="text-[10px] text-gray-600 px-2 py-4 text-center leading-relaxed">
            No cues yet. Press <span className="font-mono text-gray-400">M</span> on the timeline to drop one at the playhead.
          </div>
        )}
        {sorted.map((m, i) => (
          <CueRow
            key={m.id}
            marker={m}
            index={i + 1}
            fps={fps}
            current={m.id === currentId}
            onJump={() => locate(m.time)}
            onName={(name) => updateMarker(m.id, { name })}
            onCycleColor={() => {
              const ci = Math.max(0, PALETTE.indexOf(m.color || PALETTE[0]));
              updateMarker(m.id, { color: PALETTE[(ci + 1) % PALETTE.length] });
            }}
            onDelete={() => removeMarker(m.id)}
          />
        ))}
      </div>

      <div className="p-2 border-t border-[#242832]">
        <button
          onClick={exportCsv}
          disabled={sorted.length === 0}
          className="w-full px-2 py-1.5 text-[10px] font-bold rounded bg-[#1a1c22] text-gray-200 enabled:hover:bg-[#26282f] disabled:opacity-40"
        >
          EXPORT CSV (AS-RUN)
        </button>
      </div>
    </div>
  );
}

function CueRow({ marker, index, fps, current, onJump, onName, onCycleColor, onDelete }: {
  marker: DawMarker;
  index: number;
  fps: number;
  current: boolean;
  onJump: () => void;
  onName: (name: string) => void;
  onCycleColor: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-1.5 px-1.5 py-1 rounded text-[11px] ${
        current ? 'bg-[#1c2330]' : 'hover:bg-[#15171c]'
      }`}
    >
      <span className="w-4 text-right text-[9px] font-mono text-gray-600 shrink-0">{index}</span>
      <button
        onClick={onCycleColor}
        title="Cycle colour"
        className="w-2.5 h-2.5 rounded-full shrink-0 border border-black/40"
        style={{ backgroundColor: marker.color || PALETTE[0] }}
      />
      <input
        // Uncontrolled: this panel is the only editor of a cue name. Keyed by
        // marker.id above so a delete/reorder remounts cleanly.
        defaultValue={marker.name}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== marker.name) onName(v);
          else e.target.value = marker.name;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { (e.target as HTMLInputElement).value = marker.name; (e.target as HTMLInputElement).blur(); }
        }}
        className="flex-1 min-w-0 bg-transparent outline-none focus:bg-[#0d0f13] focus:px-1 rounded text-gray-200"
      />
      <span className="font-mono text-[9px] text-gray-500 shrink-0 tabular-nums">{formatTimecode(marker.time, fps)}</span>
      <button
        onClick={onJump}
        title="Move the transport here"
        className="shrink-0 text-gray-500 hover:text-blue-400 px-0.5 opacity-0 group-hover:opacity-100"
      >
        →
      </button>
      <button
        onClick={onDelete}
        title="Delete cue"
        className="shrink-0 text-gray-600 hover:text-red-400 px-0.5 opacity-0 group-hover:opacity-100"
      >
        🗑
      </button>
    </div>
  );
}

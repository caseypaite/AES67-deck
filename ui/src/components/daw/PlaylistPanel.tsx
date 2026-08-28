import { useEffect, useState } from 'react';
import { useDawStore } from '../../stores/useDawStore';

// Playout playlist (plan Phase 5): queue projects for back-to-back playback.
// The server sequencer advances on the metering clock; the timeline follows via
// the normal project_data fan-out.
export function PlaylistPanel() {
  const playlists = useDawStore((s) => s.playlists);
  const playlist = useDawStore((s) => s.playlist);
  const status = useDawStore((s) => s.playlistStatus);
  const projectList = useDawStore((s) => s.projectList);
  const recordingProjects = useDawStore((s) => s.recordingProjects);
  const openPlaylist = useDawStore((s) => s.openPlaylist);
  const newPlaylist = useDawStore((s) => s.newPlaylist);
  const savePlaylist = useDawStore((s) => s.savePlaylist);
  const startPlaylist = useDawStore((s) => s.startPlaylist);
  const stopPlaylist = useDawStore((s) => s.stopPlaylist);
  const setPlaylistOpen = useDawStore((s) => s.setPlaylistOpen);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => { useDawStore.getState(); }, []);

  const segs = playlist?.segments ?? [];
  const setSegs = (next: typeof segs) => savePlaylist(next);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= segs.length) return;
    const next = segs.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setSegs(next);
  };

  return (
    <div className="w-[280px] shrink-0 flex flex-col bg-[#0d0f13] border-l border-[#242832] text-gray-300">
      <div className="flex items-center justify-between px-3 h-9 border-b border-[#242832]">
        <span className="text-[10px] font-black tracking-widest text-gray-500">PLAYLIST</span>
        <button onClick={() => setPlaylistOpen(false)} className="text-gray-500 hover:text-white text-xs px-1">✕</button>
      </div>

      <div className="p-2 flex gap-1 border-b border-[#242832]">
        <select
          value={playlist?.name ?? ''}
          onChange={(e) => e.target.value && openPlaylist(e.target.value)}
          className="flex-1 bg-[#1a1d23] border border-[#3a3f48] rounded px-1.5 py-1 text-[11px] text-gray-100 outline-none"
        >
          <option value="">— open playlist —</option>
          {playlists.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          onClick={() => { const n = prompt('New playlist name'); if (n) newPlaylist(n); }}
          className="px-2 text-[11px] font-bold rounded bg-[#1a1c22] text-gray-200 hover:bg-blue-700"
        >＋</button>
      </div>

      {playlist ? (
        <>
          <div className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-1">
            {segs.length === 0 && <div className="text-[10px] text-gray-600 px-2 py-4 text-center">Empty. Add a project below.</div>}
            {segs.map((seg, i) => (
              <div key={i} className={`rounded px-1.5 py-1 text-[11px] ${status.running && status.index === i ? 'bg-emerald-950 border border-emerald-700' : 'bg-[#15171c]'}`}>
                <div className="flex items-center gap-1">
                  <span className="w-4 text-right text-[9px] font-mono text-gray-600">{i + 1}</span>
                  <span className="flex-1 truncate">{seg.project}{seg.recProject ? ' ⟨rpp⟩' : ''}</span>
                  <button onClick={() => move(i, -1)} className="text-gray-500 hover:text-white px-0.5">▲</button>
                  <button onClick={() => move(i, 1)} className="text-gray-500 hover:text-white px-0.5">▼</button>
                  <button onClick={() => setSegs(segs.filter((_, k) => k !== i))} className="text-gray-600 hover:text-red-400 px-0.5">🗑</button>
                </div>
                <div className="flex items-center gap-1 pl-5 mt-0.5 text-[10px] text-gray-500">
                  gap
                  <input
                    type="number" min={0} step={0.5} value={seg.gapSec ?? 0}
                    onChange={(e) => setSegs(segs.map((s, k) => k === i ? { ...s, gapSec: Math.max(0, Number(e.target.value) || 0) } : s))}
                    className="w-12 bg-[#1a1d23] border border-[#3a3f48] rounded px-1 py-0.5 text-right text-gray-200 outline-none"
                  />s
                  <button onClick={() => startPlaylist(i)} className="ml-auto text-emerald-400 hover:text-emerald-300 font-bold">▶ from here</button>
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-[#242832] p-2">
            <button onClick={() => setAddOpen(!addOpen)} className="w-full px-2 py-1 text-[10px] font-bold rounded bg-[#1a1c22] text-gray-200 hover:bg-[#26282f]">
              {addOpen ? '▾' : '▸'} ADD SEGMENT
            </button>
            {addOpen && (
              <div className="mt-1 max-h-40 overflow-y-auto flex flex-col gap-0.5">
                {projectList.map((p) => (
                  <button key={'p' + p} onClick={() => { setSegs([...segs, { project: p }]); }}
                    className="text-left text-[11px] px-1.5 py-0.5 rounded hover:bg-[#1c2330]">{p}</button>
                ))}
                {recordingProjects.map((p) => (
                  <button key={'r' + p} onClick={() => { setSegs([...segs, { project: p, recProject: true }]); }}
                    className="text-left text-[11px] px-1.5 py-0.5 rounded hover:bg-[#1c2330] text-purple-300">{p} ⟨rpp⟩</button>
                ))}
              </div>
            )}
            <button
              onClick={() => (status.running ? stopPlaylist() : startPlaylist(0))}
              disabled={!segs.length}
              className={`mt-2 w-full px-2 py-1.5 text-[11px] font-black rounded disabled:opacity-40 ${status.running ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'}`}
            >
              {status.running ? `■ STOP  (${status.index + 1}/${status.count})` : '▶ PLAY PLAYLIST'}
            </button>
          </div>
        </>
      ) : (
        <div className="text-[10px] text-gray-600 px-3 py-4 text-center">Open or create a playlist to queue projects for playout.</div>
      )}
    </div>
  );
}

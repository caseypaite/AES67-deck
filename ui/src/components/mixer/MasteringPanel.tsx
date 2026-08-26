import React, { useEffect, useState } from 'react';
import { useMixerStore } from '../../stores/useMixerStore';
import { MASTERING_PRESETS } from '../../data/masteringPresets';

// Mastering tools + analysers shown in the sends-sidebar space when the
// Master or Monitor bus is selected. Left: master-output spectrum + stereo
// (correlation + goniometer). Right: BS.1770 loudness + a preset browser
// (built-in mastering chains and user-saved rack presets) that load onto the
// selected bus's FX rack.

// ── spectrum ────────────────────────────────────────────────────────────────
const F_MIN = 20, F_MAX = 22000;
const RTA_F_LO = 30, RTA_F_HI = 18000;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const Spectrum = ({ bands }: { bands: number[] }) => {
  const W = 1000, H = 300, DB_LO = -78, DB_TOP = -3;
  const fx = (f: number) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * W;
  const bf = (k: number, n: number) => RTA_F_LO * Math.pow(RTA_F_HI / RTA_F_LO, k / (n - 1));
  const y = (db: number) => H - clamp((db - DB_LO) / (DB_TOP - DB_LO), 0, 1) * H;
  const n = bands.length;
  const pts = n
    ? bands.map((db, i) => `${fx(bf(i, n)).toFixed(1)},${y(db).toFixed(1)}`)
    : [];
  const d = n ? `M ${fx(bf(0, n)).toFixed(1)},${H} L ${pts.join(' L ')} L ${fx(bf(n - 1, n)).toFixed(1)},${H} Z` : '';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-full" style={{ background: 'radial-gradient(circle at 50% 30%,#0a0d12,#050608)' }}>
      <defs>
        <linearGradient id="ms-spec" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#1e3a8a" stopOpacity="0.06" />
          <stop offset="40%" stopColor="#0891b2" stopOpacity="0.3" />
          <stop offset="70%" stopColor="#65a30d" stopOpacity="0.4" />
          <stop offset="90%" stopColor="#ca8a04" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#dc2626" stopOpacity="0.65" />
        </linearGradient>
      </defs>
      {[100, 1000, 10000].map(f => <line key={f} x1={fx(f)} y1={0} x2={fx(f)} y2={H} stroke="rgba(255,255,255,0.07)" strokeWidth={1} />)}
      {[-12, -24, -48].map(db => <line key={db} x1={0} y1={y(db)} x2={W} y2={y(db)} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />)}
      {d && <path d={d} fill="url(#ms-spec)" />}
      {pts.length > 0 && <path d={`M ${pts.join(' L ')}`} fill="none" stroke="#e2e8f0" strokeOpacity={0.4} strokeWidth={1.5} />}
      {[100, 1000, 10000].map(f => (
        <text key={f} x={fx(f) + 3} y={H - 5} fill="#4a5568" fontSize={11} fontFamily="monospace">{f >= 1000 ? `${f / 1000}k` : f}</text>
      ))}
    </svg>
  );
};

// ── goniometer ──────────────────────────────────────────────────────────────
const Goniometer = ({ pts }: { pts: number[] }) => {
  const S = 100;
  const dots: React.ReactNode[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const l = pts[i], r = pts[i + 1];
    // rotate 45°: mono (L=R) → vertical, anti-phase → horizontal
    const x = (l - r) * 0.7071;
    const yv = (l + r) * 0.7071;
    dots.push(
      <circle key={i} cx={S / 2 + x * S * 0.46} cy={S / 2 - yv * S * 0.46} r={0.9} fill="#5eead4" opacity={0.6 + (i / pts.length) * 0.4} />,
    );
  }
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="w-full h-full" style={{ background: '#050608' }}>
      <circle cx={S / 2} cy={S / 2} r={S * 0.46} fill="none" stroke="rgba(255,255,255,0.1)" />
      <line x1={S / 2} y1={4} x2={S / 2} y2={S - 4} stroke="rgba(255,255,255,0.12)" />
      <line x1={4} y1={S / 2} x2={S - 4} y2={S / 2} stroke="rgba(255,255,255,0.12)" />
      <text x={S / 2 + 2} y={9} fill="#4a5568" fontSize={7} fontFamily="monospace">M</text>
      <text x={S - 10} y={S / 2 - 2} fill="#4a5568" fontSize={7} fontFamily="monospace">S</text>
      {dots}
    </svg>
  );
};

// ── loudness readout ────────────────────────────────────────────────────────
const fmt = (v: number | undefined) => (v === undefined || v < -100 ? '––.–' : v.toFixed(1));

// Module-level so its type identity is stable across the panel's ~40 Hz
// metering re-renders (a component defined in the render body would remount
// every frame).
const NumRow = ({ label, value, unit, warn }: { label: string; value: string; unit: string; warn?: boolean }) => (
  <div className="flex items-baseline gap-1.5">
    <span className="text-[9px] font-black tracking-widest text-gray-500 w-4">{label}</span>
    <span className={`font-mono tabular-nums text-[15px] flex-1 text-right ${warn ? 'text-red-400' : 'text-gray-100'}`}>{value}</span>
    <span className="text-[7px] text-gray-600 w-7">{unit}</span>
  </div>
);

// ── the panel ───────────────────────────────────────────────────────────────
export const MasteringPanel = ({ channelId }: { channelId: number }) => {
  const lufs = useMixerStore(s => s.lufs);
  const ma = useMixerStore(s => s.masterAnalysis);
  const resetLufs = useMixerStore(s => s.resetLufs);
  const applyRack = useMixerStore(s => s.applyRack);
  const rackPresets = useMixerStore(s => s.rackPresets);
  const listRackPresets = useMixerStore(s => s.listRackPresets);
  const loadRackPreset = useMixerStore(s => s.loadRackPreset);
  const saveRackPreset = useMixerStore(s => s.saveRackPreset);
  const channelName = useMixerStore(s => s.channels[channelId]?.name ?? '');

  const [sel, setSel] = useState<string>(MASTERING_PRESETS[0].id);

  useEffect(() => { listRackPresets(); }, [listRackPresets]);

  const builtin = MASTERING_PRESETS.find(p => p.id === sel);
  const rta = ma?.rta ?? [];
  const gonio = ma?.gonio ?? [];
  const corr = ma?.corr ?? 0;
  const tpWarn = (lufs?.tp ?? -120) > -1;

  const load = () => {
    if (builtin) applyRack(channelId, builtin.plugins);
    else loadRackPreset(sel); // user preset → server applies to selected channel
  };
  const save = () => {
    const name = window.prompt('Save current master chain as preset:');
    if (name?.trim()) { saveRackPreset(channelId, name.trim()); setTimeout(listRackPresets, 300); }
  };

  return (
    <div className="w-full h-full flex flex-col bg-[#0d0f13] z-10 overflow-hidden">
      <div className="shrink-0 text-[9px] font-black tracking-[0.2em] text-[#a0a5aa] uppercase text-center border-b-2 border-black py-1 bg-[#111]">
        Mastering · {channelName || 'Master'}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* left: analysers */}
        <div className="flex-1 min-w-0 flex flex-col gap-1 p-1.5 border-r border-black/50">
          <div className="flex-[1.4] min-h-0 rounded-sm overflow-hidden border border-black/60 shadow-[inset_0_2px_6px_rgba(0,0,0,0.7)]">
            <Spectrum bands={rta} />
          </div>
          <div className="flex-1 min-h-0 flex gap-1.5">
            <div className="aspect-square h-full shrink-0 rounded-sm overflow-hidden border border-black/60">
              <Goniometer pts={gonio} />
            </div>
            <div className="flex-1 flex flex-col justify-center gap-1 min-w-0">
              <div className="flex justify-between text-[8px] font-black tracking-widest text-gray-500 uppercase">
                <span>Correlation</span>
                <span className={`font-mono ${corr < 0 ? 'text-red-400' : corr < 0.4 ? 'text-amber-300' : 'text-emerald-300'}`}>{corr.toFixed(2)}</span>
              </div>
              <div className="relative h-2.5 rounded-sm bg-[#050505] border border-black/60 overflow-hidden">
                <div className="absolute inset-y-0 left-1/2 w-px bg-white/25" />
                <div
                  className={`absolute inset-y-0 ${corr >= 0 ? 'left-1/2' : 'right-1/2'} ${corr < 0 ? 'bg-red-500' : 'bg-emerald-500'}`}
                  style={{ width: `${Math.abs(corr) * 50}%` }}
                />
              </div>
              <div className="flex justify-between text-[7px] font-mono text-gray-600"><span>−1 ø</span><span>0</span><span>+1 mono</span></div>
            </div>
          </div>
        </div>

        {/* right: loudness + presets */}
        <div className="w-[320px] shrink-0 flex flex-col p-1.5 gap-1.5">
          <div className="shrink-0 grid grid-cols-2 gap-x-3 gap-y-0.5 border-b border-black/50 pb-1.5">
            <NumRow label="M" value={fmt(lufs?.m)} unit="LUFS" />
            <NumRow label="I" value={fmt(lufs?.i)} unit="LUFS" />
            <NumRow label="S" value={fmt(lufs?.s)} unit="LUFS" />
            <NumRow label="TP" value={fmt(lufs?.tp)} unit="dBTP" warn={tpWarn} />
          </div>

          <div className="shrink-0 flex items-center justify-between">
            <span className="text-[9px] font-black tracking-widest text-gray-500 uppercase">Presets</span>
            <button onClick={resetLufs} className="text-[7px] font-black tracking-widest text-gray-500 hover:text-white border border-black/60 rounded px-1.5 py-0.5">
              RESET I
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar rounded-sm border border-black/50 bg-[#0a0b0e]">
            {MASTERING_PRESETS.map(p => (
              <button
                key={p.id}
                onClick={() => setSel(p.id)}
                className={`w-full text-left px-2 py-1 border-b border-black/40 transition-colors ${sel === p.id ? 'bg-[#1e2a3a]' : 'hover:bg-white/5'}`}
              >
                <div className="flex justify-between items-baseline">
                  <span className="text-[10px] font-bold text-gray-100">{p.name}</span>
                  <span className="text-[7px] font-mono text-cyan-300/70">{p.target}</span>
                </div>
                <div className="text-[7px] text-gray-500 leading-tight line-clamp-2">{p.desc}</div>
              </button>
            ))}
            {rackPresets.length > 0 && (
              <div className="text-[7px] font-black tracking-widest text-gray-600 px-2 pt-1.5 pb-0.5">SAVED</div>
            )}
            {rackPresets.map(name => (
              <button
                key={name}
                onClick={() => setSel(name)}
                className={`w-full text-left px-2 py-1 border-b border-black/40 text-[10px] text-gray-300 transition-colors ${sel === name ? 'bg-[#1e2a3a]' : 'hover:bg-white/5'}`}
              >
                {name}
              </button>
            ))}
          </div>

          <div className="shrink-0 flex gap-1.5">
            <button onClick={load} className="flex-1 text-[9px] font-black tracking-widest text-emerald-300 border border-emerald-900 hover:border-emerald-600 rounded-sm py-1 bg-emerald-900/20 hover:bg-emerald-900/40 transition-colors">
              LOAD → {channelName || 'MASTER'}
            </button>
            <button onClick={save} className="shrink-0 text-[9px] font-black tracking-widest text-amber-300 border border-amber-900 hover:border-amber-600 rounded-sm px-2.5 py-1 bg-amber-900/20 hover:bg-amber-900/40 transition-colors">
              SAVE
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

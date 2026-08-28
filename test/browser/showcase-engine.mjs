// Richer stand-in for the C++ engine, for the mixer showcase: streams animated
// metering for every channel + bus, a live master analyser (spectrum /
// goniometer / correlation), BS.1770 loudness, and per-plugin metering for a
// focused FX editor. Sends a plugin catalog on connect. No JACK / audio.
import net from 'net';

const SOCK = process.env.AES67_SOCKET_PATH || '/tmp/aes67_showcase.sock';
const SR = 48000;

const INPUTS = Array.from({ length: 32 }, (_, i) => i + 1);
const BUSES = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
const ALL = [...INPUTS, ...BUSES];

// A believable static mix: base level (dBFS) + how lively each source is.
const rng = (seed) => { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };
const r = rng(7);
const base = {};
for (const id of ALL) {
  if (id === 100) base[id] = { lvl: -8, live: 3 };            // master
  else if (id === 109) base[id] = { lvl: -12, live: 3 };       // monitor
  else if (id >= 101) base[id] = { lvl: -16 - r() * 10, live: 2 + r() * 3 }; // aux
  else base[id] = { lvl: -10 - r() * 22, live: 3 + r() * 6 };  // inputs
}
const phase = Object.fromEntries(ALL.map((id) => [id, r() * Math.PI * 2]));

let state = 0;
let frame = 0;
let lastTick = Date.now();
let fxChannel = -1;
let fxPlugin = -1;

const CATALOG = [
  ['Calf Saturator', 'http://calf.sourceforge.net/plugins/Saturator'],
  ['Calf Crusher', 'http://calf.sourceforge.net/plugins/Crusher'],
  ['Calf Compressor', 'http://calf.sourceforge.net/plugins/Compressor'],
  ['Calf Deesser', 'http://calf.sourceforge.net/plugins/Deesser'],
  ['Calf 8-Band EQ', 'http://calf.sourceforge.net/plugins/Equalizer8Band'],
  ['Calf 5-Band EQ', 'http://calf.sourceforge.net/plugins/Equalizer5Band'],
  ['Calf Vintage Delay', 'http://calf.sourceforge.net/plugins/VintageDelay'],
  ['Calf Reverb', 'http://calf.sourceforge.net/plugins/Reverb'],
  ['Calf Limiter', 'http://calf.sourceforge.net/plugins/Limiter'],
].map(([name, uri]) => ({ uri, name, author: 'Calf Studio Gear', reportsLatency: false, controlPorts: [] }));

function connect() {
  const sock = net.connect(SOCK, () => {
    console.log('[showcase-engine] connected', SOCK);
    sock.write(JSON.stringify({ type: 'plugin_list', plugins: CATALOG }) + '\n');
  });
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'transport_play') state = state === 2 ? 2 : 1;
      else if (m.type === 'transport_stop') state = 0;
      else if (m.type === 'transport_locate') frame = Math.max(0, Number(m.frame) || 0);
      else if (m.type === 'fx_focus') { fxChannel = m.channel ?? -1; fxPlugin = m.busId ?? -1; }
    }
  });

  const tick = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTick) / 1000; lastTick = now;
    if (state !== 0) frame += Math.round(dt * SR);
    const t = now / 1000;

    const channels = {};
    for (const id of ALL) {
      const b = base[id];
      const wob = Math.sin(t * (0.7 + b.live * 0.15) + phase[id]) * (b.live * 0.6)
        + Math.sin(t * 3.3 + phase[id] * 2) * (b.live * 0.35);
      const l = b.lvl + wob + (Math.random() - 0.5) * 1.5;
      const rr = b.lvl + wob * 0.92 + (Math.random() - 0.5) * 1.5;
      channels[id] = { l: Math.min(2, l), r: Math.min(2, rr) };
    }

    // Master analyser: pink-ish tilt spectrum with slow motion.
    const rta = Array.from({ length: 31 }, (_, k) => {
      const tilt = -6 - k * 1.1;
      return tilt + Math.sin(t * 1.7 + k * 0.6) * 5 + Math.sin(t * 0.4 + k) * 3 - 12;
    });
    const gonio = [];
    for (let i = 0; i < 48; i++) {
      const a = t * 2 + i * 0.13;
      const spread = 0.55 + 0.35 * Math.sin(t * 0.5);
      gonio.push(Math.sin(a) * spread, Math.sin(a * 1.03 + 0.6) * spread);
    }
    const corr = 0.35 + 0.4 * Math.sin(t * 0.3);

    const lufs = {
      m: -14.2 + Math.sin(t * 0.9) * 1.4 + (Math.random() - 0.5) * 0.4,
      s: -14.0 + Math.sin(t * 0.35) * 0.9,
      i: state !== 0 ? -13.9 : -14.1,
      tp: -1.0 - Math.random() * 0.8,
    };

    const msg = { type: 'metering', channels, master: { rta, gonio, corr }, lufs,
      transport: { frame, state, sr: SR, buf: 128, pbUnderrun: 0, monInMask: 0 } };

    if (fxChannel >= 0 && fxPlugin >= 0) {
      const inL = base[fxChannel] ? base[fxChannel].lvl + 4 : -12;
      msg.fx = {
        channel: fxChannel, pluginIndex: fxPlugin,
        inL: inL + Math.sin(t * 4) * 3, inR: inL + Math.sin(t * 4 + 1) * 3,
        outL: inL - 2 + Math.sin(t * 4) * 2, outR: inL - 2 + Math.sin(t * 4 + 1) * 2,
        rta: Array.from({ length: 31 }, (_, k) => -8 - k * 1.0 + Math.sin(t * 2 + k * 0.7) * 7),
      };
    }
    sock.write(JSON.stringify(msg) + '\n');
  }, 33);

  sock.on('close', () => { clearInterval(tick); setTimeout(connect, 500); });
  sock.on('error', (e) => console.log('[showcase-engine] err', e.message));
}
connect();

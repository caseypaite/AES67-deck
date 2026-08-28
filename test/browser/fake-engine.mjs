// Minimal stand-in for the C++ engine: connects to the server IPC socket,
// answers transport commands, and streams ~25 Hz metering frames carrying a
// synthetic `lufs` block and the transport clock — enough to exercise the
// cue list (playhead) and the loudness strip / CSV log without JACK or audio
// hardware.
import net from 'net';

const SOCK = process.env.AES67_SOCKET_PATH || '/tmp/aes67_bt.sock';
const SR = 48000;

let state = 0; // 0 stop, 1 play, 2 record
let frame = 0;
let lastTick = Date.now();
// Phase 3e loop / punch region (mirrors engine/src/main.cpp Transport).
let loop = { in: 0, out: 0, on: false };
let punch = { in: 0, out: 0, on: false };

function connect() {
  const sock = net.connect(SOCK, () => console.log('[fake-engine] connected', SOCK));
  let buf = '';

  sock.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'transport_play') state = state === 2 ? 2 : 1;
      else if (msg.type === 'transport_stop') state = 0;
      else if (msg.type === 'transport_locate') frame = Math.max(0, Number(msg.frame) || 0);
      else if (msg.type === 'transport_set_loop') {
        loop = { in: Number(msg.start) || 0, out: Number(msg.end) || 0, on: !!msg.enabled && Number(msg.end) > Number(msg.start) };
      } else if (msg.type === 'transport_set_punch') {
        punch = { in: Number(msg.start) || 0, out: Number(msg.end) || 0, on: !!msg.enabled && Number(msg.end) > Number(msg.start) };
      } else if (msg.type === 'start_multitrack_record') {
        state = 2;
        sock.write(JSON.stringify({ type: 'take_started', dir: msg.dir, originFrame: frame, sampleRate: SR, armed: msg.armed || [], ext: 'wv' }) + '\n');
      } else if (msg.type === 'stop_multitrack_record') {
        sock.write(JSON.stringify({ type: 'take_finished', dir: '', originFrame: frame, endFrame: frame, frames: 0, sampleRate: SR, armed: [], ext: 'wv', overrun: false }) + '\n');
        state = 1;
      }
    }
  });

  const tick = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    if (state !== 0) {
      frame += Math.round(dt * SR);
      if (loop.on && loop.out > loop.in && frame >= loop.out) {
        frame = loop.in + ((frame - loop.out) % (loop.out - loop.in));
      }
    }

    // Synthetic loudness: hovers around -14.5 LUFS, true-peak around -1.3.
    const wob = Math.sin(now / 1500) * 0.6;
    const lufs = {
      m: -14.5 + wob + (Math.random() - 0.5) * 0.3,
      s: -14.6 + wob * 0.5,
      i: state !== 0 ? -14.8 : -120.0,
      tp: -1.3 + Math.random() * 0.2,
    };
    sock.write(JSON.stringify({
      type: 'metering',
      channels: { 100: { l: -6 + wob, r: -6 + wob } },
      lufs,
      transport: {
        frame, state, sr: SR, buf: 128, pbUnderrun: 0, monInMask: 0,
        loopOn: loop.on ? 1 : 0, loopIn: loop.in, loopOut: loop.out,
        punchOn: punch.on ? 1 : 0, punchIn: punch.in, punchOut: punch.out,
      },
    }) + '\n');
  }, 40);

  sock.on('close', () => { clearInterval(tick); setTimeout(connect, 500); });
  sock.on('error', (e) => console.log('[fake-engine] err', e.message));
}
connect();

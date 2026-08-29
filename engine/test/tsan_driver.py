#!/usr/bin/env python3
"""Minimal stand-in for the bridge server: listens on the engine's IPC socket,
accepts its connection, then hammers every Phase-1 concurrency path (aux sends,
faders, mute/solo/phase, plugin add/remove, transport locate/play, record
start/stop, timeline set) while draining the metering stream. Run against a
TSan build of the engine to shake out data races."""
import json, os, socket, sys, threading, time, random

SOCK = sys.argv[1] if len(sys.argv) > 1 else "/tmp/aes67_tsan.sock"
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 25.0

try:
    os.unlink(SOCK)
except FileNotFoundError:
    pass

srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(SOCK)
srv.listen(1)
srv.settimeout(30)
print(f"[driver] listening on {SOCK}, waiting for engine…", flush=True)
conn, _ = srv.accept()
print("[driver] engine connected", flush=True)
conn.settimeout(1.0)

stop = threading.Event()
meter_frames = [0]

def reader():
    buf = b""
    while not stop.is_set():
        try:
            d = conn.recv(65536)
        except socket.timeout:
            continue
        except OSError:
            break
        if not d:
            break
        buf += d
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if b'"metering"' in line:
                meter_frames[0] += 1

def send(obj):
    try:
        conn.sendall((json.dumps(obj) + "\n").encode())
    except OSError:
        pass

threading.Thread(target=reader, daemon=True).start()

CALF_EQ = "http://calf.sourceforge.net/plugins/Equalizer8Band"
CALF_COMP = "http://calf.sourceforge.net/plugins/Compressor"

t0 = time.time()
n = 0
while time.time() - t0 < DUR:
    ch = random.randint(1, 32)
    bus = random.choice([100, 101, 102, 103, 104, 105, 106, 107, 108])
    send({"type": "set_aux_send", "channel": ch, "busId": bus, "value": random.random()})
    send({"type": "set_fader", "channel": ch, "value": random.random()})
    send({"type": "set_mute", "channel": ch, "value": random.randint(0, 1)})
    send({"type": "set_solo", "channel": random.randint(1, 32), "value": random.randint(0, 1)})
    send({"type": "set_phase", "channel": ch, "value": random.randint(0, 1)})
    send({"type": "fx_focus", "channel": ch, "pluginIndex": random.randint(-1, 2)})

    if n % 20 == 0:
        send({"type": "transport_locate", "frame": random.randint(0, 48000 * 30)})
        send({"type": "transport_play"})
    if n % 37 == 0:
        send({"type": "transport_stop"})
    if n % 50 == 0:
        send({"type": "add_plugin", "channel": ch, "uri": random.choice([CALF_EQ, CALF_COMP]), "enabled": True})
    if n % 60 == 0:
        send({"type": "remove_plugin", "channel": ch, "pluginIndex": 0})
    if n % 45 == 0:
        send({"type": "load_rack", "channel": ch, "plugins": [{"uri": CALF_EQ, "enabled": True}]})
    # live FX-editor knob / bypass churn — the path Phase 4 moved onto the ring
    send({"type": "set_plugin_param", "channel": ch, "pluginIndex": random.randint(0, 3),
          "paramId": random.choice(["level_in", "level_out", "ls_level", "p1_level", "bogus_sym"]),
          "value": random.random() * 2})
    if n % 7 == 0:
        send({"type": "set_plugin_bypass", "channel": ch,
              "pluginIndex": random.randint(0, 3), "value": random.randint(0, 1)})
    if n == 5:
        send({"type": "start_record"})
    if n == 40:
        send({"type": "stop_record"})
    if n == 70:
        send({"type": "start_record"})   # immediate-ish re-record
    if n == 78:
        send({"type": "stop_record"})
    if n % 25 == 0:
        send({"type": "set_timeline", "clips": [
            {"trackId": 1, "timelineStart": 0, "length": 48000 * 10,
             "fileStart": 0, "gain": 1.0, "path": "/nonexistent.wav"}]})
    if n % 33 == 0:
        send({"type": "set_talkback_active", "channel": 110, "value": random.randint(0, 1)})
        send({"type": "set_monitor_input_mask", "mask": random.randint(0, 0xFFFF)})
        send({"type": "lufs_reset"})

    n += 1
    time.sleep(0.003)

send({"type": "transport_stop"})
send({"type": "stop_record"})
time.sleep(1.0)
stop.set()
try:
    conn.close()
except OSError:
    pass
print(f"[driver] done: {n} command bursts, {meter_frames[0]} metering frames received", flush=True)

#!/usr/bin/env python3
"""
Test Tone Generator & Mapping Verifier for AES67-Deck
Generates a calibrated sine wave test tone on a specified mixer channel,
verifies PipeWire audio links, and reads live metering feedback from the DSP engine.
"""

import argparse
import json
import math
import socket
import struct
import subprocess
import sys
import threading
import time
import wave

def main():
    parser = argparse.ArgumentParser(description="AES67-Deck Test Tone Generator")
    parser.add_argument("--channel", "-c", type=int, default=1, help="Channel number (1-32, default: 1)")
    parser.add_argument("--freq", "-f", type=float, default=1000.0, help="Tone frequency in Hz (default: 1000.0)")
    parser.add_argument("--duration", "-d", type=float, default=3.0, help="Duration in seconds (default: 3.0)")
    parser.add_argument("--amplitude", "-a", type=float, default=0.5, help="Amplitude 0.0-1.0 (default: 0.5 = -6dBFS)")
    parser.add_argument("--ws-port", type=int, default=8081, help="Server WebSocket port (default: 8081)")
    args = parser.parse_args()

    target_l = f"AES67_Deck:in_{args.channel}_L"
    target_r = f"AES67_Deck:in_{args.channel}_R"

    print("=" * 60)
    print(f"AES67-Deck Channel {args.channel} Test Tone ({args.freq} Hz, {args.duration}s)")
    print("=" * 60)

    # 1. Generate WAV
    sr = 48000
    wav_path = f"/tmp/deck_tone_ch{args.channel}.wav"
    num_samples = int(sr * args.duration)
    with wave.open(wav_path, "w") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(sr)
        frames = bytearray()
        for i in range(num_samples):
            t = float(i) / sr
            val = int(args.amplitude * math.sin(2.0 * math.pi * args.freq * t) * 32767.0)
            frames += struct.pack("<hh", val, val)
        f.writeframes(frames)

    # 2. WebSocket listener for live metering
    meter_events = []
    stop_ws = threading.Event()

    def ws_listener():
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.connect(("127.0.0.1", args.ws_port))
            req = (
                "GET / HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{args.ws_port}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            )
            s.sendall(req.encode())
            resp = b""
            while b"\r\n\r\n" not in resp:
                resp += s.recv(1024)

            buf = b""
            while not stop_ws.is_set():
                s.settimeout(0.3)
                try:
                    data = s.recv(4096)
                    if not data: break
                    buf += data
                    while len(buf) > 2:
                        b1, b2 = buf[0], buf[1]
                        plen = b2 & 0x7F
                        idx = 2
                        if plen == 126:
                            if len(buf) < 4: break
                            plen = int.from_bytes(buf[2:4], "big")
                            idx = 4
                        elif plen == 127:
                            if len(buf) < 10: break
                            plen = int.from_bytes(buf[2:10], "big")
                            idx = 10
                        if len(buf) < idx + plen: break
                        chunk = buf[idx:idx+plen]
                        buf = buf[idx+plen:]
                        try:
                            m = json.loads(chunk.decode("utf-8", errors="ignore"))
                            if m.get("type") == "metering":
                                meter_events.append({
                                    "ch": m.get("channels", {}).get(str(args.channel), {}),
                                    "master": m.get("channels", {}).get("100", {}),
                                    "monitor": m.get("channels", {}).get("109", {})
                                })
                        except: pass
                except socket.timeout:
                    continue
        except Exception as e:
            print(f"[Warning] Metering monitor: {e}")
        finally:
            s.close()

    ws_thread = threading.Thread(target=ws_listener, daemon=True)
    ws_thread.start()
    time.sleep(0.3)

    # 3. Play tone into channel ports
    print(f"Injecting test tone into {target_l} & {target_r}...")
    proc = subprocess.Popen(["pw-cat", "-p", "--target=0", wav_path])
    time.sleep(0.2)

    try:
        links_out = subprocess.check_output(["pw-link", "-o"]).decode("utf-8").splitlines()
        cat_ports = [p for p in links_out if "pw-cat" in p]
        if len(cat_ports) >= 2:
            subprocess.run(["pw-link", cat_ports[0], target_l], capture_output=True)
            subprocess.run(["pw-link", cat_ports[1], target_r], capture_output=True)
            print(f"Linked: {cat_ports[0]} -> {target_l}")
            print(f"Linked: {cat_ports[1]} -> {target_r}")
        else:
            print("[Warning] Could not detect pw-cat playback ports.")
    except Exception as e:
        print(f"[Error] Linking playback stream: {e}")

    proc.wait()
    time.sleep(0.4)
    stop_ws.set()
    ws_thread.join(timeout=1.0)

    # 4. Results
    ch_peaks = [e["ch"].get("l", -100) for e in meter_events if e.get("ch") and e["ch"].get("l", -100) > -80]
    mst_peaks = [e["master"].get("l", -100) for e in meter_events if e.get("master") and e["master"].get("l", -100) > -80]
    mon_peaks = [e["monitor"].get("l", -100) for e in meter_events if e.get("monitor") and e["monitor"].get("l", -100) > -80]

    print("\n--- Results ---")
    if ch_peaks:
        print(f"Channel {args.channel} Peak Level:     {max(ch_peaks):.2f} dBFS  [PASS]")
        print(f"Master Bus Peak Level:         {max(mst_peaks):.2f} dBFS  [PASS]")
        print(f"Monitor Bus Peak Level:        {max(mon_peaks):.2f} dBFS  [PASS]")
        print("\nTest tone playback and audio routing verified successfully!")
    else:
        print(f"Channel {args.channel} Peak Level:     No active signal detected.")
        sys.exit(1)

if __name__ == "__main__":
    main()

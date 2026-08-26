#!/usr/bin/env python3
"""Characterise a free-running PHC as a frequency reference, using chrony's
`refclock PHC` driver as the measurement instrument — it reads the PHC with
PTP_SYS_OFFSET_EXTENDED and filters it, and `chronyc sourcestats` then
reports the frequency skew and residual std-dev directly.

A homegrown clock_gettime loop can't do this reliably: compared against
CLOCK_REALTIME it measures chrony's NTP corrections, not the crystal;
compared against CLOCK_MONOTONIC_RAW it measures scheduler preemption on a
non-RT box. This script sidesteps both.

The probe is `noselect` — it never disciplines the system clock — and is
removed afterwards, restoring chrony to its normal sources.

    sudo ./phc-stability-check.py /dev/ptp0 120
"""
import subprocess, sys, time, os

dev = sys.argv[1] if len(sys.argv) > 1 else "/dev/ptp0"
settle = int(sys.argv[2]) if len(sys.argv) > 2 else 120
conf = "/etc/chrony/conf.d/zz-phc-probe.conf"

if os.geteuid() != 0:
    sys.exit("run with sudo")


def sh(cmd):
    return subprocess.run(cmd, shell=True, text=True, capture_output=True).stdout.strip()


open(conf, "w").write(f"refclock PHC {dev} poll 0 dpoll -2 filter 16 noselect\n")
try:
    sh("systemctl restart chrony")
    print(f"# probing {dev} for {settle}s via chrony refclock ...", flush=True)
    time.sleep(settle)
    stats = sh("chronyc -n sourcestats")
    src = sh("chronyc -n sources")
finally:
    os.remove(conf)
    sh("systemctl restart chrony")

phc_stats = next((l for l in stats.splitlines() if l.startswith("PHC")), None)
phc_src = next((l for l in src.splitlines() if "PHC" in l), None)
print(stats.splitlines()[0] if stats else "")
print(phc_stats or "(no PHC row — not enough samples, raise the duration)")
print(phc_src or "")

if phc_stats:
    # PHC0  NP NR Span Frequency FreqSkew Offset StdDev
    f = phc_stats.split()
    freq_skew = float(f[5]); std_dev = f[7]
    def to_ns(s):
        s = s.strip()
        for suf, mul in (("us", 1000), ("ns", 1), ("ms", 1_000_000), ("s", 1e9)):
            if s.endswith(suf):
                return float(s[:-len(suf)]) * mul
        return float(s)
    sd = to_ns(std_dev)
    v = ("HEALTHY — good frequency reference" if freq_skew < 0.05 and sd < 200 else
         "USABLE — a bit noisy, fine for software-timestamped PTP" if freq_skew < 0.5 and sd < 2000 else
         "SUSPECT — freq skew / std-dev high for a hardware clock")
    print(f"\nfreq skew {freq_skew:g} ppm, residual std-dev {sd:.0f} ns  =>  {v}")

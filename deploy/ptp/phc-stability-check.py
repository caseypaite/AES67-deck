#!/usr/bin/env python3
"""Characterise a free-running PHC against CLOCK_MONOTONIC_RAW (undisciplined
TSC). Reports the rate offset between the two crystals and the short-term
jitter around that linear drift. Erratic residuals => suspect clock block."""
import os, sys, time, statistics

dev = sys.argv[1] if len(sys.argv) > 1 else "/dev/ptp0"
dur = int(sys.argv[2]) if len(sys.argv) > 2 else 240
interval = 2.0

fd = os.open(dev, os.O_RDONLY)
PHC = ((~fd) << 3) | 3          # FD_TO_CLOCKID
RAW = time.CLOCK_MONOTONIC_RAW

def pair():
    # bracket the PHC read with RAW reads to bound the sampling error
    a = time.clock_gettime_ns(RAW)
    p = time.clock_gettime_ns(PHC)
    b = time.clock_gettime_ns(RAW)
    return (a + b) // 2, p, b - a

r0, p0, _ = pair()
xs, ys, errs = [], [], []
print(f"# sampling {dev} vs CLOCK_MONOTONIC_RAW for {dur}s ...", flush=True)
end = r0 + dur * 1_000_000_000
while time.clock_gettime_ns(RAW) < end:
    r, p, e = pair()
    xs.append(r - r0); ys.append(p - p0); errs.append(e)
    time.sleep(interval)

n = len(xs)
mx = sum(xs) / n; my = sum(ys) / n
sxx = sum((x - mx) ** 2 for x in xs)
slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
ppm = (slope - 1) * 1e6
resid = [y - (slope * (x - mx) + my) for x, y in zip(xs, ys)]
drift = [y - x for x, y in zip(xs, ys)]          # accumulated PHC-RAW gap

print(f"samples          : {n} over {xs[-1]/1e9:.1f}s")
print(f"read window err  : median {statistics.median(errs):.0f} ns, max {max(errs):.0f} ns")
print(f"rate offset      : {ppm:+.3f} ppm  (PHC vs TSC crystal)")
print(f"fit residual     : rms {statistics.pstdev(resid):.0f} ns, peak {max(abs(r) for r in resid):.0f} ns")
mono = all(drift[i] <= drift[i+1] for i in range(len(drift)-1)) or \
       all(drift[i] >= drift[i+1] for i in range(len(drift)-1))
print(f"drift monotonic  : {mono}")
step = max(abs(drift[i+1]-drift[i]) for i in range(len(drift)-1))
print(f"largest step     : {step:.0f} ns between consecutive 2s samples")
for i in range(0, n, max(1, n // 12)):
    print(f"  t={xs[i]/1e9:6.1f}s  gap={drift[i]:+d} ns")
verdict = "HEALTHY" if (abs(ppm) < 120 and statistics.pstdev(resid) < 2000 and step < 20000) else "SUSPECT — inspect before relying on it"
print(f"verdict          : {verdict}")

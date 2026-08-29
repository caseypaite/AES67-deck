# Deploying AES67-Deck as an appliance

Provisioning assets for running AES67-Deck headless on a dedicated Ubuntu
box (reference target: `ck-aes67`, Ubuntu 26.04, Lenovo ThinkCentre,
i5-4570 / 4 GB). Adjust the NIC name and host specifics for your machine.

## Layout

| Path | Installs to | Purpose |
|---|---|---|
| `sysctl/99-realtime-audio.conf` | `/etc/sysctl.d/` | RT scheduler throttle off, low swappiness, bigger socket buffers |
| `limits/95-audio-realtime.conf` | `/etc/security/limits.d/` | `@audio` → rtprio 95, memlock unlimited, nice -19 |
| `systemd/cpu-performance.service` | `/etc/systemd/system/` | lock CPU governor to `performance` at boot |
| `pipewire/*.conf` | `~/.config/pipewire/pipewire.conf.d/` | 48 kHz / quantum 128 clock; RAVENNA sink+source bridge; `AES67 System Audio` capture sink |
| `wireplumber/*.conf` | `~/.config/wireplumber/wireplumber.conf.d/` | never idle-suspend the AES67 nodes; keep WirePlumber off the RAVENNA card |
| `dkms/{dkms.conf,Makefile}` | `/usr/src/mergingravennaalsa-2.1/` | build the RAVENNA ALSA kernel module via DKMS |
| `modules/aes67.conf` | `/etc/modules-load.d/` | load `MergingRavennaALSA` at boot |
| `systemd/aes67-deck-{server,engine}.service` | `~/.config/systemd/user/` | run the stack as lingering user services |
| `nginx/aes67-deck` | `/etc/nginx/sites-available/` | serve the built UI on port 80 |
| `watch/aes67-watch.{sh,service}` | `/usr/local/bin/`, `/etc/systemd/system/` | log PTP lock + AES67 stream discovery to `/var/log/aes67-watch.log` |

## Order

1. `provision-rt.sh` — RT limits, sysctl, governor, kernel cmdline
   (`pcie_aspm=off threadirqs`), PipeWire linger + config. Installs
   `linux-lowlatency` (generic kernel + `preempt=full` boot args).
2. `build-daemon.sh` — RAVENNA kernel module (DKMS, MOK-signed) +
   `aes67-linux-daemon` (expects `~/aes67-linux-daemon` with submodules).
3. `build-deck.sh` — activate pipewire-jack, build the engine, build the
   server (`tsc` → `dist/`), deploy the UI to `/var/www/aes67-deck`,
   install + enable the user services and the nginx site.
4. Handle Secure Boot (enroll the MOK key or disable SB in BIOS), then
   **reboot** to pick up the low-latency cmdline and load the module.

## Local patches to `~/aes67-linux-daemon`

`build-daemon.sh` builds from a working copy of the upstream
[`bondagit/aes67-linux-daemon`](https://github.com/bondagit/aes67-linux-daemon)
at `~/aes67-linux-daemon`. That checkout carries two local commits on
`master` (not upstreamed — `master` otherwise tracks `origin/master`
exactly):

- **`systemd/install.sh` — run the daemon as the appliance user, not a
  dedicated system user.** Upstream's `install.sh` does
  `useradd ... aes67-daemon` (a `/sbin/nologin` system account) and
  installs all state/config owned by it. The appliance drives the entire
  stack from one lingering user account that already owns the
  PipeWire/JACK graph and the RAVENNA ALSA device, so the daemon has to
  run as that same user. The patch drops the `useradd`, installs
  `/var/lib/aes67-daemon`, the scripts dir, `daemon.conf` and
  `status.json` owned by `${SUDO_USER:-$USER}`, rewrites `User=` in the
  installed `aes67-daemon.service` via `sed`, and warns if run directly
  as root.

  Note `build-daemon.sh` in this repo does **not** call upstream's
  `install.sh` — it installs the daemon itself (step 4) and creates
  `aes67-daemon` via `systemd-sysusers`. If you switch to running the
  daemon as a systemd **user** service alongside the rest of the stack,
  apply the same `User=`/ownership change to step 4 here.

- **`3rdparty/ravenna-alsa-lkm` submodule bumped `b8dd5cd → e8579da`
  (Merging RAVENNA ALSA v2.1).** Needed for:
  - **CPU-pinned audio timer on kernel ≥ 6.15** — the appliance runs
    `linux-lowlatency` with `preempt=full`; the older submodule's timer
    code doesn't build / behave correctly on 6.15+.
  - `kill_clock_timer` actually stopping the timer (was a no-op upstream).
  - ST-2022-7 (seamless redundant streams) support in the driver.

  The DKMS package built by `build-daemon.sh` is versioned `2.1` and
  copies `driver/` + `common/` straight from this submodule, so the bump
  takes effect on the next `build-daemon.sh` run. An untracked
  `driver/MergingRavennaALSA.mod` build artifact inside the submodule is
  expected and harmless.

## Secure Boot

The RAVENNA module is out-of-tree. Two ways to let it load:

**A. Enroll the machine-owner certificate (keeps Secure Boot on — preferred).**
The key pair is `/var/lib/shim-signed/mok/MOK.{der,priv}` (from
`update-secureboot-policy --new-key`); `dkms/mok-signing.conf` pins it in
`/etc/dkms/framework.conf.d/` so **every** DKMS build — now and on future
kernel updates — is signed with it. The cert just has to be enrolled once:

```bash
sudo deploy/secureboot/enroll-mok.sh     # shows the fingerprint, runs mokutil --import
sudo reboot
# at the blue "MOK Manager" screen (needs a monitor+keyboard for this one boot):
#   Enroll MOK → Continue → Yes → <the password you set>
```

Verify afterwards: `mokutil --list-enrolled | grep ck-aes67`, then
`sudo modprobe MergingRavennaALSA` loads silently.

The signed module's `modinfo` `sig_key` equals the cert serial
(`45:AD:62:…` on `ck-aes67`) — that's the check that enrollment will make
it loadable.

**B. Disable Secure Boot in firmware** (ThinkCentre: F1 → Security → Secure
Boot → Disabled). Simpler, no per-key-rotation upkeep, but drops Secure
Boot's protection entirely.

## Network

`daemon.conf` `interface_name` should be an interface with a **hardware
PTP clock** (`ethtool -T <if>` shows `hardware-*` timestamping) for proper
AES67 sync. Software-timestamping NICs work but with worse jitter.

## PTP / clocking

The RAVENNA driver runs the AES67 media clock as a **PTP slave** — with no
grandmaster on the wire the ALSA device opens but never transfers samples
(`ptp/status` = `unlocked`, write stalls then closes).

**The grandmaster must be a separate machine.** The driver captures PTP at
`NF_INET_PRE_ROUTING` (`c_wrapper_lib.c`) — ingress from a NIC only, never
locally-originated multicast. A `ptp4l` GM *on the same box* takes the
grandmaster role but the driver never sees it (tested on `ck-aes67`). So:

- **`ptp4l-aes67-gm.service` on this box does NOT feed the local RAVENNA
  driver** — it's only useful for making *other* LAN devices slave to this
  box. Kept staged/disabled for that case.
- **Path 1** (`phc2sys` → a RAVENNA PHC) is impossible — the Merging
  driver registers no `/dev/ptp` clock (it uses an internal hrtimer).

Working options for the grandmaster:
1. **A Dante device in AES67 mode** — it runs a PTPv2 GM on domain 0.
   Verified on `ck-aes67` 2026-08-26: the RAVENNA driver locked to an
   Audinate GMID (`00-1D-C1-…`) and a Dante `L24/48000/2`, `ptime:1`
   source (`239.69.x.x`) was received end-to-end into the mixer engine.
   Just `playout_delay ≥ 96` in `daemon.conf` (software-timestamped
   slave needs the buffer headroom).
2. A dedicated small box on the LAN (e.g. a Raspberry Pi) running
   `ptp4l -i eth0 -f gm.conf` on domain 0.
3. A **second NIC in this box** running `ptp4l` GM, plugged into the same
   switch as `enp3s0` — the switch floods the PTP multicast back to
   `enp3s0`'s port, so it arrives as wire ingress and PRE_ROUTING sees it.
   With the replacement HW-PTP NIC this is the clean single-box setup:
   `ptp4l` GM on the new NIC (hardware timestamping, clocked off the free-
   running I217 PHC at `/dev/ptp0` — 0.002 ppm skew, verified), RAVENNA on
   `enp3s0`.
4. A PTP-capable switch / hardware master as GM.

`aes67-gm.conf` `domainNumber` must equal `daemon.conf` `ptp_domain`
(both 0). `eno1` does **not** need to be `up` for `/dev/ptp0` to tick.
Never run `phc2sys -s CLOCK_REALTIME -c /dev/ptp0` (pipes NTP jitter into
the reference).

### RAVENNA ALSA period + graph clock master

`20-aes67-ravenna-bridge.conf` pins `api.alsa.period-size = 48`
(= `daemon.conf` `tic_frame_size_at_1fs`) with `period-num = 2` and
`disable-tsched` — the driver rejects periods that don't match its tic
frame size, and **ignores a larger `period-num`** (negotiated `hw_params`
stays `buffer_size: 96` regardless — the "expected 192" hint does not
apply). So the card's jitter buffer is a fixed 96 samples / 2 ms.

Because that buffer is tiny, **the RAVENNA card must be the PipeWire graph
clock master**, not the on-board analog crystal. `AES67_Sink` /
`AES67_Source` carry `priority.driver = 100000 / 90000`, and
`wireplumber/53-aes67-clock-master.conf` demotes the analog output to
`10`. Without this the analog drives, `AES67_Sink` follows and is
rate-adapted against a drifting local clock, and the network output runs
**200–500 xruns/s** (seen on `ck-aes67` 2026-08-29). With RAVENNA driving,
`10-aes67-clock-48khz.conf` pins the graph quantum to **48** (phase-locked
to the 1 ms tic) — a bigger quantum overflows the 96-sample buffer and
makes it worse.

Two more props on those nodes, both learned the hard way on `ck-aes67`:

- `priority.session = 100` — a high `priority.driver` also made WirePlumber
  pick `AES67_Sink` as the **default output sink**, so apps played straight
  to the wire instead of into the mixer. Pin the bridge nodes low for
  default-sink selection (the on-board analog sits at ~1009,
  `AES67_System_Audio` at 2000).
- `AES67_Source` `node.always-process = true` — the aes67-daemon writes
  received RTP into `hw:RAVENNA` capture; if PipeWire has that PCM closed
  (nothing routed downstream) the daemon reports the RX sink as
  `all_muted` and drops the audio. `always-process` keeps the capture open
  continuously so a subscribed stream is live the moment it's routed.

Verify after deploy: `pw-top -b -n 8 | grep AES67_Sink` — the line should
be a top-level driver (`R  <id>  48  48000 …`, not `+`-indented) with the
`ERR` column flat over successive runs. `pw-dump` →
`AES67_Sink … "node.driver-id"` should be absent/None (it drives itself);
`pw-metadata -n default | grep default.audio.sink` → `AES67_System_Audio`.

## AES67 network I/O for the mix (plan Phase 2)

`20-aes67-ravenna-bridge.conf` opens the RAVENNA PCM as **AES67_Sink = 20
playout ch** (the deck's mix products) and **AES67_Source = 32 capture ch**
(subscribed streams), both `AUX0..N` positions → ports
`AES67_Sink:playback_AUX{n}` / `AES67_Source:capture_AUX{n}`. The server:

- pins each engine mix-product output to its fixed sink channel on every
  engine (re)connect and patchbay apply (`applyBroadcastRouting`) — Master
  L/R → AUX0-1, Monitor L/R → AUX2-3, `bus_101..108` L/R → AUX4-19;
- auto-provisions the 4 transmit **Sources** (Master / Monitor / AUX 1-4 /
  AUX 5-8) from `tx_sources.json`, converging the daemon on every poll
  (`reconcileTxSources`). Groups default **disabled** — enable them from the
  deck's PATCHBAY → AES67 NETWORK panel;
- allocates a contiguous `AES67_Source` capture block to each **Sink** it
  creates, persisted in `rx_sinks.json` and re-asserted after a daemon
  restart (`reconcileRxSinks`). Subscribed sinks show up in the SOURCES
  registry with ports pre-filled.

No engine rebuild — all 20 mix-product JACK ports already exist. The
per-bus **Output Endpoints** (DESTINATIONS panel) still route to non-AES67
hardware; Master/Aux/Monitor now *also* always have a dedicated AES67
stream regardless of that assignment.

**Caveats (operational):**

- **PTP lock required to transmit *and* receive** — no grandmaster ⇒
  Sources/Sinks exist but don't run.
- **Deploy:** reinstall the pipewire drop-in and restart PipeWire (this
  kills the engine — the JACK server restarts under it — and it comes back;
  the server re-drives every pw-link on reconnect). No engine rebuild.
  Then confirm the driver accepted the wider config:
  `cat /proc/asound/card0/pcm0p/sub0/hw_params` (20-ch playout) and
  `.../pcm0c/sub0/hw_params` (32-ch capture) — both are well under the
  driver's `channels_max = 128`, but if it balks, drop `AES67_Source` to
  16 ch in the drop-in.
  `pw-link -l | grep AES67_Sink:playback_AUX` should show the 20 engine
  links; `curl $DAEMON/api/sources` the enabled Deck Sources.
- **Bandwidth / CPU:** 20-ch TX L24 @ 48 k @ 1 ms ≈ 24 Mbit/s + ~4 000
  pkt/s across 4 streams, plus subscribed RX, with software PTP on the
  i5-4570 — comfortable, but enable TX groups incrementally and watch
  `/var/log/aes67-watch.log`, PTP offset, and engine xruns.

`ptp/phc-stability-check.py <dev> <seconds>` characterises a free-running
PHC (rate offset + jitter vs the undisciplined TSC) before you rely on it.

## Local machine audio (system audio in, monitoring out)

Same design on the dev workstation and the appliance — nothing per-host:

- **This machine's own playback → the mixer.** `pipewire/30-aes67-system-audio.conf`
  creates a virtual sink **`AES67 System Audio`**. The deck server makes it the
  default output (`pactl set-default-sink`, `ensureSystemAudioDefault()` — run at
  start and re-asserted on every engine reconnect; WirePlumber then persists the
  choice in `~/.local/state/wireplumber/default-nodes`), so the browser, a media
  player, notification sounds — everything — land on it. The server links its
  output to a mixer input channel via the patchbay; **channel 1 by default**
  (`DEFAULT_PATCHBAY_MAPPINGS`, seeded when no `patchbay_config.json` exists yet),
  so a headless box has its own audio on a fader before anyone opens the UI.
  The loopback has **no `node.target`** — system audio only ever reaches the
  mixer, never the wire or the speakers directly. Put it on an AES67 stream or
  in the operator's phones by routing the Master / an Aux / the Monitor bus.

- **Monitor bus → the machine's headphone jack.** `resolveMonitorOutputPorts()`
  scores the live graph's ALSA sinks (`head*phone` route ≫ `analog` ≫ on-board
  PCI ≫ Pro profile ≫ USB), skips the RAVENNA bridge, the `AES67 System Audio`
  virtual sink, and HDMI/SPDIF, and links `AES67_Deck:monitor_L/R` to that
  node's `FL/FR` (or `AUX0/1`) pair. Pin it with
  `DECK_MONITOR_PORTS="node:portL,node:portR"` in the server's environment if a
  box guesses wrong. Fallback: `alsa_output.pci-0000_00_1b.0.analog-stereo`
  (ck-aes67's on-board PCH).

**Deploy:** `provision-rt.sh` installs `30-aes67-system-audio.conf`; restart
PipeWire (kills+respawns the engine, server re-drives every link). Verify:
`pactl get-default-sink` → `AES67_System_Audio`; play something and check
`pw-link -l | grep -A2 AES67_System_Audio_Loopback:output` shows links only to
`AES67_Deck:in_1`; `grep 'Monitor routing applied' ` the server log points at
the on-board analog card.

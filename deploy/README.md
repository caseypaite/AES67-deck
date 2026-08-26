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
| `pipewire/*.conf` | `~/.config/pipewire/pipewire.conf.d/` | 48 kHz / quantum 128 clock; RAVENNA sink+source bridge |
| `wireplumber/*.conf` | `~/.config/wireplumber/wireplumber.conf.d/` | never idle-suspend the AES67 nodes |
| `dkms/{dkms.conf,Makefile}` | `/usr/src/mergingravennaalsa-2.1/` | build the RAVENNA ALSA kernel module via DKMS |
| `modules/aes67.conf` | `/etc/modules-load.d/` | load `MergingRavennaALSA` at boot |
| `systemd/aes67-deck-{server,engine}.service` | `~/.config/systemd/user/` | run the stack as lingering user services |
| `nginx/aes67-deck` | `/etc/nginx/sites-available/` | serve the built UI on port 80 |

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
1. A dedicated small box on the LAN (e.g. a Raspberry Pi) running
   `ptp4l -i eth0 -f gm.conf` on domain 0.
2. A **second NIC in this box** running `ptp4l` GM, plugged into the same
   switch as `enp3s0` — the switch floods the PTP multicast back to
   `enp3s0`'s port, so it arrives as wire ingress and PRE_ROUTING sees it.
   With the replacement HW-PTP NIC this is the clean single-box setup:
   `ptp4l` GM on the new NIC (hardware timestamping, clocked off the free-
   running I217 PHC at `/dev/ptp0` — 0.002 ppm skew, verified), RAVENNA on
   `enp3s0`.
3. A PTP-capable switch / hardware master / another AES67 device as GM.

`aes67-gm.conf` `domainNumber` must equal `daemon.conf` `ptp_domain`
(both 0). `eno1` does **not** need to be `up` for `/dev/ptp0` to tick.
Never run `phc2sys -s CLOCK_REALTIME -c /dev/ptp0` (pipes NTP jitter into
the reference).

### RAVENNA ALSA period

`20-aes67-ravenna-bridge.conf` pins `api.alsa.period-size = 48`
(= `daemon.conf` `tic_frame_size_at_1fs`) with `period-num = 2` and
`disable-tsched` — the driver rejects periods that don't match its tic
frame size. Re-verify the negotiated `hw_params` (`cat
/proc/asound/card0/pcm0p/sub0/hw_params`) once a GM is present and the
device actually runs; the driver hints an "expected" buffer of 192.

`ptp/phc-stability-check.py <dev> <seconds>` characterises a free-running
PHC (rate offset + jitter vs the undisciplined TSC) before you rely on it.

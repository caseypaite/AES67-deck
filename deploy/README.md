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

The RAVENNA module is out-of-tree and DKMS-signs it with a machine-owner
key at `/var/lib/shim-signed/mok/MOK.der`. With Secure Boot enabled the
key must be enrolled once:

```bash
sudo mokutil --import /var/lib/shim-signed/mok/MOK.der   # set a one-time password
sudo reboot                                              # at the blue MOK screen: Enroll MOK → password
```

Or disable Secure Boot in firmware and skip the enrollment.

## Network

`daemon.conf` `interface_name` should be an interface with a **hardware
PTP clock** (`ethtool -T <if>` shows `hardware-*` timestamping) for proper
AES67 sync. Software-timestamping NICs work but with worse jitter.

#!/bin/bash
# AES67-Deck realtime-audio OS prep — phases 3-5.
# Idempotent. Assumes deploy/ staged at ~/deploy on the server.
set -euo pipefail
DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
say() { printf '\n=== %s ===\n' "$*"; }

say "audio group + membership"
sudo groupadd -f audio
sudo usermod -aG audio "$USER"

say "RT limits"
sudo install -m 0644 "$DEPLOY/limits/95-audio-realtime.conf" /etc/security/limits.d/

say "sysctl RT/network tuning"
sudo install -m 0644 "$DEPLOY/sysctl/99-realtime-audio.conf" /etc/sysctl.d/
sudo sysctl --system >/dev/null

say "CPU governor -> performance (systemd)"
sudo install -m 0644 "$DEPLOY/systemd/cpu-performance.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cpu-performance.service
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor

say "kernel cmdline drop-in (pcie_aspm=off, threadirqs)"
# Neutralise any pcie_aspm=force in the base config, then append ours.
if grep -q 'pcie_aspm=force' /etc/default/grub 2>/dev/null; then
  sudo sed -i 's/pcie_aspm=force//g' /etc/default/grub
fi
sudo tee /etc/default/grub.d/zz-aes67-rt.cfg >/dev/null <<'GRUB'
# AES67-Deck realtime tuning (sorts last so it wins)
GRUB_CMDLINE_LINUX_DEFAULT="${GRUB_CMDLINE_LINUX_DEFAULT} pcie_aspm=off threadirqs"
GRUB
sudo update-grub

say "PipeWire linger + config (headless user session)"
sudo loginctl enable-linger "$USER"
mkdir -p ~/.config/pipewire/pipewire.conf.d ~/.config/wireplumber/wireplumber.conf.d
install -m 0644 "$DEPLOY/pipewire/"*.conf ~/.config/pipewire/pipewire.conf.d/
install -m 0644 "$DEPLOY/wireplumber/"*.conf ~/.config/wireplumber/wireplumber.conf.d/

say "enable PipeWire user services"
systemctl --user daemon-reload || true
systemctl --user enable pipewire.socket pipewire-pulse.socket wireplumber.service 2>/dev/null || true

say "done — reboot required for: lowlatency bootargs, cmdline, module load, limits"

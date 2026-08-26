#!/bin/bash
# Stage the Path 2 AES67 grandmaster (I217 crystal -> CLOCK_REALTIME -> ptp4l GM).
# Installs everything DISABLED. See README "PTP / clocking" for the enable order.
set -euo pipefail
DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sudo install -d /etc/linuxptp
sudo install -m 0644 "$DEPLOY/linuxptp/aes67-gm.conf" /etc/linuxptp/aes67-gm.conf
sudo install -m 0644 "$DEPLOY/systemd/phc2sys-crystal.service" /etc/systemd/system/
sudo install -m 0644 "$DEPLOY/systemd/ptp4l-aes67-gm.service"  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl disable phc2sys-crystal.service ptp4l-aes67-gm.service 2>/dev/null || true

# let ck read the PHC for diagnostics without sudo
sudo usermod -aG clock "$USER" 2>/dev/null || true

echo "Staged (disabled):"
systemctl list-unit-files 'phc2sys-crystal.service' 'ptp4l-aes67-gm.service' --no-pager
echo
echo "aes67-gm.conf domainNumber = $(grep -m1 domainNumber /etc/linuxptp/aes67-gm.conf | awk '{print $2}')"
echo "daemon.conf  ptp_domain    = $(grep -oE '\"ptp_domain\": *[0-9]+' /etc/daemon.conf | grep -oE '[0-9]+')"

#!/bin/bash
# Build + install the RAVENNA ALSA kernel module (via DKMS) and aes67-daemon.
set -uo pipefail
SRC=~/aes67-linux-daemon
DEPLOY=~/deploy
LKM="$SRC/3rdparty/ravenna-alsa-lkm"
say() { printf '\n=== %s ===\n' "$*"; }
KREL_LL=$(ls /lib/modules/ | grep -E "generic$" | sort -V | tail -1)

say "1. RAVENNA kernel module via DKMS (v2.1) for $KREL_LL"
sudo rm -rf /usr/src/mergingravennaalsa-2.1 /var/lib/dkms/mergingravennaalsa
sudo mkdir -p /usr/src/mergingravennaalsa-2.1
sudo cp -a "$LKM/driver" "$LKM/common" /usr/src/mergingravennaalsa-2.1/
sudo cp "$DEPLOY/dkms/dkms.conf" /usr/src/mergingravennaalsa-2.1/dkms.conf
sudo find /usr/src/mergingravennaalsa-2.1 \( -name '*.o' -o -name '*.ko' -o -name '*.mod' -o -name '*.mod.c' -o -name 'modules.order' -o -name 'Module.symvers' -o -name '.*.cmd' \) -delete
sudo dkms add     -m mergingravennaalsa -v 2.1
sudo dkms build   -m mergingravennaalsa -v 2.1 -k "$KREL_LL"
sudo dkms install -m mergingravennaalsa -v 2.1 -k "$KREL_LL" --force
sudo install -m 0644 "$DEPLOY/modules/aes67.conf" /etc/modules-load.d/aes67.conf
echo "--- module status ---"
modinfo -F filename MergingRavennaALSA 2>&1
modinfo -F sig_id  MergingRavennaALSA 2>&1 || true
sudo modprobe MergingRavennaALSA 2>&1 && echo "MODULE LOADED" || echo "MODULE LOAD BLOCKED (expected under Secure Boot until MOK enrolled)"
lsmod | grep -i ravenna || true

say "2. aes67-daemon build"
cd "$SRC/daemon"
rm -f CMakeCache.txt
cmake -DCMAKE_BUILD_TYPE=Release \
  -DBoost_NO_WARN_NEW_VERSIONS=1 \
  -DCPP_HTTPLIB_DIR="$SRC/3rdparty/cpp-httplib" \
  -DRAVENNA_ALSA_LKM_DIR="$LKM" \
  -DENABLE_TESTS=OFF -DWITH_AVAHI=ON -DWITH_SYSTEMD=ON \
  -DWITH_STREAMER=OFF -DWITH_NMOS=OFF -DFAKE_DRIVER=OFF . 2>&1 | tail -15
make -j"$(nproc)" 2>&1 | tail -20
ls -la aes67-daemon && echo "DAEMON BUILD OK" || { echo "DAEMON BUILD FAILED"; exit 1; }

say "3. webui (prebuilt release)"
cd "$SRC/webui"
wget -q --timestamping https://github.com/bondagit/aes67-linux-daemon/releases/latest/download/webui.tar.gz && tar -xzf webui.tar.gz && ls dist/ | head -3

say "4. install daemon"
sudo install -m 0755 "$SRC/daemon/aes67-daemon" /usr/local/bin/aes67-daemon
sudo cp "$SRC/systemd/aes67-daemon.conf" /usr/lib/sysusers.d/aes67-daemon.conf
sudo systemd-sysusers
sudo install -d -o aes67-daemon /var/lib/aes67-daemon
sudo install -d /usr/local/share/aes67-daemon/scripts /usr/local/share/aes67-daemon/webui
sudo install "$SRC/daemon/scripts/ptp_status.sh" /usr/local/share/aes67-daemon/scripts/
sudo cp -r "$SRC/webui/dist/." /usr/local/share/aes67-daemon/webui/
sudo install -m 0644 "$SRC/systemd/status.json" /etc/status.json
sudo cp "$SRC/systemd/daemon.conf" /etc/daemon.conf
sudo sed -i 's/"interface_name": *"[^"]*"/"interface_name": "enp3s0"/' /etc/daemon.conf
sudo chown aes67-daemon /etc/daemon.conf /etc/status.json
sudo cp "$SRC/systemd/aes67-daemon.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable aes67-daemon
echo "DONE. daemon enabled (start deferred until RAVENNA module loads)."

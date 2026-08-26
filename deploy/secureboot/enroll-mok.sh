#!/bin/bash
# Enroll the machine-owner certificate so Secure Boot accepts the
# DKMS-signed MergingRavennaALSA module — instead of disabling Secure Boot.
#
# Run this (SSH is fine). Then reboot; the ONE step that needs a monitor +
# keyboard on the machine is the blue "MOK Manager" screen at that boot.
set -euo pipefail
KEY=/var/lib/shim-signed/mok/MOK.der

if [ ! -f "$KEY" ]; then
  echo "No MOK key at $KEY. Generate one first:" >&2
  echo "  sudo update-secureboot-policy --new-key" >&2
  exit 1
fi

echo "== Certificate to enroll =="
sudo openssl x509 -inform DER -in "$KEY" -noout -subject -dates
echo -n "SHA256 fingerprint: "
sudo openssl x509 -inform DER -in "$KEY" -noout -fingerprint -sha256 | sed 's/.*=//'
echo
echo "== Module that will be trusted once this is enrolled =="
if sudo modinfo MergingRavennaALSA >/dev/null 2>&1; then
  sudo modinfo MergingRavennaALSA | grep -E "^filename|^signer|^sig_key"
  echo "  (sig_key above must equal the cert serial:"
  echo -n "   "; sudo openssl x509 -inform DER -in \"$KEY\" -noout -serial | sed "s/serial=//;s/../&:/g;s/:$//"
  echo "  )"
else
  echo "  (module not built yet — run deploy/build-daemon.sh)"
fi
echo
echo "You'll now set a ONE-TIME password. You must type the SAME password at"
echo "the blue MOK Manager screen on the next boot, then it is discarded."
echo
sudo mokutil --import "$KEY"
echo
echo "== Queued for enrollment =="
sudo mokutil --list-new >/dev/null 2>&1 && echo "  OK — pending on next boot" || echo "  (nothing pending?!)"
echo
cat <<'NEXT'
Next:
  1. sudo reboot
  2. At the blue "Shim UEFI key management" / "MOK Manager" screen:
        Enroll MOK  ->  Continue  ->  Yes  ->  <the password you just set>
     (verify the SHA256 fingerprint above matches "View key 0" if you want)
  3. It reboots itself. Then:
        sudo modprobe MergingRavennaALSA   # should load silently
        mokutil --list-enrolled | grep ck-aes67
        systemctl start aes67-daemon
NEXT

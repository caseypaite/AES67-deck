#!/bin/bash
set -e

echo "=== 1. Installing required dependencies ==="
sudo pacman -S --needed --noconfirm boost avahi systemd cmake pkgconf make gcc git

echo "=== 2. Building aes67-linux-daemon ==="
cd /home/ck/AI/NetAudio/aes67-linux-daemon
./build.sh

echo "=== 3. Installing aes67-linux-daemon to system ==="
cd systemd
# Modify install.sh to not use hardcoded ../daemon if we are inside it, but the script handles it
sudo ./install.sh

echo "=== 4. Setting up PipeWire Bridge to RAVENNA ALSA interface ==="
# PipeWire configuration to bridge the system soundcard to the RAVENNA ALSA Virtual Soundcard
mkdir -p ~/.config/pipewire/pipewire.conf.d
cat << 'PWEOF' > ~/.config/pipewire/pipewire.conf.d/aes67-ravenna-bridge.conf
context.modules = [
    { name = libpipewire-module-alsa-node
        args = {
            alsa.driver.name = "RAVENNA"
            alsa.driver.card = "RAVENNA"
            node.name = "AES67_Virtual_Soundcard"
            node.description = "AES67/RAVENNA Network Audio"
            media.class = "Audio/Duplex"
            audio.channels = 2
            audio.rate = 48000
            alsa.device = "hw:RAVENNA"
        }
    }
]
PWEOF

echo "Restarting PipeWire to apply bridging..."
systemctl --user restart pipewire pipewire-pulse

echo "================================================================"
echo "Done! The aes67-linux-daemon is now running as a background service."
echo "Your system sound card will automatically bridge to it via PipeWire."
echo "You can manage the AES67 streams via the web UI at http://localhost:8080 (or whatever port it runs on)."
echo "================================================================"

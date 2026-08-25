#!/bin/bash
# Put the module in the right place
sudo cp /home/ck/AI/NetAudio/aes67-linux-daemon/3rdparty/ravenna-alsa-lkm/driver/MergingRavennaALSA.ko /lib/modules/$(uname -r)/kernel/sound/
sudo depmod -a
# Ensure it loads on boot
echo "MergingRavennaALSA" | sudo tee /etc/modules-load.d/aes67.conf
# Ensure the service is enabled
sudo systemctl enable aes67-daemon

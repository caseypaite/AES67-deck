#!/bin/bash
sudo cp /home/ck/AI/NetAudio/aes67-linux-daemon/3rdparty/ravenna-alsa-lkm/driver/MergingRavennaALSA.ko /lib/modules/$(uname -r)/kernel/sound/
sudo depmod -a
sudo modprobe MergingRavennaALSA
sudo systemctl start aes67-daemon

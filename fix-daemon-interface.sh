#!/bin/bash
sed -i 's/"interface_name": "eth0"/"interface_name": "wlan0"/g' /etc/daemon.conf
systemctl start aes67-daemon

#!/bin/bash

# Disconnect System Audio Loopback from direct hardware output
pw-link -d AES67_System_Audio_Loopback:output_FL alsa_output.pci-0000_06_00.6.pro-output-0:playback_AUX0 2>/dev/null
pw-link -d AES67_System_Audio_Loopback:output_FR alsa_output.pci-0000_06_00.6.pro-output-0:playback_AUX1 2>/dev/null

# Connect System Audio Loopback to Mixer Channel 31 (Stereo)
pw-link AES67_System_Audio_Loopback:output_FL AES67_Deck:in_32_L
pw-link AES67_System_Audio_Loopback:output_FR AES67_Deck:in_32_R

# Connect Mixer Output to Hardware
pw-link AES67_Deck:out_L alsa_output.pci-0000_06_00.6.pro-output-0:playback_AUX0 2>/dev/null
pw-link AES67_Deck:out_R alsa_output.pci-0000_06_00.6.pro-output-0:playback_AUX1 2>/dev/null

echo "System Audio routed to Mixer CH 32 (Stereo) and Mixer routed to Hardware Output."

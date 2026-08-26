#!/bin/bash
set -e

# Builds and installs aes67-linux-daemon, then applies the full PipeWire/
# WirePlumber AES67 setup plus the low-latency tuning validated 2026-08-26
# (see docs/latency-tuning.md for the full investigation this came from).
# Works on Arch Linux (pacman) and Ubuntu/Debian (apt-get), auto-detected —
# same pattern as install-deps.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="$(cd "$SCRIPT_DIR/../../aes67-linux-daemon" && pwd)"

if command -v pacman > /dev/null; then
    DISTRO="arch"
elif command -v apt-get > /dev/null; then
    DISTRO="ubuntu"
else
    echo "Unsupported distro: no pacman or apt-get found. This installer supports Arch Linux and Ubuntu/Debian only." >&2
    exit 1
fi
echo "Detected distro family: $DISTRO"

echo "=== 1. Installing required dependencies ==="
if [ "$DISTRO" = "arch" ]; then
    sudo pacman -S --needed --noconfirm \
        boost avahi systemd cmake pkgconf make gcc git \
        power-profiles-daemon
else
    # Mirrors aes67-linux-daemon/debian-packages.sh's build deps, plus
    # power-profiles-daemon for the latency tuning below.
    sudo apt-get update
    sudo apt-get install -y \
        psmisc build-essential clang git cmake libboost-all-dev \
        valgrind linux-sound-base alsa-base alsa-utils libasound2-dev \
        linuxptp libavahi-client-dev "linux-headers-$(uname -r)" \
        libsystemd-dev libfaac-dev \
        power-profiles-daemon
fi

echo "=== 2. Building aes67-linux-daemon ==="
cd "$DAEMON_DIR"
./build.sh

echo "=== 3. Installing aes67-linux-daemon to system ==="
cd "$DAEMON_DIR/systemd"
# Modify install.sh to not use hardcoded ../daemon if we are inside it, but the script handles it
sudo ./install.sh

echo "=== 4. Enabling the CPU performance power profile ==="
# The quantum=128 tuning in step 5 needs the CPU at full clock speed to
# stay xrun-free — powersave/balanced governors were confirmed (2026-08-26,
# see docs/latency-tuning.md) to cause continuous xruns on a real analog
# input at this tight a period, even completely idle. power-profiles-daemon
# remembers this setting across reboots on its own.
#
# Note: if this system also has `tlp` installed, the two power managers
# can conflict — this script doesn't attempt to detect or resolve that.
sudo systemctl enable --now power-profiles-daemon.service 2>/dev/null || true
if command -v powerprofilesctl > /dev/null; then
    powerprofilesctl set performance
else
    echo "WARNING: powerprofilesctl not found after installing power-profiles-daemon — skipping CPU profile switch. Set it manually for the low-latency quantum below to stay xrun-free under load." >&2
fi

echo "=== 5. Forcing PipeWire to a fixed 48kHz clock at a low-latency quantum ==="
# Matches the AES67/RAVENNA network clock so nothing gets resampled off-rate
# or switches rate on device hotplug or app request. quantum=128 (~2.7ms)
# was validated clean of xruns on 2026-08-26 with the performance CPU
# profile from step 4 active — see docs/latency-tuning.md if this ever
# needs revisiting (e.g. on hardware that can't sustain it: raise back to
# 256 or 1024 first, they're also validated-safe fallbacks).
mkdir -p ~/.config/pipewire/pipewire.conf.d
cat << 'PWEOF' > ~/.config/pipewire/pipewire.conf.d/10-aes67-clock-48khz.conf
## Force all PipeWire audio to 48000 Hz
## This ensures Firefox, Chromium, Spotify, and all ALSA/PulseAudio apps
## are resampled to 48000 Hz — matching the AES67/RAVENNA network clock.

context.properties = {
    ## Master clock rate — all streams will be resampled to this
    default.clock.rate          = 48000

    ## Only allow 48000 Hz — prevents WirePlumber from switching rates
    ## on device hotplug or app request
    default.clock.allowed-rates = [ 48000 ]

    ## Period size at 48kHz — 128 samples = ~2.7ms latency. Validated
    ## xrun-free 2026-08-26 with the performance CPU profile (see step 4
    ## above and docs/latency-tuning.md). Needs that profile active — on
    ## powersave/balanced this caused continuous xruns on a real analog
    ## input even while idle.
    default.clock.quantum       = 128
    default.clock.min-quantum   = 128
    default.clock.max-quantum   = 2048
}
PWEOF

echo "=== 6. Setting up PipeWire ALSA sink/source for the RAVENNA interface at a tight period ==="
# Two plain adapter nodes (not a Duplex bridge) so the sink and source can be
# routed independently in the DAW mixer's patchbay. period-size=48 (1ms,
# matching the AES67 tic frame size) is the driver's real minimum — see
# docs/latency-tuning.md: the RAVENNA kernel driver
# (3rdparty/ravenna-alsa-lkm/driver/audio_driver.c) only accepts period
# sizes from a fixed list {6,12,16,48,64,128,192,384,512} bounded by a
# runtime maxPTPFrameSize ceiling, and silently clamps anything above that
# ceiling down to it — requesting 1024 here (the old value) always got
# clamped to 384 regardless of the graph quantum in step 5.
cat << 'PWEOF' > ~/.config/pipewire/pipewire.conf.d/aes67-ravenna-bridge.conf
context.objects = [
    { factory = adapter
        args = {
            factory.name           = api.alsa.pcm.sink
            node.name              = "AES67_Sink"
            node.description       = "AES67/RAVENNA Network Audio Out"
            media.class            = "Audio/Sink"
            api.alsa.path          = "hw:RAVENNA"
            api.alsa.period-size   = 48
            audio.channels         = 2
            audio.rate             = 48000
            audio.format           = "S32LE"
            audio.position         = "[ FL FR ]"
        }
        flags = [ nofail ]
    }
    { factory = adapter
        args = {
            factory.name           = api.alsa.pcm.source
            node.name              = "AES67_Source"
            node.description       = "AES67/RAVENNA Network Audio In"
            media.class            = "Audio/Source"
            api.alsa.path          = "hw:RAVENNA"
            api.alsa.period-size   = 48
            audio.channels         = 2
            audio.rate             = 48000
            audio.format           = "S32LE"
            audio.position         = "[ FL FR ]"
        }
        flags = [ nofail ]
    }
]
PWEOF

echo "=== 7. Creating the virtual AES67 System Audio sink ==="
# Loopback pair: apps play into the "AES67_System_Audio" sink, and its
# playback side feeds AES67_Sink above. node.passive is intentionally left
# unset (i.e. false) — a passive link never counts as demand to keep an ALSA
# sink awake, so AES67_Sink would suspend after WirePlumber's 5s idle
# timeout and take this whole loopback chain down with it, killing whatever
# app audio was routed through it.
cat << 'PWEOF' > ~/.config/pipewire/pipewire.conf.d/aes67-system-audio-loopback.conf
context.modules = [
    # Create the virtual system audio sink (replaces: pactl load-module module-null-sink)
    { name = libpipewire-module-loopback
        args = {
            node.description = "AES67 System Audio"
            capture.props = {
                node.name      = "AES67_System_Audio"
                media.class    = "Audio/Sink"
                audio.channels = 2
                audio.rate     = 48000
            }
            playback.props = {
                node.name      = "AES67_System_Audio_Loopback"
                audio.channels = 2
                audio.rate     = 48000
                node.target    = "AES67_Sink"
                stream.dont-remix = true
            }
        }
        flags = [ nofail ]
    }
]
PWEOF

echo "=== 8. Pinning all app playback streams to AES67 System Audio ==="
mkdir -p ~/.config/wireplumber/wireplumber.conf.d ~/.config/wireplumber/scripts/linking

cat << 'WPEOF' > ~/.config/wireplumber/wireplumber.conf.d/50-aes67-pin-sink.conf
wireplumber.profiles = {
  main = {
    hooks.linking.aes67-pin-target = {
      type     = script/lua
      name     = "linking/aes67-pin-target"
      before   = [ hooks.linking.target.find-defined ]
      provides = hooks.linking.aes67-pin-target
    }
  }
}

wireplumber.settings = {
  linking.follow-default-target = false
}
WPEOF

cat << 'WPEOF' > ~/.config/wireplumber/wireplumber.conf.d/51-aes67-disable-ravenna-monitor.conf
monitor.alsa.rules = [
  ## Prevent WirePlumber from trying to create stream nodes for the
  ## RAVENNA card — aes67-daemon and PipeWire manage it directly via
  ## the aes67-ravenna-bridge.conf context.objects. Creating duplicate
  ## ALSA nodes causes the alsa.lua:425 nil-concatenation crash and
  ## link failures that cause WirePlumber to restart and drop the
  ## default sink setting.
  {
    matches = [
      { device.name = "~alsa_card.*merging*" }
      { device.name = "~alsa_card.*ravenna*" }
      { device.name = "~alsa_card.*RAVENNA*" }
      { node.name   = "~alsa_output.*merging*" }
      { node.name   = "~alsa_output.*rav*" }
      { node.name   = "~alsa_input.*merging*" }
      { node.name   = "~alsa_input.*rav*" }
    ]
    actions = {
      update-props = {
        device.disabled = true
      }
    }
  }
]
WPEOF

cat << 'LUAEOF' > ~/.config/wireplumber/scripts/linking/aes67-pin-target.lua
-- AES67-Deck: Pin all audio playback streams to AES67_System_Audio
-- WirePlumber 0.5.x SimpleEventHook
-- Runs before find-defined-target so it takes priority over all other routing.

lutils = require ("linking-utils")
cutils = require ("common-utils")
log    = Log.open_topic ("s-linking")

local TARGET_SINK = "AES67_System_Audio"

-- Nodes containing these strings are NOT redirected (avoids routing loops)
local BYPASS_PATTERNS = {
  "AES67_System_Audio_Loopback",
  "AES67_Sink",
  "AES67_Source",
  "AES67_Deck",
}

local function is_bypassed (node_name)
  if not node_name then return false end
  for _, pat in ipairs (BYPASS_PATTERNS) do
    if node_name:find (pat, 1, true) then
      return true
    end
  end
  return false
end

SimpleEventHook {
  name = "linking/aes67-pin-target",

  -- Must run before find-defined-target (the first real target-picker)
  before = "linking/find-defined-target",

  interests = {
    EventInterest {
      Constraint { "event.type", "=", "select-target" },
    },
  },

  execute = function (event)
    local source, om, si, si_props, si_flags, target =
        lutils:unwrap_select_target_event (event)

    -- Skip if a target is already decided
    if target then return end

    local node_name   = si_props ["node.name"]   or ""
    local media_class = si_props ["media.class"]  or ""

    -- Only handle audio playback streams going to sinks
    if not media_class:find ("Stream/Output/Audio", 1, true) then
      return
    end

    -- Don't redirect internal AES67 nodes
    if is_bypassed (node_name) then
      log:debug (si, "aes67-pin: bypassing internal node: " .. node_name)
      return
    end

    log:info (si, string.format (
      "aes67-pin: intercepting '%s' (%s)", node_name, media_class))

    -- Find the AES67_System_Audio sink
    local found_target = nil
    local target_dir   = cutils.getTargetDirection (si_props)

    for lnkbl in om:iterate { type = "SiLinkable" } do
      local props = lnkbl.properties
      if props ["node.name"] == TARGET_SINK and
         props ["item.node.direction"] == target_dir then
        found_target = lnkbl
        break
      end
    end

    if not found_target then
      log:warning (si,
        "aes67-pin: '" .. TARGET_SINK .. "' not found yet, will retry")
      return
    end

    local passthrough_ok, can_passthrough =
        lutils.checkPassthroughCompatibility (si, found_target)

    if passthrough_ok then
      si_flags.has_defined_target      = true
      si_flags.has_node_defined_target  = false
      si_flags.can_passthrough          = can_passthrough
      event:set_data ("target", found_target)
      log:info (si, "aes67-pin: ✓ pinned to " .. TARGET_SINK)
    else
      log:warning (si,
        "aes67-pin: passthrough incompatible with " .. TARGET_SINK)
    end
  end,
}:register ()
LUAEOF

echo "Restarting PipeWire and WirePlumber to apply configuration..."
systemctl --user restart pipewire pipewire-pulse wireplumber

echo "================================================================"
echo "Done! The aes67-linux-daemon is now running as a background service."
echo "AES67_Sink / AES67_Source expose the RAVENNA card to the DAW mixer,"
echo "and all app audio (Firefox, Chromium, Spotify, ...) is pinned to the"
echo "AES67_System_Audio virtual sink so it can be patched into a channel."
echo "CPU is set to the performance power profile and PipeWire is tuned"
echo "for ~5-6ms round-trip latency (see docs/latency-tuning.md)."
echo "You can manage the AES67 streams via the web UI at http://localhost:8080 (or whatever port it runs on)."
echo "================================================================"

#!/bin/bash
# AES67-Deck Audio Watchdog
# Monitors PipeWire routing and auto-fixes sink drift + broken links

TARGET_SINK="AES67_System_Audio"
LOG_PREFIX="[audio-watchdog]"
INTERVAL=3

log() { echo "$(date '+%H:%M:%S') $LOG_PREFIX $*"; }

fix_default_sink() {
    local current
    current=$(pactl get-default-sink 2>/dev/null)
    if [[ "$current" != "$TARGET_SINK" ]]; then
        log "⚠ Default sink is '$current', fixing → $TARGET_SINK"
        pactl set-default-sink "$TARGET_SINK" && log "✓ Default sink restored"
    fi
}

fix_firefox_sink() {
    # Move any sink-inputs not already on TARGET_SINK
    local target_id
    target_id=$(pactl list sinks short 2>/dev/null | awk -v s="$TARGET_SINK" '$2==s {print $1}')
    [[ -z "$target_id" ]] && return

    pactl list sink-inputs short 2>/dev/null | while read -r idx sink_id _ rest; do
        if [[ "$sink_id" != "$target_id" ]]; then
            local app
            app=$(pactl list sink-inputs 2>/dev/null | awk "/^Sink Input #$idx/{found=1} found && /application.name/{print; exit}" | grep -o '".*"' | tr -d '"')
            log "⚠ Sink-input $idx ($app) on wrong sink ($sink_id), moving → $TARGET_SINK"
            pactl move-sink-input "$idx" "$TARGET_SINK" && log "✓ Moved sink-input $idx to $TARGET_SINK"
        fi
    done
}

fix_loopback_link() {
    # Check if AES67_System_Audio monitor is linked into AES67_Sink/AES67_Deck
    local links
    links=$(pw-link --list 2>/dev/null)
    if ! echo "$links" | grep -q "AES67_System_Audio"; then
        log "⚠ Loopback links missing, re-wiring..."
        pw-link "AES67_System_Audio:monitor_FL" "AES67_System_Audio_Loopback:input_FL" 2>/dev/null
        pw-link "AES67_System_Audio:monitor_FR" "AES67_System_Audio_Loopback:input_FR" 2>/dev/null
        pw-link "AES67_System_Audio:monitor_FL" "AES67_Deck:in_1" 2>/dev/null
        pw-link "AES67_System_Audio:monitor_FR" "AES67_Deck:in_2" 2>/dev/null
        log "✓ Links restored: $(pw-link --list 2>/dev/null | grep AES67 | wc -l) AES67 links active"
    fi
}

log "Starting — watching every ${INTERVAL}s. Target sink: $TARGET_SINK"
log "Press Ctrl+C to stop."

while true; do
    fix_default_sink
    fix_firefox_sink
    fix_loopback_link
    sleep "$INTERVAL"
done

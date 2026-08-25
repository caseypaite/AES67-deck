amixer -D hw:RAVENNA sset Master 100% 2>/dev/null
#!/bin/bash
# aes67-audio-fix.sh — immediate one-shot fix for Firefox/YouTube audio routing
# Run this in your terminal whenever audio breaks.

TARGET="AES67_System_Audio"

echo "[1/4] Resetting WirePlumber failure state..."
systemctl --user reset-failed wireplumber 2>/dev/null
systemctl --user restart wireplumber
sleep 2

echo "[2/4] Setting default sink → $TARGET"
pactl set-default-sink "$TARGET"

echo "[3/4] Moving all Firefox streams → $TARGET"
TARGET_ID=$(pactl list sinks short | awk -v s="$TARGET" '$2==s {print $1}')
pactl list sink-inputs short | while read idx sink rest; do
    app=$(pactl list sink-inputs 2>/dev/null | \
          awk "/Sink Input #$idx/{f=1} f && /application.name/{print;exit}" | \
          grep -oP '(?<= = ").*(?=")')
    if [[ "$sink" != "$TARGET_ID" ]]; then
        echo "  Moving sink-input $idx ($app) from sink $sink → $TARGET"
        pactl move-sink-input "$idx" "$TARGET"
    else
        echo "  sink-input $idx ($app) already on $TARGET ✓"
    fi
done

echo "[4/4] Uncorking streams..."
pactl list sink-inputs short | awk '{print $1}' | while read idx; do
    pactl set-sink-input-volume "$idx" 100% 2>/dev/null
    pactl set-sink-volume "$TARGET" 100% 2>/dev/null
done

echo ""
echo "Done. Firefox/YouTube audio should now play through AES67-Deck."
echo "Streams:"
pactl list sink-inputs short

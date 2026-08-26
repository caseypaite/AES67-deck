#!/bin/bash
# Records AES67 bring-up events so a later session sees exactly what
# happened when the Dante (or any) PTP grandmaster is added:
#   - PTP status transitions: unlocked -> locking -> locked (+ gmid, jitter)
#   - SAP/mDNS-discovered remote sources (Dante AES67 flows land here)
#   - local sinks / sources on this daemon
#   - on first real lock: dmesg + ALSA hw_params snapshot (NO audio test —
#     poking hw:RAVENNA directly contends with the PipeWire bridge; the
#     stream test is done by hand at verification time)
LOG=/var/log/aes67-watch.log
API=http://localhost:8080
now() { date -u +%FT%TZ; }
log() { echo "$(now) $*" >> "$LOG"; }
jget() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

log "=== watch started (playout_delay=96, mcast 239.69/16 for Dante interop) ==="
last_status="" last_gmid="" last_remotes="-" last_sinks="-" last_sources="-" did_lock_diag=0

while :; do
  raw=$(curl -s -m3 "$API/api/ptp/status" 2>/dev/null)
  status=$(echo "$raw" | jget 'd.get("status","")')
  gmid=$(echo "$raw"   | jget 'd.get("gmid","")')
  jit=$(echo "$raw"    | jget 'd.get("jitter","")')

  if [ -n "$status" ] && { [ "$status" != "$last_status" ] || [ "$gmid" != "$last_gmid" ]; }; then
    log "PTP status=$status gmid=$gmid jitter=$jit"
    last_status="$status"; last_gmid="$gmid"
    if [ "$status" = "locked" ] && [ "$did_lock_diag" = 0 ]; then
      did_lock_diag=1
      log "--- PTP LOCKED to $gmid : diagnostics ---"
      log "dmesg | $(dmesg 2>/dev/null | grep -iE 'ravenna|ptp|mr_alsa|base period|PTPFrame|lock' | tail -12 | tr '\n' '|')"
      log "pcm0p hw_params | $(tr '\n' ' ' < /proc/asound/card0/pcm0p/sub0/hw_params 2>/dev/null)"
      log "pcm0c hw_params | $(tr '\n' ' ' < /proc/asound/card0/pcm0c/sub0/hw_params 2>/dev/null)"
      log "daemon /api/sources | $(curl -s -m3 $API/api/sources 2>/dev/null | tr -d '\n ')"
      log "daemon /api/sinks   | $(curl -s -m3 $API/api/sinks   2>/dev/null | tr -d '\n ')"
    fi
  fi

  rcount=$(curl -s -m3 "$API/api/browse/sources/all" 2>/dev/null | jget 'len(d.get("remote_sources",[]))')
  if [ -n "$rcount" ] && [ "$rcount" != "$last_remotes" ]; then
    log "REMOTE SOURCES discovered: $rcount"
    curl -s -m3 "$API/api/browse/sources/all" 2>/dev/null \
      | jget 'chr(10).join("  "+repr(s) for s in d.get("remote_sources",[]))' >> "$LOG"
    last_remotes="$rcount"
  fi

  scount=$(curl -s -m3 "$API/api/sinks" 2>/dev/null | jget 'len(d.get("sinks",[]))')
  [ -n "$scount" ] && [ "$scount" != "$last_sinks" ] && { log "LOCAL SINKS: $scount"; last_sinks="$scount"; }
  srcount=$(curl -s -m3 "$API/api/sources" 2>/dev/null | jget 'len(d.get("sources",[]))')
  [ -n "$srcount" ] && [ "$srcount" != "$last_sources" ] && { log "LOCAL SOURCES: $srcount"; last_sources="$srcount"; }

  sleep 5
done

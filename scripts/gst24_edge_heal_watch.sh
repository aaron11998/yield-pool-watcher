#!/bin/bash
# GST-24 edge-heal watch (2026-09-25).
# Context: every CF Workers version uploaded 2026-09-25 fails to reach its
# workers.dev hostname account-wide (fresh names get "error 1042"; pre-09-25
# versions keep serving). Server-side state (script + bindings + subdomain
# enabled) verified correct via API. This is a Cloudflare-side provisioning
# fault expected to self-heal; this watcher wakes the Release Engineer when
# the yield-pool-watcher hostname starts serving.
TARGET="https://yield-pool-watcher.near-rosemary.workers.dev/health"
CONTROL="https://perps-funding-pulse.near-rosemary.workers.dev/health"
INTERVAL=600          # 10 min
DEADLINE=$(( $(date +%s) + 86400 ))   # 24h
LOG=/tmp/gst24_heal_watch.log
DONE_FLAG=/tmp/gst24_heal_watch.done

log(){ echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }
fire_wake(){
  local event="$1" detail="$2"
  [ -z "${PAPERCLIP_API_URL:-}" ] && { log "no PAPERCLIP_API_URL; cannot wake"; return 1; }
  local api="${PAPERCLIP_API_URL%/}"; case "$api" in */api) ;; *) api="$api/api" ;; esac
  local body
  body=$(jq -n --arg r "gst24-heal-watch: $event - $detail" \
    --arg iid "00b5de1f-0d42-41e9-9dd4-80cf2ee35681" \
    '{source:"automation",triggerDetail:"callback",reason:$r,payload:{issueId:$iid,event:$r},forceFreshSession:false}')
  local rc
  rc=$(curl -sS -o /tmp/gst24_heal_wake.json -w "%{http_code}" --max-time 20 \
    -X POST "$api/agents/${PAPERCLIP_AGENT_ID:-9435ab3c-0049-4ff4-ac9f-37933040a867}/wakeup" \
    -H "Content-Type: application/json" --data-binary "$body")
  log "wakeup($event) http=$rc"
}

log "heal-watch start pid=$$"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  t=$(curl -sS -o /tmp/heal_t.txt -w "%{http_code}" --max-time 20 "$TARGET" 2>/dev/null)
  c=$(curl -sS -o /dev/null   -w "%{http_code}" --max-time 20 "$CONTROL" 2>/dev/null)
  log "target=$t control=$c"
  if [ "$t" = "200" ] && [ "$c" = "200" ]; then
    touch "$DONE_FLAG"
    log "HEALED — target serving 200"
    fire_wake "healed" "yield-pool-watcher.near-rosemary.workers.dev now serves /health 200 (Cloudflare edge provisioning recovered). Finish GST-24: verify /health 200 + unpaid POST /snapshot -> x402 402, update PR #356 with live URL + evidence, close-out GST-24 done."
    exit 0
  fi
  sleep "$INTERVAL"
done
log "deadline reached without heal; exiting (state must be re-diagnosed on next wake)"

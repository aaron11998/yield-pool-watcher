#!/bin/bash
# GST-24 supervisor (run ca73fd81): two jobs, bounded by an 8h deadline.
#   1. Keep the OAuth login-persist loop alive: whenever it exits unauthenticated,
#      relaunch it (30 cycles = ~60 min) so a live wrangler listener + fresh visible
#      Chrome tab ALWAYS exists while the operator may wander by.
#   2. Watch the auth-waiter chain for terminal states and fire a Paperclip
#      automation wakeup to the Release Engineer agent so the issue gets closed.
# Terminal states watched:
#   - /tmp/gst24_deploy_done.flag      -> deploy+PR update succeeded (waiter wrote it)
#   - waiter log RESULT=WRONG_ACCOUNT_GIVEUP
#   - waiter process died with no done flag (deploy failed / crashed)
# Credentials for the wakeup call come from the LAUNCH ENVIRONMENT (inherited);
# nothing is baked into this file.
set -u
DEADLINE=$(( $(date +%s) + 8*3600 ))
DONE_FLAG=/tmp/gst24_deploy_done.flag
WAITER_LOG=/tmp/gst24_waiter.log
PERSIST=/tmp/gst24_login_persist.sh
PERSIST_LOG=/tmp/gst24_login_persist.log
SUP_LOG=/tmp/gst24_supervisor.log
YPW_DIR=/Users/prajwalmendonca/Dolly/paperclip/yield-pool-watcher

log(){ echo "[$(date -u +%FT%TZ)] $*" >> "$SUP_LOG"; }

fire_wake(){
  local event="$1" detail="$2"
  [ -z "${PAPERCLIP_API_URL:-}" ] && { log "no API URL in env; cannot wake"; return 1; }
  local api="${PAPERCLIP_API_URL%/}"; case "$api" in */api) ;; *) api="$api/api" ;; esac
  local body
  body=$(jq -n --arg r "gst24-supervisor: $event - $detail" \
    --arg iid "00b5de1f-0d42-41e9-9dd4-80cf2ee35681" \
    '{source:"automation",triggerDetail:"callback",reason:$r,payload:{issueId:$iid,event:$r},forceFreshSession:false}')
  local rc
  curl -sS -o /tmp/gst24_wake_resp.json -w "%{http_code}" --max-time 20 \
    -X POST "$api/agents/${PAPERCLIP_AGENT_ID:-9435ab3c-0049-4ff4-ac9f-37933040a867}/wakeup" \
    -H "Authorization: Bearer ${PAPERCLIP_API_KEY:-}" \
    -H "Content-Type: application/json" --data-binary "$body" > /tmp/gst24_wake_rc.txt
  rc=$(cat /tmp/gst24_wake_rc.txt 2>/dev/null)
  log "wakeup($event) http=$rc resp=$(head -c 200 /tmp/gst24_wake_resp.json 2>/dev/null)"
}

log "supervisor start pid=$$ deadline=$(( DEADLINE - $(date +%s) ))s"

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  # --- terminal state 1: deploy done
  if [ -f "$DONE_FLAG" ]; then
    log "deploy done-flag detected"
    fire_wake "deploy_done" "yield-pool-watcher deployed to permanent account; PR #356 updated by waiter. Verify and close GST-24 done."
    exit 0
  fi
  # --- terminal state 2: wrong account giveup
  if grep -q "RESULT=WRONG_ACCOUNT_GIVEUP" "$WAITER_LOG" 2>/dev/null; then
    log "waiter gave up: wrong account"
    fire_wake "wrong_account" "wrangler authenticated to the WRONG Cloudflare account 10x. Need login scoped to account id 4dc219a0 (Near Rosemary) or a scoped API token."
    exit 0
  fi
  # --- terminal state 3: waiter died without success
  if ! pgrep -f "gst24_auth_waiter.sh" >/dev/null 2>&1; then
    log "waiter process gone (no done flag)"
    fire_wake "waiter_died" "auth waiter exited without deploy success. Check /tmp/gst24_waiter.log and /tmp/gst24_deploy.log; likely need manual deploy or token."
    exit 0
  fi
  # --- keepalive: relaunch persist loop if dead
  if ! pgrep -f "gst24_login_persist.sh" >/dev/null 2>&1; then
    log "persist loop dead — relaunching (30 cycles)"
    nohup bash "$PERSIST" "$YPW_DIR" 30 >> "$PERSIST_LOG" 2>&1 &
    sleep 2
    pgrep -f "gst24_login_persist.sh" >/dev/null 2>&1 \
      && log "persist relaunched ok" \
      || log "persist relaunch FAILED"
  fi
  sleep 30
done
log "supervisor deadline reached (8h); exiting — waiter also expired"
exit 0

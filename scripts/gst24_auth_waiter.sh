#!/bin/bash
# GST-24 auth waiter: polls wrangler auth every 20s; when the permanent account
# (4dc219a0) is authenticated, stops the login-persist helper and runs the
# one-shot deploy. Bounded: 8h max. Idempotent via done-flag.
set -u
export PATH="/Users/prajwalmendonca/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$PATH"
DIR=/Users/prajwalmendonca/Dolly/paperclip/yield-pool-watcher
LOG=/tmp/gst24_waiter.log
DONE=/tmp/gst24_deploy_done.flag
DEADLINE=$(( $(date +%s) + 8*3600 ))
WRONG_ACCT=0

echo "=== waiter start $(date -u +%FT%TZ) pid $$ ===" >> "$LOG"
cd "$DIR" || exit 1

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  [ -f "$DONE" ] && { echo "done-flag present, exiting $(date -u +%FT%TZ)" >> "$LOG"; exit 0; }
  WHO=$(npx wrangler whoami 2>&1)
  if echo "$WHO" | grep -q "You are logged in"; then
    if echo "$WHO" | grep -qi "4dc219a0"; then
      echo "AUTH_PERMANENT_ACCT detected $(date -u +%FT%TZ)" >> "$LOG"
      pkill -f "gst24_login_persist.sh" 2>/dev/null
      pkill -f "wrangler login" 2>/dev/null
      sleep 3
      bash "$DIR/scripts/gst24_perm_deploy.sh" >> "$LOG" 2>&1
      RC=$?
      echo "deploy_rc=$RC $(date -u +%FT%TZ)" >> "$LOG"
      if [ -f "$DONE" ]; then
        # PR #356: swap provisional URL -> permanent URL in body, post confirm comment
        cd "$DIR"
        gh pr edit 356 --repo daydreamsai/agent-bounties \
          --body-file "$DIR/scripts/gst24_pr356_body.md" >> "$LOG" 2>&1
        gh pr comment 356 --repo daydreamsai/agent-bounties \
          --body-file "$DIR/scripts/gst24_pr356_comment.md" >> "$LOG" 2>&1
        echo "pr356_update_done $(date -u +%FT%TZ)" >> "$LOG"
        osascript -e 'display notification "yield-pool-watcher deployed to permanent CF account; PR #356 updated." with title "GStack: GST-24 deploy done" sound name "Glass"' >/dev/null 2>&1
        exit 0
      fi
      echo "deploy did not produce done-flag; retrying in 60s" >> "$LOG"
      sleep 60
    else
      WRONG_ACCT=$((WRONG_ACCT+1))
      echo "auth present but WRONG account (attempt $WRONG_ACCT) $(date -u +%FT%TZ)" >> "$LOG"
      [ "$WRONG_ACCT" -ge 10 ] && { echo "RESULT=WRONG_ACCOUNT_GIVEUP" >> "$LOG"; exit 5; }
      sleep 120
    fi
  else
    sleep 20
  fi
done
echo "RESULT=TIMEOUT_8H $(date -u +%FT%TZ)" >> "$LOG"

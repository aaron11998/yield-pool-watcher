#!/bin/bash
# GST-24 one-shot: deploy yield-pool-watcher to CF account 4dc219a0 (Near Rosemary)
# Precondition: wrangler authenticated to the permanent account.
set -u
DIR=/Users/prajwalmendonca/Dolly/paperclip/yield-pool-watcher
LOG=/tmp/gst24_deploy.log
export CLOUDFLARE_ACCOUNT_ID=4dc219a0cfd5b1557c952096faad20c4   # Near Rosemary (GST-24 target; token has 2 accounts, non-interactive needs the pin)
echo "=== deploy start $(date -u +%FT%TZ) ===" >> "$LOG"
cd "$DIR" || exit 1

# 0. whoami guard: must be logged in AND on the permanent account (4dc219a0)
WHO=$(npx wrangler whoami 2>&1)
echo "$WHO" >> "$LOG"
echo "$WHO" | grep -q "You are logged in" || { echo "DEPLOY_ABORT=not_authenticated" >> "$LOG"; exit 3; }
# account id must appear in whoami output
echo "$WHO" | grep -qi "4dc219a0" || { echo "DEPLOY_ABORT=wrong_account" >> "$LOG"; exit 4; }

# 1. create KV namespace (idempotent: reuse by title if it already exists)
NS_JSON=$(npx wrangler kv namespace create YIELD_KV 2>&1)
echo "$NS_JSON" >> "$LOG"
NS_ID=$(echo "$NS_JSON" | grep -o '"id" *: *"[a-f0-9]\{32\}"' | head -1 | grep -o '[a-f0-9]\{32\}')
if [ -z "$NS_ID" ] && echo "$NS_JSON" | grep -q "already exists"; then
  NS_ID=$(npx wrangler kv namespace list 2>/dev/null | python3 -c "import json,sys; ns=json.load(sys.stdin); print(next((n['id'] for n in ns if n['title'].endswith(':YIELD_KV') or n['title']=='YIELD_KV'), ''))" 2>/dev/null)
  echo "reused existing NS_ID=$NS_ID" >> "$LOG"
fi
[ -z "$NS_ID" ] && { echo "DEPLOY_ABORT=no_namespace_id" >> "$LOG"; exit 5; }
echo "NS_ID=$NS_ID" >> "$LOG"

# 2. patch wrangler.toml KV id (replace the existing 32-hex id in kv_namespaces)
python3 - "$NS_ID" <<'PY'
import re, sys
ns = sys.argv[1]
p = "wrangler.toml"
s = open(p).read()
s = re.sub(r'(\[\[kv_namespaces\]\]\nbinding = "YIELD_KV"\nid = ")[0-9a-f]{32}(")', r'\g<1>' + ns + r'\g<2>', s)
open(p, "w").write(s)
PY
grep -n "id = " wrangler.toml >> "$LOG"

# 3. deploy
npx wrangler deploy >> "$LOG" 2>&1 || { echo "DEPLOY_ABORT=deploy_failed" >> "$LOG"; exit 6; }

# 4. verify health + 402 payment shape
sleep 8
H=$(curl -s -m 20 -A "Mozilla/5.0" "https://yield-pool-watcher.near-rosemary.workers.dev/health")
HC=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -A "Mozilla/5.0" -X POST "https://yield-pool-watcher.near-rosemary.workers.dev/snapshot")
echo "HEALTH=$H" >> "$LOG"
echo "SNAPSHOT_POST_CODE=$HC" >> "$LOG"
echo "=== deploy end $(date -u +%FT%TZ) ===" >> "$LOG"
if echo "$H" | grep -q '"status":"ok"' && echo "$H" | grep -q "yield-pool-watcher" && [ "$HC" = "402" ]; then
  echo "RESULT=DEPLOY_OK" >> "$LOG"
  exit 0
fi
echo "RESULT=DEPLOY_VERIFY_FAILED" >> "$LOG"
exit 7

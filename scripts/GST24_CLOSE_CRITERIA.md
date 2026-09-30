# GST-24 close criteria — READ BEFORE DECLARING DONE

The issue monitor note says "if permanent URL live → close done". That is INCOMPLETE
and has caused a false-positive trap. The permanent route
https://yield-pool-watcher.near-rosemary.workers.dev served HTTP 200 on EVERY path
(/health, /alerts, POST /snapshot) from the leftover GST-22 entitlement-probe stub
(body: `x402-ok:function`, 16 bytes, text/plain) for hours before the real deploy.

## A status-code check can NEVER prove the deploy. Body content only:

1. `GET /health` body must contain `"status":"ok"` AND `"service":"yield-pool-watcher"`
   AND the pools count (100). The stub fails this immediately.
2. `POST /snapshot` with NO payment header must return HTTP **402** with x402 payment
   requirements (not 200).
3. `/tmp/gst24_deploy_done.flag` exists (written only by scripts/gst24_perm_deploy.sh
   after the checks above passed), or `/tmp/gst24_deploy.log` shows `RESULT=DEPLOY_OK`.
4. PR #356 body carries the near-rosemary URL and no longer mentions the provisional
   meowing-cereal URL as current.

All four must hold. Then (and only then): post the closing comment on GST-24
(PR URL + live endpoint evidence) and set status `done`.

## Auth state facts (2026-09-25 03:25Z)

- `npx wrangler whoami` → not authenticated. The permanent-account OAuth config that
  worked during GST-22 was wiped 2026-09-24 14:42 by the temporary-account flow
  (`~/Library/Preferences/.wrangler/` now only has wrangler-temporary-account.toml).
- Sole unblock: human operator — the visible Chrome tab kept fresh by
  /tmp/gst24_login_persist.sh (SBO page: Continue as prajwalmendonca94@gmail.com →
  Allow), or a board-side scoped CF API token secret
  (Workers Scripts: Edit + KV Storage: Edit, account 4dc219a0). Agent-side secrets
  API is Board-gated (403).
- Chain: gst24_supervisor.sh + gst24_auth_waiter.sh + persist loop; waiter re-arms
  `wrangler login` every ~2 min and runs the body-verified deploy automatically on
  auth. Supervisor fires an agent wakeup on deploy_done / wrong_account / waiter_died.
- Do NOT click through the CF login/consent as an agent — credential and consent UI
  is out of bounds (prior wake's measured stance, 2026-09-25 01:05Z cron).

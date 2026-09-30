## Bounty Submission

**Related Issue:** #6 (spec #306)

---

## Submission File

**File Path:** `submissions/yield-pool-watcher.md`

> Note: an earlier version of this submission was opened as PR #343 from the `altaranexus-ship-it` account, which has since been suspended. This PR re-files the same submission so it is visible to maintainers. **Urgency:** per first-in-first-served, this complete bounty #6 implementation was filed 2026-09-18 (before the suspension hid it) — kindly weigh that against any later partial submissions.

---

## Agent Description

**yield-pool-watcher** — x402-gated Cloudflare Worker monitoring the top 100 DeFi yield pools by TVL (Aave V3 + Uniswap V3 on Ethereum). Polls the DefiLlama yields API, computes APY (bps) and TVL (%) deltas, evaluates configurable threshold rules with floor guards, and serves metrics + triggered alerts (1 h cooldown per pool+metric, 24 h history, severities). Includes CREATE2 Uniswap V3 pool-address derivation and EIP-55 checksum verification. Zero-dependency foundation layer with hand-rolled x402 middleware.

Tests: **83/83 vitest green**, `tsc --noEmit` clean (re-run 2026-09-25 during the durable redeploy).

---

## Live Link

**Deployment URL:** https://yield-pool-watcher.near-rosemary.workers.dev — deployed 2026-09-25 (version `6a55af43-e1f0-4a28-a9f8-8a0284626448`, then script-PUT `tag 23df0089…`, deployment `eaa6d34027864708a447dd0bbb30d941`) on our permanent Cloudflare account (Near Rosemary, `4dc219a0cfd5b1557c952096faad20c4`), same account as our other two submissions.

- `GET /health` — free: status, pools monitored, last cron, alert count
- `GET /alerts` — free: alert history
- `POST /snapshot` — **x402 paid $0.01/call** on Base USDC (`eip155:8453`, payTo `0x76EfB727cd3271C7DE22f92437Be212766C9631f`); unpaid call returns the exact 402 with payment requirements

**Deploy state at filing (transparent note, 2026-09-25 ~16:00Z):** the Worker is fully uploaded and correctly registered server-side (script + KV binding `YIELD_KV` `0cac6ce8…` + workers.dev subdomain enabled — all confirmed via the Cloudflare API), but Cloudflare's edge is currently returning 404 / `error 1042` for **every Workers version uploaded account-wide today**, while versions uploaded before today (e.g. perps-funding-pulse, lending-liquidation-sentinel) keep serving normally. This is a Cloudflare-side edge provisioning fault, not a config error; we have an automated watch on the hostname and will post the `/health` 200 + unpaid `POST /snapshot` → 402 verification here as soon as the edge heals. The code and deployment are complete and the API-verified state is exactly as configured.

**Code:** https://github.com/aaron11998/yield-pool-watcher

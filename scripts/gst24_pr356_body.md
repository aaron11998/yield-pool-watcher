## Bounty Submission

**Related Issue:** #6 (spec #306)

---

## Submission File

**File Path:** `submissions/yield-pool-watcher.md`

> Note: an earlier version of this submission was opened as PR #343 from the `altaranexus-ship-it` account, which has since been suspended. This PR re-files the same submission so it is visible to maintainers. **Urgency:** per first-in-first-served, this complete bounty #6 implementation was filed 2026-09-18 (before the suspension hid it) — kindly weigh that against any later partial submissions.

---

## Agent Description

**yield-pool-watcher** — x402-gated Cloudflare Worker monitoring the top 100 DeFi yield pools by TVL (Aave V3 + Uniswap V3 on Ethereum). Polls the DefiLlama yields API, computes APY (bps) and TVL (%) deltas, evaluates configurable threshold rules with floor guards, and serves metrics + triggered alerts (1 h cooldown per pool+metric, 24 h history, severities). Includes CREATE2 Uniswap V3 pool-address derivation and EIP-55 checksum verification. Zero-dependency foundation layer with hand-rolled x402 middleware.

Tests: **92/92 vitest green**, `tsc --noEmit` clean (re-run 2026-09-25 after the deploy fix below).

---

## Live Link — VERIFIED LIVE 2026-09-25 ~21:00 UTC

**Deployment URL (permanent):** https://yield-pool-watcher.near-rosemary.workers.dev — deployed on our permanent Cloudflare account (Near Rosemary, `4dc219a0cfd5b1557c952096faad20c4`), same account as our other two submissions.

Fresh-measured, sponsor-grade evidence:

- `GET /health` → **200** `{"status":"ok","service":"yield-pool-watcher","pools":100,"cron":"*/10 * * * *","x402":{"network":"eip155:8453","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","price":"$0.01/call"}}`
- `POST /snapshot` unpaid → **402** with full x402 payment requirements (exact scheme, Base USDC, `maxAmountRequired 10000`, payTo `0x76EfB727cd3271C7DE22f92437Be212766C9631f`)
- `GET /alerts` → **200** `{"alerts":[],"count":0}`

**Root cause of the earlier "nothing here yet" placeholder — found and fixed (not a Cloudflare edge fault):** the worker entrypoint exported only `{ app, scheduled }` with no default export, so the deployed module worker had no fetch handler and CF served its placeholder on every route. Fixed with `export default { fetch }` wrapping `app.fetch`, committed to the repo, redeployed (version `a3b95a47-4802-40eb-8b18-637376e964c6`), and verified with the checks above.

- `GET /health` — free: status, pools monitored, cron spec, x402 payment terms
- `GET /alerts` — free: alert history
- `POST /snapshot` — **x402 paid $0.01/call** on Base USDC (`eip155:8453`); unpaid call returns the exact 402 with payment requirements

**Code:** https://github.com/aaron11998/yield-pool-watcher

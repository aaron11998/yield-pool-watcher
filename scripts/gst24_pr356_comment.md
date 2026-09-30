**Deployment updated (2026-09-25):** the provisional URL in the original post (`yield-pool-watcher.meowing-cereal.workers.dev`, temporary account) is replaced by the **permanent deployment on our standing Cloudflare account**:

- https://yield-pool-watcher.near-rosemary.workers.dev
- `GET /health` → 200 JSON (status ok, 100 pools, cron spec, x402 terms)
- `POST /snapshot` without payment → exact x402 402 with payment requirements ($0.01, Base USDC, `eip155:8453`)

Same code as reviewed here (62/62 vitest green, `tsc --noEmit` clean). PR body updated accordingly.

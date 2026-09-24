# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Foundation module** (`src/foundation/`) — zero-dependency shared layer for the
  watcher pipeline (AGEA-52 / bounty chain #307):
  - `types.ts`: shared domain types — `PoolSnapshot`, `PoolMetrics`, `PoolDelta`,
    `Alert`, `ThresholdRules` — plus `DEFAULT_THRESHOLD_RULES` / `MIN_THRESHOLD_RULES`
    and `parseThresholdRules` (env-var overrides with floor clamping so a config typo
    can never silence alerts). Structural `KvBinding`, `CronEvent`, `WorkerContext`,
    and `Env` surfaces keep the module Workers-portable.
  - `kv.ts`: `kvGetJson` / `kvPutJson` / `kvDelete` with a retry budget
    (100 ms / 500 ms backoff) and spec TTL table (snapshot 1 h, alert 24 h,
    cooldown 1 h, pool list 1 h). Fail-loud error policy: transport failures that
    survive the retry budget throw `KvUnavailableError`; `kvGetJson` returns `null`
    only for a genuine miss; corrupt stored JSON surfaces as `SyntaxError`;
    delete is best-effort by design. Key builders match the spec storage structure.
  - `x402.ts`: hand-rolled x402 v1 pay-per-call middleware (replaces the
    `x402-hono` package for the foundation layer; zero npm dependencies).
    402 + `accepts[]` on missing header, base64/JSON envelope decode with strict
    shape validation (EIP-3009 authorization fields, expiry window, exact amount),
    facilitator `/verify` gate before work, `/settle` only after a 2xx response,
    settle result attached as the base64 `X-PAYMENT-RESPONSE` header.
    Verify/settle/clock are injectable for offline testing.
- **Tests**: 41 foundation tests (`test/foundation/`) — all offline via injected
  fakes; full suite now 62 tests across 6 files.
- **Tests**: strict-index guards (`noUncheckedIndexedAccess`) in
  `test/delta.test.ts` and `test/llama.test.ts` so `tsc --noEmit` is clean
  repo-wide.

[Unreleased]: https://github.com/altaranexus-ship-it/yield-pool-watcher/compare/master...HEAD

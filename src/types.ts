/**
 * Domain types for yield-pool-watcher (bounty #6).
 * Spec §Implementation Decisions: top-100 pools (Aave V3 + Uniswap V3,
 * Ethereum), 10-min cron deltas, 1h cooldown, 24h alert history.
 */
import type { KVNamespace, ScheduledEvent, ExecutionContext } from "@cloudflare/workers-types";

export type { ScheduledEvent, ExecutionContext };

export interface Env {
  /** KV namespace binding (wrangler.toml [[kv_namespaces]]). */
  YIELD_KV: KVNamespace;
  /** PUBLIC pay-to address — config, not a secret. */
  ORG_EVM_PAYTO: string;
  X402_NETWORK: string;
  X402_ASSET: string;
  X402_PRICE: string;
  /** DefiLlama yields endpoint (spec's hosted-Graph endpoints were sunset; see README). */
  DATA_SOURCE_URL: string;
  /** The Graph gateway endpoint for Aave V3 subgraph (optional override). */
  AAVE_SUBGRAPH_URL?: string;
  /** The Graph gateway endpoint for Uniswap V3 subgraph (optional override). */
  UNISWAP_SUBGRAPH_URL?: string;
  /** The Graph gateway API key for authenticated requests (optional). */
  GRAPH_API_KEY?: string;
  /** Alert threshold overrides (optional, defaults in code). */
  APY_CHANGE_BPS?: string;
  TVL_CHANGE_PCT?: string;
  MIN_TVL_USD?: string;
}

export type ProtocolId = "aave-v3" | "uniswap-v3";

/** Normalized per-pool metrics. apy/tvlUsd always present; dex fields for Uniswap; utilization for Aave. */
export interface PoolMetrics {
  /** Annual percentage yield in percent (e.g. 5.2). */
  apy: number;
  /** Total value locked in USD. */
  tvl_usd: number;
  /** 24h volume, USD (Uniswap only). */
  volume_usd_24h: number | null;
  /** 24h fees, USD (Uniswap only). */
  fees_usd_24h: number | null;
  /** Borrow utilization 0..1 (Aave only). */
  utilization: number | null;
}

/** Latest normalized snapshot for one pool. */
export interface PoolSnapshot {
  /** Checksummed contract address (Aave: underlying asset; Uniswap: pool contract). */
  pool_id: string;
  /** Spec pool_id requirement: checksummed addresses. */
  protocol: ProtocolId;
  chain: "ethereum";
  /** Human symbol, e.g. "USDC" or "WETH-USDT 0.3%". */
  symbol: string;
  metrics: PoolMetrics;
  /** Unix ms when this snapshot was captured. */
  captured_at: number;
}

/** Delta between previous and current snapshot (spec §Delta Calculation). */
export interface PoolDelta {
  pool_id: string;
  apyChangeBps: number;
  tvlChangePct: number;
}

export type AlertMetric = "apy" | "tvl";
export type AlertSeverity = "low" | "medium" | "high";
export type AlertType = "apy_change" | "tvl_change";

/** A triggered threshold breach (spec: includes previous + current values). */
export interface Alert {
  type: AlertType;
  metric: AlertMetric;
  severity: AlertSeverity;
  pool_id: string;
  protocol: ProtocolId;
  symbol: string;
  /** Configured threshold that was breached. */
  threshold: { apyChangeBps?: number; tvlChangePct?: number; minTvlUsd?: number };
  previous: { apy: number; tvl_usd: number };
  current: { apy: number; tvl_usd: number };
  apyChangeBps: number;
  tvlChangePct: number;
  triggered_at: number;
}

/** Effective thresholds after validation/defaults (spec values). */
export interface ThresholdConfig {
  /** APY change in basis points. default 500, min 100. */
  apyChangeBps: number;
  /** TVL change in percent. default 10, min 5. */
  tvlChangePct: number;
  /** Ignore pools below this TVL. default 100_000, min 10_000. */
  minTvlUsd: number;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  apyChangeBps: 500,
  tvlChangePct: 10,
  minTvlUsd: 100_000,
};

/** Minimum values enforced to prevent alert spam (spec §Alert Threshold Rules). */
export const MIN_THRESHOLDS: ThresholdConfig = {
  apyChangeBps: 100,
  tvlChangePct: 5,
  minTvlUsd: 10_000,
};

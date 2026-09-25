/**
 * Yield Pool Watcher — shared domain types (AGEA-52 / bounty chain #307).
 *
 * Zero imports, zero runtime dependencies: every shape a downstream stage
 * needs (#308 subgraph integration, #309 delta calculation) lives here.
 * Storage surface (KvBinding) and worker runtime surface (CronEvent,
 * WorkerContext) are declared structurally so this file compiles anywhere.
 */

// ---- Chain & protocol identifiers -------------------------------------------

export type ChainId = "ethereum";

export type ProtocolId = "aave-v3" | "uniswap-v3";

// ---- Normalized pool metrics --------------------------------------------------

/** Per-pool metric set. apy/tvlUsd always present; dex fields for Uniswap; utilization for Aave. */
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
  protocol: ProtocolId;
  chain: ChainId;
  /** Human symbol, e.g. "USDC" or "WETH-USDT 0.3%". */
  symbol: string;
  metrics: PoolMetrics;
  /** Unix ms when this snapshot was captured. */
  captured_at: number;
}

// ---- Deltas (#309 consumes these) ---------------------------------------------

/** Change between the previous and current snapshot for one pool. */
export interface PoolDelta {
  pool_id: string;
  /** Signed APY change in basis points (current - previous). */
  apyChangeBps: number;
  /** Signed TVL change in percent (current - previous). */
  tvlChangePct: number;
}

// ---- Alerts -------------------------------------------------------------------

export type AlertMetric = "apy" | "tvl";
export type AlertSeverity = "low" | "medium" | "high";
export type AlertType = "apy_change" | "tvl_change";

/** A triggered threshold breach, with the configured rule and both readings. */
export interface Alert {
  type: AlertType;
  metric: AlertMetric;
  severity: AlertSeverity;
  pool_id: string;
  protocol: ProtocolId;
  symbol: string;
  /** Configured rule that was breached. */
  threshold: { apyChangeBps?: number; tvlChangePct?: number; minTvlUsd?: number };
  previous: { apy: number; tvl_usd: number };
  current: { apy: number; tvl_usd: number };
  apyChangeBps: number;
  tvlChangePct: number;
  triggered_at: number;
}

// ---- Threshold rules ----------------------------------------------------------

/** Effective alert thresholds after env parsing and floor clamping. */
export interface ThresholdRules {
  /** APY change in basis points. default 500, floor 100. */
  apyChangeBps: number;
  /** TVL change in percent. default 10, floor 5. */
  tvlChangePct: number;
  /** Ignore pools below this TVL. default 100_000, floor 10_000. */
  minTvlUsd: number;
}

export const DEFAULT_THRESHOLD_RULES: ThresholdRules = {
  apyChangeBps: 500,
  tvlChangePct: 10,
  minTvlUsd: 100_000,
};

/** Floors enforced to prevent alert spam (spec §Alert Threshold Rules). */
export const MIN_THRESHOLD_RULES: ThresholdRules = {
  apyChangeBps: 100,
  tvlChangePct: 5,
  minTvlUsd: 10_000,
};

/**
 * Parse threshold overrides (env-var style) with defaults and hard floors.
 * Missing, empty, or non-numeric values fall back to the default; values below
 * a floor are clamped up to it, so an env typo can never silence alerts.
 */
export function parseThresholdRules(
  overrides: Record<string, string | number | undefined> = {}
): ThresholdRules {
  const toNumber = (value: string | number | undefined): number | null => {
    if (value === undefined || value === "") return null;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const withFloor = (raw: number | null, fallback: number, floor: number): number =>
    Math.max(raw ?? fallback, floor);
  return {
    apyChangeBps: withFloor(
      toNumber(overrides.APY_CHANGE_BPS),
      DEFAULT_THRESHOLD_RULES.apyChangeBps,
      MIN_THRESHOLD_RULES.apyChangeBps
    ),
    tvlChangePct: withFloor(
      toNumber(overrides.TVL_CHANGE_PCT),
      DEFAULT_THRESHOLD_RULES.tvlChangePct,
      MIN_THRESHOLD_RULES.tvlChangePct
    ),
    minTvlUsd: withFloor(
      toNumber(overrides.MIN_TVL_USD),
      DEFAULT_THRESHOLD_RULES.minTvlUsd,
      MIN_THRESHOLD_RULES.minTvlUsd
    ),
  };
}

// ---- Storage surface ----------------------------------------------------------

/** Minimal async KV surface. Cloudflare KVNamespace satisfies this structurally. */
export interface KvBinding {
  get(key: string, type?: "text"): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** Optional list support (24h alert history + pagination). */
  list?(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

// ---- Worker runtime surface ----------------------------------------------------

/** Structural stand-in for the Workers ScheduledEvent (cron payload). */
export interface CronEvent {
  cron: string;
  scheduledTime: number;
}

/** Structural stand-in for the Workers ExecutionContext. */
export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

// ---- Environment ---------------------------------------------------------------

/** Worker configuration. KV binding is structural; the rest are plain vars. */
export interface Env {
  YIELD_KV: KvBinding;
  /** PUBLIC pay-to address — config, not a secret. */
  ORG_EVM_PAYTO: string;
  X402_NETWORK: string;
  X402_ASSET: string;
  X402_PRICE: string;
  /** Data source endpoint (DefiLlama yields; see llama adapter). */
  DATA_SOURCE_URL: string;
  /** The Graph gateway endpoint for Aave V3 subgraph (optional override). */
  AAVE_SUBGRAPH_URL?: string;
  /** The Graph gateway endpoint for Uniswap V3 subgraph (optional override). */
  UNISWAP_SUBGRAPH_URL?: string;
  /** The Graph gateway API key for authenticated requests (optional). */
  GRAPH_API_KEY?: string;
  /** Threshold overrides, parsed via parseThresholdRules. */
  APY_CHANGE_BPS?: string;
  TVL_CHANGE_PCT?: string;
  MIN_TVL_USD?: string;
}

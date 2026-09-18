/**
 * Threshold evaluation and breach detection (spec §Alert Threshold Rules).
 * Applies configured thresholds to deltas; emits Alert objects for breaches
 * that pass cooldown + minTVL filters.
 */
import type { PoolDelta, PoolSnapshot, Alert, ThresholdConfig } from "./types";
import { DEFAULT_THRESHOLDS, MIN_THRESHOLDS } from "./types";

export interface EvaluatedThresholds {
  apyChangeBps: number;
  tvlChangePct: number;
  minTvlUsd: number;
}

export function evaluateThresholds(
  delta: PoolDelta,
  current: PoolSnapshot,
  thresholds: ThresholdConfig = DEFAULT_THRESHOLDS
): { apy: boolean; tvl: boolean } {
  const min = MIN_THRESHOLDS;
  const apyBreach =
    Math.abs(delta.apyChangeBps) >= Math.max(thresholds.apyChangeBps, min.apyChangeBps);
  const tvlBreach =
    Math.abs(delta.tvlChangePct) >= Math.max(thresholds.tvlChangePct, min.tvlChangePct) &&
    current.metrics.tvl_usd >= Math.max(thresholds.minTvlUsd, min.minTvlUsd);
  return { apy: apyBreach, tvl: tvlBreach };
}

export function buildAlert(
  delta: PoolDelta,
  current: PoolSnapshot,
  metric: "apy" | "tvl",
  thresholds: ThresholdConfig,
  severity: "low" | "medium" | "high" = "medium"
): Alert {
  const type: Alert["type"] = metric === "apy" ? "apy_change" : "tvl_change";
  const alertMetric: Alert["metric"] = metric;
  const alertSeverity: Alert["severity"] = severity;

  return {
    type,
    metric: alertMetric,
    severity: alertSeverity,
    pool_id: delta.pool_id,
    protocol: current.protocol,
    symbol: current.symbol,
    threshold: {
      apyChangeBps: thresholds.apyChangeBps,
      tvlChangePct: thresholds.tvlChangePct,
      minTvlUsd: thresholds.minTvlUsd,
    },
    previous: {
      apy: current.metrics.apy - delta.apyChangeBps / 100,
      tvl_usd:
        current.metrics.tvl_usd / (1 + delta.tvlChangePct / 100),
    },
    current: {
      apy: current.metrics.apy,
      tvl_usd: current.metrics.tvl_usd,
    },
    apyChangeBps: delta.apyChangeBps,
    tvlChangePct: delta.tvlChangePct,
    triggered_at: current.captured_at,
  };
}
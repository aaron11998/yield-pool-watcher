/**
 * Delta calculation between pool snapshots (spec §Delta Calculation).
 * apyChangeBps = (current.apy - previous.apy) * 100  (basis points)
 * tvlChangePct = (current.tvl_usd - previous.tvl_usd) / previous.tvl_usd * 100
 */
import type { PoolSnapshot, PoolDelta } from "./types";

export function computeDelta(
  current: PoolSnapshot,
  previous: PoolSnapshot
): PoolDelta {
  const apyChangeBps = Math.round(
    (current.metrics.apy - previous.metrics.apy) * 100
  );
  const tvlChangePct =
    previous.metrics.tvl_usd > 0
      ? ((current.metrics.tvl_usd - previous.metrics.tvl_usd) /
          previous.metrics.tvl_usd) *
        100
      : 0;

  return {
    pool_id: current.pool_id,
    apyChangeBps,
    tvlChangePct,
  };
}

/** Batch deltas for all pools with previous snapshots available. */
export function computeAllDeltas(
  current: PoolSnapshot[],
  previous: Map<string, PoolSnapshot>
): PoolDelta[] {
  const deltas: PoolDelta[] = [];
  for (const curr of current) {
    const prev = previous.get(curr.pool_id);
    if (prev) deltas.push(computeDelta(curr, prev));
  }
  return deltas;
}
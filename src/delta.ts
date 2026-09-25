/**
 * Delta calculation between pool snapshots (spec §Delta Calculation).
 * apyChangeBps = (current.apy - previous.apy) * 100  (basis points)
 * tvlChangePct = (current.tvl_usd - previous.tvl_usd) / previous.tvl_usd * 100
 *
 * Zero-division protection: a non-positive or non-finite previous TVL has no
 * meaningful baseline, so tvlChangePct degrades to 0 instead of Infinity/NaN.
 * Non-finite APY on either side degrades to 0 bps — NaN must never reach an
 * Alert payload (JSON.stringify renders it as null, corrupting consumers).
 */
import type { PoolSnapshot, PoolDelta } from "./types";

export function computeDelta(
  current: PoolSnapshot,
  previous: PoolSnapshot
): PoolDelta {
  const currentApy = current.metrics.apy;
  const previousApy = previous.metrics.apy;
  const apyChangeBps =
    Number.isFinite(currentApy) && Number.isFinite(previousApy)
      ? Math.round((currentApy - previousApy) * 100)
      : 0;

  const currentTvl = current.metrics.tvl_usd;
  const previousTvl = previous.metrics.tvl_usd;
  const tvlChangePct =
    Number.isFinite(currentTvl) &&
    Number.isFinite(previousTvl) &&
    previousTvl > 0
      ? ((currentTvl - previousTvl) / previousTvl) * 100
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

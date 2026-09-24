/** Delta calculation tests (spec §Delta Calculation). */
import { describe, it, expect } from "vitest";
import { computeDelta, computeAllDeltas } from "../src/delta";
import type { PoolSnapshot, PoolDelta } from "../src/types";

const baseSnapshot: PoolSnapshot = {
  pool_id: "0x1234567890123456789012345678901234567890",
  protocol: "aave-v3",
  chain: "ethereum",
  symbol: "USDC",
  metrics: {
    apy: 5.0,
    tvl_usd: 1000000,
    volume_usd_24h: null,
    fees_usd_24h: null,
    utilization: 0.8,
  },
  captured_at: Date.now(),
};

describe("delta", () => {
  it("computes APY change in basis points correctly", () => {
    const current = { ...baseSnapshot, metrics: { ...baseSnapshot.metrics, apy: 5.5 } };
    const delta = computeDelta(current, baseSnapshot);
    expect(delta.apyChangeBps).toBe(50); // (5.5 - 5.0) * 100 = 50 bps
  });

  it("computes TVL change in percent correctly", () => {
    const current = { ...baseSnapshot, metrics: { ...baseSnapshot.metrics, tvl_usd: 1100000 } };
    const delta = computeDelta(current, baseSnapshot);
    expect(delta.tvlChangePct).toBeCloseTo(10.0); // (1.1M - 1M) / 1M * 100 = 10%
  });

  it("handles zero previous TVL gracefully", () => {
    const prev = { ...baseSnapshot, metrics: { ...baseSnapshot.metrics, tvl_usd: 0 } };
    const current = { ...baseSnapshot, metrics: { ...baseSnapshot.metrics, tvl_usd: 100000 } };
    const delta = computeDelta(current, prev);
    expect(delta.tvlChangePct).toBe(0);
  });

  it("batch deltas only for pools with previous snapshots", () => {
    const current = [
      { ...baseSnapshot, pool_id: "0x1111111111111111111111111111111111111111" },
      { ...baseSnapshot, pool_id: "0x2222222222222222222222222222222222222222" },
    ];
    const previous = new Map<string, PoolSnapshot>([
      ["0x1111111111111111111111111111111111111111", baseSnapshot],
    ]);
    const deltas = computeAllDeltas(current, previous);
    expect(deltas.length).toBe(1);
    const delta = deltas[0];
    expect(delta).toBeDefined();
    expect(delta!.pool_id).toBe("0x1111111111111111111111111111111111111111");
  });
});
/** Threshold evaluation tests (spec §Alert Threshold Rules). */
import { describe, it, expect } from "vitest";
import { evaluateThresholds, buildAlert } from "../src/thresholds";
import type { PoolDelta, PoolSnapshot, ThresholdConfig, Alert } from "../src/types";

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

const defaultThresholds: ThresholdConfig = {
  apyChangeBps: 500,
  tvlChangePct: 10,
  minTvlUsd: 100_000,
};

describe("thresholds", () => {
  it("detects APY breach above threshold", () => {
    const delta: PoolDelta = { pool_id: baseSnapshot.pool_id, apyChangeBps: 600, tvlChangePct: 0 };
    const { apy, tvl } = evaluateThresholds(delta, baseSnapshot, defaultThresholds);
    expect(apy).toBe(true);
    expect(tvl).toBe(false);
  });

  it("detects TVL breach above threshold", () => {
    const delta: PoolDelta = { pool_id: baseSnapshot.pool_id, apyChangeBps: 0, tvlChangePct: 15 };
    const { apy, tvl } = evaluateThresholds(delta, baseSnapshot, defaultThresholds);
    expect(apy).toBe(false);
    expect(tvl).toBe(true);
  });

  it("respects minimum APY threshold (100 bps)", () => {
    const customThresholds: ThresholdConfig = { ...defaultThresholds, apyChangeBps: 50 }; // Below min
    const delta: PoolDelta = { pool_id: baseSnapshot.pool_id, apyChangeBps: 75, tvlChangePct: 0 };
    const { apy } = evaluateThresholds(delta, baseSnapshot, customThresholds);
    expect(apy).toBe(false); // Below MIN_THRESHOLDS.apyChangeBps (100)
  });

  it("respects minimum TVL threshold (5%)", () => {
    const customThresholds: ThresholdConfig = { ...defaultThresholds, tvlChangePct: 3 }; // Below min
    const delta: PoolDelta = { pool_id: baseSnapshot.pool_id, apyChangeBps: 0, tvlChangePct: 4 };
    const { tvl } = evaluateThresholds(delta, baseSnapshot, customThresholds);
    expect(tvl).toBe(false); // Below MIN_THRESHOLDS.tvlChangePct (5)
  });

  it("respects minTvlUsd filter", () => {
    const lowTvlSnapshot = {
      ...baseSnapshot,
      metrics: { ...baseSnapshot.metrics, tvl_usd: 50_000 }, // Below default 100k
    };
    const delta: PoolDelta = { pool_id: baseSnapshot.pool_id, apyChangeBps: 0, tvlChangePct: 20 };
    const { tvl } = evaluateThresholds(delta, lowTvlSnapshot, defaultThresholds);
    expect(tvl).toBe(false); // Below minTvlUsd
  });

  it("builds APY alert with correct structure", () => {
    const delta: PoolDelta = { pool_id: baseSnapshot.pool_id, apyChangeBps: 600, tvlChangePct: 0 };
    const alert = buildAlert(delta, baseSnapshot, "apy", defaultThresholds, "high");
    expect(alert.type).toBe("apy_change");
    expect(alert.metric).toBe("apy");
    expect(alert.severity).toBe("high");
    expect(alert.pool_id).toBe(baseSnapshot.pool_id);
    expect(alert.apyChangeBps).toBe(600);
    expect(alert.threshold.apyChangeBps).toBe(500);
  });

  it("builds TVL alert with correct structure", () => {
    const delta: PoolDelta = { pool_id: baseSnapshot.pool_id, apyChangeBps: 0, tvlChangePct: 15 };
    const alert = buildAlert(delta, baseSnapshot, "tvl", defaultThresholds, "medium");
    expect(alert.type).toBe("tvl_change");
    expect(alert.metric).toBe("tvl");
    expect(alert.severity).toBe("medium");
    expect(alert.tvlChangePct).toBeCloseTo(15);
    expect(alert.threshold.tvlChangePct).toBe(10);
  });
});
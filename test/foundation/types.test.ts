/** parseThresholdRules: defaults, overrides, floor clamping (AGEA-52). */
import { describe, it, expect } from "vitest";
import {
  parseThresholdRules,
  DEFAULT_THRESHOLD_RULES,
  MIN_THRESHOLD_RULES,
  type PoolSnapshot,
  type Alert,
  type PoolDelta,
} from "../../src/foundation/types";

describe("parseThresholdRules", () => {
  it("returns defaults for no overrides", () => {
    expect(parseThresholdRules()).toEqual(DEFAULT_THRESHOLD_RULES);
  });

  it("returns defaults for empty overrides", () => {
    expect(parseThresholdRules({})).toEqual(DEFAULT_THRESHOLD_RULES);
  });

  it("accepts string overrides", () => {
    const rules = parseThresholdRules({ APY_CHANGE_BPS: "750", TVL_CHANGE_PCT: "25", MIN_TVL_USD: "500000" });
    expect(rules).toEqual({ apyChangeBps: 750, tvlChangePct: 25, minTvlUsd: 500_000 });
  });

  it("accepts numeric overrides", () => {
    const rules = parseThresholdRules({ APY_CHANGE_BPS: 750, MIN_TVL_USD: 250_000 });
    expect(rules.apyChangeBps).toBe(750);
    expect(rules.minTvlUsd).toBe(250_000);
    expect(rules.tvlChangePct).toBe(DEFAULT_THRESHOLD_RULES.tvlChangePct);
  });

  it("clamps below-floor values up to the floors", () => {
    const rules = parseThresholdRules({ APY_CHANGE_BPS: "1", TVL_CHANGE_PCT: "0", MIN_TVL_USD: "1" });
    expect(rules).toEqual(MIN_THRESHOLD_RULES);
  });

  it("falls back to defaults for non-numeric and empty values", () => {
    const rules = parseThresholdRules({ APY_CHANGE_BPS: "abc", TVL_CHANGE_PCT: "", MIN_TVL_USD: undefined });
    expect(rules).toEqual(DEFAULT_THRESHOLD_RULES);
  });

  it("accepts exactly-at-floor values", () => {
    const rules = parseThresholdRules({
      APY_CHANGE_BPS: String(MIN_THRESHOLD_RULES.apyChangeBps),
      TVL_CHANGE_PCT: String(MIN_THRESHOLD_RULES.tvlChangePct),
      MIN_TVL_USD: String(MIN_THRESHOLD_RULES.minTvlUsd),
    });
    expect(rules).toEqual(MIN_THRESHOLD_RULES);
  });
});

describe("domain type shapes (structural compile-time contracts)", () => {
  it("PoolSnapshot round-trips through JSON", () => {
    const snapshot: PoolSnapshot = {
      pool_id: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
      protocol: "uniswap-v3",
      chain: "ethereum",
      symbol: "USDC-WETH 0.05%",
      metrics: { apy: 5.2, tvl_usd: 300_000_000, volume_usd_24h: 1_000_000, fees_usd_24h: 3_000, utilization: null },
      captured_at: 1_726_000_000_000,
    };
    const revived = JSON.parse(JSON.stringify(snapshot)) as PoolSnapshot;
    expect(revived).toEqual(snapshot);
    expect(revived.protocol === "aave-v3" || revived.protocol === "uniswap-v3").toBe(true);
  });

  it("Alert carries rule + both readings", () => {
    const alert: Alert = {
      type: "apy_change",
      metric: "apy",
      severity: "high",
      pool_id: "0x1",
      protocol: "aave-v3",
      symbol: "USDC",
      threshold: { apyChangeBps: 500 },
      previous: { apy: 2, tvl_usd: 1_000_000 },
      current: { apy: 8, tvl_usd: 1_100_000 },
      apyChangeBps: 600,
      tvlChangePct: 10,
      triggered_at: 1_726_000_000_000,
    };
    expect(alert.apyChangeBps).toBeGreaterThan(alert.threshold.apyChangeBps ?? 0);
  });

  it("PoolDelta is signed", () => {
    const delta: PoolDelta = { pool_id: "0x1", apyChangeBps: -250, tvlChangePct: -3.5 };
    expect(delta.apyChangeBps).toBeLessThan(0);
    expect(delta.tvlChangePct).toBeLessThan(0);
  });
});

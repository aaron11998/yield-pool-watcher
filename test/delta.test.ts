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

  it("handles negative previous TVL without division", () => {
    const prev = { ...baseSnapshot, metrics: { ...baseSnapshot.metrics, tvl_usd: -50 } };
    const current = { ...baseSnapshot, metrics: { ...baseSnapshot.metrics, tvl_usd: 100000 } };
    const delta = computeDelta(current, prev);
    expect(delta.tvlChangePct).toBe(0);
  });

  it("degrades to 0 bps when current APY is NaN", () => {
    const current = {
      ...baseSnapshot,
      metrics: { ...baseSnapshot.metrics, apy: Number.NaN },
    };
    const delta = computeDelta(current, baseSnapshot);
    expect(delta.apyChangeBps).toBe(0);
  });

  it("degrades to 0 bps when previous APY is infinite", () => {
    const prev = {
      ...baseSnapshot,
      metrics: { ...baseSnapshot.metrics, apy: Number.POSITIVE_INFINITY },
    };
    const delta = computeDelta(baseSnapshot, prev);
    expect(delta.apyChangeBps).toBe(0);
  });

  it("degrades to 0 pct when previous TVL is not finite", () => {
    const prev = {
      ...baseSnapshot,
      metrics: { ...baseSnapshot.metrics, tvl_usd: Number.NaN },
    };
    const delta = computeDelta(baseSnapshot, prev);
    expect(delta.tvlChangePct).toBe(0);
  });

  it("preserves negative deltas (APY down, TVL down)", () => {
    const current = {
      ...baseSnapshot,
      metrics: { ...baseSnapshot.metrics, apy: 4.0, tvl_usd: 900000 },
    };
    const delta = computeDelta(current, baseSnapshot);
    expect(delta.apyChangeBps).toBe(-100); // (4.0 - 5.0) * 100
    expect(delta.tvlChangePct).toBeCloseTo(-10.0); // (0.9M - 1M) / 1M * 100
  });

  it("first sample (no prior snapshot) is skipped by computeAllDeltas", () => {
    // First cron run for a pool: KV holds no previous snapshot, so the Map is
    // empty — the pool must not produce a delta (no spurious alert baseline).
    const current = [{ ...baseSnapshot, pool_id: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }];
    const deltas = computeAllDeltas(current, new Map());
    expect(deltas.length).toBe(0);
  });

  it("missing prior for one pool skips only that pool", () => {
    const knownId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const unknownId = "0xcccccccccccccccccccccccccccccccccccccccc";
    const current = [
      { ...baseSnapshot, pool_id: knownId },
      { ...baseSnapshot, pool_id: unknownId },
    ];
    const previous = new Map<string, PoolSnapshot>([[knownId, baseSnapshot]]);
    const deltas = computeAllDeltas(current, previous);
    expect(deltas.length).toBe(1);
    expect(deltas[0]!.pool_id).toBe(knownId);
  });

  it("empty current batch yields empty output", () => {
    const previous = new Map<string, PoolSnapshot>([["0x1234567890123456789012345678901234567890", baseSnapshot]]);
    expect(computeAllDeltas([], previous)).toEqual([]);
  });

  it("previous entry for a pool not in the current batch is ignored", () => {
    const staleId = "0xdddddddddddddddddddddddddddddddddddddddd";
    const previous = new Map<string, PoolSnapshot>([
      [baseSnapshot.pool_id, baseSnapshot],
      [staleId, baseSnapshot],
    ]);
    const deltas = computeAllDeltas([baseSnapshot], previous);
    // baseSnapshot's pool has a prior -> 1 delta; the stale entry alone never
    // creates output.
    expect(deltas.length).toBe(1);
    expect(deltas[0]!.pool_id).toBe(baseSnapshot.pool_id);
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

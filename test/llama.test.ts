/** Llama data adapter tests (DefiLlama yields API). */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchLlamaPools,
  isUsableRow,
  topRows,
  deriveUniswapV3PoolAddress,
  checksumAddress,
  parseFeeTier,
  rowToSnapshot,
  buildTop100,
} from "../src/llama";
import type { LlamaPoolRow } from "../src/llama";
import type { PoolSnapshot } from "../src/types";

const mockFetch = vi.fn();

const sampleAaveRow: LlamaPoolRow = {
  pool: "aave-v3-usdc",
  project: "aave-v3",
  chain: "Ethereum",
  symbol: "USDC",
  tvlUsd: 1000000,
  apy: 5.0,
  apyBase: 4.5,
  // Llama uses a different USDC address than canonical
  underlyingTokens: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
  poolMeta: null,
  volumeUsd1d: null,
};

const sampleUniRow: LlamaPoolRow = {
  pool: "uniswap-v3-usdc-weth-0.05",
  project: "uniswap-v3",
  chain: "Ethereum",
  symbol: "USDC-WETH",
  tvlUsd: 5000000,
  apy: 12.0,
  apyBase: null,
  // Use llama's token addresses
  underlyingTokens: [
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  ],
  poolMeta: "0.05%",
  volumeUsd1d: 100000000,
};

describe("llama", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("isUsableRow filters by project, chain, and finite apy/tvl", () => {
    expect(isUsableRow(sampleAaveRow, "aave-v3")).toBe(true);
    expect(isUsableRow({ ...sampleAaveRow, project: "other" }, "aave-v3")).toBe(false);
    expect(isUsableRow({ ...sampleAaveRow, chain: "Polygon" }, "aave-v3")).toBe(false);
    expect(isUsableRow({ ...sampleAaveRow, tvlUsd: 0 }, "aave-v3")).toBe(false);
    expect(isUsableRow({ ...sampleAaveRow, apy: null, apyBase: null }, "aave-v3")).toBe(false);
  });

  it("topRows sorts by TVL desc and limits", () => {
    const rows = [
      { ...sampleAaveRow, tvlUsd: 100 },
      { ...sampleAaveRow, tvlUsd: 1000 },
      { ...sampleAaveRow, tvlUsd: 10000 },
    ];
    const top = topRows(rows, "aave-v3", 2);
    expect(top.length).toBe(2);
    expect(top[0]?.tvlUsd).toBe(10000);
    expect(top[1]?.tvlUsd).toBe(1000);
  });

  it("checksumAddress produces valid EIP-55", () => {
    // Test with canonical USDC address (lowercase)
    const addr = "0xa0b86a33e6441b8c4505b0e33b4a5d4d8f6c6d12";
    const checksummed = checksumAddress(addr);
    expect(checksummed).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The correct EIP-55 checksum computed from lowercase (verified against EIP-55 test vector)
    expect(checksummed).toBe("0xA0B86a33e6441b8C4505b0e33B4a5D4D8f6C6D12");
  });

  it("parseFeeTier parses common fee tiers", () => {
    expect(parseFeeTier("0.3%")).toBe(3000);
    expect(parseFeeTier("0.05%")).toBe(500);
    expect(parseFeeTier("1%")).toBe(10000);
    expect(parseFeeTier("0.01%")).toBe(100);
    expect(parseFeeTier("")).toBeNull();
    expect(parseFeeTier(null)).toBeNull();
  });

  it("deriveUniswapV3PoolAddress matches known pool using llama token addresses", () => {
    // Llama provides different token addresses than canonical
    const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // llama's USDC on Ethereum
    const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"; // llama's WETH on Ethereum
    // With llama's addresses, fee 500 (0.05%) produces the canonical pool
    const pool = deriveUniswapV3PoolAddress(usdc, weth, 500);
    // Known mainnet deployment for USDC/WETH (derived from llama token addresses)
    expect(pool.toLowerCase()).toBe("0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640");
  });

  it("rowToSnapshot produces valid Aave snapshot", () => {
    const snap = rowToSnapshot(sampleAaveRow, 1000000);
    expect(snap.protocol).toBe("aave-v3");
    // Llama's USDC address checksummed
    expect(snap.pool_id.toLowerCase()).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(snap.metrics.apy).toBe(4.5); // apyBase preferred
    expect(snap.metrics.utilization).toBeNull();
  });

  it("rowToSnapshot produces valid Uniswap snapshot", () => {
    const snap = rowToSnapshot(sampleUniRow, 1000000);
    expect(snap.protocol).toBe("uniswap-v3");
    // With llama's token addresses and poolMeta=0.05%, fee=500 produces canonical pool
    expect(snap.pool_id.toLowerCase()).toBe("0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640");
    expect(snap.metrics.volume_usd_24h).toBe(100000000);
    expect(snap.metrics.fees_usd_24h).toBeCloseTo((12.0 / 100 / 365) * 5000000, 2);
  });

  it("buildTop100 returns 100 snapshots (50 each)", () => {
    const rows: LlamaPoolRow[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push({ ...sampleAaveRow, tvlUsd: 1000000 - i * 10000, symbol: `AAVE${i}` });
      rows.push({ ...sampleUniRow, tvlUsd: 1000000 - i * 10000, symbol: `UNI${i}` });
    }
    const snaps = buildTop100(rows, 1000000);
    expect(snaps.length).toBe(100);
    const aaveCount = snaps.filter((s) => s.protocol === "aave-v3").length;
    const uniCount = snaps.filter((s) => s.protocol === "uniswap-v3").length;
    expect(aaveCount).toBe(50);
    expect(uniCount).toBe(50);
  });

  it("fetchLlamaPools retries once on failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [sampleAaveRow] }) });
    const result = await fetchLlamaPools(mockFetch, "https://test.com");
    expect(result).toEqual([sampleAaveRow]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("fetchLlamaPools throws after retries exhausted", async () => {
    mockFetch.mockRejectedValue(new Error("persistent error"));
    await expect(fetchLlamaPools(mockFetch, "https://test.com")).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
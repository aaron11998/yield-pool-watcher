/** Subgraph adapter tests (AGEA-53 / #308). Fully offline: fetch is injected. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchSubgraph,
  fetchPoolSnapshots,
  buildGatewayEndpoint,
  rayRateToApyPercent,
  parseUtilization,
  aaveTvlUsd,
  aaveReserveToSnapshot,
  sum24h,
  parseFeeTierBps,
  uniPoolToSnapshot,
  AAVE_V3_QUERY,
  UNISWAP_V3_QUERY,
  AAVE_V3_SUBGRAPH_ID,
  UNISWAP_V3_SUBGRAPH_ID,
} from "../src/subgraph";
import type {
  AaveQueryResult,
  AaveReserveRow,
  UniPoolRow,
  UniQueryResult,
} from "../src/subgraph";
import type { PoolSnapshot } from "../src/foundation/types";

const mockFetch = vi.fn();

const NOW = 1_760_000_000_000;

// Golden ray numbers: 5% supply APY = 0.05 * 1e27.
const RAY = 1e27;
const RAY_SQ = RAY * RAY;

function aaveRow(overrides: Partial<AaveReserveRow> = {}): AaveReserveRow {
  return {
    id: "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f0x0",
    underlyingAsset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    symbol: "USDC",
    decimals: 6,
    isActive: true,
    isFrozen: false,
    isPaused: false,
    totalLiquidity: "50000000000000", // 50M USDC (1e6 decimals)
    totalCurrentVariableDebt: "20000000000000",
    utilizationRate: "0.4",
    liquidityRate: String(0.05 * RAY),
    variableBorrowRate: String(0.07 * RAY),
    liquidityIndex: String(1.02 * RAY),
    lastUpdateTimestamp: 1_760_000_000,
    price: { priceInEth: String((1 / 3000) * RAY) },
    ...overrides,
  };
}

function uniRow(overrides: Partial<UniPoolRow> = {}): UniPoolRow {
  return {
    id: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    token0: { id: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC" },
    token1: { id: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", symbol: "WETH" },
    feeTier: "500",
    totalValueLockedUSD: "250000000.5",
    volumeUSD: "9876543210.25",
    feesUSD: "2962962.96",
    poolHourData: Array.from({ length: 24 }, (_, i) => ({
      volumeUSD: "1000000",
      feesUSD: "500",
    })),
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "Test",
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as unknown as Response;
}

describe("buildGatewayEndpoint", () => {
  it("joins base url and deployment id, trimming trailing slashes", () => {
    expect(buildGatewayEndpoint("https://gw.test/api/subgraphs/id/", "abc")).toBe(
      "https://gw.test/api/subgraphs/id/abc"
    );
    expect(buildGatewayEndpoint("https://gw.test", "abc")).toBe("https://gw.test/abc");
  });
});

describe("fetchSubgraph", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("POSTs query+variables with auth headers and returns data", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: 1 } }));
    const data = await fetchSubgraph(mockFetch, "https://gw.test/x", "{ q }", { first: 5 }, {
      Authorization: "Bearer test-key",
    });
    expect(data).toEqual({ ok: 1 });
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://gw.test/x");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["Authorization"]).toBe("Bearer test-key");
    expect(JSON.parse(init.body)).toEqual({ query: "{ q }", variables: { first: 5 } });
  });

  it("retries once after an HTTP error and succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 503))
      .mockResolvedValueOnce(jsonResponse({ data: { n: 2 } }));
    const data = await fetchSubgraph(mockFetch, "https://gw.test/x", "{ q }", {});
    expect(data).toEqual({ n: 2 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws the last SubgraphQueryError after retry budget", async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ error: "down" }, 502));
    await expect(fetchSubgraph(mockFetch, "https://gw.test/x", "{ q }", {})).rejects.toThrow(
      /HTTP 502/
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces GraphQL-level errors immediately without burning the retry", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ errors: [{ message: "indexed up to block 100" }] })
    );
    await expect(fetchSubgraph(mockFetch, "https://gw.test/x", "{ q }", {})).rejects.toThrow(
      /indexed up to block/
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("fails immediately when data{} is absent", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(fetchSubgraph(mockFetch, "https://gw.test/x", "{ q }", {})).rejects.toThrow(
      /missing data/
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("aave parsing", () => {
  it("rayRateToApyPercent converts liquidityRate ray to percent", () => {
    expect(rayRateToApyPercent(String(0.05 * RAY))).toBeCloseTo(5, 9);
    expect(rayRateToApyPercent("0")).toBe(0);
  });

  it("parseUtilization accepts 0..1, rejects out-of-range and NaN", () => {
    expect(parseUtilization("0.4")).toBe(0.4);
    expect(parseUtilization("0")).toBe(0);
    expect(parseUtilization("1")).toBe(1);
    expect(parseUtilization("1.5")).toBeNull();
    expect(parseUtilization("-0.1")).toBeNull();
    expect(parseUtilization("NaN")).toBeNull();
  });

  it("aaveTvlUsd golden vector: 50M USDC at 1/3000 ETH, ETH=$3000", () => {
    const row = aaveRow();
    const tvl = aaveTvlUsd(
      row.totalLiquidity,
      row.decimals,
      row.price,
      String(3000 * RAY)
    );
    expect(tvl).not.toBeNull();
    expect(tvl!).toBeCloseTo(50_000_000, 0);
  });

  it("aaveTvlUsd returns null when an oracle leg is missing or broken", () => {
    const row = aaveRow();
    expect(aaveTvlUsd(row.totalLiquidity, row.decimals, null, String(3000 * RAY))).toBeNull();
    expect(
      aaveTvlUsd(row.totalLiquidity, row.decimals, row.price, null)
    ).toBeNull();
    expect(
      aaveTvlUsd(row.totalLiquidity, row.decimals, { priceInEth: "0" }, String(3000 * RAY))
    ).toBeNull();
    expect(aaveTvlUsd(row.totalLiquidity, row.decimals, row.price, "-5")).toBeNull();
  });

  it("aaveReserveToSnapshot normalizes an active reserve", () => {
    const snap = aaveReserveToSnapshot(aaveRow(), String(3000 * RAY), NOW);
    expect(snap).not.toBeNull();
    expect(snap!.protocol).toBe("aave-v3");
    expect(snap!.pool_id).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(snap!.symbol).toBe("USDC");
    expect(snap!.metrics.apy).toBeCloseTo(5, 9);
    expect(snap!.metrics.tvl_usd).toBeCloseTo(50_000_000, 0);
    expect(snap!.metrics.utilization).toBe(0.4);
    expect(snap!.metrics.volume_usd_24h).toBeNull();
    expect(snap!.captured_at).toBe(NOW);
  });

  it("skips frozen/paused/inactive and malformed-address reserves", () => {
    const ok = String(3000 * RAY);
    expect(aaveReserveToSnapshot(aaveRow({ isFrozen: true }), ok, NOW)).toBeNull();
    expect(aaveReserveToSnapshot(aaveRow({ isPaused: true }), ok, NOW)).toBeNull();
    expect(aaveReserveToSnapshot(aaveRow({ isActive: false }), ok, NOW)).toBeNull();
    expect(
      aaveReserveToSnapshot(aaveRow({ underlyingAsset: "not-an-address" }), ok, NOW)
    ).toBeNull();
    expect(
      aaveReserveToSnapshot(aaveRow({ price: null }), ok, NOW)
    ).toBeNull();
  });
});

describe("uniswap parsing", () => {
  it("sum24h adds 24 hourly rows and rejects malformed data", () => {
    expect(sum24h(uniRow().poolHourData, "volumeUSD")).toBeCloseTo(24_000_000, 6);
    expect(sum24h([], "feesUSD")).toBeNull();
    expect(sum24h([{ volumeUSD: "1", feesUSD: "-2" }], "feesUSD")).toBeNull();
    expect(sum24h([{ volumeUSD: "oops", feesUSD: "1" }], "volumeUSD")).toBeNull();
  });

  it("parseFeeTierBps keeps valid positive tiers", () => {
    expect(parseFeeTierBps("500")).toBe(500);
    expect(parseFeeTierBps("10000")).toBe(10000);
    expect(parseFeeTierBps("0")).toBeNull();
    expect(parseFeeTierBps("-5")).toBeNull();
    expect(parseFeeTierBps("abc")).toBeNull();
  });

  it("uniPoolToSnapshot derives fee APY and 24h windows", () => {
    const snap = uniPoolToSnapshot(uniRow(), NOW);
    expect(snap).not.toBeNull();
    // fees: 24h * 500 = 12000/day -> 12000*365/250000000.5*100 ~ 0.01752%
    expect(snap!.metrics.apy).toBeCloseTo(((12_000 * 365) / 250_000_000.5) * 100, 9);
    expect(snap!.metrics.tvl_usd).toBeCloseTo(250_000_000.5, 6);
    expect(snap!.metrics.volume_usd_24h).toBeCloseTo(24_000_000, 6);
    expect(snap!.metrics.fees_usd_24h).toBeCloseTo(12_000, 6);
    expect(snap!.metrics.utilization).toBeNull();
    expect(snap!.protocol).toBe("uniswap-v3");
    expect(snap!.symbol).toBe("USDC-WETH 0.05%");
  });

  it("hour data absent -> APY 0 with null 24h windows (honest unknown)", () => {
    const snap = uniPoolToSnapshot(uniRow({ poolHourData: [] }), NOW);
    expect(snap).not.toBeNull();
    expect(snap!.metrics.apy).toBe(0);
    expect(snap!.metrics.volume_usd_24h).toBeNull();
    expect(snap!.metrics.fees_usd_24h).toBeNull();
  });

  it("skips zero-TVL, malformed pool ids, and bad fee tiers", () => {
    expect(uniPoolToSnapshot(uniRow({ totalValueLockedUSD: "0" }), NOW)).toBeNull();
    expect(uniPoolToSnapshot(uniRow({ id: "0xdead" }), NOW)).toBeNull();
    expect(uniPoolToSnapshot(uniRow({ feeTier: "" }), NOW)).toBeNull();
  });
});

describe("fetchPoolSnapshots", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  function routeByEndpoint(url: string, payload: unknown): Response {
    void url;
    return jsonResponse(payload);
  }

  it("merges both protocols into one snapshot list", async () => {
    const aavePayload: AaveQueryResult = {
      reserves: [aaveRow()],
      priceOracles: [{ usdPriceEth: String(3000 * RAY) }],
    };
    const uniPayload: UniQueryResult = { pools: [uniRow()] };
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes(AAVE_V3_SUBGRAPH_ID)) return routeByEndpoint(url, { data: aavePayload });
      if (url.includes(UNISWAP_V3_SUBGRAPH_ID)) return routeByEndpoint(url, { data: uniPayload });
      return jsonResponse({ error: "unknown endpoint" }, 404);
    });
    const snaps = await fetchPoolSnapshots({
      fetchImpl: mockFetch,
      aave: {
        endpoint: buildGatewayEndpoint("https://gw.test", AAVE_V3_SUBGRAPH_ID),
        headers: { Authorization: "Bearer aave-key" },
      },
      uniswap: {
        endpoint: buildGatewayEndpoint("https://gw.test", UNISWAP_V3_SUBGRAPH_ID),
      },
      perProtocol: 50,
      nowMs: NOW,
    });
    expect(snaps).toHaveLength(2);
    const protocols = snaps.map((s: PoolSnapshot) => s.protocol).sort();
    expect(protocols).toEqual(["aave-v3", "uniswap-v3"]);
    const aaveCall = mockFetch.mock.calls.find((c) => c[0].includes(AAVE_V3_SUBGRAPH_ID))!;
    expect(aaveCall[1].headers.Authorization).toBe("Bearer aave-key");
    expect(JSON.parse(aaveCall[1].body).query).toContain("reserves");
    const uniCall = mockFetch.mock.calls.find((c) => c[0].includes(UNISWAP_V3_SUBGRAPH_ID))!;
    expect(JSON.parse(uniCall[1].body).query).toContain("pools");
  });

  it("drops oracle-less Aave reserves but keeps valid Uniswap pools", async () => {
    const aavePayload: AaveQueryResult = {
      reserves: [aaveRow(), aaveRow({ price: null })],
      priceOracles: null,
    };
    // First reserve survives only if usdPriceEth exists; here it must be dropped.
    const uniPayload: UniQueryResult = { pools: [uniRow()] };
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/aave")) return jsonResponse({ data: aavePayload });
      return jsonResponse({ data: uniPayload });
    });
    const snaps = await fetchPoolSnapshots({
      fetchImpl: mockFetch,
      aave: { endpoint: "https://gw.test/aave" },
      uniswap: { endpoint: "https://gw.test/uni" },
      perProtocol: 50,
      nowMs: NOW,
    });
    expect(snaps.map((s) => s.protocol)).toEqual(["uniswap-v3"]);
  });

  it("propagates a failing protocol as a rejected promise (fail-loud)", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes(AAVE_V3_SUBGRAPH_ID)) return jsonResponse({ error: "down" }, 500);
      return jsonResponse({ data: { pools: [] } });
    });
    await expect(
      fetchPoolSnapshots({
        fetchImpl: mockFetch,
        aave: {
          endpoint: buildGatewayEndpoint("https://gw.test", AAVE_V3_SUBGRAPH_ID),
        },
        uniswap: {
          endpoint: buildGatewayEndpoint("https://gw.test", UNISWAP_V3_SUBGRAPH_ID),
        },
        perProtocol: 50,
        nowMs: NOW,
      })
    ).rejects.toThrow(/HTTP 500/);
  });

  it("queries carry the narrowed field set and Aave ordering", async () => {
    expect(AAVE_V3_QUERY).toContain("orderBy: totalLiquidity");
    expect(AAVE_V3_QUERY).toContain("priceOracles");
    expect(AAVE_V3_QUERY).toContain("liquidityRate");
    expect(UNISWAP_V3_QUERY).toContain("poolHourData");
    expect(UNISWAP_V3_QUERY).toContain("totalValueLockedUSD");
  });
});

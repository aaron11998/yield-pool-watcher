/**
 * Subgraph data source adapter (AGEA-53 / bounty chain #308).
 *
 * Queries Aave V3 and Uniswap V3 subgraphs and parses pool metrics into the
 * normalized PoolSnapshot shape from src/foundation/types.ts.
 *
 * Endpoint reality (verified 2026-09-25):
 * - The legacy hosted service (api.thegraph.com/subgraphs/name/...) was
 *   sunset: every path now 301s to error.thegraph.com.
 * - The Graph gateway (gateway.thegraph.com/api/subgraphs/id/{deployment})
 *   requires a per-account API key sent as `Authorization: Bearer <key>`.
 *
 * The adapter therefore takes endpoints + optional auth headers as plain
 * config (Env vars, never literals) and stays transport-agnostic: fetchImpl
 * is injected, so tests run fully offline against canned GraphQL payloads.
 *
 * Field math per schema ground truth:
 * - Aave (aave/protocol-subgraphs schemas/v3.schema.graphql): Reserve has
 *   liquidityRate / variableBorrowRate / liquidityIndex as BigInt ray (1e27),
 *   totalLiquidity + totalCurrentVariableDebt as BigInt wei, utilizationRate
 *   as BigDecimal 0..1, and price via PriceOracleAsset.priceInEth (ray, ETH
 *   units) against PriceOracle.usdPriceEth (ray, USD per ETH). TVL in USD =
 *   totalLiquidity * scaledEthPrice / 1e27 where scaledEthPrice =
 *   priceInEth / usdPriceEth * usdPriceEth... — resolved concretely below as
 *   (totalLiquidity * priceInEth * usdPriceEth) / 1e54.
 * - Uniswap (Uniswap/v3-subgraph src/v3/schema.graphql): Pool carries
 *   totalValueLockedUSD, feesUSD, volumeUSD (all-time); 24h windows come from
 *   the newest poolHourData rows (volumeUSD / feesUSD per hour summed).
 */
import type { PoolSnapshot, PoolMetrics, ProtocolId } from "./foundation/types";

export interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

/** Optional per-endpoint auth headers (e.g. { Authorization: "Bearer ..." }). */
export type SubgraphHeaders = Record<string, string>;

/** Live Aave V3 mainnet deployment id on The Graph gateway (steady since 2023). */
export const AAVE_V3_SUBGRAPH_ID = "deq7E7AHAcRy3Trb7tp1FwaseRL4sVvancpMYkgXIiGE";
/** Official Uniswap V3 stats subgraph deployment id on The Graph gateway. */
export const UNISWAP_V3_SUBGRAPH_ID = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";

export const DEFAULT_GATEWAY_URL = "https://gateway.thegraph.com/api/subgraphs/id";

export const buildGatewayEndpoint = (baseUrl: string, deploymentId: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/${deploymentId}`;

/** Query requested per protocol. Kept narrow: only fields the parser touches. */
export const AAVE_V3_QUERY = `
  query TopReserves($first: Int!) {
    reserves(
      where: { isActive: true, isFrozen: false, isPaused: false }
      first: $first
      orderBy: totalLiquidity
      orderDirection: desc
    ) {
      id
      underlyingAsset
      symbol
      decimals
      isActive
      isFrozen
      isPaused
      totalLiquidity
      totalCurrentVariableDebt
      utilizationRate
      liquidityRate
      variableBorrowRate
      liquidityIndex
      lastUpdateTimestamp
      price { priceInEth }
    }
    # Freshest oracle wins: PriceOracle ids are contract addresses, so a magic
    # id lookup is fragile. lastUpdateTimestamp always descends to the live one.
    priceOracles(first: 1, orderBy: lastUpdateTimestamp, orderDirection: desc) {
      usdPriceEth
    }
  }
`;

export const UNISWAP_V3_QUERY = `
  query TopPools($first: Int!, $orderBy: String!) {
    pools(first: $first, orderBy: $orderBy, orderDirection: desc) {
      id
      token0 { id symbol }
      token1 { id symbol }
      feeTier
      totalValueLockedUSD
      volumeUSD
      feesUSD
      poolHourData(first: 24, orderBy: periodStartUnix, orderDirection: desc) {
        volumeUSD
        feesUSD
      }
    }
  }
`;

/** Narrow GraphQL JSON response shape; anything else fails validation below. */
export interface SubgraphResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export class SubgraphQueryError extends Error {
  readonly status: number;
  constructor(endpoint: string, status: number, detail: string) {
    super(`subgraph query failed for ${endpoint} (HTTP ${status}): ${detail}`);
    this.name = "SubgraphQueryError";
    this.status = status;
  }
}

/** POST one GraphQL document. Retries once after 500ms on network/HTTP error. */
export async function fetchSubgraph<T>(
  fetchImpl: FetchLike,
  endpoint: string,
  query: string,
  variables: Record<string, unknown>,
  headers: SubgraphHeaders = {}
): Promise<T> {
  let lastErr: unknown = new Error("unreachable");
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new SubgraphQueryError(endpoint, res.status, bodyText.slice(0, 200) || res.statusText);
      }
      const body = (await res.json()) as SubgraphResponse<T>;
      if (body.errors?.length) {
        throw new SubgraphQueryError(endpoint, res.status, body.errors.map((e) => e.message).join("; "));
      }
      if (!body.data) {
        throw new SubgraphQueryError(endpoint, res.status, "payload missing data{}");
      }
      return body.data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---- Aave parsing ---------------------------------------------------------------

/** Ray factor: Aave stores rates/indices as fixed-point 1e27. */
const RAY = 1e27;
/** RAY^2: a USD price derivation divides two ray values, needing 1e54. */
const RAY_SQ = RAY * RAY;

/** Raw shapes exactly as the GraphQL query asks them. */
export interface AavePriceEntry {
  priceInEth: string;
}

export interface AaveReserveRow {
  id: string;
  underlyingAsset: string;
  symbol: string;
  decimals: number;
  isActive: boolean;
  isFrozen: boolean;
  isPaused: boolean;
  totalLiquidity: string;
  totalCurrentVariableDebt: string;
  utilizationRate: string;
  liquidityRate: string;
  variableBorrowRate: string;
  liquidityIndex: string;
  lastUpdateTimestamp: number;
  price: AavePriceEntry | null;
}

export interface AaveQueryResult {
  reserves: AaveReserveRow[];
  priceOracles: { usdPriceEth: string }[] | null;
}

/** supply APY in percent: ray -> percent. liquidityRate is the supplier rate. */
export function rayRateToApyPercent(liquidityRate: string): number {
  return Number(liquidityRate) / RAY * 100;
}

/** utilizationRate BigDecimal (0..1 as string) -> finite 0..1, else null. */
export function parseUtilization(rate: string): number | null {
  const v = Number(rate);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

/**
 * USD TVL from wei liquidity, token decimals, and the oracle pair:
 * priceInEth (ray, ETH per 1 token-unit) and usdPriceEth (ray, USD per ETH):
 * tvlUsd = totalLiquidity(wei) / 10^decimals * priceInEth/RAY * usdPriceEth/RAY
 *        = totalLiquidity * priceInEth * usdPriceEth / (10^decimals * 1e54).
 * Null when either oracle leg is missing/non-positive: a broken price feed
 * must never fabricate a zero TVL (deltas + alerts depend on real values).
 */
export function aaveTvlUsd(
  totalLiquidity: string,
  decimals: number,
  price: AavePriceEntry | null,
  usdPriceEth: string | null
): number | null {
  if (!price || !usdPriceEth) return null;
  const priceInEth = Number(price.priceInEth);
  const usdPerEth = Number(usdPriceEth);
  if (!Number.isFinite(priceInEth) || priceInEth <= 0) return null;
  if (!Number.isFinite(usdPerEth) || usdPerEth <= 0) return null;
  if (!Number.isFinite(decimals) || decimals < 0) return null;
  const denom = Math.pow(10, decimals) * RAY_SQ;
  return (Number(totalLiquidity) * priceInEth * usdPerEth) / denom;
}

/** Aave reserve -> PoolSnapshot. Returns null on unusable rows (documented skip). */
export function aaveReserveToSnapshot(
  row: AaveReserveRow,
  usdPriceEth: string | null,
  nowMs: number
): PoolSnapshot | null {
  if (row.isActive === false || row.isFrozen || row.isPaused) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(row.underlyingAsset)) return null;
  const tvl = aaveTvlUsd(row.totalLiquidity, row.decimals, row.price, usdPriceEth);
  if (tvl === null || !Number.isFinite(tvl) || tvl <= 0) return null;
  const metrics: PoolMetrics = {
    apy: rayRateToApyPercent(row.liquidityRate),
    tvl_usd: tvl,
    volume_usd_24h: null,
    fees_usd_24h: null,
    utilization: parseUtilization(row.utilizationRate),
  };
  return {
    pool_id: row.underlyingAsset,
    protocol: "aave-v3",
    chain: "ethereum",
    symbol: row.symbol,
    metrics,
    captured_at: nowMs,
  };
}

// ---- Uniswap parsing --------------------------------------------------------

export interface UniHourData {
  volumeUSD: string;
  feesUSD: string;
}

export interface UniToken {
  id: string;
  symbol: string;
}

export interface UniPoolRow {
  id: string;
  token0: UniToken;
  token1: UniToken;
  feeTier: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
  feesUSD: string;
  poolHourData: UniHourData[];
}

export interface UniQueryResult {
  pools: UniPoolRow[];
}

/** Sum 24 hourly rows (USD strings) -> finite number, else null. */
export function sum24h(hours: UniHourData[], field: "volumeUSD" | "feesUSD"): number | null {
  if (!Array.isArray(hours) || hours.length === 0) return null;
  let total = 0;
  for (const hour of hours) {
    const v = Number(hour[field]);
    if (!Number.isFinite(v) || v < 0) return null;
    total += v;
  }
  return total;
}

/** Fee tier basis points (e.g. "500") -> APY percent contribution, plus sanity. */
export function parseFeeTierBps(feeTier: string): number | null {
  const v = Number(feeTier);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v;
}

/** Uniswap V3 pool -> PoolSnapshot. Returns null on unusable rows. */
export function uniPoolToSnapshot(row: UniPoolRow, nowMs: number): PoolSnapshot | null {
  const tvl = Number(row.totalValueLockedUSD);
  if (!Number.isFinite(tvl) || tvl <= 0) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(row.id)) return null;
  const volume24h = sum24h(row.poolHourData, "volumeUSD");
  const fees24h = sum24h(row.poolHourData, "feesUSD");
  const feeTier = parseFeeTierBps(row.feeTier);
  if (feeTier === null) return null;
  // Fee APY: daily-ized from 24h fees; hourly data absent -> null APY leg.
  const apy = fees24h !== null && tvl > 0 ? ((fees24h * 365) / tvl) * 100 : 0;
  const metrics: PoolMetrics = {
    apy,
    tvl_usd: tvl,
    volume_usd_24h: volume24h,
    fees_usd_24h: fees24h,
    utilization: null,
  };
  return {
    pool_id: row.id,
    protocol: "uniswap-v3",
    chain: "ethereum",
    symbol: `${row.token0.symbol}-${row.token1.symbol} ${feeTier / 10000}%`,
    metrics,
    captured_at: nowMs,
  };
}

// ---- Top-level harvest ------------------------------------------------------

export interface SubgraphSourceConfig {
  endpoint: string;
  headers?: SubgraphHeaders;
}

export interface SubgraphFetchArgs {
  fetchImpl: FetchLike;
  aave: SubgraphSourceConfig;
  uniswap: SubgraphSourceConfig;
  perProtocol: number;
  nowMs: number;
}

/** Both protocols in parallel; one protocol failing is fatal per spec fail-loud. */
export async function fetchPoolSnapshots(args: SubgraphFetchArgs): Promise<PoolSnapshot[]> {
  const [aaveRes, uniRes] = await Promise.all([
    fetchSubgraph<AaveQueryResult>(
      args.fetchImpl,
      args.aave.endpoint,
      AAVE_V3_QUERY,
      { first: args.perProtocol },
      args.aave.headers ?? {}
    ),
    fetchSubgraph<UniQueryResult>(
      args.fetchImpl,
      args.uniswap.endpoint,
      UNISWAP_V3_QUERY,
      { first: args.perProtocol },
      args.uniswap.headers ?? {}
    ),
  ]);
  const usdPriceEth = aaveRes.priceOracles?.[0]?.usdPriceEth ?? null;
  const aaveSnapshots = aaveRes.reserves
    .map((r) => aaveReserveToSnapshot(r, usdPriceEth, args.nowMs))
    .filter((s): s is PoolSnapshot => s !== null);
  const uniSnapshots = uniRes.pools
    .map((r) => uniPoolToSnapshot(r, args.nowMs))
    .filter((s): s is PoolSnapshot => s !== null);
  return [...aaveSnapshots, ...uniSnapshots];
}

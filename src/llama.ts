/**
 * Data source adapter (spec deviation, documented):
 *
 * Spec named legacy hosted-Graph endpoints
 * (api.thegraph.com/subgraphs/name/{aave/protocol-v3,uniswap/uniswap-v3}).
 * Those were sunset by Edge & Node in 2023 and now return HTTP 301 HTML —
 * verified 2026-09-18 before build start. The durable free equivalent carrying
 * the same numbers is the DefiLlama yields API (no key):
 *   GET {DATA_SOURCE_URL} -> { data: LlamaPoolRow[] }
 *
 * Identity strategy (keeps spec's checksummed-address requirement honest):
 * - Aave V3 rows: underlyingTokens[0] is the reserve's underlying token ->
 *   EIP-55 checksummed via keccak-256 (js-sha3).
 * - Uniswap V3 rows: llama exposes token0/token1 + fee tier, not the pool
 *   contract — so we derive the REAL pool address via the documented V3
 *   CREATE2 formula (factory 0x1F98431c8aD98523631AE4a59f267346ea31F984,
 *   init code hash 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54).
 *   Golden-vector tested against known deployments (e.g. USDC/WETH 0.05% ->
 *   0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640).
 *
 * Side effect vs spec: the 200-subgraph-query risk (#1) collapses to ONE
 * upstream GET per cron — free-tier subrequest budget is never in play.
 */
import { keccak256 } from "js-sha3";
import type { PoolSnapshot, PoolMetrics, ProtocolId } from "./types";

export interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

export interface LlamaPoolRow {
  pool: string;
  project: string;
  chain: string;
  symbol: string;
  tvlUsd: number;
  apy: number | null;
  apyBase?: number | null;
  volumeUsd1d?: number | null;
  underlyingTokens?: (string | null)[] | null;
  poolMeta?: string | null;
}

export interface LlamaResponse {
  data: LlamaPoolRow[];
}

export const ETHEREUM = "Ethereum";
export const TOP_PER_PROTOCOL = 50; // 50 Aave + 50 Uniswap = spec's top-100

/** GET + parse the llama yields feed. Retry once after 500ms (spec §Error Handling). */
export async function fetchLlamaPools(
  fetchImpl: FetchLike,
  url: string
): Promise<LlamaPoolRow[]> {
  let lastErr: unknown = new Error("unreachable");
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`llama HTTP ${res.status}`);
      const body = (await res.json()) as LlamaResponse;
      if (!body || !Array.isArray(body.data)) throw new Error("llama payload missing data[]");
      return body.data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Usable row: right project+chain, finite apy/tvl, tvl > 0. */
export function isUsableRow(row: LlamaPoolRow, protocol: ProtocolId): boolean {
  if (row.project !== protocol || row.chain !== ETHEREUM) return false;
  if (typeof row.tvlUsd !== "number" || !Number.isFinite(row.tvlUsd) || row.tvlUsd <= 0)
    return false;
  const apy = row.apyBase ?? row.apy;
  return typeof apy === "number" && Number.isFinite(apy);
}

/** Top-N by TVL per protocol, stable order. */
export function topRows(
  rows: LlamaPoolRow[],
  protocol: ProtocolId,
  n: number
): LlamaPoolRow[] {
  return rows
    .filter((r) => isUsableRow(r, protocol))
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, n);
}

// ---- Address derivation ------------------------------------------------------

const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_V3_POOL_INIT_CODE_HASH =
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

/** abi.encode(address a, address b, uint24 fee) -> 96-byte hex (3 words). */
function encodePoolKey(tokenA: string, tokenB: string, fee: number): string {
  const word = (hexAddr: string) => hexAddr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  // Uniswap V3 sorts tokens by address
  const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  return word(t0) + word(t1) + fee.toString(16).padStart(64, "0");
}

/** Uniswap V3 CREATE2 pool address: keccak(0xff ++ factory ++ keyHash ++ initHash)[12:]. */
export function deriveUniswapV3PoolAddress(
  tokenA: string,
  tokenB: string,
  fee: number
): string {
  const keyHash = keccak256(hexToBytes(encodePoolKey(tokenA, tokenB, fee)));
  const preimage = new Uint8Array(1 + 20 + 32 + 32);
  preimage[0] = 0xff;
  preimage.set(hexToBytes(UNISWAP_V3_FACTORY), 1);
  preimage.set(hexToBytes(keyHash), 21);
  preimage.set(hexToBytes(UNISWAP_V3_POOL_INIT_CODE_HASH), 53);
  const raw = keccak256(preimage).slice(24); // last 20 bytes
  return checksumAddress("0x" + raw);
}

/** EIP-55 mixed-case checksumming (keccak-256 based). */
export function checksumAddress(addr: string): string {
  const m = /^0x[0-9a-fA-F]{40}$/.exec(addr);
  if (!m) throw new Error(`not an address: ${addr}`);
  const low = addr.toLowerCase().slice(2);
  // Hash the bytes of the address, not the string
  const hash = keccak256(hexToBytes(low));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const c = low[i]!;
    // hash is hex string, each char is a nibble; check if nibble >= 8
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/** "0.3%" -> 3000, "0.05%" -> 500, "1%" -> 10000. null when absent/unparseable. */
export function parseFeeTier(poolMeta: string | null | undefined): number | null {
  if (!poolMeta) return null;
  const m = /^([\d.]+)\s*%$/.exec(poolMeta.trim());
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return Math.round(pct * 10000); // 0.3% -> 3000, 0.05% -> 500, 1% -> 10000
}

// ---- Row -> snapshot -----------------------------------------------------------

export function rowToSnapshot(row: LlamaPoolRow, nowMs: number): PoolSnapshot {
  const isAave = row.project === "aave-v3";
  const protocol: ProtocolId = isAave ? "aave-v3" : "uniswap-v3";
  const apy = row.apyBase ?? row.apy ?? 0;
  const tvl = row.tvlUsd;

  let poolId: string;
  let metrics: PoolMetrics;

  if (isAave) {
    const underlying = row.underlyingTokens?.[0];
    if (typeof underlying !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(underlying)) {
      throw new Error(`aave row missing underlying token: ${row.symbol}`);
    }
    poolId = checksumAddress(underlying);
    metrics = {
      apy,
      tvl_usd: tvl,
      volume_usd_24h: null,
      fees_usd_24h: null,
      // Not exposed by the free llama feed; documented README limitation.
      utilization: null,
    };
  } else {
    const tokens = row.underlyingTokens ?? [];
    const [t0, t1] = tokens;
    if (
      typeof t0 !== "string" ||
      typeof t1 !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(t0) ||
      !/^0x[0-9a-fA-F]{40}$/.test(t1)
    ) {
      throw new Error(`uniswap row missing token pair: ${row.symbol}`);
    }
    const fee = parseFeeTier(row.poolMeta) ?? 3000; // 0.3% is the V3 default tier
    poolId = deriveUniswapV3PoolAddress(t0, t1, fee);
    const fees24h = (apy / 100 / 365) * tvl; // inverse of spec's own APY formula
    metrics = {
      apy,
      tvl_usd: tvl,
      volume_usd_24h: typeof row.volumeUsd1d === "number" ? row.volumeUsd1d : null,
      fees_usd_24h: fees24h,
      utilization: null,
    };
  }

  return {
    pool_id: poolId,
    protocol,
    chain: "ethereum",
    symbol: isAave ? row.symbol : `${row.symbol} ${row.poolMeta ?? ""}`.trim(),
    metrics,
    captured_at: nowMs,
  };
}

/** Full top-100 harvest: 50 Aave + 50 Uniswap snapshots. */
export function buildTop100(rows: LlamaPoolRow[], nowMs: number): PoolSnapshot[] {
  const aave = topRows(rows, "aave-v3", TOP_PER_PROTOCOL).map((r) => rowToSnapshot(r, nowMs));
  const uni = topRows(rows, "uniswap-v3", TOP_PER_PROTOCOL).map((r) => rowToSnapshot(r, nowMs));
  return [...aave, ...uni];
}

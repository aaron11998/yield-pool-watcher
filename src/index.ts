// yield-pool-watcher - Cloudflare Workers entrypoint (bounty #6, GStack tech plan).
// Cron: */10 * * * * - 10-minute polling per spec.
// Free: GET /health, GET /alerts.
// Paid: POST /snapshot - $0.01, network eip155:8453 (Base), USDC.
// No private keys: x402 middleware only VERIFIES payment.
import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import { computeAllDeltas, computeDelta } from "./delta";
import { evaluateThresholds, buildAlert } from "./thresholds";
import {
  shouldAlert,
  recordAlert,
  getRecentAlerts,
  updateLastCron,
  getLastCron,
} from "./alerts";
import { kvGetJson, kvPutJson, snapshotKey, previousKey, POOL_LIST_KEY, TTL } from "./kv";
import type {
  PoolSnapshot,
  PoolDelta,
  Alert,
  ThresholdConfig,
  Env,
  ScheduledEvent,
  ExecutionContext,
} from "./types";
// Subgraph imports
import {
  fetchPoolSnapshots,
  AAVE_V3_SUBGRAPH_ID,
  UNISWAP_V3_SUBGRAPH_ID,
  buildGatewayEndpoint,
  DEFAULT_GATEWAY_URL,
} from "./subgraph";

const X402_NETWORK = "eip155:8453";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

type Bindings = Env;

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "yield-pool-watcher",
    pools: 100,
    cron: "*/10 * * * *",
    x402: { network: X402_NETWORK, asset: USDC_BASE, price: "$0.01/call" },
  })
);

app.get("/alerts", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 200);
  const since = c.req.query("since")
    ? Number(c.req.query("since"))
    : Date.now() - 24 * 3600 * 1000;
  const alerts = await getRecentAlerts(c.env.YIELD_KV, limit, since);
  return c.json({ alerts, count: alerts.length });
});

/** Per-request middleware wiring: Workers env vars exist only on the request context. */
app.use("/snapshot", async (c, next) => {
  const mw = paymentMiddleware(c.env.ORG_EVM_PAYTO as `0x${string}`, {
    "/snapshot": {
      price: "$0.01",
      network: "base",
      config: {
        description: "Yield pool watcher: top-100 Aave V3 + Uniswap V3 snapshots + deltas",
      },
    },
  });
  return mw(c, next);
});

app.post("/snapshot", async (c) => {
  const nowMs = Date.now();

  // Build subgraph endpoints from env or defaults
  const aaveEndpoint = c.env.AAVE_SUBGRAPH_URL ?? buildGatewayEndpoint(DEFAULT_GATEWAY_URL, AAVE_V3_SUBGRAPH_ID);
  const uniswapEndpoint = c.env.UNISWAP_SUBGRAPH_URL ?? buildGatewayEndpoint(DEFAULT_GATEWAY_URL, UNISWAP_V3_SUBGRAPH_ID);

  // Prepare headers for The Graph gateway API key if configured
  const graphApiKey = c.env.GRAPH_API_KEY;
  const subgraphHeaders = graphApiKey ? { Authorization: `Bearer ${graphApiKey}` } : {};

  const aaveConfig = { endpoint: aaveEndpoint, headers: subgraphHeaders };
  const uniswapConfig = { endpoint: uniswapEndpoint, headers: subgraphHeaders };

  // Fetch snapshots from both subgraphs (100 each, then we'll take top 100 by TVL)
  const snapshots = await fetchPoolSnapshots({
    fetchImpl: fetch,
    aave: aaveConfig,
    uniswap: uniswapConfig,
    perProtocol: 100,
    nowMs,
  });

  // Sort by TVL descending and take top 100
  const sorted = snapshots
    .filter((s): s is PoolSnapshot => s !== null && s.metrics.tvl_usd > 0)
    .sort((a, b) => b.metrics.tvl_usd - a.metrics.tvl_usd);
  const top100 = sorted.slice(0, 100);

  // Load previous snapshots from KV
  const previousMap = new Map<string, PoolSnapshot>();
  for (const snap of top100) {
    const prev = await kvGetJson<PoolSnapshot>(c.env.YIELD_KV, previousKey(snap.pool_id));
    if (prev) previousMap.set(snap.pool_id, prev);
  }

  // Compute deltas
  const deltas = computeAllDeltas(top100, previousMap);

  // Evaluate thresholds and fire alerts
  const thresholds: ThresholdConfig = {
    apyChangeBps: Number(c.env.APY_CHANGE_BPS ?? 500),
    tvlChangePct: Number(c.env.TVL_CHANGE_PCT ?? 10),
    minTvlUsd: Number(c.env.MIN_TVL_USD ?? 100_000),
  };

  const firedAlerts: Alert[] = [];
  for (const delta of deltas) {
    const current = top100.find((s) => s.pool_id === delta.pool_id);
    if (!current) continue;

    const { apy, tvl } = evaluateThresholds(delta, current, thresholds);

    if (apy && (await shouldAlert(c.env.YIELD_KV, delta.pool_id, "apy"))) {
      const alert = buildAlert(delta, current, "apy", thresholds);
      await recordAlert(c.env.YIELD_KV, alert);
      firedAlerts.push(alert);
    }
    if (tvl && (await shouldAlert(c.env.YIELD_KV, delta.pool_id, "tvl"))) {
      const alert = buildAlert(delta, current, "tvl", thresholds);
      await recordAlert(c.env.YIELD_KV, alert);
      firedAlerts.push(alert);
    }
  }

  // Store current snapshots as previous for next cron
  for (const snap of top100) {
    await kvPutJson(c.env.YIELD_KV, previousKey(snap.pool_id), snap, TTL.previousSeconds);
    await kvPutJson(c.env.YIELD_KV, snapshotKey(snap.pool_id), snap, TTL.snapshotSeconds);
  }

  // Store pool list for reference
  await kvPutJson(c.env.YIELD_KV, POOL_LIST_KEY, top100.map((s) => s.pool_id), TTL.poolListSeconds);

  // Update last cron timestamp
  await updateLastCron(c.env.YIELD_KV, nowMs);

  return c.json({
    snapshots: top100.length,
    deltas: deltas.length,
    alerts_fired: firedAlerts.length,
    alerts: firedAlerts,
    timestamp: nowMs,
  });
});

// Cloudflare Workers module format: default export = fetch handler (serves all
// HTTP routes via Hono), named `scheduled` below = cron handler.
// GST-24 root-cause fix: this file previously exported only `{ app }`, so the
// deployed worker had no fetch handler and CF served "nothing here yet" (404)
// on every route.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};

// Scheduled handler for cron
export async function scheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  // Run the same logic as POST /snapshot but without payment middleware
  const nowMs = Date.now();

  // Build subgraph endpoints from env or defaults
  const aaveEndpoint = env.AAVE_SUBGRAPH_URL ?? buildGatewayEndpoint(DEFAULT_GATEWAY_URL, AAVE_V3_SUBGRAPH_ID);
  const uniswapEndpoint = env.UNISWAP_SUBGRAPH_URL ?? buildGatewayEndpoint(DEFAULT_GATEWAY_URL, UNISWAP_V3_SUBGRAPH_ID);

  // Prepare headers for The Graph gateway API key if configured
  const graphApiKey = env.GRAPH_API_KEY;
  const subgraphHeaders = graphApiKey ? { Authorization: `Bearer ${graphApiKey}` } : {};

  const aaveConfig = { endpoint: aaveEndpoint, headers: subgraphHeaders };
  const uniswapConfig = { endpoint: uniswapEndpoint, headers: subgraphHeaders };

  // Fetch snapshots from both subgraphs (100 each, then we'll take top 100 by TVL)
  const snapshots = await fetchPoolSnapshots({
    fetchImpl: fetch,
    aave: aaveConfig,
    uniswap: uniswapConfig,
    perProtocol: 100,
    nowMs,
  });

  // Sort by TVL descending and take top 100
  const sorted = snapshots
    .filter((s): s is PoolSnapshot => s !== null && s.metrics.tvl_usd > 0)
    .sort((a, b) => b.metrics.tvl_usd - a.metrics.tvl_usd);
  const top100 = sorted.slice(0, 100);

  const previousMap = new Map<string, PoolSnapshot>();
  for (const snap of top100) {
    const prev = await kvGetJson<PoolSnapshot>(env.YIELD_KV, previousKey(snap.pool_id));
    if (prev) previousMap.set(snap.pool_id, prev);
  }

  const deltas = computeAllDeltas(top100, previousMap);

  const thresholds: ThresholdConfig = {
    apyChangeBps: Number(env.APY_CHANGE_BPS ?? 500),
    tvlChangePct: Number(env.TVL_CHANGE_PCT ?? 10),
    minTvlUsd: Number(env.MIN_TVL_USD ?? 100_000),
  };

  for (const delta of deltas) {
    const current = top100.find((s) => s.pool_id === delta.pool_id);
    if (!current) continue;

    const { apy, tvl } = evaluateThresholds(delta, current, thresholds);

    if (apy && (await shouldAlert(env.YIELD_KV, delta.pool_id, "apy"))) {
      const alert = buildAlert(delta, current, "apy", thresholds);
      await recordAlert(env.YIELD_KV, alert);
    }
    if (tvl && (await shouldAlert(env.YIELD_KV, delta.pool_id, "tvl"))) {
      const alert = buildAlert(delta, current, "tvl", thresholds);
      await recordAlert(env.YIELD_KV, alert);
    }
  }

  for (const snap of top100) {
    await kvPutJson(env.YIELD_KV, previousKey(snap.pool_id), snap, TTL.previousSeconds);
    await kvPutJson(env.YIELD_KV, snapshotKey(snap.pool_id), snap, TTL.snapshotSeconds);
  }

  await kvPutJson(env.YIELD_KV, POOL_LIST_KEY, top100.map((s) => s.pool_id), TTL.poolListSeconds);
  await updateLastCron(env.YIELD_KV, nowMs);
}
/**
 * KV helpers with retry/backoff (spec: retry twice with 100ms/500ms backoff)
 * and TTL constants (snapshot 1h, alert 24h, cooldown 1h, pool list 1h).
 *
 * Pure dependency-injection design: every helper takes a minimal
 * `KVLike` interface so tests run against an in-memory Map (spec §Testing
 * Decisions) while production passes `env.YIELD_KV`.
 */

export const TTL = {
  snapshotSeconds: 3600, // 1 hour
  previousSeconds: 3600, // 1 hour
  alertSeconds: 86400, // 24 hours
  cooldownSeconds: 3600, // 1 hour
  poolListSeconds: 3600, // 1 hour
  lastCronSeconds: 86400, // keep lastCron readable for a day
} as const;

export const KV_RETRY_DELAYS_MS = [100, 500] as const;

/** Minimal async KV surface (structurally satisfied by CF KVNamespace). */
export interface KVLike {
  get(key: string, type?: "text"): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** Optional list support (used by /alerts pagination + 24h history). */
  list?(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

/** get with JSON parse; null on miss. Retries per spec then gives up (returns null). */
export async function kvGetJson<T>(kv: KVLike, key: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = await kv.get(key);
      if (raw === null || raw === "") return null;
      return JSON.parse(raw) as T;
    } catch (_err) {
      if (attempt >= KV_RETRY_DELAYS_MS.length) return null;
      await sleep(KV_RETRY_DELAYS_MS[attempt] ?? 500);
    }
  }
}

/** put with JSON stringify; throws after retry budget exhausted (cron fail-loud). */
export async function kvPutJson(
  kv: KVLike,
  key: string,
  value: unknown,
  ttlSeconds?: number
): Promise<void> {
  const payload = JSON.stringify(value);
  for (let attempt = 0; ; attempt++) {
    try {
      await kv.put(key, payload, ttlSeconds !== undefined ? { expirationTtl: ttlSeconds } : {});
      return;
    } catch (_err) {
      if (attempt >= KV_RETRY_DELAYS_MS.length) throw _err;
      await sleep(KV_RETRY_DELAYS_MS[attempt] ?? 500);
    }
  }
}

/** delete with retry; best-effort (final failure is swallowed). */
export async function kvDelete(kv: KVLike, key: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await kv.delete(key);
      return;
    } catch (_err) {
      if (attempt >= KV_RETRY_DELAYS_MS.length) return;
      await sleep(KV_RETRY_DELAYS_MS[attempt] ?? 500);
    }
  }
}

// ---- Key builders (spec §KV Storage Structure) -------------------------------

export const snapshotKey = (poolId: string): string => `pool:snapshot:${poolId}`;
export const previousKey = (poolId: string): string => `pool:previous:${poolId}`;
export const alertKey = (ts: number, poolId: string): string =>
  `alert:${String(ts).padStart(13, "0")}:${poolId}`;
export const cooldownKey = (poolId: string, metric: string): string =>
  `cooldown:${poolId}:${metric}`;
export const LAST_CRON_KEY = "state:lastCron";
export const POOL_LIST_KEY = "state:poolList";

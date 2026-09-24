/**
 * KV helpers with retry/backoff and TTL constants (AGEA-52 / #307 foundation).
 *
 * Spec: retry twice with 100ms/500ms backoff. TTL: snapshot 1h, alert 24h,
 * cooldown 1h, pool list 1h.
 *
 * Error policy (fail-loud on writes, fail-loud on transport failures):
 * - `kvGetJson` returns null ONLY for a genuine miss (no value stored).
 *   A transport error that survives the retry budget throws — callers must
 *   never mistake "storage down" for "no previous snapshot" (that would
 *   fabricate zero-deltas and suppress every alert).
 * - `kvPutJson` throws after the retry budget is exhausted (cron fail-loud).
 * - `kvDelete` is best-effort: final failure is swallowed by design.
 */

import type { KvBinding } from "./types";

export const TTL = {
  snapshotSeconds: 3600, // 1 hour
  previousSeconds: 3600, // 1 hour
  alertSeconds: 86400, // 24 hours
  cooldownSeconds: 3600, // 1 hour
  poolListSeconds: 3600, // 1 hour
  lastCronSeconds: 86400, // keep lastCron readable for a day
} as const;

export const KV_RETRY_DELAYS_MS = [100, 500] as const;

export class KvUnavailableError extends Error {
  constructor(operation: string, key: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`kv ${operation} failed for "${key}" after ${KV_RETRY_DELAYS_MS.length + 1} attempts: ${reason}`);
    this.name = "KvUnavailableError";
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** get with JSON parse; null on miss. Throws KvUnavailableError if storage stays down. */
export async function kvGetJson<T>(kv: KvBinding, key: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = await kv.get(key);
      if (raw === null || raw === "") return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      if (attempt >= KV_RETRY_DELAYS_MS.length) {
        if (err instanceof SyntaxError) throw err; // stored value corrupt: surface it
        throw new KvUnavailableError("get", key, err);
      }
      await sleep(KV_RETRY_DELAYS_MS[attempt] ?? 500);
    }
  }
}

/** put with JSON stringify; throws after the retry budget is exhausted. */
export async function kvPutJson(
  kv: KvBinding,
  key: string,
  value: unknown,
  ttlSeconds?: number
): Promise<void> {
  const payload = JSON.stringify(value);
  for (let attempt = 0; ; attempt++) {
    try {
      await kv.put(key, payload, ttlSeconds !== undefined ? { expirationTtl: ttlSeconds } : {});
      return;
    } catch (err) {
      if (attempt >= KV_RETRY_DELAYS_MS.length) throw new KvUnavailableError("put", key, err);
      await sleep(KV_RETRY_DELAYS_MS[attempt] ?? 500);
    }
  }
}

/** delete with retry; best-effort (final failure is swallowed). */
export async function kvDelete(kv: KvBinding, key: string): Promise<void> {
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

// ---- Key builders (spec §KV Storage Structure) --------------------------------

export const snapshotKey = (poolId: string): string => `pool:snapshot:${poolId}`;
export const previousKey = (poolId: string): string => `pool:previous:${poolId}`;
export const alertKey = (ts: number, poolId: string): string =>
  `alert:${String(ts).padStart(13, "0")}:${poolId}`;
export const cooldownKey = (poolId: string, metric: string): string =>
  `cooldown:${poolId}:${metric}`;
export const LAST_CRON_KEY = "state:lastCron";
export const POOL_LIST_KEY = "state:poolList";

/**
 * Alert persistence + 1h cooldown enforcement + /alerts API handler.
 * Spec §Alert Threshold Rules: 1h cooldown per pool+metric, 24h history.
 */
import type { KVLike } from "./kv";
import type { Alert } from "./types";
import { kvGetJson, kvPutJson, alertKey, cooldownKey, LAST_CRON_KEY, TTL } from "./kv";

export async function shouldAlert(
  kv: KVLike,
  poolId: string,
  metric: "apy" | "tvl",
  cooldownSeconds: number = TTL.cooldownSeconds
): Promise<boolean> {
  const key = cooldownKey(poolId, metric);
  const last = await kvGetJson<number>(kv, key);
  if (!last) return true;
  return Date.now() - last >= cooldownSeconds * 1000;
}

export async function recordAlert(
  kv: KVLike,
  alert: Alert
): Promise<void> {
  // Store alert with 24h TTL
  await kvPutJson(kv, alertKey(alert.triggered_at, alert.pool_id), alert, TTL.alertSeconds);
  // Set cooldown
  await kvPutJson(kv, cooldownKey(alert.pool_id, alert.metric), alert.triggered_at, TTL.cooldownSeconds);
}

export async function getRecentAlerts(
  kv: KVLike,
  limit: number = 100,
  sinceMs?: number
): Promise<Alert[]> {
  // List alert keys (sorted by timestamp desc since key prefix is padded timestamp)
  if (!kv.list) return [];
  const list = await kv.list({ prefix: "alert:", limit });
  const alerts: Alert[] = [];
  for (const key of list.keys) {
    const alert = await kvGetJson<Alert>(kv, key.name);
    if (alert && (!sinceMs || alert.triggered_at >= sinceMs)) {
      alerts.push(alert);
    }
    if (alerts.length >= limit) break;
  }
  // Already sorted by key (timestamp desc), reverse for chronological
  return alerts.reverse();
}

export async function updateLastCron(kv: KVLike, ts: number): Promise<void> {
  await kvPutJson(kv, LAST_CRON_KEY, { ts }, TTL.lastCronSeconds);
}

export async function getLastCron(kv: KVLike): Promise<number | null> {
  const data = await kvGetJson<{ ts: number }>(kv, LAST_CRON_KEY);
  return data?.ts ?? null;
}
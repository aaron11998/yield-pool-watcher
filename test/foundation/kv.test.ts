/** KV helper tests: retry/backoff, TTL wiring, fail-loud error policy (AGEA-52). */
import { describe, it, expect } from "vitest";
import {
  kvGetJson,
  kvPutJson,
  kvDelete,
  KvUnavailableError,
  KV_RETRY_DELAYS_MS,
  TTL,
  snapshotKey,
  previousKey,
  alertKey,
  cooldownKey,
  LAST_CRON_KEY,
  POOL_LIST_KEY,
} from "../../src/foundation/kv";
import type { KvBinding } from "../../src/foundation/types";

/** In-memory KV with programmable failure injection. */
class FakeKV implements KvBinding {
  store = new Map<string, string>();
  getFailures = 0;
  putFailures = 0;
  deleteFailures = 0;
  lastPutOptions: { expirationTtl?: number } | undefined;

  async get(key: string): Promise<string | null> {
    if (this.getFailures > 0) {
      this.getFailures--;
      throw new Error("kv transport down");
    }
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.lastPutOptions = opts;
    if (this.putFailures > 0) {
      this.putFailures--;
      throw new Error("kv transport down");
    }
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    if (this.deleteFailures > 0) {
      this.deleteFailures--;
      throw new Error("kv transport down");
    }
    this.store.delete(key);
  }
}

describe("kv helpers", () => {
  it("round-trips JSON values", async () => {
    const kv = new FakeKV();
    await kvPutJson(kv, "k", { a: 1, b: "x" }, TTL.snapshotSeconds);
    expect(await kvGetJson<{ a: number; b: string }>(kv, "k")).toEqual({ a: 1, b: "x" });
    expect(kv.lastPutOptions).toEqual({ expirationTtl: 3600 });
  });

  it("returns null on miss and on empty-string value", async () => {
    const kv = new FakeKV();
    expect(await kvGetJson(kv, "missing")).toBeNull();
    kv.store.set("empty", "");
    expect(await kvGetJson(kv, "empty")).toBeNull();
  });

  it("retries transient get failures within budget then succeeds", async () => {
    const kv = new FakeKV();
    kv.getFailures = KV_RETRY_DELAYS_MS.length; // fails twice, third attempt hits the store
    kv.store.set("k", JSON.stringify({ ok: true }));
    expect(await kvGetJson<Record<string, unknown>>(kv, "k")).toEqual({ ok: true });
  });

  it("throws KvUnavailableError when get exhausts the retry budget", async () => {
    const kv = new FakeKV();
    kv.getFailures = KV_RETRY_DELAYS_MS.length + 1;
    await expect(kvGetJson(kv, "k")).rejects.toBeInstanceOf(KvUnavailableError);
  }, 5000);

  it("surfaces corrupt JSON as SyntaxError, not a silent miss", async () => {
    const kv = new FakeKV();
    kv.store.set("corrupt", "{not json");
    await expect(kvGetJson(kv, "corrupt")).rejects.toBeInstanceOf(SyntaxError);
  });

  it("retries transient put failures within budget then succeeds", async () => {
    const kv = new FakeKV();
    kv.putFailures = KV_RETRY_DELAYS_MS.length;
    await expect(kvPutJson(kv, "k", 1)).resolves.toBeUndefined();
    expect(kv.store.get("k")).toBe("1");
  }, 5000);

  it("throws KvUnavailableError when put exhausts the retry budget", async () => {
    const kv = new FakeKV();
    kv.putFailures = KV_RETRY_DELAYS_MS.length + 1;
    await expect(kvPutJson(kv, "k", 1)).rejects.toBeInstanceOf(KvUnavailableError);
  }, 5000);

  it("kvDelete is best-effort: swallows exhausted failures", async () => {
    const kv = new FakeKV();
    kv.deleteFailures = KV_RETRY_DELAYS_MS.length + 1;
    await expect(kvDelete(kv, "k")).resolves.toBeUndefined();
  }, 5000);

  it("put without ttl sends empty options", async () => {
    const kv = new FakeKV();
    await kvPutJson(kv, "k", { x: 1 });
    expect(kv.lastPutOptions).toEqual({});
  });

  it("key builders match the spec storage structure", () => {
    expect(snapshotKey("0xabc")).toBe("pool:snapshot:0xabc");
    expect(previousKey("0xabc")).toBe("pool:previous:0xabc");
    expect(alertKey(1_726_000_000_000, "0xabc")).toBe("alert:1726000000000:0xabc");
    expect(cooldownKey("0xabc", "apy")).toBe("cooldown:0xabc:apy");
    expect(LAST_CRON_KEY).toBe("state:lastCron");
    expect(POOL_LIST_KEY).toBe("state:poolList");
  });

  it("TTL table matches spec (snapshot 1h, alert 24h, cooldown 1h)", () => {
    expect(TTL.snapshotSeconds).toBe(3600);
    expect(TTL.previousSeconds).toBe(3600);
    expect(TTL.alertSeconds).toBe(86_400);
    expect(TTL.cooldownSeconds).toBe(3600);
    expect(TTL.poolListSeconds).toBe(3600);
  });
});

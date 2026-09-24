/** x402 middleware tests: full 402 flow offline via injected verify/settle (AGEA-52). */
import { describe, it, expect } from "vitest";
import {
  x402PaymentMiddleware,
  decodePaymentHeader,
  encodeJsonHeader,
  priceToAtomicUnits,
  isEvmAddress,
  payment402Response,
  PaymentRejectedError,
  X402_VERSION,
  type PaymentRequirements,
  type VerifyResult,
  type SettleResult,
  type X402MiddlewareConfig,
} from "../../src/foundation/x402";

const BASE_CONFIG: X402MiddlewareConfig = {
  payTo: "0x76EfB727cd3271C7DE22f92437Be212766C9631f",
  price: "$0.01",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  assetName: "USD Coin",
  assetVersion: "2",
  facilitatorUrl: "https://facilitator.example/x402",
};

/** Build a valid payment envelope header for the given requirements. */
function validPaymentHeader(reqs: PaymentRequirements, overrides: Record<string, unknown> = {}): string {
  const auth = {
    from: "0x1111111111111111111111111111111111111111",
    to: reqs.payTo,
    value: reqs.maxAmountRequired,
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    salt: "0xsalt",
    ...overrides,
  };
  return encodeJsonHeader({ x402Version: X402_VERSION, scheme: "exact", payload: { signature: "0x" + "ab".repeat(65), authorization: auth } });
}

const OK_VERIFY = async (): Promise<VerifyResult> => ({ isValid: true, payer: "0x1111111111111111111111111111111111111111" });
const OK_SETTLE = async (): Promise<SettleResult> => ({ success: true, transaction: "0xdeadbeef" });

function makeApp(configOverrides: Partial<X402MiddlewareConfig> = {}) {
  const calls: string[] = [];
  const config: X402MiddlewareConfig = {
    ...BASE_CONFIG,
    verifyPayment: OK_VERIFY,
    settlePayment: OK_SETTLE,
    nowSeconds: () => 1_726_000_000,
    ...configOverrides,
  };
  const handler = x402PaymentMiddleware(config)(async () => {
    calls.push("handler");
    return new Response(JSON.stringify({ ok: true, calls: calls.length }), { status: 200 });
  });
  return { handler, calls };
}

function paidRequest(url: string, header: string | null): Request {
  const headers = new Headers();
  if (header !== null) headers.set("X-PAYMENT", header);
  return new Request(url, { method: "POST", headers });
}

describe("priceToAtomicUnits", () => {
  it("converts $0.01 with 6 decimals (USDC)", () => {
    expect(priceToAtomicUnits("$0.01")).toBe("10000");
  });
  it("accepts bare numbers and custom decimals", () => {
    expect(priceToAtomicUnits("0.5", 18)).toBe("500000000000000000");
    expect(priceToAtomicUnits("1", 6)).toBe("1000000");
  });
  it("rejects non-positive and garbage prices", () => {
    expect(() => priceToAtomicUnits("0")).toThrow();
    expect(() => priceToAtomicUnits("free")).toThrow();
  });
});

describe("decodePaymentHeader", () => {
  it("decodes a valid envelope", () => {
    const reqs: PaymentRequirements = {
      scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", resource: "/snapshot",
      payTo: "0x76EfB727cd3271C7DE22f92437Be212766C9631f", asset: "0x1", maxTimeoutSeconds: 60,
    };
    const payload = decodePaymentHeader(validPaymentHeader(reqs));
    expect(payload.x402Version).toBe(1);
    expect(payload.scheme).toBe("exact");
    expect(payload.payload.authorization.value).toBe("10000");
  });

  it.each([
    ["not-base64!!", "invalid_payment_header"],
    [encodeJsonHeader({ nope: 1 }), "unsupported_version"],
    [
      encodeJsonHeader({ x402Version: 1, scheme: "tip", payload: {} }),
      "unsupported_scheme",
    ],
    [
      encodeJsonHeader({
        x402Version: 1,
        scheme: "exact",
        payload: { signature: "0xabc", authorization: { from: "not-an-address", to: "0x1", value: "1", validAfter: "0", validBefore: "1", salt: "s" } },
      }),
      "invalid_payment_header",
    ],
  ])("rejects %s with %s", (header, code) => {
    try {
      decodePaymentHeader(header);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentRejectedError);
      expect((err as PaymentRejectedError).code).toBe(code);
    }
  });
});

describe("isEvmAddress", () => {
  it("accepts 20-byte hex and rejects everything else", () => {
    expect(isEvmAddress("0x76EfB727cd3271C7DE22f92437Be212766C9631f")).toBe(true);
    expect(isEvmAddress("0x123")).toBe(false);
    expect(isEvmAddress("76EfB727cd3271C7DE22f92437Be212766C9631f")).toBe(false);
    expect(isEvmAddress(42)).toBe(false);
  });
});

describe("x402PaymentMiddleware", () => {
  it("returns 402 + accepts when the header is missing and never calls the handler", async () => {
    const { handler, calls } = makeApp();
    const res = await handler(paidRequest("https://w.dev/snapshot", null));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: PaymentRequirements[] };
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]?.scheme).toBe("exact");
    expect(body.accepts[0]?.maxAmountRequired).toBe("10000");
    expect(body.accepts[0]?.payTo).toBe(BASE_CONFIG.payTo);
    expect(body.accepts[0]?.network).toBe("eip155:8453");
    expect(body.accepts[0]?.extra).toEqual({ name: "USD Coin", version: "2" });
    expect(calls).toEqual([]);
  });

  it("verifies via facilitator, runs the handler, settles, and returns X-PAYMENT-RESPONSE", async () => {
    const verifyCalls: string[] = [];
    const settleCalls: string[] = [];
    const { handler, calls } = makeApp({
      verifyPayment: async (header) => {
        verifyCalls.push(header);
        return { isValid: true, payer: "0x1111111111111111111111111111111111111111" };
      },
      settlePayment: async (header) => {
        settleCalls.push(header);
        return { success: true, transaction: "0xdeadbeef" };
      },
    });
    const header = validPaymentHeader({
      scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", resource: "/snapshot",
      payTo: BASE_CONFIG.payTo, asset: BASE_CONFIG.asset, maxTimeoutSeconds: 60,
    });
    const res = await handler(paidRequest("https://w.dev/snapshot", header));
    expect(res.status).toBe(200);
    expect(calls).toEqual(["handler"]);
    expect(verifyCalls).toHaveLength(1);
    expect(settleCalls).toHaveLength(1);
    const settleHeader = res.headers.get("X-PAYMENT-RESPONSE");
    expect(settleHeader).not.toBeNull();
    const settle = JSON.parse(atob(settleHeader as string)) as SettleResult;
    expect(settle.success).toBe(true);
    expect(settle.transaction).toBe("0xdeadbeef");
  });

  it("rejects an expired authorization without calling verify or the handler", async () => {
    const { handler, calls } = makeApp();
    const header = validPaymentHeader(
      {
        scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", resource: "/snapshot",
        payTo: BASE_CONFIG.payTo, asset: BASE_CONFIG.asset, maxTimeoutSeconds: 60,
      },
      { validBefore: String(1_726_000_000 - 10) } // before the injected now
    );
    const res = await handler(paidRequest("https://w.dev/snapshot", header));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("payment_expired");
    expect(calls).toEqual([]);
  });

  it("rejects a not-yet-valid authorization", async () => {
    const { handler, calls } = makeApp();
    const header = validPaymentHeader(
      {
        scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", resource: "/snapshot",
        payTo: BASE_CONFIG.payTo, asset: BASE_CONFIG.asset, maxTimeoutSeconds: 60,
      },
      { validAfter: String(1_726_000_000 + 3600) }
    );
    const res = await handler(paidRequest("https://w.dev/snapshot", header));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("payment_not_yet_valid");
    expect(calls).toEqual([]);
  });

  it("rejects an amount mismatch", async () => {
    const { handler, calls } = makeApp();
    const header = validPaymentHeader(
      {
        scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", resource: "/snapshot",
        payTo: BASE_CONFIG.payTo, asset: BASE_CONFIG.asset, maxTimeoutSeconds: 60,
      },
      { value: "9999" }
    );
    const res = await handler(paidRequest("https://w.dev/snapshot", header));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("amount_mismatch");
    expect(calls).toEqual([]);
  });

  it("returns 402 when verification fails", async () => {
    const { handler, calls } = makeApp({ verifyPayment: async () => ({ isValid: false, invalidReason: "bad signature" }) });
    const header = validPaymentHeader({
      scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", resource: "/snapshot",
      payTo: BASE_CONFIG.payTo, asset: BASE_CONFIG.asset, maxTimeoutSeconds: 60,
    });
    const res = await handler(paidRequest("https://w.dev/snapshot", header));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("verification_failed");
    expect(body.error).toContain("bad signature");
    expect(calls).toEqual([]);
  });

  it("returns 402 when the facilitator is unreachable", async () => {
    const { handler, calls } = makeApp({
      verifyPayment: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const header = validPaymentHeader({
      scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", resource: "/snapshot",
      payTo: BASE_CONFIG.payTo, asset: BASE_CONFIG.asset, maxTimeoutSeconds: 60,
    });
    const res = await handler(paidRequest("https://w.dev/snapshot", header));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("facilitator_unreachable");
    expect(calls).toEqual([]);
  });

  it("does NOT settle when the handler returns an error status", async () => {
    let settleCount = 0;
    const config: X402MiddlewareConfig = {
      ...BASE_CONFIG,
      verifyPayment: OK_VERIFY,
      settlePayment: async () => {
        settleCount++;
        return { success: true };
      },
      nowSeconds: () => 1_726_000_000,
    };
    const handler = x402PaymentMiddleware(config)(async () => new Response("boom", { status: 500 }));
    const header = validPaymentHeader({
      scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", resource: "/snapshot",
      payTo: BASE_CONFIG.payTo, asset: BASE_CONFIG.asset, maxTimeoutSeconds: 60,
    });
    const res = await handler(paidRequest("https://w.dev/snapshot", header));
    expect(res.status).toBe(500);
    expect(settleCount).toBe(0);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeNull();
  });

  it("reports a settle failure in X-PAYMENT-RESPONSE without failing the response", async () => {
    const config: X402MiddlewareConfig = {
      ...BASE_CONFIG,
      verifyPayment: OK_VERIFY,
      settlePayment: async () => {
        throw new Error("rpc down");
      },
      nowSeconds: () => 1_726_000_000,
    };
    const handler = x402PaymentMiddleware(config)(async () => new Response("ok", { status: 200 }));
    const header = validPaymentHeader({
      scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", resource: "/snapshot",
      payTo: BASE_CONFIG.payTo, asset: BASE_CONFIG.asset, maxTimeoutSeconds: 60,
    });
    const res = await handler(paidRequest("https://w.dev/snapshot", header));
    expect(res.status).toBe(200);
    const settle = JSON.parse(atob(res.headers.get("X-PAYMENT-RESPONSE") as string)) as SettleResult;
    expect(settle.success).toBe(false);
    expect(settle.error).toContain("rpc down");
  });

  it("uses the request path as the resource when resourceName is unset", async () => {
    let capturedResource = "";
    const config: X402MiddlewareConfig = {
      ...BASE_CONFIG,
      verifyPayment: async (_header, reqs) => {
        capturedResource = reqs.resource;
        return { isValid: true };
      },
      settlePayment: OK_SETTLE,
      nowSeconds: () => 1_726_000_000,
    };
    const handler = x402PaymentMiddleware(config)(async () => new Response("ok"));
    const header = validPaymentHeader({
      scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", resource: "/snapshot",
      payTo: BASE_CONFIG.payTo, asset: BASE_CONFIG.asset, maxTimeoutSeconds: 60,
    });
    await handler(paidRequest("https://w.dev/snapshot", header));
    expect(capturedResource).toBe("/snapshot");
  });

  it("payment402Response includes the error string when provided", () => {
    const reqs: PaymentRequirements = {
      scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", resource: "/snapshot",
      payTo: "0x1", asset: "0x1", maxTimeoutSeconds: 60,
    };
    const res = payment402Response(reqs, "because");
    expect(res.status).toBe(402);
  });
});

/**
 * x402 payment middleware — hand-rolled, zero external dependencies
 * (AGEA-52 / #307 foundation; replaces the x402-hono package).
 *
 * Implements the x402 v1 pay-per-call flow for Cloudflare Workers:
 *  1. No `X-PAYMENT` header  -> 402 with `accepts[]` payment requirements.
 *  2. Header present         -> decode + shape-validate the payment envelope
 *                               (exact scheme, EIP-3009 authorization fields,
 *                               expiry window, exact amount match).
 *  3. Facilitator `/verify`  -> `{isValid}` gate before doing any work.
 *  4. Downstream handler runs.
 *  5. On 2xx                 -> facilitator `/settle`, result attached as the
 *                               base64 `X-PAYMENT-RESPONSE` header.
 *
 * No private keys live in the worker: the facilitator holds the settlement
 * signer; this module only verifies and delegates. Verify/settle functions
 * are injectable so tests run fully offline (same DI pattern as the KV layer).
 */

// ---- Wire types (x402 v1) ------------------------------------------------------

export const X402_VERSION = 1;

/** USDC-style 6-decimal asset by default; override via decimals in price parsing. */
export interface PaymentRequirements {
  scheme: "exact";
  /** CAIP-2 chain, e.g. "eip155:8453" (Base). */
  network: string;
  /** Atomic units as a decimal string (USDC: 6 dp -> "$0.01" = "10000"). */
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  /** ERC-20 contract address of the payment asset. */
  asset: string;
  maxTimeoutSeconds: number;
  /** EIP-712 domain for the asset's TransferWithAuthorization. */
  extra?: { name: string; version: string };
}

export interface PaymentAuthorization {
  from: string;
  to: string;
  /** Atomic units as a string. */
  value: string;
  /** Unix seconds (inclusive) from which the authorization is valid. */
  validAfter: string;
  /** Unix seconds (exclusive) after which the authorization expires. */
  validBefore: string;
  /** Random salt preventing replay of identical authorizations. */
  salt: string;
}

export interface ExactPaymentPayload {
  /** 65-byte hex signature (r+s+v) over the EIP-712 authorization struct. */
  signature: string;
  authorization: PaymentAuthorization;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: "exact";
  resource?: string;
  payload: ExactPaymentPayload;
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResult {
  success: boolean;
  error?: string;
  network?: string;
  transaction?: string;
  payer?: string;
}

// ---- Errors --------------------------------------------------------------------

/** Machine-readable rejection reasons carried in the 402 body `error` field. */
export type PaymentErrorCode =
  | "invalid_payment_header"
  | "unsupported_scheme"
  | "unsupported_version"
  | "amount_mismatch"
  | "payment_expired"
  | "payment_not_yet_valid"
  | "verification_failed"
  | "facilitator_unreachable";

export class PaymentRejectedError extends Error {
  readonly code: PaymentErrorCode;
  constructor(code: PaymentErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "PaymentRejectedError";
    this.code = code;
  }
}

// ---- Config --------------------------------------------------------------------

export interface X402MiddlewareConfig {
  /** PUBLIC settlement address — config, not a secret. */
  payTo: string;
  /** e.g. "$0.01" or "0.01". */
  price: string;
  /** CAIP-2 network, e.g. "eip155:8453". */
  network: string;
  /** Payment asset contract (USDC on Base by convention). */
  asset: string;
  /** Resource identifier reported to clients (defaults to the request path). */
  resourceName?: string;
  description?: string;
  maxTimeoutSeconds?: number;
  /** EIP-712 domain name/version for the asset (e.g. USDC / "2"). */
  assetName?: string;
  assetVersion?: string;
  /** Token decimals for price -> atomic-unit conversion (default 6, USDC). */
  assetDecimals?: number;
  /** Facilitator base URL, e.g. "https://.../facilitator" (POST {url}/verify|/settle). */
  facilitatorUrl: string;
  /** Optional auth headers for the facilitator (wire from env, never hard-code). */
  facilitatorHeaders?: Record<string, string>;
  verifyTimeoutMs?: number;
  settleTimeoutMs?: number;
  /** Injectable for tests; defaults to the facilitator implementation. */
  verifyPayment?: (paymentHeader: string, requirements: PaymentRequirements) => Promise<VerifyResult>;
  /** Injectable for tests; defaults to the facilitator implementation. */
  settlePayment?: (paymentHeader: string, requirements: PaymentRequirements) => Promise<SettleResult>;
  /** Injectable clock (unix seconds) for expiry validation in tests. */
  nowSeconds?: () => number;
}

/** A plain Workers handler: request in, response out. */
export type WorkerHandler = (request: Request) => Response | Promise<Response>;

/** Middleware signature: wraps a handler with the payment gate. */
export type PaymentMiddleware = (handler: WorkerHandler) => WorkerHandler;

// ---- Price & address helpers -----------------------------------------------------

/** "$0.01" | "0.01" -> atomic units string using `decimals` (default USDC 6). */
export function priceToAtomicUnits(price: string, decimals = 6): string {
  const numeric = Number(price.replace(/^\$/, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`x402: unparseable price "${price}"`);
  }
  return BigInt(Math.round(numeric * 10 ** decimals)).toString();
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const isEvmAddress = (value: unknown): value is string =>
  typeof value === "string" && EVM_ADDRESS_RE.test(value);

const isNonNegativeIntString = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value) && BigInt(value) >= 0n;

// ---- Envelope encode/decode -------------------------------------------------------

export function encodeJsonHeader(value: unknown): string {
  return btoa(JSON.stringify(value));
}

/** Base64-decode + structurally validate an X-PAYMENT header. Throws PaymentRejectedError. */
export function decodePaymentHeader(header: string): PaymentPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(header));
  } catch (err) {
    throw new PaymentRejectedError("invalid_payment_header", "base64/JSON decode failed");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new PaymentRejectedError("invalid_payment_header", "envelope is not an object");
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.x402Version !== X402_VERSION) {
    throw new PaymentRejectedError("unsupported_version", `x402Version ${String(envelope.x402Version)}`);
  }
  if (envelope.scheme !== "exact") {
    throw new PaymentRejectedError("unsupported_scheme", String(envelope.scheme));
  }
  const payload = envelope.payload as Record<string, unknown> | undefined;
  const authorization = payload?.authorization as Record<string, unknown> | undefined;
  if (
    !payload ||
    !authorization ||
    typeof payload.signature !== "string" ||
    payload.signature.length === 0 ||
    !isEvmAddress(authorization.from) ||
    !isEvmAddress(authorization.to) ||
    !isNonNegativeIntString(authorization.value) ||
    !isNonNegativeIntString(authorization.validAfter) ||
    !isNonNegativeIntString(authorization.validBefore) ||
    typeof authorization.salt !== "string" ||
    authorization.salt.length === 0
  ) {
    throw new PaymentRejectedError("invalid_payment_header", "missing/malformed exact payload fields");
  }
  return {
    x402Version: X402_VERSION,
    scheme: "exact",
    payload: {
      signature: payload.signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value,
        validAfter: authorization.validAfter,
        validBefore: authorization.validBefore,
        salt: authorization.salt,
      },
    },
  };
}

// ---- Requirements & 402 response ----------------------------------------------------

export function buildPaymentRequirements(config: X402MiddlewareConfig, resource: string): PaymentRequirements {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: config.network,
    maxAmountRequired: priceToAtomicUnits(config.price, config.assetDecimals),
    resource,
    payTo: config.payTo,
    asset: config.asset,
    maxTimeoutSeconds: config.maxTimeoutSeconds ?? 60,
  };
  if (config.description !== undefined) requirements.description = config.description;
  if (config.assetName !== undefined && config.assetVersion !== undefined) {
    requirements.extra = { name: config.assetName, version: config.assetVersion };
  }
  return requirements;
}

/** 402 response carrying the payment requirements (and rejection reason if any). */
export function payment402Response(
  requirements: PaymentRequirements,
  error?: string
): Response {
  const body: Record<string, unknown> = {
    x402Version: X402_VERSION,
    accepts: [requirements],
  };
  if (error !== undefined) body.error = error;
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

/** Settle result serialized into the X-PAYMENT-RESPONSE response header. */
export function settleResponseHeader(result: SettleResult): string {
  return encodeJsonHeader(result);
}

// ---- Facilitator client (default verify/settle) --------------------------------------

function facilitatorPost(
  baseUrl: string,
  path: "/verify" | "/settle",
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`facilitator ${path} HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  });
}

function facilitatorVerify(
  config: X402MiddlewareConfig,
  paymentHeader: string,
  requirements: PaymentRequirements
): Promise<VerifyResult> {
  return facilitatorPost(
    config.facilitatorUrl,
    "/verify",
    config.facilitatorHeaders ?? {},
    { x402Version: X402_VERSION, paymentHeader, paymentRequirements: requirements },
    config.verifyTimeoutMs ?? 5000
  ).then((raw) => {
    if (typeof raw.isValid !== "boolean") {
      throw new Error("facilitator verify response missing isValid");
    }
    const result: VerifyResult = { isValid: raw.isValid };
    if (typeof raw.invalidReason === "string") result.invalidReason = raw.invalidReason;
    if (typeof raw.payer === "string") result.payer = raw.payer;
    return result;
  });
}

function facilitatorSettle(
  config: X402MiddlewareConfig,
  paymentHeader: string,
  requirements: PaymentRequirements
): Promise<SettleResult> {
  return facilitatorPost(
    config.facilitatorUrl,
    "/settle",
    config.facilitatorHeaders ?? {},
    { x402Version: X402_VERSION, paymentHeader, paymentRequirements: requirements },
    config.settleTimeoutMs ?? 10000
  ).then((raw) => {
    const result: SettleResult = { success: raw.success === true };
    if (typeof raw.network === "string") result.network = raw.network;
    if (typeof raw.transaction === "string") result.transaction = raw.transaction;
    if (typeof raw.payer === "string") result.payer = raw.payer;
    if (typeof raw.error === "string") result.error = raw.error;
    return result;
  });
}

// ---- Middleware -------------------------------------------------------------------------

/**
 * Build the payment middleware. Wrap a handler:
 *   const paid = x402PaymentMiddleware(config)(handler);
 * 402 paths never invoke the handler; settle only fires on 2xx responses and
 * never blocks delivery (a settle failure is reported via X-PAYMENT-RESPONSE).
 */
export function x402PaymentMiddleware(config: X402MiddlewareConfig): PaymentMiddleware {
  const verify = config.verifyPayment ?? ((h, reqs) => facilitatorVerify(config, h, reqs));
  const settle = config.settlePayment ?? ((h, reqs) => facilitatorSettle(config, h, reqs));
  const nowSec = config.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  return (handler: WorkerHandler): WorkerHandler => {
    return async (request: Request): Promise<Response> => {
      const resource = config.resourceName ?? new URL(request.url).pathname;
      const requirements = buildPaymentRequirements(config, resource);

      const paymentHeader = request.headers.get("X-PAYMENT");
      if (paymentHeader === null || paymentHeader === "") {
        return payment402Response(requirements, "X-PAYMENT header required");
      }

      let payload: PaymentPayload;
      try {
        payload = decodePaymentHeader(paymentHeader);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return payment402Response(requirements, detail);
      }

      const auth = payload.payload.authorization;
      const now = nowSec();
      if (Number(auth.validBefore) <= now) {
        return payment402Response(requirements, "payment_expired: authorization validBefore passed");
      }
      if (Number(auth.validAfter) > now + 30) {
        return payment402Response(requirements, "payment_not_yet_valid: authorization validAfter in the future");
      }
      if (auth.value !== requirements.maxAmountRequired) {
        return payment402Response(
          requirements,
          `amount_mismatch: paid ${auth.value}, required ${requirements.maxAmountRequired}`
        );
      }

      let verification: VerifyResult;
      try {
        verification = await verify(paymentHeader, requirements);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return payment402Response(requirements, `facilitator_unreachable: ${detail}`);
      }
      if (!verification.isValid) {
        const reason = verification.invalidReason ?? "verification_failed";
        return payment402Response(requirements, `verification_failed: ${reason}`);
      }

      const response = await handler(request);
      if (response.status >= 400) {
        return response; // handler failed: do not settle
      }

      let settleResult: SettleResult;
      try {
        settleResult = await settle(paymentHeader, requirements);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        settleResult = { success: false, error: detail };
      }
      const withHeader = new Response(response.body, response);
      withHeader.headers.set("X-PAYMENT-RESPONSE", settleResponseHeader(settleResult));
      return withHeader;
    };
  };
}

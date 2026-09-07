import { config } from "./config.ts";
import { charge } from "./cu.ts";
import type { Chain } from "./types.ts";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Raised when a request could not be answered. Deliberately NOT conflated with a null
 * result: `eth_getTransactionReceipt` legitimately returns null for an unmined tx, whereas
 * a rejected request means we know nothing. Returning null for both is how a rejected
 * `eth_getLogs` ("free tier caps this at 10 blocks") once read as "this token has never
 * traded" — a confident, wrong, plausible-looking answer.
 */
export class RpcError extends Error {
  readonly chain: string;
  readonly method: string;
  constructor(chain: string, method: string, detail: string) {
    super(`rpc ${method} on ${chain} failed: ${detail}`);
    this.name = "RpcError";
    this.chain = chain;
    this.method = method;
  }
}

/**
 * JSON-RPC over HTTP with backoff.
 *
 * Returns null ONLY when the node answers "no such thing". Throws RpcError on anything
 * else — transport failure, timeout, or a JSON-RPC error object. Callers that can proceed
 * without the value must catch explicitly, so the decision to ignore a failure is written
 * down rather than implied.
 */
export async function rpc<T = unknown>(
  chain: Chain, method: string, params: unknown[], tries = 4,
): Promise<T | null> {
  const url = config.endpoints[chain].replace(/^wss:/, "https:");
  let last = "unknown";
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      charge(method);   // billed on delivery, so count the attempt, not the success
      if (RETRYABLE.has(res.status)) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { result?: T | null; error?: { message: string } };
      // A JSON-RPC error is a refusal, not an absence. Never retried — the request itself
      // is what the node objected to, so sending it again just wastes the rate limit.
      if (body.error) throw new RpcError(chain, method, body.error.message);
      return body.result ?? null;
    } catch (err) {
      if (err instanceof RpcError) throw err;
      last = err instanceof Error ? err.message : String(err);
      if (attempt === tries - 1) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw new RpcError(chain, method, `${tries} attempts failed, last: ${last}`);
}

/** rpc() that reports failure as null, for callers where degrading is genuinely fine. */
export async function rpcOrNull<T = unknown>(
  chain: Chain, method: string, params: unknown[], tries = 4,
): Promise<T | null> {
  try {
    return await rpc<T>(chain, method, params, tries);
  } catch (err) {
    console.error(`[rpc] ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const decimalsCache = new Map<string, number>();

/**
 * ERC-20 decimals(), cached — it never changes and this sits on the hot path.
 *
 * An empty return means the contract has no decimals(), for which 18 is the convention.
 * A failed *call* is not that, and is allowed to throw: guessing 18 after a timeout would
 * misprice by whole orders of magnitude.
 */
export async function tokenDecimals(chain: Chain, token: string): Promise<number> {
  const key = `${chain}:${token.toLowerCase()}`;
  const hit = decimalsCache.get(key);
  if (hit !== undefined) return hit;
  const hex = await rpc<string>(chain, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"]);
  const d = hex && hex !== "0x" ? parseInt(hex, 16) : 18;
  decimalsCache.set(key, d);
  return d;
}

const supplyCache = new Map<string, number>();

/** totalSupply(), cached. Used to turn a fill price into a market cap. */
export async function totalSupply(chain: Chain, token: string, decimals: number): Promise<number> {
  const key = `${chain}:${token.toLowerCase()}`;
  const hit = supplyCache.get(key);
  if (hit !== undefined) return hit;
  const hex = await rpc<string>(chain, "eth_call", [{ to: token, data: "0x18160ddd" }, "latest"]);
  const s = hex && hex !== "0x" ? Number(BigInt(hex)) / 10 ** decimals : 0;
  supplyCache.set(key, s);
  return s;
}

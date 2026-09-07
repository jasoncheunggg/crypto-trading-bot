import type { Chain } from "./types.ts";

/**
 * One interface, two routers.
 *
 * v1.0 depended on gmgn for everything: routing, signing and submission. When their API
 * returned 429 to every request for over a day — from five IPs, three countries, two chains,
 * with no traffic of ours — the bot could not trade at all. There is no partial degradation
 * available when the only thing that can price a swap is unreachable: no quote means no
 * price, no tier, no minimum output and no calldata.
 *
 * So routing becomes replaceable. The gates, sizing, tiers and exit logic never learn which
 * router answered.
 */

/**
 * What a router must tell us to make an entry decision.
 *
 * Deliberately the same shape `execution.ts` already returns, so the call sites do not change
 * in Phase 1. `raw` carries the provider's own response for logging and for fields only one of
 * them has (gmgn's gas_limit, liqd's per-hop breakdown).
 */
export interface RouteQuote {
  /** What we would spend, in USD. */
  inputUsd: number;
  /** Tokens we would receive, human units. */
  outputAmount: number;
  /** The floor the provider will accept, human units. Our slippage tolerance applied. */
  minOutputAmount: number;
  /** USD per token actually paid, including every cut taken along the way. */
  fillPrice: number;
  /** Market cap implied by OUR fill — the tier reference under exit.tierSelection "atOwnFill". */
  impliedMarketCapUsd: number;
  /** How much worse than the tracked wallet's own fill, in percent. Null if theirs is unknown. */
  slippageVsSignalPct: number | null;
  raw: unknown;
}

/**
 * An unsigned transaction, ready to broadcast.
 *
 * gmgn cannot produce this — it signs and submits with a key it holds, which is why v1.0's
 * wallet was custodial in the way that matters. liqd returns calldata for us to sign, which
 * is the whole reason v2.0 can own its own key, gas price and nonce.
 *
 * Null from a router that does not support self-execution.
 */
export interface SwapTx {
  to: string;
  data: string;
  /** Native value in wei, as a hex string. "0x0" for token-to-token. */
  value: string;
  /** Absolute floor in raw output units — the only thing that binds against OUR decision
   *  price. A percentage tolerance is applied to the provider's re-quote at submission time
   *  and does not protect us: measured fills of 79.7% to 89.7% of quote against a nominal 5%. */
  minOutputRaw: string;
}

export interface Router {
  readonly name: string;
  /** Price an entry. Null when the pair cannot be routed — which is itself a signal: liqd
   *  returned NO_VIABLE_PATHS for the honeypot gmgn priced at $91.05 while it was worth $1.07. */
  quote(args: {
    chain: Chain;
    inputToken: string;
    outputToken: string;
    /** Human units of the input token. */
    amountIn: number;
    inputDecimals: number;
    outputDecimals: number;
    /** USD value of amountIn, for fillPrice and market cap. */
    inputUsd: number;
    slippagePct: number;
    totalSupply: number;
    /** The tracked wallet's own fill price, for the slippage gate. */
    signalFillPrice: number | null;
  }): Promise<RouteQuote | null>;
  /** The transaction for a quote, when this router can hand one over. */
  buildSwap?(q: RouteQuote): SwapTx | null;
}

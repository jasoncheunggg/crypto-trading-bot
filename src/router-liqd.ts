import type { Chain } from "./types.ts";
import type { Router, RouteQuote, SwapTx } from "./router.ts";

/**
 * LiquidSwap (Liquid Labs) — https://api.liqd.ag
 *
 * Chosen over gmgn for v2.0 on measured grounds, not preference:
 *
 *   - Covers Robinhood Chain (4663), the only chain we trade. 0x lists it too; most
 *     aggregators do not.
 *   - Returns UNSIGNED calldata. gmgn signs with a key it holds, which is why v1.0 could not
 *     self-execute and why its outage was total.
 *   - No API key and no rate limit observed: 12 requests at 3.4/s all returned 200, against
 *     gmgn's 5/s that had been returning 429 to a silent key for over a day.
 *   - No forced fee. gmgn takes exactly 1.00% per side — measured across four trades — which
 *     is ~$0.56 per round trip against a gross edge of $2.68.
 *   - Prices honestly. It refused the honeypot outright (NO_VIABLE_PATHS) and priced the
 *     drained rug at $0.01 for 100,000 tokens, where gmgn quoted $91.05 into an empty pool.
 *   - Accurate: an ETH quote matched our own chain-derived price to 0.00%.
 *
 * The one thing it does not do is holder concentration, which gmgn's token/security provides.
 * That gate has never once fired in 40 recorded entries, so it is optional rather than load
 * bearing.
 */

const BASE = "https://api.liqd.ag";

/** Chain ids, since liqd takes a numeric id rather than a name. Verified: our robinhood
 *  endpoint reports eth_chainId 0x1237 = 4663, matching liqd's listing exactly. */
const CHAIN_ID: Record<string, number> = { robinhood: 4663 };

interface LiqdResponse {
  success?: boolean;
  message?: string;
  error_type?: string;
  execution?: {
    to: string;
    calldata: string;
    details: {
      path: string[];
      amountIn: string;
      amountOut: string;
      minAmountOut: string;
      hopSwaps?: unknown[];
    };
  };
}

export class LiqdRouter implements Router {
  readonly name = "liqd";

  async quote(a: {
    chain: Chain; inputToken: string; outputToken: string;
    amountIn: number; inputDecimals: number; outputDecimals: number;
    inputUsd: number; slippagePct: number; totalSupply: number;
    signalFillPrice: number | null;
  }): Promise<RouteQuote | null> {
    const chainId = CHAIN_ID[a.chain];
    if (!chainId) return null;

    const url = `${BASE}/v2/route?tokenIn=${a.inputToken}&tokenOut=${a.outputToken}`
      + `&amountIn=${a.amountIn}&chainId=${chainId}&multiHop=true&slippage=${a.slippagePct}`;

    let body: LiqdResponse;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      body = await res.json() as LiqdResponse;
    } catch {
      return null;                                   // network failure — caller falls back
    }

    // NO_VIABLE_PATHS is not an error to paper over. It is the router declining to price a
    // pair it cannot route, and on 2026-09-05 that was the correct call on a honeypot.
    const e = body.execution;
    if (!e?.calldata || !e.details?.amountOut) return null;

    const outputAmount = Number(e.details.amountOut) / 10 ** a.outputDecimals;
    const minOutputAmount = Number(e.details.minAmountOut) / 10 ** a.outputDecimals;
    if (!(outputAmount > 0)) return null;

    const fillPrice = a.inputUsd / outputAmount;
    return {
      inputUsd: a.inputUsd,
      outputAmount,
      minOutputAmount,
      fillPrice,
      impliedMarketCapUsd: fillPrice * a.totalSupply,
      slippageVsSignalPct: a.signalFillPrice ? (fillPrice / a.signalFillPrice - 1) * 100 : null,
      raw: body,
    };
  }

  /**
   * The transaction to broadcast. The floor comes from the router's own minAmountOut, which
   * is computed against the price WE were quoted — unlike a percentage tolerance, which the
   * provider applies to its own re-quote at submission and which therefore does not bind.
   */
  buildSwap(q: RouteQuote): SwapTx | null {
    const b = q.raw as LiqdResponse;
    const e = b?.execution;
    if (!e?.to || !e.calldata || !e.details?.minAmountOut) return null;
    return {
      to: e.to,
      data: e.calldata,
      value: "0x0",                                  // token-in; native-in sets this upstream
      minOutputRaw: String(e.details.minAmountOut),
    };
  }
}

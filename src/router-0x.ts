import type { Chain } from "./types.ts";
import type { Router, RouteQuote, SwapTx } from "./router.ts";
import { config } from "./config.ts";

/**
 * 0x Swap API v2 — https://api.0x.org
 *
 * PRIMARY router for v2.0. Chosen over liqd after measuring both against gmgn's price for
 * all 54 tokens this bot has actually traded, on 2026-09-08:
 *
 *     accurate to within 15%     0x  48/54      liqd  25/54
 *     returned a route at all    0x  54/54      liqd  48/54  (6 x HTTP 404)
 *
 * liqd's failure was ROUTING COVERAGE, not pricing: it indexes fewer venues, so when the good
 * pool was on one it does not see, it silently fell back to a bad one. CHROME is the clearest
 * case — 0x routed Uniswap_V3 at 0.79x gmgn's price, liqd quoted 332x through a broken V4 pool.
 * Same pattern on Ekubo_V3 (liqd 85x), BrownFi_V3 (liqd 17.6x) and Uniswap_V4 (liqd 7.2x).
 *
 * Where the two AGREE they are both right and gmgn is the stale one: on the two known rugs
 * (0xa80ebb6d98, 0x5b234bcf67) they returned identical 27.39x and 7.65x, i.e. both refused to
 * pay gmgn's last-traded price into a pool that no longer honours it.
 *
 * What 0x gives that liqd does not:
 *   - `liquidityAvailable: false` — distinguishes "unroutable" from "provider is down". liqd
 *     returns null for both, which made an outage indistinguishable from a dead token.
 *   - A real `gas` estimate (277,224 observed) against the 2,250,000 WORST_GAS_LIMIT measured
 *     off gmgn's deep routing. That constant is what reserved $33.80/swap and stranded a
 *     position on 2026-09-04.
 *   - `tokenMetadata.*TaxBps` transfer-tax detection. NOT a honeypot detector: it reported 0/0
 *     for the known honeypot at 0x5b234bcf67. Recorded, never gated on.
 *
 * The costs, stated plainly: 0x requires an API key and meters ~5 rps, which is the same shape
 * of dependency that took v1.0 offline — so liqd stays wired as the fallback precisely because
 * it needs neither. And 0x takes a 15 bps volume fee where liqd takes none; against gmgn's
 * 200 bps per side that is still a 6.7x improvement.
 *
 * Approval target is `allowanceTarget` = 0x0000000000001ff3684f28c67538d4d072c22734, verified
 * on chain: 1,009 bytes, EIP-1967 implementation and admin slots both zero, and owner()
 * REVERTS. Immutable and ownerless — a stronger property than liqd's router, which is
 * immutable but does carry an owner.
 */

const BASE = "https://api.0x.org";

/** 0x takes a numeric chain id. Robinhood 4663 is on its supported-chains list and verified
 *  live: our endpoint reports eth_chainId 0x1237 = 4663 and /price returned 200 against it. */
const CHAIN_ID: Record<string, number> = { robinhood: 4663 };

interface ZeroExResponse {
  liquidityAvailable?: boolean;
  allowanceTarget?: string;
  transaction?: { to: string; data: string; value: string; gas?: string; gasPrice?: string };
  buyAmount?: string;
  minBuyAmount?: string;
  route?: { fills?: { source?: string; proportionBps?: string }[] };
  tokenMetadata?: {
    buyToken?: { buyTaxBps?: string; sellTaxBps?: string; transferTaxBps?: string };
  };
  issues?: { simulationIncomplete?: boolean; balance?: unknown; allowance?: unknown };
}

export class ZeroExRouter implements Router {
  readonly name = "0x";

  async quote(a: {
    chain: Chain; inputToken: string; outputToken: string;
    amountIn: number; inputDecimals: number; outputDecimals: number;
    inputUsd: number; slippagePct: number; totalSupply: number;
    signalFillPrice: number | null;
  }): Promise<RouteQuote | null> {
    const chainId = CHAIN_ID[a.chain];
    if (!chainId) return null;

    const key = process.env.ZEROX_API_KEY;
    if (!key) return null;                             // no key, no quote — caller falls back

    // 0x takes RAW sell units, unlike liqd which takes human units. Rounding down here rather
    // than at the caller keeps the same `amountIn` contract across both routers.
    const sellAmount = BigInt(Math.floor(a.amountIn * 10 ** a.inputDecimals)).toString();
    // `taker` is REQUIRED for /quote to build calldata, and it is also what makes the response
    // carry `issues.balance` / `issues.allowance` for our actual wallet rather than a generic one.
    const taker = config.entry.walletAddress as string;

    const url = `${BASE}/swap/allowance-holder/quote`
      + `?chainId=${chainId}&sellToken=${a.inputToken}&buyToken=${a.outputToken}`
      + `&sellAmount=${sellAmount}&taker=${taker}`
      + `&slippageBps=${Math.round(a.slippagePct * 100)}`;

    let body: ZeroExResponse;
    try {
      const res = await fetch(url, {
        headers: { "0x-api-key": key, "0x-version": "v2" },
        signal: AbortSignal.timeout(15_000),
      });
      body = await res.json() as ZeroExResponse;
    } catch { return null; }

    // An explicit false is 0x telling us the pair genuinely cannot be routed — a different
    // fact from a network failure, and the one liqd could never distinguish.
    if (body.liquidityAvailable === false) return null;
    if (!body.buyAmount || !body.minBuyAmount) return null;

    const outputAmount = Number(body.buyAmount) / 10 ** a.outputDecimals;
    const minOutputAmount = Number(body.minBuyAmount) / 10 ** a.outputDecimals;
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
   * The transaction to broadcast. `to` is the AllowanceHolder, and the floor is 0x's own
   * `minBuyAmount` — computed against the price WE were quoted, unlike a percentage tolerance
   * which a provider re-applies to its own quote at submission and which therefore does not
   * bind. Verified: slippageBps=500 produced minBuyAmount exactly 0.95 x buyAmount.
   */
  buildSwap(q: RouteQuote): SwapTx | null {
    const b = q.raw as ZeroExResponse;
    const t = b?.transaction;
    if (!t?.to || !t.data || !b.minBuyAmount) return null;
    return {
      to: t.to,
      data: t.data,
      // 0x reports value as a DECIMAL string; SwapTx carries hex wei. Zero for token-in, which
      // is every swap we make while the input asset is WETH.
      value: "0x" + BigInt(t.value ?? "0").toString(16),
      minOutputRaw: String(b.minBuyAmount),
    };
  }

  /** Gas 0x simulated for this exact route. Far tighter than the 2,250,000 worst case measured
   *  off gmgn, and the input to a reserve that no longer has to assume deep routing. */
  gasEstimate(q: RouteQuote): number | null {
    const g = (q.raw as ZeroExResponse)?.transaction?.gas;
    const n = g ? Number(g) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }
}

export interface ZeroExSwapTx {
  to: string;
  data: string;
  value: bigint;
  gas: bigint;
  /** Expected output, raw units. */
  buyAmount: bigint;
  /** The floor 0x baked into the calldata, raw units. Enforced on chain. */
  minBuyAmount: bigint;
}

/**
 * A signable swap, priced from RAW input units.
 *
 * Separate from `quote()` because execution and decision want different things: `quote()`
 * answers "what would this cost in USD and what market cap does that imply", which needs a
 * native price and a total supply. This answers "give me the transaction", which needs
 * neither and must not fail because a price lookup did.
 *
 * `taker` MUST be the wallet that will sign. 0x builds the calldata around it, and a
 * transaction built for one address and sent from another does not merely misreport — it can
 * revert after the gas is spent.
 */
export async function zeroExSwapTx(a: {
  chain: Chain; sellToken: string; buyToken: string;
  sellAmountRaw: string; slippageBps: number; taker: string;
}): Promise<ZeroExSwapTx | null> {
  const chainId = CHAIN_ID[a.chain];
  const key = process.env["ZEROX_API_KEY"];
  if (!chainId || !key) return null;

  const url = `${BASE}/swap/allowance-holder/quote`
    + `?chainId=${chainId}&sellToken=${a.sellToken}&buyToken=${a.buyToken}`
    + `&sellAmount=${a.sellAmountRaw}&taker=${a.taker}`
    + `&slippageBps=${Math.max(1, Math.min(9999, Math.round(a.slippageBps)))}`;

  let b: ZeroExResponse;
  try {
    const res = await fetch(url, {
      headers: { "0x-api-key": key, "0x-version": "v2" },
      signal: AbortSignal.timeout(15_000),
    });
    b = await res.json() as ZeroExResponse;
  } catch { return null; }

  if (b.liquidityAvailable === false) return null;
  const t = b.transaction;
  if (!t?.to || !t.data || !b.buyAmount || !b.minBuyAmount) return null;

  return {
    to: t.to, data: t.data,
    value: BigInt(t.value ?? "0"),
    gas: BigInt(t.gas ?? "0"),
    buyAmount: BigInt(b.buyAmount),
    minBuyAmount: BigInt(b.minBuyAmount),
  };
}

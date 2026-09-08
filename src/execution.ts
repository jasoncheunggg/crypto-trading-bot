import { config } from "./config.ts";
import type { Chain } from "./types.ts";
import { ZeroExRouter } from "./router-0x.ts";
import { nativeUsd } from "./live.ts";

/**
 * What we spend. NATIVE ETH — not USDG, and no longer WETH either.
 *
 * The sentinel 0xEeee...EEeE is 0x's convention for "the chain's own coin". Measured against
 * WETH on 2026-09-08, same size, same tokens: identical output to the wei, +18,809 gas on the
 * buy and +3,421 on the sell — about $0.016 a round trip. And against USDG over 16 tokens:
 * 96.21% vs 96.39% median retention, which is inside the per-token noise.
 *
 * So all three cost the same to trade, and the choice is about failure modes rather than fills.
 *
 * Native wins because gas and capital become THE SAME ASSET. A wallet rich in its trading
 * currency but out of gas cannot SELL, and that is not hypothetical — it stranded a position on
 * 2026-09-04 and cost a managed exit. With native ETH the state is unreachable by construction
 * rather than defended against, which is why gastank.ts is deleted rather than rewired.
 *
 * It also needs no approval on the way in: native rides in `tx.value`, and 0x returns
 * issues.allowance = None. Only the SELL side still approves, per token.
 *
 * What it costs: idle capital is exposed to the ETH price, roughly +/-2% a day on a book that
 * is flat most of the time. That is symmetric and zero-mean, unlike an unsellable position,
 * which is -100% and permanent. The mitigation is to keep working capital small rather than to
 * hold a different asset.
 */
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const INPUT: Record<string, { address: string; decimals: number; symbol: string }> = {
  robinhood: { address: NATIVE, decimals: 18, symbol: "ETH" },
};

/** One instance; it holds no state beyond the base URL. */
const zerox = new ZeroExRouter();

export interface Quote {
  inputUsd: number;
  outputAmount: number;
  minOutputAmount: number;
  /** USD per token we would actually pay, including every cut taken along the way. */
  fillPrice: number;
  /** Market cap implied by OUR fill — the tier reference under exit.tierSelection "atOwnFill". */
  impliedMarketCapUsd: number;
  slippageVsSignalPct: number | null;
  raw: unknown;
}

/**
 * Price a prospective entry. Read-only — no key beyond ZEROX_API_KEY, no signature.
 *
 * 0x prices in RAW units of the input token; the input is WETH, so a USD position size has to
 * be converted through the native price first. gmgn took a raw USDG amount, where USD and
 * token units happened to coincide; that coincidence is gone and assuming it survives is how
 * a $30 position silently becomes a 30 WETH one.
 */
export async function quote(
  chain: Chain, token: string, positionUsd: number, tokenDecimals: number,
  totalSupply: number, signalFillPrice: number | null,
): Promise<Quote | null> {
  const input = INPUT[chain];
  if (!input) return null;

  const px = await nativeUsd(chain);
  if (px === null || px <= 0) return null;            // no price, no size — refuse rather than guess

  const q = await zerox.quote({
    chain, inputToken: input.address, outputToken: token,
    amountIn: positionUsd / px, inputDecimals: input.decimals, outputDecimals: tokenDecimals,
    inputUsd: positionUsd, slippagePct: config.entry.swapSlippageTolerancePct as number,
    totalSupply, signalFillPrice,
  });
  return q as Quote | null;
}

export function inputAsset(chain: Chain): { address: string; decimals: number; symbol: string } | null {
  return INPUT[chain] ?? null;
}

/** A USD position size as a raw on-chain amount of the input asset. */
export async function inputAmountRaw(chain: Chain, positionUsd: number): Promise<string | null> {
  const input = INPUT[chain];
  if (!input) return null;
  // WETH is not a dollar. Under v1.0 the input was USDG and `positionUsd` WAS the token
  // amount; carrying that assumption into v2.0 would size every position ~2,500x too large.
  const px = await nativeUsd(chain);
  if (px === null || px <= 0) return null;
  return BigInt(Math.floor((positionUsd / px) * 10 ** input.decimals)).toString();
}

export function inputSymbol(chain: Chain): string {
  return INPUT[chain]?.symbol ?? "?";
}

/**
 * What this many tokens would actually fetch right now, IN USD.
 *
 * The entry gate checks liquidity BEFORE buying, which says nothing about whether the position
 * can still be sold later. PNS500 passed with $45,393 of liquidity, ran to +104.8%, then had
 * its liquidity pulled — the take-profit reverted and every retry after it was rejected, while
 * gmgn's UI still showed a $68k pool.
 *
 * RETURNS USD, NOT WETH. The v1.0 version returned raw units of the input asset and the caller
 * compared that to `pos.costUsd`. Under USDG those were the same number. Under WETH they differ
 * by the ETH price, so every transient sell failure would have measured ~0.01 against a $30
 * cost, tripped the `worth < costUsd * 0.1` test, and been declared RUGGED and terminal —
 * abandoning live positions over a passing revert.
 */
export async function sellQuoteUsd(
  chain: Chain, token: string, amountRaw: string, tokenDecimals: number,
): Promise<number | null> {
  const out = INPUT[chain];
  if (!out) return null;
  const px = await nativeUsd(chain);
  if (px === null || px <= 0) return null;

  const amountIn = Number(amountRaw) / 10 ** tokenDecimals;
  if (!(amountIn > 0)) return null;

  // Slippage is irrelevant to a valuation — we want the mid, not an executable floor — but the
  // parameter is required, so it is set wide enough never to shape the answer.
  const q = await zerox.quote({
    chain, inputToken: token, outputToken: out.address,
    amountIn, inputDecimals: tokenDecimals, outputDecimals: out.decimals,
    inputUsd: 0, slippagePct: 50, totalSupply: 0, signalFillPrice: null,
  });
  if (!q) return null;
  return q.outputAmount * px;                          // WETH out -> USD
}

export interface RoundTrip {
  /** WETH returned divided by WETH spent, 0..1. Below ~0.05 is a honeypot or a dead pool. */
  retention: number;
  /** Tokens the buy leg would deliver. */
  outTokens: number;
  /** False when the sell leg cannot be routed at all — buyable but not exitable. */
  sellable: boolean;
}

/**
 * Buy this token and immediately sell all of it back, in quotes only. What comes home.
 *
 * This is the entry safety gate, and it replaces asking a provider whether a token is a
 * honeypot. Measured across all 112 robinhood tokens this bot has ever traded, on 2026-09-08:
 *
 *     median retention 96.11%      >=90%: 105      80-90%: 3      <80%: 3
 *
 * and the three below 80% were the entire rogues' gallery — 0.05%, 0.37% (the first rug) and
 * 2.97% (the honeypot). The next worst legitimate token retained 85.68%, so any threshold
 * between roughly 5% and 80% separates them with no false positives.
 *
 * Both providers' own honeypot flags fail this test. 0x reported sellTaxBps 0 for a token with
 * a 99% sell tax; gmgn's `is_honeypot` fired on 9 of 55 tokens including the two best trades
 * ever made (+$41.88 and +$54.16), and gating on it would have cost $76.58.
 *
 * The limitation, stated plainly: this is a QUOTE, not an execution. A token that quotes
 * honestly and reverts on transfer would still pass. It also costs a second serial 0x call on
 * the entry path, because the sell leg needs the buy leg's output amount.
 */
export async function roundTripProbe(
  chain: Chain, token: string, positionUsd: number, tokenDecimals: number,
): Promise<RoundTrip | null> {
  const input = INPUT[chain];
  if (!input) return null;
  const px = await nativeUsd(chain);
  if (px === null || px <= 0) return null;

  const wethIn = positionUsd / px;
  const buy = await zerox.quote({
    chain, inputToken: input.address, outputToken: token,
    amountIn: wethIn, inputDecimals: input.decimals, outputDecimals: tokenDecimals,
    inputUsd: positionUsd, slippagePct: 50, totalSupply: 0, signalFillPrice: null,
  });
  if (!buy || !(buy.outputAmount > 0)) return null;    // cannot even buy — caller rejects

  const sell = await zerox.quote({
    chain, inputToken: token, outputToken: input.address,
    amountIn: buy.outputAmount, inputDecimals: tokenDecimals, outputDecimals: input.decimals,
    inputUsd: positionUsd, slippagePct: 50, totalSupply: 0, signalFillPrice: null,
  });
  // No sell route is the single most dangerous state: buyable, unexitable. One of the 112
  // tokens is in exactly that condition today.
  if (!sell || !(sell.outputAmount > 0)) {
    return { retention: 0, outTokens: buy.outputAmount, sellable: false };
  }
  return {
    retention: sell.outputAmount / wethIn,
    outTokens: buy.outputAmount,
    sellable: true,
  };
}

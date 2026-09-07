import { config } from "./config.ts";
import type { Chain } from "./types.ts";
import { ZeroExRouter } from "./router-0x.ts";
import { nativeUsd } from "./live.ts";

/**
 * What we spend. v2.0 trades from WETH, not USDG.
 *
 * Forced rather than chosen: the self-custodied wallet holds native ETH and could not
 * reliably receive USDG, and holding one asset removes the USDG<->ETH conversion machinery
 * entirely. Wrapping is 1:1 at a fixed contract — 58,459 gas, no routing, no slippage, no
 * price risk — unlike the USDG swaps the gas tank used to perform.
 *
 * Gas is still paid in NATIVE ETH, so the wallet keeps a native balance alongside the WETH.
 *
 * bsc is retained only so the table shape is unchanged; it was removed from
 * `detection.chains` on 2026-09-04 and 0x is queried on chain 4663 alone.
 */
const INPUT: Record<string, { address: string; decimals: number; symbol: string }> = {
  robinhood: { address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", decimals: 18, symbol: "WETH" },
  bsc: { address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18, symbol: "USDC" },
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

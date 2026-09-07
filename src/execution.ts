import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.ts";
import type { Chain } from "./types.ts";
import { gmgn, GmgnRateLimit } from "./gmgn.ts";

const run = promisify(execFile);

/**
 * Input currency per chain — what WE spend. This is NOT the same list as the detection
 * quote assets: those are what a tracked wallet may pay in, this is what GMGN accepts as
 * a swap input. USDT is a valid detection quote on BSC but is rejected as an input there
 * (HTTP 401), because GMGN's currency table lists only BNB and USDC for bsc.
 * A stablecoin is chosen so a USD position size maps 1:1 to an input amount.
 */
const INPUT: Record<string, { address: string; decimals: number; symbol: string }> = {
  robinhood: { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6, symbol: "USDG" },
  bsc: { address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18, symbol: "USDC" },
};

/** Wallet bound to the GMGN API key — swaps must originate from it. From WALLET_ADDRESS. */
const FROM = config.entry.walletAddress as string;

export interface Quote {
  inputUsd: number;
  outputAmount: number;
  minOutputAmount: number;
  /** USD per token we would actually pay, including the platform and DEX cut. */
  fillPrice: number;
  /** Market cap implied by OUR fill — the tier reference under exit.tierSelection "atOwnFill". */
  impliedMarketCapUsd: number;
  slippageVsSignalPct: number | null;
  raw: unknown;
}

/**
 * Price a prospective entry. Read-only: `order quote` needs GMGN_API_KEY only, no private
 * key and no signature, so this path is safe to exercise long before execution is wired up.
 *
 * Still goes through gmgn-cli (429-766 ms of Node startup). See "Deferred optimisations"
 * in the spec — the HTTP API removes that, and needs Ed25519 signed auth for swaps.
 */
export async function quote(
  chain: Chain, token: string, positionUsd: number, tokenDecimals: number,
  totalSupply: number, signalFillPrice: number | null,
): Promise<Quote | null> {
  const input = INPUT[chain];
  if (!input) return null;

  const amount = BigInt(Math.floor(positionUsd * 10 ** input.decimals)).toString();
  try {
    const stdout = await gmgn([
      "order", "quote", "--chain", chain, "--from", FROM,
      "--input-token", input.address, "--output-token", token,
      "--amount", amount, "--slippage", String(config.entry.swapSlippageTolerancePct), "--raw",
    ], 20_000);

    const q = JSON.parse(stdout) as { output_amount?: string; min_output_amount?: string };
    if (!q.output_amount) return null;

    const outputAmount = Number(q.output_amount) / 10 ** tokenDecimals;
    const minOutputAmount = Number(q.min_output_amount ?? 0) / 10 ** tokenDecimals;
    if (!outputAmount) return null;

    const fillPrice = positionUsd / outputAmount;
    return {
      inputUsd: positionUsd, outputAmount, minOutputAmount, fillPrice,
      impliedMarketCapUsd: fillPrice * totalSupply,
      // Positive means we pay more per token than the tracked wallet did.
      slippageVsSignalPct: signalFillPrice ? (fillPrice / signalFillPrice - 1) * 100 : null,
      raw: q,
    };
  } catch (err) {
    // A RATE LIMIT IS NOT "no quote". Swallowing it here logged `abort — no quote for $28`,
    // which reads as "gmgn could not price this token" and is indistinguishable from a real
    // routing failure. Worse, the caller learned nothing, so the bot kept quoting into an
    // active ban — and gmgn extends a ban by 5s for every request made during it, up to five
    // minutes. Three "no quote" events on 2026-09-05 sat inside exactly such a window.
    if (err instanceof GmgnRateLimit) throw err;
    return null;
  }
}

/**
 * The asset we spend on this chain, for callers that must build a real swap rather than a
 * quote. Same table the quote uses, so a live entry cannot drift from the price it was sized
 * against — the commonest way a paper number and a real fill quietly stop describing the same
 * trade.
 */
export function inputAsset(chain: Chain): { address: string; decimals: number; symbol: string } | null {
  return INPUT[chain] ?? null;
}

/** A USD position size as a raw on-chain amount of the input asset. */
export function inputAmountRaw(chain: Chain, positionUsd: number): string | null {
  const input = INPUT[chain];
  if (!input) return null;
  return BigInt(Math.floor(positionUsd * 10 ** input.decimals)).toString();
}

export function inputSymbol(chain: Chain): string {
  return INPUT[chain]?.symbol ?? "?";
}

/**
 * What this many tokens would actually fetch right now, in USD.
 *
 * The entry gate checks pool liquidity BEFORE buying, which says nothing about whether the
 * position can still be sold later. PNS500 passed with $45,393 of liquidity, ran to +104.8%,
 * and then had its liquidity pulled — the take-profit reverted on chain and every retry after
 * it was rejected, while gmgn's own UI still showed a $68k pool and a healthy price.
 *
 * So this asks the only question that matters after a failed sell: is there anything left to
 * sell into? Called on failure, never on the happy path, so it costs nothing in normal use.
 */
export async function sellQuoteUsd(
  chain: Chain, token: string, amountRaw: string,
): Promise<number | null> {
  const out = INPUT[chain];
  if (!out) return null;
  try {
    const stdout = await gmgn([
      "order", "quote", "--chain", chain, "--from", FROM,
      "--input-token", token, "--output-token", out.address,
      "--amount", amountRaw, "--slippage", "50", "--raw",
    ], 20_000);
    const q = JSON.parse(stdout) as { output_amount?: string };
    if (!q.output_amount) return null;
    return Number(q.output_amount) / 10 ** out.decimals;
  } catch { return null; }
}

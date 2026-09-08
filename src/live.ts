import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.ts";
import { rpc } from "./rpc.ts";
import { tokenBalance, isNative, toRawUnits } from "./reconcile.ts";
import type { Chain } from "./types.ts";
import { ZeroExRouter, zeroExSwapTx } from "./router-0x.ts";
import { send, account, tradingBlocked, ensureAllowance } from "./signer.ts";

const run = promisify(execFile);

/**
 * Real swap submission.
 *
 * Deliberately separate from execution.ts, which only quotes. Quoting is safe to call
 * anywhere; this spends money, so it lives behind its own module, its own dryRun check and
 * gmgn-cli's own GMGN_ALLOW_AUTOMATED_TRADES gate. Three independent guards is not paranoia
 * — one bad call here is unrecoverable in a way no paper bug ever is.
 *
 * Interface confirmed by a live round trip on 2026-09-03:
 *   swap      -> {status:"submitted", hash, order_id}
 *   order get -> {status:"confirmed", hash, order_id, report:{input_amount, output_amount, …}}
 * The report is the ONLY source of truth for what was actually filled. A quote is a
 * prediction; measured once at 828.26 predicted vs 833.49 received, 0.6% apart.
 */

export interface SwapResult {
  /** Did the chain mine the transaction successfully? */
  minedOk?: boolean;
  /** Did the wallet balance actually move as expected? */
  balanceConfirmed?: boolean;
  /** Observed change in the output token's balance. */
  balanceDelta?: number;
  ok: boolean;
  /** Present once the chain has confirmed. */
  hash?: string;
  orderId?: string;
  /** Settled amounts, in whole units. Only set when ok. */
  inputAmount?: number;
  outputAmount?: number;
  /** Realised price: input per output unit. */
  fillPrice?: number;
  /**
   * Gas this swap actually burned, in USD, from the receipt.
   *
   * Needed because gas does NOT appear anywhere in the settled amounts: it is paid in native
   * currency, separately, so the USDG proceeds of a sale read the same whether gas cost 40
   * cents or four dollars. Percentage fees are already inside the settled amounts; gas never
   * is. Undefined when the receipt or the native price could not be read — callers fall back
   * to `exit.breakevenStop.gasUsdPerSwap` rather than treating it as free.
   */
  gasUsd?: number;
  /** Why it failed, for the log and the alert. */
  error?: string;
  /** Terminal state, from the chain or from our own pre-broadcast simulation. */
  status?: string;
}

const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * What to price to value gas, per chain.
 *
 * The zero address answers on robinhood (ETH) but gmgn returns ETH for it on bsc too, which
 * would value BNB gas at $2,516 instead of $612 — so bsc is pointed at WBNB explicitly. A
 * wrong gas price is worse than no gas price: it silently corrupts every trade's P&L rather
 * than falling back to the estimate.
 */
/** The wrapped native token, whose price in USDG IS the native price. Mirrors execution.ts's
 *  INPUT table; kept local so live.ts does not import execution.ts (which imports this file). */
const INPUT_WETH: Record<string, string> = {
  robinhood: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
};

const GAS_TOKEN: Record<string, { chain: string; address: string }> = {
  robinhood: { chain: "robinhood", address: NATIVE },
  bsc: { chain: "bsc", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
};

const zerox = new ZeroExRouter();

const nativePrice = new Map<string, { usd: number; at: number }>();
const NATIVE_PRICE_TTL_MS = 10 * 60_000;   // gas is cents; a 10-minute-old price is plenty

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Native price derived from CHAIN swaps, so the entry path never spends gmgn budget on it.
 *
 * Prices the wrapped native token against the sizing asset out of a recent swap — the same
 * arithmetic `verifyPrice` does, minus the median-of-3 quorum, which is overkill here: this
 * number converts wei to dollars for gas accounting, and gas is cents. Measured at ~430ms
 * against gmgn's ~485ms and agreeing to 0.008%, but on Alchemy's separate quota.
 *
 * Deliberately NOT `verifyPrice` itself: the quorum costs 1,897ms and 351 CU for precision
 * that changes nothing about a gas estimate.
 */
async function nativeUsdFromChain(chain: Chain): Promise<number | null> {
  const quotes = config.quoteAssets[chain] ?? {};
  const wrapped = Object.entries(quotes).find(([, q]) => !q.isSizingAsset);
  const sizing = Object.entries(quotes).find(([, q]) => q.isSizingAsset);
  if (!wrapped || !sizing) return null;
  const [wAddr, wMeta] = wrapped, [sAddr, sMeta] = sizing;
  try {
    const head = parseInt((await rpc<string>(chain, "eth_blockNumber", [])) as string, 16) - 2;
    for (let w = 0; w < 3; w++) {
      const to = head - w * 10, from = to - 9;
      const logs = await rpc<{ transactionHash: string }[]>(chain, "eth_getLogs", [{
        fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
        address: wAddr, topics: [TRANSFER_TOPIC],
      }]).catch(() => null);
      const hashes = [...new Set((logs ?? []).map((l) => l.transactionHash))];
      for (const h of hashes.slice(0, 3)) {
        const r = await rpc<{ logs: { address: string; topics: string[]; data: string }[] }>(
          chain, "eth_getTransactionReceipt", [h]).catch(() => null);
        if (!r) continue;
        let maxWrapped = 0n, maxSizing = 0, wLegs = 0, sLegs = 0;
        for (const l of r.logs) {
          if (l.topics[0] !== TRANSFER_TOPIC) continue;
          const a = l.address.toLowerCase();
          if (a === wAddr) { wLegs++; const v = BigInt(l.data); if (v > maxWrapped) maxWrapped = v; }
          else if (a === sAddr) { sLegs++; maxSizing = Math.max(maxSizing, Number(BigInt(l.data)) / 10 ** sMeta.decimals); }
        }
        if (wLegs > 6 || sLegs > 4) continue;          // batched — unpriceable, same rule as verifyPrice
        const amt = Number(maxWrapped) / 10 ** wMeta.decimals;
        if (amt <= 0 || maxSizing <= 0) continue;
        const px = maxSizing / amt;
        // A mispaired batch can produce any number at all. Native is not $50 or $50,000.
        if (px < 200 || px > 20_000) continue;
        return px;
      }
    }
  } catch { /* fall through to 0x */ }
  return null;
}

/** In-flight refreshes, so a burst of signals cannot start ten lookups at once. */
const nativeInflight = new Map<string, Promise<number | null>>();

/**
 * STALE-WHILE-REVALIDATE. A cached price is returned immediately even when past its TTL, and
 * the refresh happens in the background.
 *
 * The chain lookup has to skip BATCHED transactions, and how many it meets is luck: measured
 * between 840ms and 3,327ms on identical code moments apart. Awaiting that on the entry path
 * would be worse than the gmgn call it replaces, on tokens that move 58% in a second. A gas
 * price minutes old is fine — it converts wei to dollars for accounting, not for a decision —
 * so freshness is worth nothing here and latency is worth a lot.
 *
 * Only the very first call of the process can block, and `warmNativeUsd` on startup pays that
 * one off the entry path.
 */
export async function nativeUsd(chain: Chain): Promise<number | null> {
  const hit = nativePrice.get(chain);
  const stale = hit !== undefined && Date.now() - hit.at >= NATIVE_PRICE_TTL_MS;
  if (hit && !stale) return hit.usd;
  if (hit && stale) { void refreshNative(chain); return hit.usd; }   // serve stale, refresh behind
  return refreshNative(chain);
}

/** Fetch and cache. Chain first, 0x only if the chain cannot answer. */
function refreshNative(chain: Chain): Promise<number | null> {
  const running = nativeInflight.get(chain);
  if (running) return running;
  const p = (async () => {
    const onChain = await nativeUsdFromChain(chain);
    if (onChain !== null) {
      nativePrice.set(chain, { usd: onChain, at: Date.now() });
      return onChain;
    }
    return nativeUsdFrom0x(chain);
  })().finally(() => nativeInflight.delete(chain));
  nativeInflight.set(chain, p);
  return p;
}

/** Pay the first lookup at startup so no signal ever waits for it. */
export function warmNativeUsd(chain: Chain): void {
  void refreshNative(chain).catch(() => null);
}

/**
 * The chain's dollar stablecoin, for pricing native ETH when the log-derived route cannot.
 *
 * USDG on robinhood is 0x5fc5360d... at SIX decimals — not the eighteen every other token
 * here uses, and not the mainnet USDG address (0xe343..., which has no code on chain 4663 at
 * all). Both mistakes silently produce a price wrong by a factor of 10^12 or a dead lookup.
 */
const STABLE: Record<string, { address: string; decimals: number }> = {
  robinhood: { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6 },
};

/**
 * Native price from 0x, by asking what one WETH fetches in USDG.
 *
 * Replaces the gmgn `token info` lookup v1.0 used. Verified 2026-09-08: $2,484.38 against
 * gmgn's own $2,489.42, a 0.2% difference — well inside what this number is used for, which
 * is converting wei to dollars for sizing and accounting rather than any price decision.
 */
async function nativeUsdFrom0x(chain: Chain): Promise<number | null> {
  const input = INPUT_WETH[chain];
  const stable = STABLE[chain];
  if (!input || !stable) return null;
  const q = await zerox.quote({
    chain, inputToken: input, outputToken: stable.address,
    amountIn: 1, inputDecimals: 18, outputDecimals: stable.decimals,
    inputUsd: 0, slippagePct: 50, totalSupply: 0, signalFillPrice: null,
  });
  const usd = q?.outputAmount;
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return null;
  nativePrice.set(chain, { usd, at: Date.now() });
  return usd;
}

/** Gas burned by one transaction, in USD. Null if the receipt or the price is unavailable. */
async function gasUsdFor(
  chain: Chain, gasUsed?: string, effectiveGasPrice?: string,
): Promise<number | undefined> {
  if (!gasUsed || !effectiveGasPrice) return undefined;
  const px = await nativeUsd(chain);
  if (px === null) return undefined;
  const wei = BigInt(gasUsed) * BigInt(effectiveGasPrice);
  return (Number(wei) / 1e18) * px;
}

/**
 * Submit one swap and wait for it to settle.
 *
 * Refuses unless mode.dryRun is false AND the environment opts in. Returns rather than
 * throws: a throw here would unwind the exit loop and strand a live position.
 */
export async function executeSwap(
  chain: Chain, inputToken: string, outputToken: string,
  amountRaw: string, slippagePct: number, settleTimeoutMs = 90_000,
  /**
   * ABSOLUTE floor on what the swap may return, in the output token's raw units.
   *
   * A percentage tolerance does not bind. Under gmgn it was applied to THEIR re-quote at
   * submission, so a price move between our decision and the submit window filled at the new
   * price however far it ran: measured fills of 79.7%, 86.3%, 89.4% and 89.7% against a
   * nominal 5%. Under 0x the same hazard exists in a different shape — slippageBps is applied
   * to the quote 0x returns at THAT moment, not to the price the gates approved.
   *
   * So this floor is enforced by REQUOTING until 0x's own minBuyAmount clears it, and refusing
   * if it cannot. That makes "this exit cannot return less than X" true rather than approximate.
   *
   * Omitted for stops and cutoffs, where failing to sell is the worse outcome.
   */
  minOutputRaw?: string,
): Promise<SwapResult> {
  const blocked = tradingBlocked();
  if (blocked) return { ok: false, error: `refused: ${blocked}` };

  const from = account().address;

  // Snapshot BEFORE submitting — the balance check is a comparison, not an absolute.
  const balanceBefore = (await tokenBalance(chain, outputToken).catch(() => null)) ?? 0;
  const inputBefore = await tokenBalance(chain, inputToken).catch(() => null);

  // Native ETH needs no approval — it rides in tx.value, and 0x reports issues.allowance None.
  // Every token we BUY still needs its own approval before it can be SOLD, which is the case
  // this guards: without it a position can be entered and never exited.
  if (!isNative(inputToken)) {
    const allow = await ensureAllowance(chain, inputToken, BigInt(amountRaw));
    if (!allow.ok) return { ok: false, error: `refused: ${allow.error ?? "could not approve input token"}` };
  }

  let tx = await zeroExSwapTx({
    chain, sellToken: inputToken, buyToken: outputToken,
    sellAmountRaw: amountRaw, slippageBps: Math.round(slippagePct * 100), taker: from,
  });
  if (!tx) return { ok: false, error: "0x returned no route" };

  // Tighten to OUR floor if 0x's is looser. One requote, derived from the floor rather than
  // guessed: if we need F of an expected B, the tolerance that produces it is 1 - F/B.
  if (minOutputRaw) {
    const floor = BigInt(minOutputRaw);
    if (tx.minBuyAmount < floor) {
      if (tx.buyAmount <= floor) {
        return {
          ok: false,
          error: `refused: 0x quotes ${tx.buyAmount} but the floor is ${floor} — the price moved past our decision`,
        };
      }
      const bps = Number((tx.buyAmount - floor) * 10_000n / tx.buyAmount);
      const tighter = await zeroExSwapTx({
        chain, sellToken: inputToken, buyToken: outputToken,
        sellAmountRaw: amountRaw, slippageBps: Math.max(1, bps), taker: from,
      });
      if (!tighter || tighter.minBuyAmount < floor) {
        return { ok: false, error: `refused: could not obtain a route with minOutput >= ${floor}` };
      }
      tx = tighter;
    }
  }

  const sent = await send({
    chain, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas, label: "swap",
  });
  if (!sent.ok) {
    // A simulation revert is deterministic against current state — the pool is identical a
    // second later, so a retry cannot succeed. Reported distinctly so attemptEntry does not
    // spend retries on it.
    const status = sent.error?.startsWith("simulation reverted") ? "sim_reverted" : undefined;
    return { ok: false, status, error: sent.error };
  }

  const gasUsd = await gasUsdFor(chain, String(sent.gasUsed ?? 0n), String(sent.effectiveGasPrice ?? 0n));

  const balanceAfter = (await tokenBalance(chain, outputToken).catch(() => null)) ?? balanceBefore;
  const delta = balanceAfter - balanceBefore;
  const inputAfter = await tokenBalance(chain, inputToken).catch(() => null);
  const inputAmount = inputBefore !== null && inputAfter !== null ? inputBefore - inputAfter : undefined;
  const outputAmount = delta > 0 ? delta : undefined;

  // Approve what we just BOUGHT, now, while nothing is waiting on it. The exit is the one
  // moment where an extra transaction costs the most, and a sell blocked on a missing
  // approval is how a managed position becomes an unmanaged one. Deliberately not awaited
  // for its result beyond logging: executeSwap re-checks on the way out regardless.
  if (delta > 0 && !isNative(outputToken)) {
    void ensureAllowance(chain, outputToken, 2n ** 255n)
      .then((a) => { if (a.approved) console.log(`   approve ${outputToken} for exit — ${a.hash}`); })
      .catch(() => undefined);
  }

  return {
    ok: true, hash: sent.hash, status: "confirmed",
    minedOk: true, balanceConfirmed: delta > 0, balanceDelta: delta,
    inputAmount, outputAmount, gasUsd,
    fillPrice: inputAmount && outputAmount && outputAmount > 0 ? inputAmount / outputAmount : undefined,
  };
}

/** Why an entry attempt ended, and whether retrying is SAFE. */
export type EntryOutcome =
  | { kind: "filled"; result: SwapResult; partial: false }
  | { kind: "partial"; result: SwapResult; partial: true; expected: number; got: number }
  | { kind: "no-fill"; reason: string }        // provably nothing landed — safe to retry
  | { kind: "error"; reason: string };         // ambiguous or failed — NEVER retry

/**
 * One entry attempt, classified by whether a retry would be safe.
 *
 * The distinction that matters is CERTAINTY, not success. A retry after a swap that actually
 * landed would double the position with nothing recording the first half — strictly worse
 * than missing the trade. So "no-fill" is claimed only when both independent checks agree
 * nothing happened: no receipt on chain AND no balance movement. Everything else — a revert,
 * a timeout, a submit error, an unreadable response — is "error", and the caller must not
 * retry it.
 *
 * A PARTIAL fill is a real position. It is kept and managed normally; only the size differs
 * from what was asked for, and that is recorded rather than corrected.
 */
/**
 * Hard floor on tokens received, as a share of the quote we DECIDED on.
 *
 * `--slippage` does not bind here. gmgn re-quotes at submission and applies the tolerance to
 * THAT number, so a price move between our decision and the submit window fills at the new
 * price however far it ran: measured fills of 79.7%, 86.3%, 89.4% and 89.7% of quote against
 * a nominal 5% tolerance. `--min-output` is an absolute amount, so it is the only mechanism
 * that binds against the price the gates actually approved.
 *
 * 0.92 comes from the distribution over 46 real entries: 42 filled at 95%+ (median 100.0%,
 * and 21 came in ABOVE quote), while the four bad ones all landed below 90%. Nothing at all
 * fell between 90% and 95%, so anything in that gap separates them cleanly; 92% is its
 * midpoint. Tightening to 98% would start rejecting 8 perfectly good fills.
 *
 * The cost is a missed signal plus the gas on a reverted buy. That is the right trade: an
 * entry 16% above quote is instantly 14% underwater, which puts the -20% stop within noise of
 * the market and manufactures stop-outs on trades that never moved against us (SLINK,
 * 2026-09-04: filled 15.9% high, stopped 11 seconds later, -3.5%).
 */
const MIN_FILL_RATIO = 0.92;

export async function attemptEntry(
  chain: Chain, inputToken: string, outputToken: string,
  amountRaw: string, slippagePct: number, expectedOut: number,
  outputDecimals = 18,
): Promise<EntryOutcome> {
  const before = (await tokenBalance(chain, outputToken).catch(() => null)) ?? 0;
  // Floor in RAW units, built with toRawUnits rather than float maths: an 18-decimal amount
  // needs more significant digits than a Number carries, and asking for more than the pool
  // can give reverts the buy for the wrong reason.
  const minOut = expectedOut > 0
    ? toRawUnits(expectedOut * MIN_FILL_RATIO, outputDecimals).toString()
    : undefined;
  const r = await executeSwap(chain, inputToken, outputToken, amountRaw, slippagePct, 90_000, minOut);

  if (r.ok) {
    const got = r.outputAmount ?? r.balanceDelta ?? 0;
    // Below this share of the quote, treat it as a partial rather than a clean fill.
    const PARTIAL_BELOW = 0.95;
    if (expectedOut > 0 && got > 0 && got < expectedOut * PARTIAL_BELOW) {
      return { kind: "partial", result: r, partial: true, expected: expectedOut, got };
    }
    return { kind: "filled", result: r, partial: false };
  }

  // A guard refusal is not a market outcome. Nothing was submitted, so nothing landed — but
  // "no-fill" must mean ONE thing: the order went out and provably did not take. Letting a
  // refusal wear that label would spend retry attempts against a gate that will refuse again,
  // and would blur the only signal the caller uses to decide a rebuy is safe.
  if (r.error?.startsWith("refused:")) return { kind: "error", reason: r.error };

  // A SIMULATION REVERT is deterministic against current state. signer.send runs the exact
  // call through eth_call before broadcasting, so this costs no gas — but it also means the
  // pool is identical a second later and a retry cannot succeed. It replaces gmgn's
  // pre-submission refusals (GEvmInsufficientSlippage / GEvmValueLossTooHigh), which are gone
  // with gmgn, and it is strictly better: the chain itself decides rather than a vendor's
  // policy, and the failure text names the actual revert reason.
  //
  // Classified `error`, not `no-fill`, because `no-fill` authorises a retry.
  if (r.status === "sim_reverted") {
    return { kind: "error", reason: r.error ?? "simulation reverted — deterministic, not retrying" };
  }

  // A floor we could not meet is the price having moved past the decision the gates approved.
  // Also deterministic at this instant, and also not a retry.
  if (/could not obtain a route with minOutput|the price moved past our decision/i.test(r.error ?? "")) {
    return { kind: "error", reason: r.error ?? "min-output floor unreachable" };
  }

  // A revert is definitive but is NOT retried here: the swap was attempted and rejected by
  // the chain, which usually means slippage or liquidity moved. The caller re-evaluates from
  // scratch rather than resubmitting the same order.
  if (r.status === "reverted") return { kind: "error", reason: "transaction reverted on chain" };

  // Provably nothing landed: no receipt, and the balance did not move.
  const after = (await tokenBalance(chain, outputToken).catch(() => null)) ?? before;
  const moved = Math.abs(after - before) > 0;
  const receiptSeen = r.minedOk !== undefined;
  if (!receiptSeen && !moved) {
    return { kind: "no-fill", reason: r.error ?? "no receipt and no balance change" };
  }
  return { kind: "error", reason: r.error ?? `ambiguous outcome (status ${r.status})` };
}

export { NATIVE };

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config, describe, maxSlippagePctFor, entrySlippageCap } from "./config.ts";
import { Detector } from "./detector.ts";
import { planEntry } from "./entry.ts";
import { quote, inputSymbol, inputAsset, inputAmountRaw, sellQuoteUsd } from "./execution.ts";
import { swapTxFromQuote } from "./router-0x.ts";
import { attemptEntry, executeSwap, nativeUsd, warmNativeUsd } from "./live.ts";
import { open as openPosition, close as closePosition, all as allPositions, push as positionsPush, tierFor } from "./positions.ts";
import { reconcilePosition, tokenBalanceRaw, toRawUnits, tokenBalance, NATIVE_ADDRESS as NATIVE_TOKEN } from "./reconcile.ts";
import { checkBreaker, capPositionUsd } from "./breaker.ts";
import { gasUsdPerSwap, reserveUsdPerSwap, currentGwei, recordGas, describeGas } from "./gas.ts";
import { tokenRisk, concentrationBlocks, bytecodeBlocks, sellTaxBlocks, closedSourceBlocks } from "./security.ts";
import { refreshBalances, describeBalances, dailyAnchor, gasState, gasNativeHeld, REFRESH_MS } from "./balance.ts";
import type { Position } from "./positions.ts";
import { ExitManager, cutoffFor } from "./exit.ts";
import { SwapPriceFeed } from "./swapprice.ts";
import { PathRecorder } from "./pricepath.ts";
import { record, all as allTrades } from "./trades.ts";
import { fundsFor } from "./portfolio.ts";
import { totalSupply, rpc } from "./rpc.ts";
import { setBudget, summary as cuSummary, monthSpent, remaining as cuRemaining, persist as cuPersist } from "./cu.ts";
import type { Signal } from "./types.ts";

const usd = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * Whether a real order may be sent. THREE independent switches, all of which must be opened
 * deliberately — `executeSwap` re-checks two of them itself, so this is a gate in front of a
 * gate rather than the only thing standing between a signal and the wallet.
 *
 * `logOnly` is included here even though executeSwap does not check it, because its whole
 * meaning is "watch, do not act", and a mode that quietly traded would make it a lie.
 */
function liveTrading(): boolean {
  return config.mode.dryRun === false
    && config.mode.logOnly === false
    && process.env["BOT_ALLOW_AUTOMATED_TRADES"] === "1";
}
/**
 * Stop cleanly after N completed live trades.
 *
 * For proving a new execution stack with real money without committing to an open-ended run.
 * Counts CLOSED live positions, not entries, so the run covers a whole round trip — entry,
 * management, ladder and exit — rather than stopping with capital still in a token.
 *
 * Shadows never count: they cost nothing and hold no slot, so a run that stopped on one would
 * prove nothing about the path that spends money.
 *
 * null disables it, which is the normal configuration.
 */
const STOP_AFTER = (config.mode as { stopAfterTrades?: number | null }).stopAfterTrades ?? null;
let liveTradesClosed = 0;

const t = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
let detector: import("./detector.ts").Detector | undefined;

/** The one exit path. Declared as a function so the stopAfterTrades check can reach it from
 *  inside the exit handler, which runs long before the signal handlers are installed. */
function shutdown(why: string): void {
  try { detector?.stop(); recorder.stopAll(); feed?.stop(); } catch { /* stopping anyway */ }
  cuPersist();
  console.log(`[${t()}] alchemy spend: ${cuSummary()}`);
  console.log(`\n[${t()}] stopped (${why})`);
  process.exit(0);
}

const STATE = resolve(import.meta.dirname, "..", "state");
mkdirSync(STATE, { recursive: true });

/** Alerts go to a file rather than killing the process — an overnight run must survive them. */
function alert(line: string): void {
  appendFileSync(resolve(STATE, "alerts.log"), `${t()} ${line}\n`);
}

/**
 * One price feed for the whole process. The exit manager and the path recorder read the
 * same prices, so a recording can no longer disagree with the decision it is meant to
 * explain — an earlier run had the exit reporting a -6.7% trough while the recorder,
 * polling separately, wrote -44.9% for the same seconds.
 */
/**
 * OFF by default. The feed's chain-wide quote-asset subscription delivers ~244 logs/s on
 * robinhood and ~152/s on bsc, and Alchemy bills roughly 28 CU per delivered log — about
 * 40M CU/hour, a whole monthly allowance in 45 minutes. Detection is unaffected: it filters
 * by wallet address, so it sees ~86 logs/hour.
 */
const feedEnabled = config.livePriceFeed?.enabled === true;
const feed = feedEnabled
  ? new SwapPriceFeed(() => {}, (m) => console.log(`[${t()}] ${m}`))
  : null;
const exits = new ExitManager(feed);
const recorder = new PathRecorder(
  (config.exit.pathRecorder?.sampleIntervalSeconds ?? 1) * 1000,
  (config.exit.timeCutoffSeconds + config.exit.timeCutoffJitterSeconds +
    (config.exit.pathRecorder?.tailSecondsAfterCutoff ?? 600)) * 1000,
  feed,
);
const TAIL_MS = (config.exit.pathRecorder?.tailSecondsAfterCutoff ?? 600) * 1000;

async function onSignal(s: Signal): Promise<void> {
  const when = s.timestamp
    ? new Date(s.timestamp * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z" : "?";
  const anomaly = s.verdict === "QUOTE_NO_TOKEN" ? "   <-- ANOMALY, review" : "";

  console.log(`\n[${t()}] ${s.wallet.name}  [${s.chain}]  ${s.verdict}${anomaly}`);
  console.log(`   block   ${s.blockNumber}  ${when}`);
  console.log(`   token   ${s.token}`);
  console.log(`   amount  ${s.tokenAmount >= 0 ? "+" : ""}${s.tokenAmount.toLocaleString("en-US", { maximumFractionDigits: 6 })}`);
  console.log(`   signal  ${s.sizeUsd ? usd(s.sizeUsd) : "nothing paid"}` +
    (s.quoteLegs.length ? `   legs ${s.quoteLegs.map((l) =>
      `${l.symbol} ${l.amount.toFixed(l.symbol === "WETH" ? 4 : 2)}${l.usd === null ? "(?)" : `=$${l.usd.toFixed(2)}`}`).join(", ")}` : ""));
  console.log(`   router  ${s.viaKnownRouter ? "FOMO" : "not FOMO"}`);
  console.log(`   tx      ${s.txHash}`);

  if (s.verdict === "BUY" && s.viaKnownRouter) {
    alert(`FOMO BUY ${s.wallet.name} [${s.chain}] ${usd(s.sizeUsd)} ${s.token} ${s.txHash}`);
  }
  // The router gate fails CLOSED: an unrecognised contract means the trade is skipped.
  // That failure is silent by nature — FOMO's second router hid this way and cost ~87% of
  // qualifying volume. This alert is the only thing that makes a new router announce itself.
  const flagAbove = config.detection?.classifier?.flagUnknownRouterAboveUsd ?? Infinity;
  if (s.verdict === "BUY" && !s.viaKnownRouter && s.sizeUsd >= flagAbove) {
    const line = `UNKNOWN ROUTER  ${s.wallet.name} [${s.chain}] ${usd(s.sizeUsd)} via ${s.routerUsed} — NOT traded. Check if this is a new FOMO contract. tx ${s.txHash}`;
    alert(line);
    console.log(`\n   *** ${line}\n`);
  }

  const plan = await planEntry(s);
  if (plan.signalMarketCapUsd) {
    const drift = plan.lookupMarketCapUsd
      ? `  ->  lookup ${usd(plan.lookupMarketCapUsd)} (${((plan.lookupMarketCapUsd / plan.signalMarketCapUsd - 1) * 100).toFixed(1)}%)` : "";
    console.log(`   mcap    ${usd(plan.signalMarketCapUsd)} their fill${drift}`);
  }
  if (plan.poolLiquidityUsd !== null) console.log(`   liq     ${usd(plan.poolLiquidityUsd)}`);

  if (!plan.act && !plan.blockedByReentryOnly) {
    console.log(`   ACTION  skip — ${plan.rejections.join("; ")}`);
    return;
  }
  // A re-entry we refuse is still run as a SHADOW: same tiers, same stop, same verified
  // fills, but no capital, no slot, and its result is kept in a separate ledger. Blocking it
  // outright would mean never learning whether blocking it was the right call.
  const shadow = !plan.act;
  if (shadow) console.log(`   ACTION  shadow — ${plan.rejections.join("; ")} (measuring the counterfactual)`);

  // Started HERE, not where it is consumed. `quote()` needs the supply, so awaiting it just
  // above the quote put a ~355ms round trip squarely on the critical path for every token we
  // had not seen before — which is nearly all of them. Nothing between here and the quote
  // depends on it, so it overlaps the gas gates, the breaker and sizing instead. Kicked off
  // only after the cheap rejections so ordinary non-buys never pay for it. The result is
  // permanently cached, and a failure resolves to 0 exactly as the old inline call did.
  const supplyPromise = totalSupply(s.chain, s.token, s.tokenDecimals).catch(() => 0);

  // Belt and braces: any path that reaches here without sizing is a bug, but it must not be
  // a fatal one — an unhandled throw in onSignal takes the whole runner down.
  // The breaker halts ENTRIES only. An open position must always be allowed to exit —
  // refusing to sell during a bad run turns a bounded loss into an unbounded one.
  // The breaker measures against a DAILY ANCHOR, not against the live balance. Sizing wants
  // "what do I have now"; the breaker wants "how far down am I today", and a denominator that
  // moves with every trade makes that question meaningless — a slow bleed never trips it,
  // because the balance it is compared against falls alongside the losses.
  // Out of gas is worse than out of money: a wallet that cannot pay for a swap cannot SELL,
  // and an unsellable position is the failure that stranded one through its cutoff. Entries
  // stop well above empty so the remaining gas is reserved for closing whatever is open —
  // including the retries a reverting sell would burn.
  const gas = liveTrading() ? gasState(s.chain) : null;
  if (gas?.halt) {
    console.log(`   ACTION  HALTED — gas low: ~${gas.swaps} swaps left, entries stopped until refilled`);
    alert(`GAS LOW ${s.chain}: ~${gas.swaps} swaps left — ENTRIES HALTED, refill to resume`);
    return;
  }

  // Two gates the swap-count check above cannot see, because it divides by a FIXED
  // 0.00025 native per swap — a constant from when gas was 0.3 gwei. On 2026-09-04 at
  // 8.4 gwei it reported 76 swaps left while the true answer was ZERO, so the halt that
  // exists to stop us entering a position we cannot exit was reading the wrong number at
  // exactly the moment it mattered.
  //
  // Both are ENTRY-only. An open position must always be allowed to sell; refusing to exit
  // because gas is expensive turns a bounded loss into an unbounded one.
  if (liveTrading()) {
    const gwei = await currentGwei(s.chain);
    const maxGwei = (config.risk as { maxGasGwei?: number }).maxGasGwei;
    if (gwei !== null && maxGwei && gwei > maxGwei) {
      console.log(`   ACTION  HALTED — gas ${gwei.toFixed(2)} gwei over the ${maxGwei} ceiling; a round trip costs more than the edge`);
      alert(`GAS CEILING ${s.chain}: ${gwei.toFixed(2)} gwei > ${maxGwei} — ENTRIES HALTED`);
      return;
    }
    // Can we even SUBMIT a worst-case swap? This is the reserve gmgn enforces, not what a
    // swap costs — the two differ by ~10x and only this one predicts GEvmInsufficientFundsForGas.
    const px = await nativeUsd(s.chain);
    const held = gasNativeHeld(s.chain);
    if (px !== null && held !== null) {
      const reserve = await reserveUsdPerSwap(s.chain, px);
      const ethUsd = held * px;
      if (reserve !== null && ethUsd < reserve) {
        console.log(`   ACTION  HALTED — ETH $${ethUsd.toFixed(2)} below the $${reserve.toFixed(2)} submit reserve; an exit would block`);
        alert(`GAS RESERVE ${s.chain}: ETH $${ethUsd.toFixed(2)} < reserve $${reserve.toFixed(2)} — ENTRIES HALTED`);
        return;
      }
    }
  }

  const brk = checkBreaker(dailyAnchor(s.chain, fundsFor(s.chain)?.balanceUsd ?? 0));
  if (brk.tripped) {
    console.log(`   ACTION  HALTED — circuit breaker: ${brk.reasons.join("; ")}`);
    alert(`BREAKER TRIPPED ${brk.reasons.join("; ")} — entries halted, exits continue`);
    return;
  }

  if (!plan.sizing) {
    console.log(`   ACTION  skip — no sizing available (${plan.rejections.join("; ")})`);
    return;
  }
  const sized = capPositionUsd(plan.sizing.positionUsd);
  if (sized.capped) {
    console.log(`   size    capped ${usd(plan.sizing.positionUsd)} -> ${usd(sized.usd)} by maxPositionUsd`);
    alert(`POSITION CAPPED ${usd(plan.sizing.positionUsd)} -> ${usd(sized.usd)}`);
  }
  const positionUsd = sized.usd;
  const supply = await supplyPromise;
  const signalPrice = s.tokenAmount ? s.sizeUsd / Math.abs(s.tokenAmount) : null;
  // Fired ALONGSIDE the quote, not after it. The security lookup takes ~448ms against the
  // quote's ~606ms, so running them together costs nothing on a path already spending ~3s
  // between signal and fill. Sequential, it would be a 15% latency tax on every entry.
  const quotedAt = Date.now();
  const [q, risk, codeBytes] = await Promise.all([
    quote(s.chain, s.token, positionUsd, s.tokenDecimals, supply, signalPrice),
    tokenRisk(s.chain, s.token),
    // One eth_getCode, ~26 CU, riding alongside the quote so it costs no latency at all.
    rpc<string>(s.chain, "eth_getCode", [s.token, "latest"])
      .then((c) => (c && c !== "0x" ? (c.length - 2) / 2 : null))
      .catch(() => null),
  ]);
  if (!q) { console.log(`   ACTION  abort — no quote for ${usd(positionUsd)} ${inputSymbol(s.chain)}`); return; }
  if (risk.top10Pct !== null) {
    console.log(`   holders top-10 ${risk.top10Pct.toFixed(0)}%${risk.openSource === false ? "   contract NOT open source" : ""}`);
  }

  const worse = q.slippageVsSignalPct;
  console.log(`   quote   ${usd(q.inputUsd)} -> ${q.outputAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })} tokens  fill $${q.fillPrice.toPrecision(6)}` +
    (worse === null ? "" : `  ${worse >= 0 ? "+" : ""}${worse.toFixed(2)}% vs theirs`));
  console.log(`   ourMcap ${usd(q.impliedMarketCapUsd)}  <- tier reference`);

  // Concentration is judged against OUR fill's market cap — the same reference the tier uses,
  // and the one that says how young the token really is by the time we would be buying it.
  // THE CEILING, CHECKED AGAINST OUR OWN FILL, BEFORE ANY MONEY MOVES.
  //
  // `planEntry` already screens on their fill and on a fresh lookup, but the binding number is
  // the market cap OUR quote implies — `tierSelection` is "atOwnFill" — and that can land above
  // the ceiling when theirs did not. `openPosition` returns null in that case, which is correct,
  // but it runs AFTER `attemptEntry` has spent the money: on 2026-09-05 the bot bought $33.02 of
  // NUKE at an implied $7,078,218 against a $7,000,000 ceiling, aborted, recorded nothing, and
  // left the tokens unmanaged for three hours until they were sold by hand at -$5.76.
  //
  // Narrowing the ceiling from $10M to $7M is what made this reachable — the same fill passed
  // comfortably before. The ordering was always wrong; the change merely found it.
  if (tierFor(q.impliedMarketCapUsd) === null) {
    console.log(`   ACTION  abort — our fill implies ${usd(q.impliedMarketCapUsd)}, above the ceiling (theirs was ${usd(plan.signalMarketCapUsd)})`);
    return;
  }

  const bigCode = bytecodeBlocks(codeBytes);
  if (bigCode) {
    console.log(`   ACTION  abort — ${bigCode}`);
    alert(`BYTECODE REJECT ${s.token} — ${bigCode}`);
    return;
  }

  // Ahead of concentration because it is the cheaper certainty: a 99% sell tax is not a risk
  // profile to weigh, it is a token that cannot be exited.
  const taxed = sellTaxBlocks(risk);
  if (taxed) {
    console.log(`   ACTION  abort — ${taxed}`);
    alert(`SELL TAX REJECT ${s.token} — ${taxed}`);
    return;
  }

  // Same reasoning as the sell-tax gate and placed beside it: this is not a risk to weigh but
  // a token whose exit may not exist. Free — is_open_source rides the response already fetched.
  const unreadable = closedSourceBlocks(risk);
  if (unreadable) {
    console.log(`   ACTION  abort — ${unreadable}`);
    alert(`CLOSED SOURCE REJECT ${s.token} — ${unreadable}`);
    return;
  }

  const blocked = concentrationBlocks(risk, q.impliedMarketCapUsd);
  if (blocked) {
    console.log(`   ACTION  abort — ${blocked}`);
    alert(`CONCENTRATION REJECT ${s.token} — ${blocked}`);
    return;
  }

  const slip = entrySlippageCap(q.impliedMarketCapUsd, plan.signalMarketCapUsd);
  if (worse !== null && worse > slip.pct) {
    console.log(`   ACTION  abort — ${worse.toFixed(2)}% above their fill exceeds max ${slip.pct}% (${slip.rule})`);
    return;
  }
  if (worse !== null && worse > maxSlippagePctFor(q.impliedMarketCapUsd)) {
    console.log(`   slip    ${worse.toFixed(2)}% allowed by the low-mcap override (${slip.rule}), band alone would have refused it`);
  }
  // ─── money leaves here ────────────────────────────────────────────────────────────────
  // Everything above is read-only — quotes, gates, sizing. Shadows never reach this: they
  // exist to measure policy, and a shadow that spent would be measuring something else.
  let fillPrice = q.fillPrice, costUsd = q.inputUsd, tokensOut = q.outputAmount;
  let entryTxHash: string | undefined, entryOrderId: string | undefined, partialFill = false;
  let entryGasUsd: number | undefined;

  if (!shadow && liveTrading()) {
    const input = inputAsset(s.chain);
    const amountRaw = await inputAmountRaw(s.chain, positionUsd);
    if (!input || !amountRaw) {
      console.log(`   ACTION  abort — no swap input asset configured for ${s.chain}`);
      return;
    }
    // The tolerance the QUOTE was priced with, not slipCap — slipCap is the entry gate ("how
    // much worse than their fill may our quote be"), a different question. Tight here is
    // right: a reverted buy costs one missed signal, whereas overpaying is money gone. The
    // sell side is deliberately loose for the opposite reason — see manage().
    // s.tokenDecimals matters: the floor is built in RAW units, and an 18-decimal default on
    // a 6-decimal token would ask for 10^12 times too much and revert every buy.
    // Hand the quote's OWN transaction down rather than letting executeSwap re-quote. The
    // gates approved a specific price; broadcasting a different one, taken 2.3s later, is how
    // an entry that passed every check refused itself on 2026-09-08. Stale quotes are dropped
    // inside executeSwap, so the retry below re-prices rather than replaying an old fill.
    const prebuilt = swapTxFromQuote(q);
    const attempt = (reuse: boolean) => attemptEntry(s.chain, input.address, s.token, amountRaw,
      config.entry.swapSlippageTolerancePct, q.outputAmount, s.tokenDecimals,
      reuse && prebuilt ? { tx: prebuilt, at: quotedAt } : undefined);

    let out = await attempt(true);
    // Retry ONLY on no-fill, which is claimed only when both chain checks agree nothing
    // landed. Every ambiguous outcome is "error" and is left alone: doubling a position that
    // already exists, with nothing recording the first half, is worse than missing the trade.
    if (out.kind === "no-fill") {
      console.log(`   entry   no fill (${out.reason}) — one retry`);
      out = await attempt(false);
    }
    if (out.kind === "no-fill" || out.kind === "error") {
      console.log(`   ACTION  abort — entry ${out.kind}: ${out.reason}`);
      alert(`ENTRY ${out.kind.toUpperCase()} ${s.token} — ${out.reason}`);
      return;
    }

    // Settled amounts, never the quote's. The quote is what we asked for; these are what the
    // chain gave us, and the position must be built from the latter or every downstream
    // number describes a trade that did not happen.
    const r = out.result;
    tokensOut = r.outputAmount ?? r.balanceDelta ?? q.outputAmount;
    // r.inputUsd, never r.inputAmount: the input is native ETH now, so the raw amount is a
    // quantity of ETH and recording it as dollars understates a $5 entry as $0.002.
    costUsd = r.inputUsd ?? q.inputUsd;
    fillPrice = tokensOut > 0 ? costUsd / tokensOut : q.fillPrice;
    entryTxHash = r.hash;
    entryOrderId = r.orderId;
    entryGasUsd = r.gasUsd;
    recordGas(r.gasUsd);          // measured, feeds the gas-tank average
    partialFill = out.kind === "partial";

    if (out.kind === "partial") {
      console.log(`   entry   PARTIAL — asked ${out.expected.toLocaleString("en-US", { maximumFractionDigits: 2 })}, got ${out.got.toLocaleString("en-US", { maximumFractionDigits: 2 })} tokens; keeping and managing it normally`);
      alert(`PARTIAL FILL ${s.token} ${out.got.toFixed(2)}/${out.expected.toFixed(2)} tokens`);
    }
    console.log(`   entry   filled ${tokensOut.toLocaleString("en-US", { maximumFractionDigits: 2 })} tokens @ $${fillPrice.toPrecision(6)} for ${usd(costUsd)}  tx ${entryTxHash?.slice(0, 12) ?? "?"}…`);
  }

  // Breakeven is computed from LIVE gas, not the config constant — at $0.525 vs a real
  // $0.97-$2.72 it understated what every trade has to earn, and the take-profit floor and
  // the breakeven stop both inherit that number.
  const gasNow = await gasUsdPerSwap(s.chain).catch(() => undefined);
  const pos = openPosition(s, fillPrice, costUsd, tokensOut, q.impliedMarketCapUsd, shadow, gasNow);
  if (!pos) { console.log(`   ACTION  abort — our mcap ${usd(q.impliedMarketCapUsd)} is above the ceiling`); return; }
  if (entryTxHash) pos.entryTxHash = entryTxHash;
  if (entryOrderId) pos.entryOrderId = entryOrderId;
  if (partialFill) pos.partialFill = true;
  if (entryGasUsd !== undefined) pos.entryGasUsd = entryGasUsd;
  pos.quotedAmount = q.outputAmount;

  console.log(`   ACTION  ${shadow ? "SHADOW" : liveTrading() ? "ENTERED (REAL)" : "PAPER ENTRY"} ${pos.id}   tier +${pos.takeProfitPct}%  stop -${pos.stopLossPct}%  breakeven $${pos.breakevenPrice.toPrecision(6)}`);
  alert(`${shadow ? "SHADOW" : "ENTRY"} ${pos.id} ${pos.token} ${usd(pos.costUsd)} tier +${pos.takeProfitPct}%`);

  // Price the token from its own trades, seeded with our fill so the outlier gate is armed
  // from the first sample rather than after a warm-up.
  await feed?.watch(pos.chain, pos.token, pos.entryPrice,
    pos.entryPrice * (1 - pos.stopLossPct / 100));
  recorder.start(pos);

  // Exit runs concurrently; the detector keeps listening for other signals throughout.
  // One cutoff drawn per ENTRY, shared by both arms, so the A/B differs only in the policy.
  const sharedCutoff = cutoffFor();
  manage(pos, undefined, 0, sharedCutoff);

  // A/B: the same entry, run again with a 60s minimum hold before any profit-taking. Costs
  // no capital and no slot; it exists so the two exit policies can be compared on identical
  // trades rather than on different nights against different markets.
  const ab = config.exit.abMinHoldSeconds;
  if (ab && !shadow) {
    const twin: Position = { ...pos, id: `${pos.id}-mh${ab}`, shadow: true, variant: `minhold${ab}` };
    positionsPush(twin);
    console.log(`           A/B twin ${twin.id} (min hold ${ab}s)`);
    manage(twin, undefined, ab, sharedCutoff);

    // CONTROL arm: identical policy to the live position. Its only job is to measure how far
    // two runs of the SAME rules drift apart, because the arms poll independently and prices
    // here move ~10 points in a second. Without this the experiment cannot tell a real effect
    // from timing noise — an early pair showed +5.52 points where neither arm's minimum hold
    // had even engaged.
    if (config.exit.abControlArm) {
      const ctrl: Position = { ...pos, id: `${pos.id}-ctl`, shadow: true, variant: "control" };
      positionsPush(ctrl);
      manage(ctrl, undefined, 0, sharedCutoff);
    }
  }
}

/**
 * Runs a position's exit to completion and books the result. Shared by fresh entries and by
 * positions resumed after a restart, so a recovered position closes on exactly the same path
 * as a new one.
 */
function manage(pos: Position, startedAtMs?: number, minHoldSeconds = 0, cutoffSeconds?: number): void {
  /**
   * Real sales, for real positions only. A shadow selling would spend money to measure a
   * counterfactual, and a paper position has nothing to sell.
   *
   * The proceeds reported back are the SETTLED input amount — what the wallet actually
   * received — not tokens multiplied by a price. That is the whole reason the live path
   * exists: `exit.ts` cannot mis-book a fill it never computed.
   */
  // `!pos.paper` is not redundant with liveTrading(): a position OPENED in paper can be
  // resumed after the mode is switched, and selling it for real would dump tokens the wallet
  // has never held. The position's own provenance decides, not the process's current mode.
  const sellFn = (!pos.shadow && !pos.paper && liveTrading())
    ? async (tokens: number, reason: string, atPrice: number, noFloor?: boolean) => {
        const input = inputAsset(pos.chain);
        if (!input) return { ok: false as const, error: `no input asset for ${pos.chain}` };
        // Exact conversion, then CLAMPED to what the wallet actually holds. Floating point
        // cannot represent an 18-decimal amount, so the old arithmetic could ask for more
        // than we own and revert; and our own bookkeeping can drift from the chain after a
        // partial fill. The chain's integer is the only number that is certainly sellable.
        const want = toRawUnits(tokens, pos.tokenDecimals);
        const held = await tokenBalanceRaw(pos.chain, pos.token).catch(() => null);
        if (held !== null && held <= 0n) return { ok: false as const, error: "wallet holds none of this token" };
        const raw = (held !== null && held < want ? held : want).toString();
        // A take-profit gets an ABSOLUTE floor; a stop and a cutoff get none.
        //
        // The earlier attempt expressed the floor as a slippage PERCENTAGE, which does not
        // work: gmgn measures --slippage against its own quote at submission, not against the
        // price we decided at. A take-profit "bounded to breakeven" at 23.7% settled 46% below
        // its trigger and booked -29.66%, because by submission time the base had already
        // fallen. --min-output is measured against nothing — it is the number of tokens we
        // refuse to go below — so it is the only form that actually holds.
        //
        // The floor is what it costs to get out whole: the money spent, plus BOTH legs of gas
        // at the CURRENT gas price. Not the config constant, which read $0.525 while real
        // swaps cost $2.72 — robinhood chain fee revenue went from $56k/day to $3.75M in
        // eleven days as memecoin traders flooded it, so a fixed number is the wrong shape.
        //
        // STOPS AND CUTOFFS GET NO FLOOR. Both exist to force an exit, a stop is a loss by
        // definition, and refusing to sell a falling position is the expensive failure.
        const loose = maxSlippagePctFor(pos.entryMarketCapUsd);
        const mustExit = reason === "stop_loss" || reason === "breakeven_stop" || reason === "time_cutoff";
        let minOutputRaw: string | undefined;
        if (!mustExit && !noFloor) {
          const gasBoth = (await gasUsdPerSwap(pos.chain)) * 2;
          const floorUsd = pos.costUsd + gasBoth;
          /**
           * The floor is in DOLLARS and the payout is in NATIVE ETH. It must be converted.
           *
           * v1.0 sold into USDG, where one unit is one dollar, so the dollar figure could be
           * raw-encoded directly. v2.0 sells into ETH, and encoding $35.35 as 35.35e18 asks
           * for 35 ETH — about 2,500x the real floor. Every take-profit was then refused:
           *
           *   0x quotes 16390551245270580 but the floor is 35348438956350044293
           *
           * On 2026-09-09 that held a position through a +32.7% peak, refused eleven sells
           * while the token was worth $41 against a $35 cost, and closed it as stuck.
           *
           * With no price the floor cannot be expressed at all. It is dropped rather than
           * guessed — 0x's own slippage bound still applies, and an unprotected take-profit
           * at the market beats another stuck position.
           */
          const px = await nativeUsd(pos.chain);
          if (px === null || px <= 0) {
            console.log(`   [${pos.id}] sell floor SKIPPED — no native price to convert $${floorUsd.toFixed(2)} into ETH`);
          } else {
            const floorNative = floorUsd / px;
            minOutputRaw = toRawUnits(floorNative, input.decimals).toString();
            console.log(`   [${pos.id}] sell floor $${floorUsd.toFixed(2)} = ${floorNative.toFixed(8)} ${input.symbol} (cost ${usd(pos.costUsd)} + ${usd(gasBoth)} gas) — cannot settle below it`);
          }
        } else {
          console.log(`   [${pos.id}] sell ${reason}: no floor, slippage ${loose}% (${mustExit ? "must exit" : "floor dropped after repeated refusals"})`);
        }
        const slip = loose;
        const r = await executeSwap(pos.chain, pos.token, input.address, raw, slip, 90_000, minOutputRaw);
        if (!r.ok) {
          // GAS-BLOCKED is checked FIRST and returns before the rug-check quote below.
          // gmgn refuses these at the API with GEvmInsufficientFundsForGas — nothing is
          // submitted, no gas is burned, and liquidity is not the problem, so asking for a
          // sell quote would only spend rate limit on a question we already know the answer
          // to. Twelve attempts each firing that quote is how one blocked exit turned into
          // ~24 gmgn calls on 2026-09-04.
          const errText = String(r.error ?? "");
          if (/InsufficientFundsForGas|insufficient funds for gas|40002351/i.test(errText)) {
            return { ok: false as const, error: errText, gasBlocked: true as const };
          }
          // A failed sell has two very different causes and they need opposite responses.
          // Transient (rate limit, timeout, a passing revert): retry, it will come good.
          // RUGGED (liquidity pulled): retrying is pointless and the position is a total loss
          // — PNS500 reverted, then took eleven more attempts to admit defeat while gmgn's UI
          // still showed a $68k pool. One quote tells them apart in seconds.
          const worth = await sellQuoteUsd(pos.chain, pos.token, raw, pos.tokenDecimals).catch(() => null);
          if (worth !== null && worth < pos.costUsd * 0.1) {
            const line = `RUGGED ${pos.id} ${pos.token} — ${tokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens quote at only ${usd(worth)} against ${usd(pos.costUsd)} cost. Liquidity is gone; not retrying.`;
            console.log(`   [${pos.id}] *** ${line}`);
            alert(line);
            return { ok: false as const, error: `rugged: sells for ${usd(worth)} of ${usd(pos.costUsd)}`, terminal: true as const };
          }
          if (worth !== null) console.log(`   [${pos.id}] sell failed but the token still quotes at ${usd(worth)} — treating as transient`);
          // Carry the hash when the transaction reached the network: the sale may have
          // settled despite this failure, and exit.ts confirms it rather than writing
          // the position off. See saleFromTx() in reconcile.ts.
          return { ok: false as const, error: r.error ?? `status ${r.status}`,
                   hash: r.hash, broadcast: r.broadcast };
        }
        // r.outputUsd, never r.outputAmount: a sell pays out in native ETH, so the raw amount
        // is a quantity of ETH. Undefined means the price was unreadable, which must not be
        // silently recorded as proceeds of zero.
        const gross = r.outputUsd;
        if (gross === undefined) return { ok: false as const, error: "settled but the native price was unreadable — RECONCILE" };
        if (gross <= 0) return { ok: false as const, error: "settled with no proceeds" };
        // Gas is deducted HERE and nowhere else. It is paid in native currency, so it never
        // touches the settled output amount — but the platform and DEX fees already have, so
        // running the paper `net()` over this would charge those a second time.
        const gas = r.gasUsd ?? (config.exit.breakevenStop.gasUsdPerSwap ?? 0);
        recordGas(r.gasUsd);
        const proceeds = Math.max(0, gross - gas);
        alert(`SOLD ${pos.id} ${reason} ${(r.inputAmount ?? tokens).toFixed(2)} tokens -> ${usd(gross)} less ${usd(gas)} gas${r.gasUsd === undefined ? " (estimated)" : ""}`);
        return { ok: true as const, tokens: r.inputAmount ?? tokens, proceedsUsd: proceeds };
      }
    : undefined;

  /**
   * Can the wallet afford to SUBMIT a swap right now? Alchemy only, ~30 CU a call.
   *
   * Deliberately compares against the same reserve gmgn enforces rather than what a swap
   * costs — the two differ by roughly 10x and it was the gap between them that stranded a
   * position. Errs toward TRUE on a read failure: a missed retry is cheaper than a position
   * that stops trying to exit because a chain read hiccuped.
   */
  const gasReady = (!pos.shadow && !pos.paper && liveTrading())
    ? async (): Promise<boolean> => {
        try {
          const px = await nativeUsd(pos.chain);
          if (px === null) return true;
          const [bal, reserve] = await Promise.all([
            tokenBalance(pos.chain, NATIVE_TOKEN),
            reserveUsdPerSwap(pos.chain, px),
          ]);
          if (bal === null || reserve === null) return true;
          return bal * px >= reserve;
        } catch { return true; }
      }
    : undefined;

  void exits.run(pos, (m) => console.log(`   [${pos.id}] ${m}`), undefined, startedAtMs,
    (price, tx) => recorder.note(pos.id, price, pos.entryPrice, tx), minHoldSeconds, cutoffSeconds,
    sellFn, gasReady).then((r) => {
    // Keep recording past the close: the tail is how we tell whether the cutoff left money
    // on the table, which is the whole point of having the paths.
    setTimeout(() => { recorder.stop(pos.id); feed?.unwatch(pos.chain, pos.token); }, TAIL_MS);
    closePosition(pos.id, r.reason === "stuck" ? "stuck" : "closed");
    const rec = record(pos, r);
    const sign = rec.realizedPnlUsd >= 0 ? "+" : "";
    console.log(`\n[${t()}] ${pos.shadow ? "SHADOW CLOSED" : "CLOSED"} ${pos.id}  ${r.reason}  ${sign}${usd(rec.realizedPnlUsd)} (${sign}${rec.realizedPnlPct.toFixed(2)}%)  peak ${r.peakPct.toFixed(1)}%  trough ${r.troughPct.toFixed(1)}%  held ${rec.heldSec}s`);
    alert(`${pos.shadow ? "SHADOW CLOSED" : "CLOSED"} ${pos.id} ${r.reason} ${sign}${rec.realizedPnlPct.toFixed(2)}%`);
    if (!pos.shadow) {
      const ts = allTrades();
      const wins = ts.filter((x) => x.realizedPnlUsd > 0).length;
      const net = ts.reduce((a, x) => a + x.realizedPnlUsd, 0);
      console.log(`           session: ${ts.length} trades, ${wins} up, net ${net >= 0 ? "+" : ""}${usd(net)}   spend: ${cuSummary()}`);

      liveTradesClosed += 1;
      if (STOP_AFTER !== null && liveTradesClosed >= STOP_AFTER) {
        // Stop only with the book FLAT. Exiting while another position is open would leave it
        // unmanaged with no stop and no cutoff watching it — the single worst state this
        // system can be left in, and worse than simply running one trade longer.
        const stillOpen = allPositions().filter((p) => p.status === "open" && !p.shadow).length;
        if (stillOpen > 0) {
          console.log(`[${t()}] stopAfterTrades reached but ${stillOpen} position(s) still open — running on until flat`);
        } else {
          console.log(`\n[${t()}] STOPPING — stopAfterTrades=${STOP_AFTER} reached and the book is flat.`);
          alert(`STOPPED after ${liveTradesClosed} live trade(s) — stopAfterTrades reached`);
          shutdown("stopAfterTrades");
        }
      }
    }
  }).catch((e: unknown) => {
    recorder.stop(pos.id);
    feed?.unwatch(pos.chain, pos.token);
    console.log(`   [${pos.id}] exit error: ${String(e)}`);
  });
}

/**
 * Adopt positions left open by a previous process.
 *
 * An exit loop only ever lived in memory, so a crash or a restart abandoned whatever was
 * open — one position sat unattended for 5,185 seconds against a 420-second cutoff. On
 * startup each still-open position is resumed on its ORIGINAL clock, which means anything
 * already past its cutoff sells immediately rather than being granted a fresh window.
 */
async function resumeOpenPositions(): Promise<void> {
  const stranded = allPositions().filter((p) => p.status === "open" && p.remainingAmount > 1e-9);
  if (!stranded.length) return;
  console.log(`\n[${t()}] resuming ${stranded.length} position${stranded.length === 1 ? "" : "s"} left open by a previous run`);
  for (const pos of stranded) {
    const age = Math.floor(Date.now() / 1000) - pos.openedAt;

    // Reconcile against the CHAIN before resuming. positions.json is what the bot believed
    // when it last wrote; the wallet is what is true. They diverge whenever a swap's
    // confirmation was lost — and in live mode a resumed position that is not actually held
    // would have the exit manager trying to sell tokens that are not there.
    // Paper positions hold nothing on-chain, so this only bites once dryRun is false.
    if (config.mode.dryRun === false && !pos.shadow) {
      const rec = await reconcilePosition(pos.chain, pos.token, pos.remainingAmount, pos.entryTxHash)
        .catch(() => null);
      if (rec && rec.verdict !== "matched") {
        console.log(`           ${pos.id}  RECONCILE ${rec.verdict.toUpperCase()} — ${rec.note}  [entry tx: ${rec.entry ?? "unknown"}]`);
        alert(`RECONCILE ${rec.verdict} ${pos.id} entry=${rec.entry ?? "unknown"} ${rec.note}`);
        if (rec.entry === "reverted") {
          // The entry never succeeded, yet a position was recorded. That is a bug in the entry
          // path, not a lost confirmation — say so loudly rather than quietly closing it.
          console.log(`           ${pos.id}  -> ENTRY REVERTED but a position was recorded — investigate`);
          alert(`ENTRY REVERTED ${pos.id} ${pos.entryTxHash ?? ""} — position recorded for a failed buy`);
          closePosition(pos.id, "stuck");
          continue;
        }
        if (rec.verdict === "missing" && rec.actual < pos.remainingAmount * 0.01) {
          // The wallet holds essentially none of it. With a successful entry receipt that means
          // the SELL landed and we lost its confirmation; with no receipt it means the buy never
          // happened. Same action, different story — and the log now records which.
          const why = rec.entry === "success" ? "the sell landed"
                    : rec.entry === "not-found" ? "the buy never landed"
                    : "cause unknown (no entry hash stored)";
          console.log(`           ${pos.id}  -> wallet is empty, ${why}`);
          closePosition(pos.id, "closed");
          continue;
        }
        if (rec.actual > 0 && rec.actual < pos.remainingAmount) {
          // A partial fill, or a sell that only got part of the way out. Manage what is real.
          console.log(`           ${pos.id}  -> resuming with the chain's ${rec.actual}, not ${pos.remainingAmount}`);
          pos.remainingAmount = rec.actual;
        }
      }
    }
    console.log(`           ${pos.id}  ${pos.sourceWalletName}  open ${age}s  ${age > config.exit.timeCutoffSeconds ? "(past cutoff — will close at once)" : "(still inside its window)"}`);
    alert(`RESUMED ${pos.id} after ${age}s`);
    await feed?.watch(pos.chain, pos.token, pos.entryPrice,
      pos.entryPrice * (1 - pos.stopLossPct / 100));
    recorder.start(pos);
    manage(pos, pos.openedAt * 1000);
  }
}

console.log(describe());
for (const chain of config.chains) {
  const f = fundsFor(chain);
  if (f) console.log(`funds    : ${chain} ${usd(f.balanceUsd)} - ${usd(f.gasReserveUsd)} gas = ${usd(f.tradableUsd)} tradable (${f.source})`);
}
console.log(`exit     : +tier ladder ${config.exit.ladder.sellPctOfRemainder}%/${config.exit.ladder.intervalSeconds}s, stop -${config.risk.stopLossPct}%, cutoff ${config.exit.timeCutoffSeconds}s ±${config.exit.timeCutoffJitterSeconds}s`);
setBudget(config.alchemy?.cuBudgetPerMonth ?? Infinity, config.alchemy?.alreadyUsedThisMonth ?? 0);
console.log(`budget   : ${(config.alchemy?.cuBudgetPerMonth ?? 0).toLocaleString()} CU/month, ${monthSpent().toLocaleString()} used, ${cuRemaining().toLocaleString()} left (persists across restarts)`);
{
  const cb = config.risk.circuitBreaker as { enabled?: boolean; maxLossPctOfBalance?: number; maxConsecutiveLosses?: number; maxPositionUsd?: number } | undefined;
  const anchor = dailyAnchor("robinhood", fundsFor("robinhood")?.balanceUsd ?? 0);
  const st = checkBreaker(anchor);
  console.log(`breaker  : ${cb?.enabled ? `halt at -${cb.maxLossPctOfBalance}% / ${cb.maxConsecutiveLosses} losses in a row, position cap ${usd(cb.maxPositionUsd ?? 0)}` : "off"}`
    + `  (today's anchor ${usd(anchor)})`
    + `${st.tripped ? "   *** TRIPPED: " + st.reasons.join("; ") + " ***" : ""}`);
}
console.log(`A/B      : ${config.exit.abMinHoldSeconds ? `every entry twinned with a ${config.exit.abMinHoldSeconds}s min-hold shadow` : "off"}`);
console.log(`prices   : ${feedEnabled ? "swap-derived (alchemy WSS) — HIGH CU COST" : "gmgn poll (alchemy live feed OFF)"}`);
console.log(`recorder : one row per trade, ${TAIL_MS / 60000} min tail after close`);
/**
 * Wallet balance sweep, on a timer and never on the entry path.
 *
 * Sizing reads whatever the last sweep left behind. Reading inline before each entry would
 * add an RPC round trip of 100-300ms to a path already spending ~2.4s between signal and
 * fill, to refine a number that moves by a few dollars — the wrong trade for a scalper.
 *
 * It runs in paper mode too. The figure does not size anything while dryRun is true, but it
 * keeps the reading exercised and the file warm, so the first live entry is not also the
 * first time this code has ever run.
 */
void refreshBalances(config.chains).then(() => {
  for (const line of describeBalances(config.chains)) console.log(`wallet   : ${line}`);
});
// Pay the first native-price lookup HERE, off the entry path. Deriving it from chain means
// skipping batched transactions, which measured anywhere from 840ms to 3,327ms on identical
// code seconds apart — a stall no signal should ever wait behind. After this the cache is
// always populated and `nativeUsd` serves it instantly, refreshing behind the caller.
warmNativeUsd(config.chains[0]!);
setInterval(() => {
  void refreshBalances(config.chains).then(() => {
    if (!liveTrading()) return;
    for (const c of config.chains) {
      if ((fundsFor(c)?.tradableUsd ?? 0) <= 0) continue;   // nothing to trade, nothing to warn about
      const g = gasState(c);
      if (!g?.warn) continue;
      const line = `GAS ${g.halt ? "CRITICAL" : "LOW"} ${c}: ~${g.swaps} swaps left`;
      console.log(`[${t()}] *** ${line}`);
      alert(line + (g.halt ? " — entries halted" : ""));
    }
    // Stop completely only once nothing is open. Killing the process with a live position
    // would abandon real tokens with nothing watching them — the same outcome as the stuck
    // position, reached deliberately instead of by accident. So: halt entries immediately
    // (in onSignal), and shut down at the first moment the book is actually flat.
    // Only chains that can actually TRADE count. bsc holds no capital and no gas, so it is
    // permanently "out of gas" — and on the first night it shut the whole runner down while
    // robinhood had 23 swaps in hand. A chain with nothing to spend cannot run out of the
    // means to spend it.
    const tradable = config.chains.filter((c) => (fundsFor(c)?.tradableUsd ?? 0) > 0);
    const halting = tradable.length > 0 && tradable.every((c) => gasState(c)?.halt);
    const openNow = allPositions().filter((p) => p.status === "open" && !p.shadow).length;
    if (halting && openNow === 0) {
      console.log(`\n[${t()}] STOPPING — out of gas and no open positions. Refill and restart.`);
      alert("STOPPED: out of gas, book is flat. Refill native token and restart.");
      cuPersist();
      process.exit(0);
    }
  }).catch(() => { /* a stale balance beats a dead runner */ });
}, REFRESH_MS).unref();

console.log(`\n[${t()}] running continuously — alerts to state/alerts.log, trades to state/trades.jsonl\n`);

await resumeOpenPositions();



detector = new Detector((s) => {
  // One bad signal must not end the run. The runner lost 36 minutes to an unhandled throw.
  void onSignal(s).catch((e: unknown) => {
    const msg = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
    console.log(`[${t()}] SIGNAL HANDLER ERROR — continuing\n${msg}`);
    alert(`SIGNAL HANDLER ERROR ${e instanceof Error ? e.message : String(e)}`);
  });
}, (m) => console.log(`[${t()}] ${m}`));
detector.start();
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(sig));
}

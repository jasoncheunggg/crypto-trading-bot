import { config } from "./config.ts";
import { PathRecorder } from "./pricepath.ts";
import type { SwapPriceFeed } from "./swapprice.ts";
import { verifyPrice } from "./verify.ts";
import type { Position } from "./positions.ts";
import { noteExcursion } from "./positions.ts";

/**
 * How often the position is evaluated. Prices arrive from the live feed as trades land, so
 * this is a cheap in-memory read, not a network call — it can be far tighter than the
 * ladder interval. The stop-loss is the reason: waiting a full ladder interval to notice a
 * collapse is the difference between exiting at the stop and exiting well below it.
 */
const TICK_MS = 200;

/** Windows searched when pricing a ladder slice. Deliberately small — see the call site. */
const LADDER_VERIFY_WINDOWS = 3;

/**
 * Pause after a REAL sale fails to settle before the loop tries again.
 *
 * Long enough not to hammer a failing endpoint, short enough that a stop still gets out
 * quickly. Failures are usually transient — a submit timeout, a rate limit — and the position
 * keeps its tokens throughout, so retrying is safe in a way that retrying a BUY is not.
 */
const SELL_RETRY_MS = 2_000;

/**
 * How many times a REAL sale may fail before the position is abandoned as `stuck`.
 *
 * Retrying forever looks safe — the tokens are still ours, so why stop? — but a sale that
 * REVERTS still pays gas. A rugged token whose sells always revert would burn ~$0.50 every
 * SELL_RETRY_MS, which empties a $23 gas reserve in about 90 seconds and then takes every
 * OTHER position's exit down with it, because none of them can pay for gas either. One
 * unsellable position must not become an account-wide failure.
 *
 * 12 attempts is ~25s of trying: long enough to ride out a rate limit or a reorg, short
 * enough that the reserve survives. `stuck` keeps the position on the books with its tokens
 * intact, so it can be unwound by hand.
 */
const SELL_ATTEMPT_LIMIT = 12;

/**
 * Pacing while a sell is blocked on gas.
 *
 * GAS_POLL_MS is how often the wallet is re-checked through Alchemy. 15s costs ~30 CU a look
 * (`eth_gasPrice` + `eth_getBalance`) — about 7k CU/hour, against a 15M budget — and gmgn is
 * not touched at all while blocked, so no rate limit can be reached however long this runs.
 *
 * GAS_WAIT_* is the fallback when no `gasReady` probe was supplied: exponential so that a
 * long block cannot turn into a steady stream of gmgn calls.
 */
const GAS_POLL_MS = 15_000;
const GAS_WAIT_MIN_MS = 15_000;
const GAS_WAIT_MAX_MS = 120_000;

/**
 * Feed-silence handling.
 *
 * FEED_SILENT_MS is how long the cheap feed may be quiet before the chain is consulted. A
 * couple of missed polls is ordinary; six seconds is not.
 *
 * CHAIN_FALLBACK_MS paces the chain lookups that follow. verifyPrice costs ~306-561 CU and
 * Alchemy caps throughput at 300 CU/s. Tripping Alchemy DURING a gmgn outage would leave the
 * bot blind on BOTH providers at once — the one outcome worse than the bug this fixes — and
 * the dashboard has already recorded a 407 CU/s spike once. Worst case by interval, at the
 * current 2 concurrent positions:
 *
 *     2s -> 561 CU/s  OVER CAP        5s -> 224 CU/s  (75% of cap)
 *     4s -> 281 CU/s  (94%, too tight) 6s -> 187 CU/s  (62%, chosen)
 *
 * 6s also survives a return to 3 concurrent positions (281 CU/s), where 5s would not (337).
 * Six-second granularity on a stop is a real cost, measured against the 452 seconds of
 * seeing nothing at all that motivated this. It also matters that this is a DIFFERENT provider from
 * the feed: the outage that motivated it took out gmgn entirely while Alchemy was untouched.
 *
 * FEED_ALARM_MS is when silence stops being a hiccup and becomes an unmanaged position.
 */
const FEED_SILENT_MS = 6_000;
const CHAIN_FALLBACK_MS = 6_000;
const FEED_ALARM_MS = 30_000;

export type ExitReason =
  | "stop_loss" | "breakeven_stop" | "take_profit_ladder" | "time_cutoff" | "stuck";

export interface Fill {
  at: number; price: number; tokens: number; usd: number;
  reason: ExitReason; sliceIndex: number; remainingAfter: number;
}

export interface ExitResult {
  positionId: string;
  fills: Fill[];
  closedAt: number;
  reason: ExitReason;
  proceedsUsd: number;
  costUsd: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  peakPct: number;
  troughPct: number;
  /** Share of the peak/trough observations that were chain-verified rather than feed-quoted. */
  excursionConfidence: number;
  /** Share of FILLS priced from the chain. The number that says how much to trust the P&L. */
  fillConfidence: number;
}

/**
 * Proceeds of one sell, after fees.
 *
 * The percentage fees are proportional to size, so slice count does not change their total.
 * GAS DOES: it is a flat cost per swap regardless of size, so an eight-slice ladder pays it
 * eight times. Measured at $0.525/swap on robinhood, that was 31% of a $15 position and was
 * absent from the model entirely — the recorded +14.67% over 117 trades became -2.66% once
 * it was applied. Every tier and ladder value tuned before this was optimised against a cost
 * structure that did not exist.
 */
function net(gross: number): number {
  const b = config.exit.breakevenStop;
  const afterPct = gross * (1 - (b.platformFeePctPerSwap + b.dexFeePctPerSwap) / 100);
  return Math.max(0, afterPct - (b.gasUsdPerSwap ?? 0));
}

/** Per-trade jitter so the bot does not exit at the same instant as everyone else. */
export function cutoffFor(): number {
  const j = config.exit.timeCutoffJitterSeconds ?? 0;
  return config.exit.timeCutoffSeconds + (j ? (Math.random() * 2 - 1) * j : 0);
}

/**
 * Runs a position to completion.
 *
 * Priority order matters: a single price update can gap through both the stop and the
 * take-profit on an illiquid token, and `exit.simultaneousTriggerWins` decides. Default
 * is stopLoss, because capital preservation outranks profit-taking.
 *
 * Selling is paced independently of price arrival: the ladder sells on a clock, so a burst
 * of trades cannot dump the position in seconds, and the cutoff is wall-clock, so a token
 * going quiet cannot strand a position that should have closed.
 */
export class ExitManager {
  private recorder: PathRecorder;

  constructor(feed: SwapPriceFeed | null = null) {
    this.recorder = new PathRecorder(3000, 20 * 60_000, feed);
  }

  /**
   * `startedAtMs` lets a resumed position keep its ORIGINAL clock. A restart that reset the
   * cutoff to zero would hand a position another full window it had already spent — the
   * opposite of the problem resuming is meant to solve.
   */
  async run(
    p: Position,
    onEvent: (msg: string) => void = () => {},
    priceFn?: (chain: string, token: string) => Promise<number | null>,
    startedAtMs?: number,
    onVerified?: (price: number, txHash: string) => void,
    minHoldSeconds = 0,
    /**
     * Fixed cutoff, overriding the per-run jitter. An A/B twin MUST inherit its parent's
     * cutoff: with independent draws the two sides get different deadlines, and on a trade
     * that exits on time rather than on target that difference IS the result. Observed once
     * as a 12.83-point gap between a pair where neither side ever took profit.
     */
    cutoffSeconds?: number,
    /**
     * Perform a REAL sale of `tokens` and report what actually settled. Absent for paper and
     * for shadows, where a fill is arithmetic on a price.
     *
     * Returning `ok: false` means the position still holds the tokens — the loop keeps them
     * on the books and tries again, rather than recording a sale that did not happen. That is
     * the one failure this must never get wrong: a position wrongly marked sold leaves real
     * tokens on chain with nothing watching them.
     */
    sellFn?: (tokens: number, reason: ExitReason, atPrice: number) =>
      Promise<{ ok: true; tokens: number; proceedsUsd: number }
        | { ok: false; error: string; terminal?: boolean; gasBlocked?: boolean }>,
    /**
     * Can the wallet currently afford to SUBMIT a swap? Alchemy only — balance and gas price.
     *
     * Consulted only while a sell is gas-blocked, so the retry loop waits on a cheap chain
     * read instead of asking gmgn again. Absent, gas-blocked retries fall back to plain
     * backoff.
     */
    gasReady?: () => Promise<boolean>,
  ): Promise<ExitResult> {
    const price = priceFn ?? ((c, t) => this.recorder.priceOf(c as never, t));
    const cutoff = cutoffSeconds ?? cutoffFor();
    const started = startedAtMs ?? Date.now();
    const intervalMs = config.exit.ladder.intervalSeconds * 1000;
    const tpPrice = p.entryPrice * (1 + p.takeProfitPct / 100);
    const stopPrice = p.entryPrice * (1 - p.stopLossPct / 100);

    let remaining = p.remainingAmount;
    let laddering = false;
    let slice = 0;
    let stopAt = stopPrice;
    const fills: Fill[] = [];
    // Seeded from the POSITION, not from nothing. A resumed position that reset these
    // reported an excursion it never had: -14.2% peak on a token that ran to +37.9%, because
    // the runner restarted mid-trade. The tier thresholds are fitted on this data.
    let peak = p.peakPct ?? -Infinity, trough = p.troughPct ?? Infinity;
    // Excursions are tracked from the raw feed because verification only happens at
    // crossings — but the feed is the thing that invents prices, so a peak drawn from it can
    // be fiction. Verified observations override the raw ones and are counted, so a consumer
    // can tell a measured excursion from a quoted one.
    let obs = 0, verifiedObs = 0;

    /**
     * Rolling plausibility reference.
     *
     * Bounding against the ENTRY price is too crude in both directions: it admitted a fill at
     * 2.46x entry on a position whose own peak was 1.59x (booked as +143%), and it never
     * covered the fallback path at all, which sold at 0.036x entry and booked -96%. Both were
     * fabrications. A median of recent accepted prices tracks a genuine move while still
     * refusing a jump no sequence of trades produced.
     */
    const recent: number[] = [p.entryPrice];
    const REF_WINDOW = 7;
    const BAND = 3;
    const reference = () => {
      const w = [...recent].sort((a, b) => a - b);
      return w[Math.floor(w.length / 2)]!;
    };
    const plausible = (px: number) => {
      const r = px / reference();
      return r <= BAND && r >= 1 / BAND;
    };
    const accept = (px: number) => {
      recent.push(px);
      if (recent.length > REF_WINDOW) recent.shift();
    };
    let implausible = 0;
    /**
     * Escape valve. A genuine collapse produces prices the reference calls implausible, and
     * refusing them all would deadlock the stop-loss — the position would ride to the cutoff
     * on a coin that had actually died. So a run of implausible prices that agree with EACH
     * OTHER is adopted: fabrications disagree wildly, a real move does not.
     */
    const ADOPT_AFTER = 3;
    let run: number[] = [];
    /** Fills priced from the chain vs total fills — recorded so P&L carries its own provenance. */
    let verifiedFills = 0, totalFills = 0;

    onEvent(`exit watch ${p.id}  tp $${tpPrice.toPrecision(6)} (+${p.takeProfitPct}%)  stop $${stopPrice.toPrecision(6)} (-${p.stopLossPct}%)  cutoff ${cutoff.toFixed(0)}s`);

    /**
     * A fill may not be priced above anything this position has actually seen.
     *
     * Booked a sell at 1.26x the position's own peak — +91.3% on a trade whose highest
     * observed point was +51.7% — because the ladder's fill lookup landed on a mispaired
     * transaction. The loop samples about every 1.4s, so a real spike leaves a mark; a price
     * that appears in the fill and nowhere else in the position's life is fiction, and a
     * price that genuinely existed only between two samples was never tradable anyway.
     *
     * ASYMMETRIC ON PURPOSE. The ceiling applies upward only. Across 10 recorded stops not
     * one filled below the observed trough — confirm() updates the trough with the very
     * price that trips the stop — so a downward guard would never fire on real data, and the
     * only thing that COULD trip it is a genuine fast crash, which is exactly when refusing
     * to sell is worst. LNKS fell 98% and stayed there; a guard that held through that would
     * have cost far more than the mispricing it prevented.
     *
     * 1.17x sits in the middle of an empty band. Over 338 recorded slices the highest
     * legitimate fill is 1.0933x and the lowest fabrication is 1.2614x, with nothing between:
     * every threshold from 1.10x to 1.25x rejects the same two fills. 1.17x was chosen over
     * 1.10x for headroom on the side that is actually well measured — 336 legitimate fills
     * define the lower edge, so 0.6% of clearance there is thin, whereas the upper edge rests
     * on n=2.
     *
     * The residual risk is a future mispairing landing between 1.17x and 1.26x, which this
     * would wave through. Costs are asymmetric against that — a wrongly REJECTED fill merely
     * falls back to the feed price, ~2.4% less accurate, while a missed fabrication books a
     * 26-55% error — so if legitimate fills keep topping out near 1.09x, tightening back
     * toward 1.10x is the better trade.
     */
    const EXCURSION_CEILING = 1.17;
    let excursionRejects = 0;

    /** Choose what a slice is booked at: the chain's price unless it is off the top of the map. */
    const fillPrice = (verified: number | null, quoted: number): { px: number; ok: boolean } => {
      if (verified === null) return { px: quoted, ok: false };
      if (peak > -Infinity) {
        const peakPrice = p.entryPrice * (1 + peak / 100);
        if (peakPrice > 0 && verified > peakPrice * EXCURSION_CEILING) {
          excursionRejects++;
          onEvent(`  fill REJECTED — chain said $${verified.toPrecision(6)}, ${(verified / peakPrice).toFixed(2)}x the observed peak of $${peakPrice.toPrecision(6)}; booking the feed's $${quoted.toPrecision(6)}`);
          return { px: quoted, ok: false };
        }
      }
      return { px: verified, ok: true };
    };

    /**
     * Book a sale. Returns false when a REAL sale was attempted and did not settle, in which
     * case nothing is recorded and the tokens stay on the books.
     *
     * With `sellFn` the price and size come from what actually settled, never from `px`. `px`
     * is the number that justified selling; it is not evidence of what the sale fetched, and
     * conflating the two is how a paper fill and a real one quietly stop describing the same
     * trade.
     */
    let sellFailures = 0;
    let sellTerminal = false;
    let gasBlocked = false;
    let gasAlarmed = false;
    let gasWaitMs = GAS_WAIT_MIN_MS;
    /** Feed-silence state: when a price was last obtained, and whether we have alarmed. */
    let lastPriceAt = Date.now();
    let nextChainPriceAt = 0;
    let feedAlarmed = false;
    let chainFallbacks = 0;
    const sell = async (px: number, tokens: number, reason: ExitReason): Promise<boolean> => {
      let soldTokens = tokens, usd = net(tokens * px), price = px;
      if (sellFn) {
        const r = await sellFn(tokens, reason, px);
        if (!r.ok) {
          // GAS-BLOCKED is not a failed attempt. gmgn REJECTS these before submitting
          // anything, so no transaction exists and no gas is burned — the entire reason
          // SELL_ATTEMPT_LIMIT exists does not apply. Counting them spent the budget in 25
          // seconds on 2026-09-04 and abandoned a sellable $32 position as `stuck` while the
          // only real problem was a wallet $18 short of the reserve.
          if (r.gasBlocked) {
            gasBlocked = true;
            if (!gasAlarmed) {
              gasAlarmed = true;
              onEvent(`  sell BLOCKED ON GAS (${reason}) — ${r.error}; holding ${tokens.toLocaleString("en-US", { maximumFractionDigits: 2 })} and waiting for the wallet to afford it. Not counted against the ${SELL_ATTEMPT_LIMIT}-attempt budget.`);
            }
            return false;
          }
          sellFailures++;
          // Terminal means there is nothing to sell into. Retrying a rug wastes the attempt
          // budget and delays the alert; the tokens are kept and the position marked stuck.
          if (r.terminal) { sellTerminal = true; }
          onEvent(`  sell FAILED (${reason}) — ${r.error}; still holding ${tokens.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
          return false;
        }
        soldTokens = r.tokens;
        usd = r.proceedsUsd;                       // already net of everything the chain took
        price = r.tokens > 0 ? r.proceedsUsd / r.tokens : px;
      }
      remaining -= soldTokens;
      fills.push({ at: Math.floor(Date.now() / 1000), price, tokens: soldTokens, usd, reason,
        sliceIndex: slice++, remainingAfter: remaining });
      onEvent(`  sell ${reason}  ${soldTokens.toLocaleString("en-US", { maximumFractionDigits: 2 })} @ $${price.toPrecision(6)} -> $${usd.toFixed(2)}  (${((price / p.entryPrice - 1) * 100).toFixed(2)}%)  left ${remaining.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
      return true;
    };

    /**
     * What to do after a sale did not go through. Returns true to abandon as `stuck`.
     *
     * Gas-blocked sells never give up and never consume the attempt budget: the tokens are
     * still ours, nothing was submitted, and the condition clears the moment the wallet is
     * funded or gas falls. While blocked this waits on `gasReady` — an Alchemy balance and
     * gas-price read — so a wallet that cannot pay makes ZERO gmgn calls instead of the ~24
     * that 12 attempts used to cost (each failure also fired a rug-check quote).
     */
    const afterFailedSell = async (): Promise<boolean> => {
      if (sellTerminal) return true;
      if (gasBlocked) {
        if (!gasReady) { await sleep(gasWaitMs); gasWaitMs = Math.min(gasWaitMs * 2, GAS_WAIT_MAX_MS); return false; }
        // Poll the PRECONDITION, not gmgn. Cheap enough to do often: ~30 CU a look.
        for (;;) {
          await sleep(GAS_POLL_MS);
          let ok = false;
          try { ok = await gasReady(); } catch { ok = false; }
          if (ok) break;
        }
        onEvent(`  gas is affordable again — retrying the sell`);
        gasBlocked = false; gasAlarmed = false; gasWaitMs = GAS_WAIT_MIN_MS;
        return false;
      }
      if (sellFailures >= SELL_ATTEMPT_LIMIT) return true;
      await sleep(SELL_RETRY_MS);
      return false;
    };

    let reason: ExitReason = "time_cutoff";
    let lastLadderAt = 0;
    let verifications = 0, rejected = 0;
    /**
     * Periodic chain-priced anchor while the position is open. The recorder samples ~1/s
     * from the cheap feed, which is enough RESOLUTION to replay any alternative sell
     * interval — but not enough TRUST: unverified spikes have inverted three replays
     * outright. An anchor every ANCHOR_SECONDS gives the path a spine of real prices to
     * check the quoted ones against, so "what if we sold every 8s instead of 2s" becomes
     * answerable rather than merely computable.
     */
    // Shadows are not anchored: their own fills are chain-priced already, and it is the real
    // position's path that gets replayed. Anchoring both would double the cost for nothing.
    const ANCHOR_SECONDS = p.shadow ? 0 : (config.exit.pathRecorder?.verifyEverySeconds ?? 0);
    let nextAnchor = ANCHOR_SECONDS ? Date.now() + ANCHOR_SECONDS * 1000 : Infinity;

    /**
     * A crossing claimed by the cheap feed is checked against the chain before we act.
     * GMGN was observed alternating between two prices 1.61x apart on one token, and the
     * exit sold on the wrong one. Verification is the difference between reacting to the
     * market and reacting to a bad quote.
     *
     * Returns the price to act on, or null to ignore this tick.
     *
     * A verification that cannot be completed does NOT license the claim: one failed
     * lookup would otherwise let through the very price we are guarding against. Only
     * after UNVERIFIABLE_LIMIT consecutive failures — Alchemy down, or the budget gone —
     * is the unverified claim honoured, loudly, because refusing forever would mean
     * holding through a real crash.
     */
    const UNVERIFIABLE_LIMIT = 3;
    const REJECT_COOLDOWN_MS = 400;
    let consecutiveFailures = 0;
    let nextVerifyAt = 0;
    /** Backing of the most recent verification, so a caller can see a single-sourced price. */
    let lastSamples = 0;

    /**
     * A stop that gaps down implausibly far, or rests on one unchecked transaction, waits for
     * ONE more reading before selling.
     *
     * The take-profit side is guarded by comparing a fill against the peak, but that cannot
     * work here: both the polled price and the verified price update `trough` BEFORE the sell,
     * so checking a stop fill against the trough compares the number with itself and can never
     * fire. (The upside works only because the ladder's fill is a SECOND, separate lookup that
     * never feeds back into `peak`.) The only thing that separates a mispriced drop from a real
     * one is TIME — a fabrication is gone on the next reading, a crash is still there.
     *
     * GAP_RATIO 0.70 comes from the 11 recorded stops: every one filled between 0.770x and
     * 1.001x of the median of the 7 readings before it. At 0.70x none of them would have been
     * delayed — including LNKS, which filled at 1.001x because the feed had already been
     * showing the crashed price for minutes. A real collapse does not look like a gap; it
     * looks like a level.
     *
     * SINGLE_SAMPLE_RATIO 0.85 covers the other hole: a verified price backed by ONE
     * transaction, which is where the mispairings live. About half of lookups return fewer
     * than 3 samples, so this is deliberately kept inside the normal stop range and only
     * engages on the steeper 2 of 11.
     *
     * Waiting is close to free: measured across 10 stops, the price 1.4s after the fill was
     * a median +1.72% and a mean +0.14% — slightly BETTER than selling immediately — and 2 of
     * the 10 had bounced more than 5%.
     *
     * The wait is for a CHANGED price, not for a fixed duration. Asking the feed again sooner
     * does not help: gmgn's backend only refreshes every ~0.9-2.1s (8 calls at 430ms apart
     * returned 3 distinct prices), so a faster read hands back a COPY of the suspect number —
     * and a copy agreeing with itself would read as confirmation, which is worse than not
     * checking. Watching for the value to move costs nothing, since the loop already polls,
     * and it releases as soon as there is genuinely something new rather than on a timer.
     */
    const GAP_RATIO = 0.70;
    const SINGLE_SAMPLE_RATIO = 0.85;
    /** Ceiling on the wait, for a feed that has frozen rather than merely gone quiet. */
    const STOP_RECHECK_CAP_MS = 2_500;
    let stopDeferredUntil = 0;
    let stopDeferredPrice: number | null = null;
    let stopDeferredOnce = false;
    let stopsDeferred = 0;

    const confirm = async (claimed: number, kind: "stop" | "target"): Promise<number | null> => {
      if (Date.now() < nextVerifyAt) return null;      // recently rejected; bounds CU spend
      verifications++;
      const v = await verifyPrice(p.chain, p.token, undefined, reference());
      if (!v) {
        consecutiveFailures++;
        if (consecutiveFailures >= UNVERIFIABLE_LIMIT) {
          onEvent(`  ${kind} UNVERIFIED after ${consecutiveFailures} failed lookups — acting on the feed's $${claimed.toPrecision(6)}`);
          return claimed;
        }
        onEvent(`  ${kind} unconfirmed (lookup ${consecutiveFailures}/${UNVERIFIABLE_LIMIT} failed) — holding`);
        nextVerifyAt = Date.now() + REJECT_COOLDOWN_MS;
        return null;
      }
      consecutiveFailures = 0;
      lastSamples = v.samples;
      onVerified?.(v.price, v.txHash);   // the recording should keep the price we believed
      accept(v.price);
      const vpct = (v.price / p.entryPrice - 1) * 100;
      peak = Math.max(peak, vpct); trough = Math.min(trough, vpct);
      noteExcursion(p.id, peak, trough);
      obs++; verifiedObs++;
      const stillCrossed = kind === "stop" ? v.price <= stopAt : v.price >= tpPrice;
      if (stillCrossed) {
        onEvent(`  ${kind} confirmed on chain @ $${v.price.toPrecision(6)} (claimed $${claimed.toPrecision(6)}, tx ${v.txHash.slice(0, 12)}…${v.ageBlocks ? `, ${v.ageBlocks} blocks stale` : ""})`);
        return v.price;
      }
      rejected++;
      nextVerifyAt = Date.now() + REJECT_COOLDOWN_MS;
      onEvent(`  ${kind} REJECTED — feed said $${claimed.toPrecision(6)}, chain says $${v.price.toPrecision(6)} (tx ${v.txHash.slice(0, 12)}…)`);
      return null;
    };

    while (remaining > 1e-9) {
      const elapsed = (Date.now() - started) / 1000;
      if (elapsed >= cutoff) {
        // Worth one lookup: this is the fill price for the whole remaining position.
        const v = await verifyPrice(p.chain, p.token, undefined, reference());
        if (v) verifications++;
        const quoted = (await price(p.chain, p.token)) ?? p.entryPrice;
        const chosen = fillPrice(v?.price ?? null, quoted);
        // Only a price we ACCEPT reaches the recording. Writing a rejected one was how a
        // fabricated 91% found its way into the path the tuner replays.
        if (chosen.ok && v) { verifiedFills++; onVerified?.(v.price, v.txHash); }
        totalFills++;
        if (!await sell(chosen.px, remaining, "time_cutoff")) {
          if (await afterFailedSell()) { reason = "stuck"; break; }
          continue;
        }
        reason = "time_cutoff"; break;
      }
      /**
       * The feed going quiet is an EMERGENCY, not a pause.
       *
       * This loop used to `continue` on a null price, which reads as "nothing to do". It is
       * not: with no price there is no stop check, no target check and no excursion tracking,
       * so the position is entirely unmanaged while looking perfectly healthy in the log. A
       * gmgn rate-limit ban did exactly that for 452 seconds — the token crossed its +55%
       * target at $290,534 mcap and the bot never saw a single price, because the highest it
       * ever observed was $212,697. It then could not sell either, and the position stuck.
       *
       * Alchemy was working throughout. `verifyPrice` reads prices from chain swaps on a
       * completely separate quota, and the bot simply never reached for it. So: when the cheap
       * feed goes silent, price from the chain instead — slowly, because it costs ~130-550 CU
       * a look against a 300 CU/s throughput cap, and only while the feed is actually down.
       * In normal operation this never runs.
       */
      let px = await price(p.chain, p.token);
      if (px !== null) { lastPriceAt = Date.now(); feedAlarmed = false; }
      else {
        const silentMs = Date.now() - lastPriceAt;
        if (silentMs >= FEED_SILENT_MS && Date.now() >= nextChainPriceAt) {
          nextChainPriceAt = Date.now() + CHAIN_FALLBACK_MS;
          const v = await verifyPrice(p.chain, p.token, undefined, reference());
          if (v) { px = v.price; chainFallbacks++; verifications++; lastPriceAt = Date.now(); }
        }
        if (px === null) {
          // Loud, once per outage. A blind position must never look like a quiet one.
          if (silentMs >= FEED_ALARM_MS && !feedAlarmed) {
            feedAlarmed = true;
            onEvent(`  *** NO PRICE for ${(silentMs / 1000).toFixed(0)}s — position is UNMANAGED (feed down, chain lookup also failing)`);
          }
          await sleep(TICK_MS); continue;
        }
      }
      if (!plausible(px)) {
        // Neither traded on nor recorded. A quoted price this far from everything else the
        // position has seen is the failure that booked a -96% stop on a coin that never moved.
        implausible++;
        run.push(px);
        const lo = Math.min(...run), hi = Math.max(...run);
        if (run.length >= ADOPT_AFTER && hi / lo <= 1.5) {
          onEvent(`  adopting moved price level $${px.toPrecision(6)} after ${run.length} consistent readings (was $${reference().toPrecision(6)})`);
          recent.length = 0;
          for (const r of run) recent.push(r);
          run = [];
        } else {
          if (implausible % 25 === 1) onEvent(`  ignoring implausible price $${px.toPrecision(6)} (reference $${reference().toPrecision(6)})`);
          await sleep(TICK_MS); continue;
        }
      } else {
        run = [];
      }
      // Captured BEFORE this tick's price joins the window: the question a stop has to answer
      // is "how far is this below where we were", and a reference that already contains the
      // suspect price cannot answer it.
      const refBefore = reference();
      accept(px);
      const pct = (px / p.entryPrice - 1) * 100;
      peak = Math.max(peak, pct); trough = Math.min(trough, pct);
      noteExcursion(p.id, peak, trough);
      obs++;

      if (Date.now() >= nextAnchor) {
        nextAnchor = Date.now() + ANCHOR_SECONDS * 1000;
        const a = await verifyPrice(p.chain, p.token, undefined, reference());
        if (a) {
          verifications++;
          onVerified?.(a.price, a.txHash);
          const apct = (a.price / p.entryPrice - 1) * 100;
          peak = Math.max(peak, apct); trough = Math.min(trough, apct);
          obs++; verifiedObs++;
        }
      }

      const hitStop = px <= stopAt;
      const hitTp = px >= tpPrice;

      // The stop condition cleared, so whatever we were double-checking is over. The next
      // distinct stop event gets its own single recheck.
      if (!hitStop) { stopDeferredOnce = false; stopDeferredUntil = 0; stopDeferredPrice = null; }

      // Both triggered in one update — config decides which wins.
      if (hitStop && (config.exit.simultaneousTriggerWins === "stopLoss" || !hitTp)) {
        // Serving out a recheck: hold until the feed actually moves off the number that
        // triggered it, or the cap expires. Re-reading a value the source has not refreshed
        // yet would confirm the suspect price with a copy of itself.
        if (stopDeferredPrice !== null && px === stopDeferredPrice && Date.now() < stopDeferredUntil) {
          await sleep(TICK_MS); continue;
        }
        const at = await confirm(px, "stop");
        if (at === null) { await sleep(TICK_MS); continue; }

        const gapped = refBefore > 0 && at < refBefore * GAP_RATIO;
        const thin = lastSamples <= 1 && refBefore > 0 && at < refBefore * SINGLE_SAMPLE_RATIO;
        // A price carried by the FULL quorum is never held. Three independent transactions
        // agreeing is not a fabrication — for the median of three to be wrong, three separate
        // mispairings would have to agree with each other, which is not the failure mode.
        // Holding one costs up to CHAIN_FALLBACK-scale seconds on a genuine collapse, and
        // overshoot is already the largest cost on the stop path: a live stop decided at
        // -25.24% settled at -34.51%, 9.3 points lost purely between deciding and settling.
        // Corroborated bad news should be acted on immediately.
        const corroborated = lastSamples >= 3;
        if (!stopDeferredOnce && !corroborated && (gapped || thin)) {
          // ONCE per stop event. A second deferral would be a way to never sell at all, which
          // on a real collapse is the expensive mistake.
          stopDeferredOnce = true;
          stopDeferredPrice = px;
          stopDeferredUntil = Date.now() + STOP_RECHECK_CAP_MS;
          stopsDeferred++;
          onEvent(`  stop HELD for one more reading — $${at.toPrecision(6)} is ${(at / refBefore).toFixed(2)}x the recent level${thin ? ` on a single sample` : ""}`);
          await sleep(TICK_MS); continue;
        }

        totalFills++; if (at !== px) verifiedFills++;
        const r: ExitReason = laddering ? "breakeven_stop" : "stop_loss";
        if (!await sell(at, remaining, r)) {
          if (await afterFailedSell()) { reason = "stuck"; break; }
          continue;
        }
        reason = r; break;
      }
      // A minimum hold delays PROFIT-TAKING only. The stop above is evaluated first and stays
      // live throughout, so this is "don't sell early into a move", not "hold and hope".
      if (elapsed < minHoldSeconds) { await sleep(TICK_MS); continue; }
      if (hitTp || laddering) {
        if (!laddering) {
          const at = await confirm(px, "target");
          if (at === null) { await sleep(TICK_MS); continue; }
          laddering = true;
          onEvent(`  take profit reached at ${((at / p.entryPrice - 1) * 100).toFixed(2)}%`);
        }
        // Slices are clock-paced; price updates arrive far faster than we want to sell.
        if (Date.now() - lastLadderAt < intervalMs) { await sleep(TICK_MS); continue; }

        // EVERY slice is priced from the chain, not just the first. The ladder sells 25% of
        // the REMAINDER, so the first slice is a quarter of the position and the rest is
        // three quarters — booking that at a quoted price put most of the recorded profit
        // on numbers the bot itself would not have trusted to sell on.
        // A TIGHT window here on purpose. The ladder is meant to sell on a clock; a lookup
        // that trawls 20 windows on a quiet token turned a 2s ladder into a 17-158s one,
        // varying with liquidity rather than with anything we chose. Three windows keeps the
        // slice on schedule, and a miss falls back to the feed price with the fill recorded
        // as unverified rather than silently stretching the interval.
        const vs = await verifyPrice(p.chain, p.token, LADDER_VERIFY_WINDOWS, reference());
        if (vs) verifications++;
        const chosen = fillPrice(vs?.price ?? null, px);
        if (chosen.ok && vs) { verifiedFills++; onVerified?.(vs.price, vs.txHash); }
        const fillPx = chosen.px;
        lastLadderAt = Date.now();
        totalFills++;

        const want = remaining * (config.exit.ladder.sellPctOfRemainder / 100);
        const floor = config.exit.ladder.minSliceUsd ?? 0;
        if (want * fillPx < floor) {
          // Below the floor the tail is mostly gas — dump the remainder in one go.
          if (!await sell(fillPx, remaining, "take_profit_ladder")) {
            if (await afterFailedSell()) { reason = "stuck"; break; }
            continue;
          }
          reason = "take_profit_ladder"; break;
        }
        if (!await sell(fillPx, want, "take_profit_ladder")) {
          if (await afterFailedSell()) { reason = "stuck"; break; }
          continue;
        }
        reason = "take_profit_ladder";
        if (config.exit.breakevenStop.enabled && config.exit.breakevenStop.afterFirstLadderSell) {
          // Raise the stop so the "let it run" remainder cannot turn into a loss.
          stopAt = Math.max(stopAt, p.breakevenPrice);
        }
      }
      await sleep(TICK_MS);
    }

    if (verifications) {
      const ex = excursionRejects ? `, ${excursionRejects} fill${excursionRejects === 1 ? "" : "s"} refused above peak` : "";
      const sd = stopsDeferred ? `, ${stopsDeferred} stop${stopsDeferred === 1 ? "" : "s"} rechecked` : "";
      const sf = sellFailures ? `, ${sellFailures} sell${sellFailures === 1 ? "" : "s"} retried` : "";
      const cf = chainFallbacks ? `, ${chainFallbacks} price${chainFallbacks === 1 ? "" : "s"} from chain (feed down)` : "";
      onEvent(`  ${verifications} chain verifications, ${rejected} bad crossing${rejected === 1 ? "" : "s"} rejected${ex}${sd}${sf}${cf}`);
    }
    const proceedsUsd = fills.reduce((s, f) => s + f.usd, 0);
    // The BUY's gas. Sell-side gas is already off: `net()` takes it for paper, and the live
    // sellFn deducts the receipt's actual figure. Prefer what the entry receipt really burned
    // over the configured estimate — measured $0.48 against a configured $0.525, and gas
    // varies with routing depth rather than being a constant.
    const entryGas = p.entryGasUsd ?? (config.exit.breakevenStop.gasUsdPerSwap ?? 0);
    return {
      positionId: p.id, fills, closedAt: Math.floor(Date.now() / 1000), reason,
      proceedsUsd, costUsd: p.costUsd,
      // The BUY's gas too — net() already took it off each sell. Without this the entry leg
      // of every trade is free, which is where a third of the real cost sits on a 1-slice exit.
      realizedPnlUsd: proceedsUsd - p.costUsd - entryGas,
      realizedPnlPct: ((proceedsUsd - entryGas) / p.costUsd - 1) * 100,
      peakPct: peak === -Infinity ? 0 : peak,
      troughPct: trough === Infinity ? 0 : trough,
      excursionConfidence: obs ? verifiedObs / obs : 0,
      fillConfidence: totalFills ? verifiedFills / totalFills : 0,
    };
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

import { config } from "./config.ts";
import { tokenFacts } from "./liquidity.ts";
import { roundTripProbe } from "./execution.ts";
import { sizePosition, type Sizing } from "./portfolio.ts";
import { countForToken, slotsInUse, secondsSinceLastEntry } from "./positions.ts";
import type { Signal } from "./types.ts";

export interface EntryPlan {
  act: boolean;
  rejections: string[];
  /**
   * True when the ONLY thing stopping this entry is that the token is already held.
   * Blocking a re-entry destroys the evidence for whether blocking it was right, so this
   * flag lets the runner shadow the trade instead of discarding it.
   */
  blockedByReentryOnly: boolean;
  sizing: Sizing | null;
  /** Market cap implied by the tracked wallet's own fill — logged, never the tier reference. */
  signalMarketCapUsd: number;
  /** Market cap from a lookup now. Reads AFTER their buy moved the price. */
  lookupMarketCapUsd: number | null;
  poolLiquidityUsd: number | null;
  /** Percent of a $-position that survives an immediate buy-then-sell-back, in quotes. */
  roundTripRetentionPct: number | null;
  takeProfitPct: number | null;
}

function tierFor(marketCapUsd: number): number | null {
  for (const t of config.exit.takeProfitTiers as { maxMarketCapUsd: number; takeProfitPct: number }[]) {
    if (marketCapUsd < t.maxMarketCapUsd) return t.takeProfitPct;
  }
  return null;
}

/**
 * Decide whether a signal becomes a position, and how large.
 *
 * Gates run cheapest-first so an obvious reject never pays for a network call.
 * Note the tier here is provisional: config.exit.tierSelection is "atOwnFill", so the
 * binding tier is recomputed from OUR fill once the buy confirms. This one is an estimate
 * for logging and for the ceiling check.
 */
export async function planEntry(signal: Signal): Promise<EntryPlan> {
  const rejections: string[] = [];

  if (signal.verdict !== "BUY") rejections.push(`not a buy (${signal.verdict})`);
  if (!signal.viaKnownRouter) {
    // Surface, do not merely drop. A missing router is invisible otherwise — the signal
    // simply never appears. FOMO's second contract (0x4337084d) hid this way and cost us
    // every trade through it, including a $47,161 sell.
    const flagAbove = config.detection?.classifier?.flagUnknownRouterAboveUsd ?? Infinity;
    if (signal.verdict === "BUY" && signal.sizeUsd >= flagAbove) {
      rejections.push(`UNKNOWN ROUTER — qualifying $${signal.sizeUsd.toFixed(2)} buy via ${signal.routerUsed ?? "?"} is NOT in knownRouters; check whether it is a new FOMO contract`);
    } else {
      rejections.push("not via a known FOMO router");
    }
  }
  if (signal.sizeUsd < config.entry.minTradeUsd) {
    rejections.push(`signal size $${signal.sizeUsd.toFixed(2)} < minTradeUsd $${config.entry.minTradeUsd}`);
  }

  // Concurrency, before any network call. Stuck positions deliberately do not occupy a slot:
  // with a small cap one unsellable token would otherwise halt the bot permanently.
  const cap = config.risk.maxConcurrentPositions;
  if (slotsInUse() >= cap) rejections.push(`at position cap (${slotsInUse()}/${cap})`);

  // A repeat buy on a token already held opens another position only where the platform
  // allows it, and only up to maxPositionsPerToken — otherwise one memecoin fills every slot.
  const re = config.entry.dedupe.tokenReentry;
  const held = countForToken(signal.chain, signal.token);
  const beforeReentry = rejections.length;
  if (held > 0) {
    if (!re.allowPerPlatform?.[signal.wallet.platform]) {
      rejections.push(`already holding ${signal.token} and reentry is off for ${signal.wallet.platform}`);
    } else if (held >= re.maxPositionsPerToken) {
      rejections.push(`already holding ${held}/${re.maxPositionsPerToken} positions in this token`);
    }
  }

  // COOLDOWN: no second buy of the same coin for a while after the first, whether or not the
  // first is still open. `countForToken` only sees OPEN positions, so without this a coin
  // could be re-bought seconds after it closed — and on 2026-09-04 the same token was signalled
  // three times inside four minutes by two different wallets. Chasing a name we have just
  // traded concentrates risk in one coin and pays the entry cost twice for one thesis.
  const cooldownMin = (re as { cooldownMinutes?: number }).cooldownMinutes ?? 0;
  if (cooldownMin > 0) {
    const since = secondsSinceLastEntry(signal.chain, signal.token);
    if (since !== null && since < cooldownMin * 60) {
      const left = Math.ceil((cooldownMin * 60 - since) / 60);
      rejections.push(`already holding cooldown — bought this token ${Math.floor(since / 60)}m ago, ${left}m of the ${cooldownMin}m cooldown left`);
    }
  }

  const blockedByReentryOnly = beforeReentry === 0 && rejections.length > 0
    && rejections.every((r) => r.startsWith("already holding"));

  const plan: EntryPlan = {
    blockedByReentryOnly,
    act: false, rejections, sizing: null,
    signalMarketCapUsd: signal.impliedMarketCapUsd,
    lookupMarketCapUsd: null, poolLiquidityUsd: null, takeProfitPct: null,
    roundTripRetentionPct: null,
  };
  // Cheap gates already failed — don't pay for token facts. A re-entry block is the one
  // exception: the runner shadows those to measure the counterfactual, and a shadow still
  // needs sizing. Returning early here left sizing null and crashed the runner on the first
  // blocked re-entry after shadowing was added.
  if (rejections.length && !blockedByReentryOnly) return plan;

  const facts = await tokenFacts(signal.chain, signal.token);
  if (!facts) {
    rejections.push("could not read pool liquidity / market cap");
    return plan;
  }
  plan.lookupMarketCapUsd = facts.marketCapUsd;
  plan.poolLiquidityUsd = facts.liquidityUsd;

  // Liquidity is a validity check, not a sizing input: zero-liquidity tokens carry
  // nominal marks in the millions and cannot be sold at any price.
  if (facts.liquidityUsd < config.entry.minPoolLiquidityUsd) {
    rejections.push(`pool liquidity $${facts.liquidityUsd.toFixed(2)} < floor $${config.entry.minPoolLiquidityUsd}`);
  }
  const mcForGate = signal.impliedMarketCapUsd || facts.marketCapUsd;
  if (mcForGate >= config.entry.marketCapCeilingUsd) {
    rejections.push(`market cap $${Math.round(mcForGate).toLocaleString("en-US")} >= ceiling`);
  }
  if (config.entry.marketCapFloorUsd != null && mcForGate < config.entry.marketCapFloorUsd) {
    rejections.push(`market cap below floor $${config.entry.marketCapFloorUsd}`);
  }
  plan.takeProfitPct = tierFor(mcForGate);

  const sizing = sizePosition(signal.chain, facts.liquidityUsd);
  plan.sizing = sizing;
  if (sizing.blocked) rejections.push(sizing.blocked);

  // ROUND-TRIP PROBE — the last gate, and the only one that asks whether we could get OUT.
  //
  // Quotes a buy at the size we actually intend, then quotes selling all of it straight back.
  // Measured across all 112 robinhood tokens ever traded (2026-09-08): median retention 96.11%,
  // 105 of 111 at or above 90%, and the three below 80% were 0.05%, 0.37% (the first rug) and
  // 2.97% (the honeypot). The worst legitimate token retained 85.68%, so the floor sits in a
  // wide empty gap rather than near any real distribution.
  //
  // This exists because neither provider's own honeypot flag survives contact with the data:
  // 0x reported sellTaxBps 0 on a token with a 99% sell tax, and gmgn's `is_honeypot` fired on
  // 9 of 55 tokens including the two best trades ever made — gating on it would have cost $76.58.
  //
  // Runs last so it is only paid for by signals that have passed everything else, and it is
  // skipped entirely when the position would not be taken anyway.
  const minRet = (config.entry as { minRoundTripRetentionPct?: number }).minRoundTripRetentionPct;
  if (minRet != null && rejections.length === 0 && sizing.positionUsd > 0) {
    const rt = await roundTripProbe(
      signal.chain, signal.token, sizing.positionUsd, signal.tokenDecimals,
    );
    if (!rt) {
      rejections.push("round-trip probe could not price this token");
    } else if (!rt.sellable) {
      // Buyable but not exitable is the worst state this system can enter, and one of the 112
      // tokens is in it today. Never a warning — always a refusal.
      rejections.push("NO SELL ROUTE — buyable but not exitable");
    } else {
      plan.roundTripRetentionPct = rt.retention * 100;
      if (rt.retention * 100 < minRet) {
        rejections.push(`round-trip retention ${(rt.retention * 100).toFixed(1)}% < floor ${minRet}%`);
      }
    }
  }

  plan.act = rejections.length === 0;
  return plan;
}

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.ts";

const STATE = resolve(import.meta.dirname, "..", "state");
const TRADES = resolve(STATE, "trades.jsonl");
const OVERRIDE = resolve(STATE, "breaker-override.json");

/**
 * Trading halt conditions.
 *
 * Computed from the trade ledger on every entry rather than held in memory, for the same
 * reason the CU budget is: this runner restarts often, and an in-memory counter would reset
 * the moment something went wrong — which is exactly when it matters. A breaker that forgets
 * is not a breaker.
 *
 * Everything here is a HALT ON ENTRY. Open positions are always allowed to exit; refusing to
 * sell would turn a bad day into an unbounded one.
 */

export interface BreakerState {
  tripped: boolean;
  reasons: string[];
  /** Rolling-window figures, for the log line. */
  windowHours: number;
  windowPnlPct: number;
  windowTrades: number;
  consecutiveLosses: number;
}

interface Trade { closedAt: number; realizedPnlUsd: number; costUsd: number; reason: string; paper?: boolean }

/**
 * Trades from the CURRENT mode only.
 *
 * One ledger holds both, and without this filter the first live session inherits the paper
 * history: a +71.8% paper window would have hidden a real losing run behind it, a real loss
 * would never have reached the limit, and the consecutive-loss count would have walked back
 * across trades that never happened. A breaker measuring the wrong ledger is worse than none,
 * because it reports a number that looks like supervision.
 *
 * Paper runs keep seeing only paper, so the breaker stays testable before it is ever needed.
 */
function readTrades(): Trade[] {
  if (!existsSync(TRADES)) return [];
  const wantPaper = config.mode.dryRun !== false;
  const out: Trade[] = [];
  for (const line of readFileSync(TRADES, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line) as Trade;
      if ((t.paper === true) === wantPaper) out.push(t);
    } catch { /* truncated tail */ }
  }
  return out.sort((a, b) => a.closedAt - b.closedAt);
}

/** A manual reset: writing this file clears the breaker until the next trip. */
function overriddenUntil(): number {
  try {
    if (!existsSync(OVERRIDE)) return 0;
    return (JSON.parse(readFileSync(OVERRIDE, "utf8")) as { until?: number }).until ?? 0;
  } catch { return 0; }
}

export function clearBreaker(hours = 24): void {
  writeFileSync(OVERRIDE, JSON.stringify({ until: Math.floor(Date.now() / 1000) + hours * 3600 }));
}

export function checkBreaker(startingBalanceUsd: number): BreakerState {
  const b = config.risk.circuitBreaker as {
    enabled?: boolean; windowHours?: number; maxLossPctOfBalance?: number;
    maxConsecutiveLosses?: number; maxTradesPerWindow?: number;
  } | undefined;
  const windowHours = b?.windowHours ?? 24;
  const state: BreakerState = {
    tripped: false, reasons: [], windowHours,
    windowPnlPct: 0, windowTrades: 0, consecutiveLosses: 0,
  };
  if (!b?.enabled) return state;

  const trades = readTrades();
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const win = trades.filter((t) => t.closedAt >= cutoff);
  const pnl = win.reduce((a, t) => a + t.realizedPnlUsd, 0);
  state.windowTrades = win.length;
  state.windowPnlPct = startingBalanceUsd > 0 ? (pnl / startingBalanceUsd) * 100 : 0;

  // Consecutive losses counted from the most recent trade backwards.
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i]!.realizedPnlUsd < 0) state.consecutiveLosses++;
    else break;
  }

  if (b.maxLossPctOfBalance != null && state.windowPnlPct <= -Math.abs(b.maxLossPctOfBalance)) {
    state.reasons.push(`down ${state.windowPnlPct.toFixed(1)}% in ${windowHours}h (limit ${b.maxLossPctOfBalance}%)`);
  }
  if (b.maxConsecutiveLosses != null && state.consecutiveLosses >= b.maxConsecutiveLosses) {
    state.reasons.push(`${state.consecutiveLosses} losses in a row (limit ${b.maxConsecutiveLosses})`);
  }
  if (b.maxTradesPerWindow != null && state.windowTrades >= b.maxTradesPerWindow) {
    state.reasons.push(`${state.windowTrades} trades in ${windowHours}h (limit ${b.maxTradesPerWindow})`);
  }

  if (state.reasons.length && overriddenUntil() > Math.floor(Date.now() / 1000)) {
    state.reasons.push("(manually overridden — not halting)");
    return state;
  }
  state.tripped = state.reasons.length > 0;
  return state;
}

/**
 * Hard ceiling on a single position, in dollars.
 *
 * Separate from the percentage sizing because it guards a different failure: sizing reads a
 * balance and multiplies. If the balance is ever wrong — a bad read, a compounding bug, a
 * decimals error — the percentage is still "15%" while the dollars are anything at all.
 */
export function capPositionUsd(want: number): { usd: number; capped: boolean } {
  const max = (config.risk.circuitBreaker as { maxPositionUsd?: number } | undefined)?.maxPositionUsd;
  if (max == null || want <= max) return { usd: want, capped: false };
  return { usd: max, capped: true };
}

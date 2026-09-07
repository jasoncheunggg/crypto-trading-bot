import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExitResult } from "./exit.ts";
import type { Position } from "./positions.ts";

const DIR = resolve(import.meta.dirname, "..", "state");
const FILE = resolve(DIR, "trades.jsonl");
/** Counterfactual re-entries, kept apart so they can never be mistaken for realised P&L. */
const SHADOW_FILE = resolve(DIR, "shadow-trades.jsonl");

export interface TradeRecord {
  closedAt: number; positionId: string; paper: boolean;
  chain: string; token: string;
  sourceWallet: string; sourceWalletName: string; signalTx: string;
  signalMarketCapUsd: number; entryMarketCapUsd: number;
  entryPrice: number; costUsd: number; tokenAmount: number;
  takeProfitPct: number; stopLossPct: number;
  reason: string; proceedsUsd: number; realizedPnlUsd: number; realizedPnlPct: number;
  peakPct: number; troughPct: number; excursionConfidence: number; fillConfidence: number; sells: number;
  /** Every slice: when, at what price, how much. Lets ladder behaviour be read rather than inferred. */
  fills: { at: number; price: number; tokens: number; usd: number; reason: string }[]; heldSec: number;
}

/**
 * A `stuck` position never sold, so it has no realised P&L — the tokens are still in the
 * wallet.
 *
 * Booking one as a loss equal to its whole cost is fiction, and expensive fiction: a stuck
 * $27.06 position was written down as -$27.88 (-103%) on a token the wallet still held and
 * which was worth roughly $23. That number then fed the circuit breaker, taking it to -13.4%
 * against a -15% halt on a loss that had not happened. A second stuck position would have
 * halted live trading on entirely imaginary losses.
 *
 * So a stuck trade records ZERO P&L and is flagged. The real result lands whenever the tokens
 * are actually sold — by a later run, or by hand.
 */
function stuckRecord<T extends { realizedPnlUsd: number; realizedPnlPct: number }>(r: T, isStuck: boolean): T {
  return isStuck ? { ...r, realizedPnlUsd: 0, realizedPnlPct: 0 } : r;
}

export function record(p: Position, r: ExitResult): TradeRecord {
  const stuck = r.reason === "stuck";
  const pnl = stuckRecord({ realizedPnlUsd: r.realizedPnlUsd, realizedPnlPct: r.realizedPnlPct }, stuck);
  const rec: TradeRecord = {
    closedAt: r.closedAt, positionId: p.id, paper: p.paper,
    chain: p.chain, token: p.token,
    // Stats key on the address, never the name, so renaming a wallet keeps its history.
    sourceWallet: p.sourceWallet, sourceWalletName: p.sourceWalletName, signalTx: p.signalTx,
    signalMarketCapUsd: p.signalMarketCapUsd, entryMarketCapUsd: p.entryMarketCapUsd,
    entryPrice: p.entryPrice, costUsd: p.costUsd, tokenAmount: p.tokenAmount,
    takeProfitPct: p.takeProfitPct, stopLossPct: p.stopLossPct,
    reason: r.reason, proceedsUsd: r.proceedsUsd,
    realizedPnlUsd: pnl.realizedPnlUsd, realizedPnlPct: pnl.realizedPnlPct,
    peakPct: r.peakPct, troughPct: r.troughPct, excursionConfidence: r.excursionConfidence, fillConfidence: r.fillConfidence,
    fills: r.fills.map((f) => ({ at: f.at, price: f.price, tokens: f.tokens, usd: f.usd, reason: f.reason })),
    sells: r.fills.length, heldSec: r.closedAt - p.openedAt,
  };
  mkdirSync(DIR, { recursive: true });
  // `unsold` carries the tokens still held, so the position can be found and closed out later.
  appendFileSync(p.shadow ? SHADOW_FILE : FILE, JSON.stringify({ ...rec, shadow: p.shadow === true,
    variant: p.variant ?? null, ...(stuck ? { unsold: p.remainingAmount, unsoldCostUsd: p.costUsd } : {}) }) + "\n");
  return rec;
}

export function all(): TradeRecord[] {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as TradeRecord);
}

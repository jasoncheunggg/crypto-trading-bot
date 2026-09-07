import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.ts";
import type { Chain, Signal } from "./types.ts";

const DIR = resolve(import.meta.dirname, "..", "state");
const FILE = resolve(DIR, "positions.json");

export interface Position {
  id: string;
  openedAt: number;
  chain: Chain;
  token: string;
  tokenDecimals: number;
  sourceWallet: string;          // address, not name — stats key on this so renames keep history
  sourceWalletName: string;
  signalTx: string;
  /** Market cap the tracked wallet's own fill implied — logged, never the tier reference. */
  signalMarketCapUsd: number;
  /** Market cap OUR fill implied. This selects the tier. */
  entryMarketCapUsd: number;
  entryPrice: number;
  costUsd: number;
  tokenAmount: number;
  remainingAmount: number;
  takeProfitPct: number;
  stopLossPct: number;
  /** True breakeven: entry plus round-trip fees, so a "breakeven" stop cannot exit at a loss. */
  breakevenPrice: number;
  status: "open" | "closed" | "stuck";
  /** A counterfactual position: costs nothing, holds no slot, exists only to be measured. */
  shadow?: boolean;
  /** Which counterfactual this is, e.g. "minhold60" or "reentry". */
  variant?: string;
  /**
   * OUR entry swap, when live. Distinct from signalTx, which is the TRACKED WALLET's
   * transaction — the thing we copied, not the thing we did. Without this, startup
   * reconciliation can only read the balance and cannot tell a lost confirmation from a
   * revert from a swap that never landed: all three look like "we hold nothing".
   */
  entryTxHash?: string;
  entryOrderId?: string;
  /**
   * The fill came in under the quote. The position is real and managed normally — this is a
   * record of what happened, not a different mode. Unwinding a partial costs another swap's
   * gas and locks in a loss on a position that may still work out.
   */
  partialFill?: boolean;
  /** What the quote promised, when the fill came in short. */
  quotedAmount?: number;
  /**
   * Highest and lowest percent-from-entry seen so far, PERSISTED.
   *
   * The exit loop kept these in memory only, so a restart reset them to zero and the trade
   * record then reported an excursion that never happened — one position logged a -14.2% peak
   * on a token that had actually run to +37.9%, because the runner was restarted mid-trade.
   * Harmless for P&L, corrosive for tuning: the tier thresholds are fitted on exactly this
   * data.
   */
  peakPct?: number;
  troughPct?: number;
  /**
   * Gas the ENTRY swap actually burned, in USD, from its receipt.
   *
   * Kept on the position because the exit is what computes P&L, and by then the entry receipt
   * is long gone. Absent for paper and for any live entry whose receipt could not be priced,
   * in which case P&L falls back to the configured estimate.
   */
  entryGasUsd?: number;
  paper: boolean;
}

function load(): Position[] {
  try { return JSON.parse(readFileSync(FILE, "utf8")) as Position[]; } catch { return []; }
}
let positions: Position[] = load();

function save(): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(positions, null, 2) + "\n");
}

/**
 * Exported so the entry path can ask the SAME question `open()` will ask, BEFORE it spends.
 * A second copy of this rule in index.ts would be free to drift from this one, and the whole
 * failure was the two checks disagreeing about when they run.
 */
export function tierFor(marketCapUsd: number): number | null {
  for (const t of config.exit.takeProfitTiers as { maxMarketCapUsd: number; takeProfitPct: number }[]) {
    if (marketCapUsd < t.maxMarketCapUsd) return t.takeProfitPct;
  }
  return null;
}

/**
 * The price at which a round trip breaks even.
 *
 * Percentage fees are proportional, so they cost the same however many slices the exit takes.
 * Gas is not: it is flat per swap, so as a PERCENTAGE it depends on position size — $1.05 of
 * round-trip gas is 7% of a $15 position and 1% of a $100 one. Sizing it against the actual
 * position is the only way the breakeven stop protects what it claims to.
 */
function breakeven(entryPrice: number, positionUsd: number, gasUsdPerSwap?: number): number {
  const b = config.exit.breakevenStop;
  // The LIVE gas figure when the caller has one. The config constant is a fallback that has
  // been badly wrong: $0.525 while real swaps cost $2.72, because robinhood chain fee revenue
  // went from $56k/day to $3.75M in eleven days. A breakeven computed from a stale gas number
  // understates what the trade must earn, and everything downstream — the breakeven stop, the
  // take-profit floor — inherits the error.
  const gas = (gasUsdPerSwap ?? b.gasUsdPerSwap ?? 0) * 2;    // one buy, one sell
  const gasPct = positionUsd > 0 ? (gas / positionUsd) * 100 : 0;
  const roundTripPct = (b.platformFeePctPerSwap + b.dexFeePctPerSwap) * 2 + b.extraBufferPct + gasPct;
  return entryPrice * (1 + roundTripPct / 100);
}

export function open(
  signal: Signal, entryPrice: number, costUsd: number, tokenAmount: number,
  entryMarketCapUsd: number, shadow = false, gasUsdPerSwap?: number,
): Position | null {
  const tp = tierFor(entryMarketCapUsd);
  if (tp === null) return null;   // above the ceiling — never opens
  const p: Position = {
    id: `${signal.chain}-${signal.txHash.slice(2, 10)}-${Date.now()}`,
    openedAt: Math.floor(Date.now() / 1000),
    chain: signal.chain, token: signal.token, tokenDecimals: signal.tokenDecimals,
    sourceWallet: signal.wallet.address, sourceWalletName: signal.wallet.name,
    signalTx: signal.txHash,
    signalMarketCapUsd: signal.impliedMarketCapUsd,
    entryMarketCapUsd, entryPrice, costUsd,
    tokenAmount, remainingAmount: tokenAmount,
    takeProfitPct: tp,
    stopLossPct: config.risk.stopLossPct,
    breakevenPrice: breakeven(entryPrice, costUsd, gasUsdPerSwap),
    status: "open", shadow,
    paper: config.mode.dryRun,
  };
  positions.push(p); save();
  return p;
}

export const openPositions = () => positions.filter((p) => p.status === "open" && !p.shadow);

/** Stuck positions must not occupy a slot — with a small cap, one would halt the bot forever. */
export function slotsInUse(): number {
  return positions.filter((p) => p.status === "open" && !p.shadow).length;
}
export function countForToken(chain: Chain, token: string): number {
  return positions.filter(
    (p) => p.status === "open" && !p.shadow
      && p.chain === chain && p.token.toLowerCase() === token.toLowerCase(),
  ).length;
}
/**
 * Seconds since we last ENTERED this token, open or closed, or null if never.
 *
 * Deliberately looks at every position rather than only open ones: the point of a cooldown is
 * to stop re-buying a coin we have just traded, and the commonest shape of that is buying back
 * into a name minutes after selling it, when the position is already closed and `countForToken`
 * returns zero. Shadows are excluded — they never spent anything, so they must not gate real
 * money.
 */
export function secondsSinceLastEntry(chain: Chain, token: string): number | null {
  let latest = 0;
  for (const p of positions) {
    if (p.shadow || p.chain !== chain) continue;
    if (p.token.toLowerCase() !== token.toLowerCase()) continue;
    if (p.openedAt > latest) latest = p.openedAt;
  }
  return latest ? Math.floor(Date.now() / 1000) - latest : null;
}

export function all(): Position[] { return positions; }

/** Register an already-built position (used for shadow twins, which bypass open()'s sizing). */
export function push(p: Position): void { positions.push(p); save(); }

/**
 * Record a new excursion extreme, throttled.
 *
 * Called from the exit loop as the price moves, so it must not write on every tick — but it
 * must survive a kill, which is the whole point. Ten seconds bounds the loss to a few samples.
 */
let lastExcursionSave = 0;
export function noteExcursion(id: string, peakPct: number, troughPct: number): void {
  const p = positions.find((x) => x.id === id);
  if (!p) return;
  const movedPeak = p.peakPct === undefined || peakPct > p.peakPct;
  const movedTrough = p.troughPct === undefined || troughPct < p.troughPct;
  if (!movedPeak && !movedTrough) return;
  if (movedPeak) p.peakPct = peakPct;
  if (movedTrough) p.troughPct = troughPct;
  if (Date.now() - lastExcursionSave > 10_000) { lastExcursionSave = Date.now(); save(); }
}

export function close(id: string, status: "closed" | "stuck" = "closed"): void {
  const p = positions.find((x) => x.id === id);
  if (!p) return;
  p.status = status;
  // Zeroed for both: a stuck position has had its remainder sold and a trade recorded, so
  // leaving the amount behind makes it read as open forever and blocks the concurrency slot.
  p.remainingAmount = 0;
  save();
}

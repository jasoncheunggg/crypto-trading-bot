import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.ts";
import { inputAsset } from "./execution.ts";
import { tokenBalance } from "./reconcile.ts";
import { nativeUsd } from "./live.ts";
import type { Chain } from "./types.ts";

const STATE = resolve(import.meta.dirname, "..", "state");
const FILE = resolve(STATE, "balance.json");

/**
 * Real wallet balance, and a once-a-day anchor for the circuit breaker.
 *
 * Two different questions are being answered here, and they want different answers:
 *
 *   SIZING asks "how much do I have right now". Measured over 3,000 shuffled orderings of
 *   134 recorded trades, sizing continuously off the current balance returned about 2.1x what
 *   a once-a-day figure returned ($3,397 vs $1,595 from $200) and — because compounding is
 *   commutative — gave the IDENTICAL result in every ordering, where the daily version came
 *   out anywhere from $1,510 to $1,659 depending only on which trades fell either side of the
 *   refresh. Continuous is both the higher and the more predictable of the two.
 *
 *   The BREAKER asks "how far down am I today". That needs a FIXED anchor, or the question
 *   has no stable meaning: measured against a balance that moves with every trade, a 25% fall
 *   quietly redefines itself all day, and a slow bleed never trips because the denominator
 *   falls with the numerator.
 *
 * So the balance refreshes continuously and the anchor is stamped once per UTC day.
 *
 * The refresh runs on a TIMER, never on the entry path. Reading a balance is an RPC round
 * trip of 100-300ms, and entry already spends ~2.4s between signal and fill; sizing does not
 * need a number that fresh, so it reads whatever the last sweep left behind.
 */

interface Snapshot {
  perChain: Record<string, { usd: number; at: number; gasNative?: number }>;
  /** UTC day number -> balance at the first observation of that day. */
  anchors: Record<string, Record<string, number>>;
}

const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * Gas budget, measured in NATIVE units rather than dollars.
 *
 * Deliberately not priced in USD: valuing it needs gmgn, and the whole point of this check is
 * to keep working when gmgn is unavailable. Native units are read straight from the chain.
 *
 * 0.00025 ETH per swap is the measured 440k gas at 0.46 gwei (~0.0002 ETH) plus headroom,
 * because gas price has been observed between 0.45 and 1.83 gwei — four times the baseline.
 * Budgeting at the cheap end would run the wallet dry precisely when the network is busy.
 */
const GAS_NATIVE_PER_SWAP = 0.00025;

/** Alert here: roughly ten round trips left, a few hours at the observed trade rate. */
const GAS_WARN_SWAPS = 20;
/**
 * Stop opening positions here. Ten swaps is far more than the two sells that closing a full
 * book requires, and the margin exists because a sell that REVERTS still pays gas — the
 * retry budget must be affordable even in the worst case.
 */
const GAS_HALT_SWAPS = 10;

export function gasSwapsLeft(chain: Chain): number | null {
  const g = snap.perChain[chain]?.gasNative;
  return g === undefined ? null : Math.floor(g / GAS_NATIVE_PER_SWAP);
}

/** Native balance from the last sweep, in native units. null if never read. */
export function gasNativeHeld(chain: Chain): number | null {
  return snap.perChain[chain]?.gasNative ?? null;
}

/** null when the balance has never been read — treated as "unknown", never as "fine". */
export function gasState(chain: Chain): { swaps: number; warn: boolean; halt: boolean } | null {
  const s = gasSwapsLeft(chain);
  if (s === null) return null;
  return { swaps: s, warn: s <= GAS_WARN_SWAPS, halt: s <= GAS_HALT_SWAPS };
}

function load(): Snapshot {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf8")) as Snapshot;
  } catch { /* corrupt or truncated — start clean rather than crash the runner */ }
  return { perChain: {}, anchors: {} };
}

let snap: Snapshot = load();

function save(): void {
  try { writeFileSync(FILE, JSON.stringify(snap, null, 2)); } catch { /* never fatal */ }
}

const utcDay = (ms = Date.now()): string => String(Math.floor(ms / 86_400_000));

/**
 * Read the spendable balance for a chain from the chain itself, IN USD.
 *
 * Under v1.0 the input was USDG and this returned its balance directly, because a stablecoin's
 * units already are dollars. That assumption survived the move to WETH and was WRONG for the
 * whole of Phase A and B: it reported 0.00099 as "$0.00099" and would have sized every position
 * at a hundredth of a cent. It failed safe — everything landed under minPositionSizeUsd — which
 * is exactly why it went unnoticed.
 *
 * The input is now native ETH, so the conversion is explicit and mandatory. A null price means
 * we do not know what the wallet is worth, and the honest answer is null rather than a number
 * denominated in the wrong unit.
 *
 * Native is no longer excluded from spendable, because it IS the trading asset now. The gas
 * reserve is taken off downstream in fundsFor, once, rather than by holding a second currency.
 */
export async function readLiveBalance(chain: Chain): Promise<number | null> {
  const input = inputAsset(chain);
  if (!input) return null;
  try {
    const bal = await tokenBalance(chain, input.address);
    if (bal === null) return null;
    const px = await nativeUsd(chain);
    if (px === null || px <= 0) return null;
    return bal * px;
  } catch { return null; }
}

/** Refresh every configured chain. Safe to call on a timer; failures leave the old value. */
export async function refreshBalances(chains: Chain[]): Promise<void> {
  for (const c of chains) {
    const usd = await readLiveBalance(c);
    if (usd === null) continue;
    // Native too: it pays for gas, and a wallet rich in USDG but out of gas cannot SELL.
    // That is the dangerous direction — an unsellable position is worse than a missed entry.
    const gasNative = await tokenBalance(c, NATIVE).catch(() => null);
    snap.perChain[c] = {
      usd, at: Math.floor(Date.now() / 1000),
      ...(gasNative === null ? {} : { gasNative }),
    };
  }
  save();
}

/** Last observed live balance, or null if never read. */
export function liveBalanceUsd(chain: Chain): number | null {
  return snap.perChain[chain]?.usd ?? null;
}

/** When the balance was last read, in epoch seconds. Null if never. */
export function balanceAt(chain: Chain): number | null {
  return snap.perChain[chain]?.at ?? null;
}

export function balanceAge(chain: Chain): number | null {
  const at = snap.perChain[chain]?.at;
  return at === undefined ? null : Math.floor(Date.now() / 1000) - at;
}

/**
 * The balance this UTC day started at — the breaker's denominator.
 *
 * Stamped on first request each day and never moved again, so "down 25% today" keeps one
 * meaning from midnight to midnight. `current` is what to stamp if today has no anchor yet;
 * it is supplied by the caller so this works identically for paper and live without the
 * module needing to know which is running.
 */
export function dailyAnchor(chain: Chain, current: number): number {
  const day = utcDay();
  const byChain = (snap.anchors[day] ??= {});
  // Keyed by MODE as well as chain. Switching to live mid-day would otherwise inherit the
  // paper anchor — observed at $425.81 against $176.30 of real money, which would have put
  // the -20% halt at a loss of $85, or 48% of the actual capital. The two modes have
  // different balances and must never share a denominator.
  const key = `${config.mode.dryRun === false ? "live" : "paper"}:${chain}`;
  if (byChain[key] === undefined) {
    byChain[key] = current;
    // Keep a week; the breaker only ever looks at today, the rest is for reading back.
    for (const d of Object.keys(snap.anchors)) {
      if (Number(day) - Number(d) > 7) delete snap.anchors[d];
    }
    save();
  }
  return byChain[key]!;
}

/** For the startup banner and the status line. */
export function describeBalances(chains: Chain[]): string[] {
  const out: string[] = [];
  for (const c of chains) {
    const b = liveBalanceUsd(c);
    const age = balanceAge(c);
    const anchor = snap.anchors[utcDay()]?.[`${config.mode.dryRun === false ? "live" : "paper"}:${c}`];
    const g = gasState(c);
    out.push(`${c}: ${b === null ? "unread" : "$" + b.toFixed(2)}` +
      (age === null ? "" : ` (${age}s ago)`) +
      (anchor === undefined ? "" : `, day anchor $${anchor.toFixed(2)}`) +
      (g === null ? "" : `, gas ${g.swaps} swaps${g.halt ? " *** HALTING ENTRIES ***" : g.warn ? " (LOW)" : ""}`));
  }
  return out;
}

/** How often the timer should fire. Cheap (~26 CU) and off the entry path, so not daily. */
export const REFRESH_MS = (config.risk.balanceRefreshMinutes ?? 30) * 60_000;

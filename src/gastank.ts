import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.ts";

const FILE = resolve(import.meta.dirname, "..", "state", "gastank.json");

/**
 * DORMANT UNDER v2.0 — kept because the accounting inside it is still correct.
 *
 * Under v1.0 the trading asset was USDG and gas was native ETH, two genuinely different
 * assets, so running out of gas meant SWAPPING USDG for it — a routed trade with slippage and
 * price risk, which is why this file exists and why it refuses to run with a position open.
 *
 * v2.0 trades from WETH. Gas is still native ETH, but the conversion between them is now
 * WETH.withdraw() — 1:1 at a fixed contract, no routing, no slippage, no counterparty. The
 * refill is nearly trivial, so the machinery that made a risky swap safe is mostly beside the
 * point.
 *
 * What is NOT beside the point is `reserveUsdPerSwap` and `roundTripsLeft`: the distinction
 * between what a swap COSTS and what must be HELD to submit one is unchanged, and getting it
 * wrong reported 76 swaps of headroom on a wallet that could not submit one. Those stay.
 *
 * `topUpNeeded` returns null while `risk.autoGasTopUp.enabled` is false, which it is under
 * v2.0. Rewiring it to unwrap WETH is Phase 3 work, once signing exists.
 */

/**
 * Keeps enough native token in the wallet to trade, by converting USDG when it runs low.
 *
 * A wallet rich in USDG but out of gas cannot SELL, and an unsellable position is the worst
 * failure this system has: one such stranding cost a managed exit outright. The existing gas
 * monitor only halts — this refills.
 *
 * The average is measured, never assumed. `gasUsdPerSwap` in config read $0.525 while the
 * live session averaged $0.691 and a single multi-hop swap cost $2.72, because robinhood
 * chain fee revenue went 82-fold in eleven days. A constant here would size top-ups against
 * a cost that no longer exists.
 */

interface Tank {
  /** Recent per-swap gas costs in USD, newest last. */
  recent: number[];
  /** Epoch ms of the last conversion, so a failure cannot loop. */
  lastTopUpAt: number;
  toppedUpToday: number;
  day: string;
}

const WINDOW = 20;            // enough to smooth a $2.72 outlier without lagging a real shift
const MIN_SAMPLES = 4;        // below this, fall back to the configured estimate
const COOLDOWN_MS = 15 * 60_000;
const MAX_PER_DAY = 3;

function load(): Tank {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf8")) as Tank;
  } catch { /* corrupt — start clean rather than block trading */ }
  return { recent: [], lastTopUpAt: 0, toppedUpToday: 0, day: "" };
}
let tank: Tank = load();
const save = () => { try { writeFileSync(FILE, JSON.stringify(tank)); } catch { /* never fatal */ } };
const today = () => new Date().toISOString().slice(0, 10);

/** Record what a swap actually cost, from its receipt. Called after every entry and exit. */
export function recordGas(usd: number | undefined): void {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return;
  tank.recent.push(usd);
  if (tank.recent.length > WINDOW) tank.recent.shift();
  save();
}

/** Mean cost of one swap. Falls back to config until there are enough real observations. */
export function avgGasUsd(): number {
  const fallback = config.exit.breakevenStop.gasUsdPerSwap ?? 0.525;
  if (tank.recent.length < MIN_SAMPLES) return fallback;
  return tank.recent.reduce((a, b) => a + b, 0) / tank.recent.length;
}

/**
 * How many more round trips the wallet can actually do.
 *
 * TWO different numbers govern this and the old version used only one. `reserveUsd` is the
 * balance floor gmgn requires before it will submit anything (see `reserveUsdPerSwap`);
 * `avgGasUsd` is what a swap actually burns. You may keep trading while the balance stays
 * above the floor, and each round trip depletes it by two swaps' worth of real cost.
 *
 * Dividing by the average alone reported 26 swaps on a wallet that could not submit ONE —
 * the floor was $33.80 and the balance $15.96. Below the floor the honest answer is zero,
 * whatever the average says, so that case returns 0 rather than a comforting number.
 *
 * `reserveUsd` null means the gas price could not be read; the caller then has no floor to
 * check and this falls back to the old cost-only estimate rather than blocking on an
 * RPC hiccup.
 */
export function roundTripsLeft(ethUsd: number, reserveUsd?: number | null): number {
  if (reserveUsd == null) return Math.floor(ethUsd / (avgGasUsd() * 2));
  if (ethUsd < reserveUsd) return 0;
  return Math.floor((ethUsd - reserveUsd) / (avgGasUsd() * 2));
}

export interface TopUp { usd: number; reason: string }

/**
 * How much USDG to convert, or null to do nothing.
 *
 * `openPositions` MUST be zero. A conversion while a position is open races that position's
 * exit for the same gmgn rate-limit budget, and a 31-second block on an exit cost $3.87 once
 * already. Gas is never so urgent that it is worth delaying a sell.
 */
export function topUpNeeded(
  ethUsd: number, usdgUsd: number, openPositions: number, reserveUsd?: number | null,
): TopUp | null {
  const c = config.risk.autoGasTopUp as {
    enabled?: boolean; belowRoundTrips?: number; targetRoundTrips?: number;
    maxUsdPerTopUp?: number; minUsdgReserve?: number;
  } | undefined;
  if (!c?.enabled) return null;
  if (openPositions > 0) return null;

  if (tank.day !== today()) { tank.day = today(); tank.toppedUpToday = 0; save(); }
  if (tank.toppedUpToday >= MAX_PER_DAY) return null;
  if (Date.now() - tank.lastTopUpAt < COOLDOWN_MS) return null;

  const below = c.belowRoundTrips ?? 8;
  const target = c.targetRoundTrips ?? 25;
  const have = roundTripsLeft(ethUsd, reserveUsd);
  if (have >= below) return null;

  // Top up to the FLOOR plus the target's worth of real cost. Sizing against the average
  // alone refilled to a balance that still could not submit a swap: at a $33.80 floor,
  // 25 round trips of average cost is ~$30 and lands under the floor with a full tank.
  const targetBalance = (reserveUsd ?? 0) + target * avgGasUsd() * 2;
  const want = Math.max(targetBalance - ethUsd, 0);
  const capped = Math.min(want, c.maxUsdPerTopUp ?? 40);
  // Converting a small amount is mostly toll: a $1 test conversion lost 21% to gas, $10 loses
  // 1.6%. Below $10 it is not worth doing at all.
  if (capped < 10) return null;
  // Never strip the trading balance to buy gas.
  if (usdgUsd - capped < (c.minUsdgReserve ?? 50)) return null;

  return {
    usd: capped,
    reason: `${have} round trips left (floor ${below}), topping up toward ${target}`
      + ` — reserve $${(reserveUsd ?? 0).toFixed(2)}/swap must be HELD, $${avgGasUsd().toFixed(3)}/swap actually burned`,
  };
}

export function markToppedUp(): void {
  tank.lastTopUpAt = Date.now();
  tank.toppedUpToday += 1;
  save();
}

export function describeTank(ethUsd: number, reserveUsd?: number | null): string {
  const rt = roundTripsLeft(ethUsd, reserveUsd);
  return `gas $${avgGasUsd().toFixed(3)}/swap burned (${tank.recent.length} samples), `
    + (reserveUsd == null ? "" : `$${reserveUsd.toFixed(2)}/swap reserved, `)
    + `${rt} round trips left${rt === 0 && reserveUsd != null ? " — BELOW THE FLOOR, cannot submit a swap" : ""}, `
    + `${tank.toppedUpToday} top-ups today`;
}

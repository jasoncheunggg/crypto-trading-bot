import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { rpc } from "./rpc.ts";
import { config } from "./config.ts";
import type { Chain } from "./types.ts";

/**
 * Gas: what a swap costs, what must be held to submit one, and what we have actually paid.
 *
 * RECALIBRATED 2026-09-08 for v2.0. Every constant here was measured against gmgn's deep
 * routing and is now wrong by roughly 4x, because 0x settles a memecoin swap in a fraction of
 * the gas gmgn's routes did. Real receipts from the first live v2.0 round trip:
 *
 *     buy   0x481cc28c   173,790 gas   $0.1286
 *     sell  0xb16ff231   143,679 gas   $0.1055
 *
 * against the old GAS_UNITS of 700,000, which claimed $0.515 a swap. That error was not
 * cosmetic: `breakeven()` multiplies this by two, so on a $30 position it inflated the
 * breakeven price by $0.79 — 2.6 percentage points — and the breakeven stop sat that much too
 * high, refusing exits on positions that were genuinely in profit.
 */

/** Observed middle of real v2.0 swaps, rounded up. Native ETH costs ~19k more on the buy leg
 *  than WETH did (the router wraps internally), so this sits above both measurements. */
const GAS_UNITS = 200_000;
const TTL_MS = 60_000;

const cache = new Map<string, { usd: number; at: number }>();

/**
 * What must be HELD before a swap can be submitted — a different number from what one COSTS,
 * and the one that actually stops trading.
 *
 * The chain requires `gas_limit x maxFeePerGas` to be covered before admitting a transaction,
 * and refunds the remainder, so this is a balance floor rather than a cost. On 2026-09-04 the
 * wallet held $15.96, `roundTripsLeft` reported 26 swaps because it divided by the ~$0.60 a
 * swap had been costing, and every sell was refused: the floor was $33.80.
 *
 * WORST_GAS_LIMIT is now the largest SINGLE-LEG estimate 0x quoted across 16 tokens on
 * 2026-09-08 (~1.26M on a deep multi-hop), not the 2.25M measured off gmgn. BUFFER replaces
 * GMGN_HIGH_MULTIPLE, which described gmgn's HIGH fee tier and means nothing now that we set
 * our own fees — it matches the 1.25x limit buffer applied in signer.send.
 */
const WORST_GAS_LIMIT = 1_300_000;
const BUFFER = 1.25;

export async function reserveUsdPerSwap(chain: Chain, nativeUsdPrice: number): Promise<number | null> {
  // Reuse currentGwei's cache rather than making a second eth_gasPrice call: both ask the
  // identical question and both sit on the entry path.
  const gwei = await currentGwei(chain);
  if (gwei === null) return null;
  const usd = (WORST_GAS_LIMIT * gwei * BUFFER / 1e9) * nativeUsdPrice;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

export async function gasUsdPerSwap(chain: Chain, nativeUsdPrice = 2493): Promise<number> {
  const hit = cache.get(chain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.usd;
  const fallback = config.exit.breakevenStop.gasUsdPerSwap ?? 0.15;
  try {
    const hex = await rpc<string>(chain, "eth_gasPrice", []);
    if (!hex) return fallback;
    const usd = (GAS_UNITS * Number(BigInt(hex)) / 1e18) * nativeUsdPrice;
    if (!Number.isFinite(usd) || usd <= 0) return fallback;
    cache.set(chain, { usd, at: Date.now() });
    return usd;
  } catch { return fallback; }
}

/** Current gas price in gwei, cached briefly — it sits on the entry path. */
const gweiCache = new Map<string, { gwei: number; at: number }>();
export async function currentGwei(chain: Chain): Promise<number | null> {
  const hit = gweiCache.get(chain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.gwei;
  try {
    const hex = await rpc<string>(chain, "eth_gasPrice", []);
    if (!hex) return null;
    const gwei = Number(BigInt(hex)) / 1e9;
    if (!Number.isFinite(gwei) || gwei <= 0) return null;
    gweiCache.set(chain, { gwei, at: Date.now() });
    return gwei;
  } catch { return null; }
}

/* ------------------------------------------------------------------ observed cost ---------
 * Absorbed from gastank.ts, which is deleted.
 *
 * That file existed because v1.0 held its capital in USDG and paid gas in native ETH: two
 * different assets, so refilling gas meant a ROUTED SWAP with slippage and price risk, and
 * most of its machinery was there to make that swap safe. v2.0 trades native ETH, so gas and
 * capital are the same pot and the refill does not exist. The top-up path, its cooldowns, its
 * daily cap and its refusal-while-a-position-is-open are all gone with it.
 *
 * What survives is the accounting, because `breakeven()` needs to know what a swap ACTUALLY
 * costs rather than what a constant guesses, and because the distinction between the balance
 * floor and the average cost is what stopped `roundTripsLeft` reporting 26 swaps of headroom
 * on a wallet that could not submit one.
 */

const FILE = resolve(import.meta.dirname, "..", "state", "gastank.json");
interface Tank { recent: number[] }
const WINDOW = 20;
const MIN_SAMPLES = 4;

function load(): Tank {
  try {
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Tank>;
      return { recent: Array.isArray(raw.recent) ? raw.recent : [] };
    }
  } catch { /* corrupt — start clean rather than block trading */ }
  return { recent: [] };
}
let tank: Tank = load();
const save = () => { try { writeFileSync(FILE, JSON.stringify(tank)); } catch { /* never fatal */ } };

/** Record what a swap actually cost, from its receipt. Called after every entry and exit. */
export function recordGas(usd: number | undefined): void {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return;
  tank.recent.push(usd);
  if (tank.recent.length > WINDOW) tank.recent.shift();
  save();
}

/** Mean cost of one swap. Falls back to config until there are enough real observations. */
export function avgGasUsd(): number {
  const fallback = config.exit.breakevenStop.gasUsdPerSwap ?? 0.15;
  if (tank.recent.length < MIN_SAMPLES) return fallback;
  return tank.recent.reduce((a, b) => a + b, 0) / tank.recent.length;
}

/**
 * How many more round trips the wallet can actually do.
 *
 * TWO different numbers govern this. `reserveUsd` is the balance floor the chain requires
 * before it will admit a transaction; `avgGasUsd` is what a swap actually burns. Trading may
 * continue while the balance stays above the floor, and each round trip depletes it by two
 * swaps' worth of real cost. Dividing by the average alone reported 26 swaps on a wallet that
 * could not submit ONE, so below the floor the answer is zero whatever the average says.
 */
export function roundTripsLeft(ethUsd: number, reserveUsd?: number | null): number {
  if (reserveUsd == null) return Math.floor(ethUsd / (avgGasUsd() * 2));
  if (ethUsd < reserveUsd) return 0;
  return Math.floor((ethUsd - reserveUsd) / (avgGasUsd() * 2));
}

export function describeGas(ethUsd: number, reserveUsd?: number | null): string {
  const rt = roundTripsLeft(ethUsd, reserveUsd);
  return `gas $${avgGasUsd().toFixed(3)}/swap burned (${tank.recent.length} samples), `
    + (reserveUsd == null ? "" : `$${reserveUsd.toFixed(2)}/swap reserved, `)
    + `${rt} round trips left${rt === 0 && reserveUsd != null ? " — BELOW THE FLOOR, cannot submit a swap" : ""}`;
}

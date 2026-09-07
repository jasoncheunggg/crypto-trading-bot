import { rpc } from "./rpc.ts";
import { config } from "./config.ts";
import type { Chain } from "./types.ts";

/**
 * What one swap costs in gas, in USD, at the CURRENT gas price.
 *
 * `exit.breakevenStop.gasUsdPerSwap` is a constant, and a constant is the wrong shape for
 * this chain: it was measured at $0.525 on 2026-09-01 and real swaps cost $2.72 two days
 * later. Robinhood Chain fee revenue went from $56k/day on 23 August to $3.75M by 1 September
 * as memecoin traders flooded it — the very activity this bot trades — and the median base
 * fee moved from a few cents to 0.467 gwei with intraday spikes past 5.
 *
 * Gas USED also varies with routing depth: 178k for a direct pair, 1.14M for a multi-hop
 * memecoin. GAS_UNITS is the observed middle of that range for the swaps we actually do.
 *
 * Read from eth_gasPrice, which is Alchemy and effectively free, cached briefly because it
 * sits on the entry and exit paths.
 */
const GAS_UNITS = 700_000;
const TTL_MS = 60_000;

const cache = new Map<string, { usd: number; at: number }>();

/**
 * What must be HELD for gmgn to accept a swap at all — a different number from what a swap
 * COSTS, and the one that actually stops trading.
 *
 * gmgn sets `maxFeePerGas` from its own HIGH tier, and the chain then requires the full
 * `gas_limit x maxFeePerGas` to be covered before the transaction is admitted. The unused
 * remainder is refunded, so this is a balance floor, never a cost.
 *
 * The gap between the two is what stranded a position on 2026-09-04. The wallet held $15.96,
 * `roundTripsLeft` reported 26 swaps because it divided by the ~$0.60 a swap had been
 * costing, and every sell was refused with GEvmInsufficientFundsForGas: the chain was at
 * 2.92 gwei, gmgn's high was near 6.4, and a 2.15M-limit route needed **$33.80** reserved.
 * The sell that finally went through cost $1.55. The average was never the binding number.
 *
 * WORST_GAS_LIMIT is the largest limit observed across 28 real swaps (2,214,770), not a
 * typical one, because this exists to answer "can I definitely still exit" — and the routes
 * that quote the highest limits are the hooked-V4 pools that carried most of the P&L.
 * GMGN_HIGH_MULTIPLE is measured: high 1.078 gwei against a 0.489 base, i.e. 2.20x.
 */
const WORST_GAS_LIMIT = 2_250_000;
const GMGN_HIGH_MULTIPLE = 2.2;

export async function reserveUsdPerSwap(chain: Chain, nativeUsdPrice: number): Promise<number | null> {
  // Reuse currentGwei's cache rather than making a second eth_gasPrice call. Both ask the
  // identical question and both sit on the entry path; measured at 141ms and 160ms on
  // consecutive calls, i.e. no cache at all, while currentGwei answered the same thing in 0ms.
  const gwei = await currentGwei(chain);
  if (gwei === null) return null;
  const usd = (WORST_GAS_LIMIT * gwei * GMGN_HIGH_MULTIPLE / 1e9) * nativeUsdPrice;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

export async function gasUsdPerSwap(chain: Chain, nativeUsdPrice = 2517): Promise<number> {
  const hit = cache.get(chain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.usd;
  const fallback = config.exit.breakevenStop.gasUsdPerSwap ?? 0.525;
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

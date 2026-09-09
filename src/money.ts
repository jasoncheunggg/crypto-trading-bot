import { config } from "./config.ts";
import type { Chain } from "./types.ts";

/**
 * THE one place a quote-asset amount becomes dollars.
 *
 * This exists because the same bug shipped three separate times. Under v1.0 the only asset the
 * bot ever counted was USDG, so `raw / 10**decimals` WAS the dollar figure, and that identity
 * got written into four files as plain arithmetic. v2.0 trades native ETH, and every one of
 * those lines silently began returning a quantity of ETH labelled as money:
 *
 *   readLiveBalance   reported 0.00099 ETH as "$0.00099" and would have sized every position
 *                     at a hundredth of a cent
 *   costUsd/proceeds  recorded a $5.19 entry as $0.00, which corrupted the entry price, the
 *                     stop, the price feed's plausibility reference and the sell's min-output
 *                     floor, and stranded a live position
 *   verifyPrice       cannot price a non-USDG swap at all, so misprice protection silently
 *                     degrades to "could not confirm" on any token trading in ETH
 *
 * A currency MODE would not have prevented any of them: the hazard is not which asset is read
 * but that a leg's amount and its value are the same number, so using one as the other type
 * checks and looks plausible. The fix is that there is now no way to obtain a leg's value
 * except through `legUsd`, which cannot return a figure it has not converted.
 *
 * Rates are read from a cache rather than fetched, because two of the call sites are sync hot
 * paths (a websocket log handler, and a per-candidate loop inside verifyPrice). `nativeUsd`
 * already maintains that cache with stale-while-revalidate; this just reads it.
 */

const nativeCache = new Map<string, number>();

/** Published by live.ts's nativeUsd whenever it resolves. */
export function setNativeUsd(chain: Chain, usd: number): void {
  if (Number.isFinite(usd) && usd > 0) nativeCache.set(chain, usd);
}
export function cachedNativeUsd(chain: Chain): number | null {
  return nativeCache.get(chain) ?? null;
}

/** USD per WHOLE unit of each quote asset, plus its decimals. Null when a rate is unknown. */
export interface UsdRates {
  rate: Record<string, number>;
  decimals: Record<string, number>;
  symbol: Record<string, string>;
  /** "dollar" = its units already are USD. "native" = converted at the chain price. */
  source: Record<string, "dollar" | "native">;
}

interface QuoteAsset { symbol: string; decimals: number; priceSource?: string; isSizingAsset?: boolean }

/**
 * How each configured quote asset converts to dollars.
 *
 * `priceSource` is explicit in config rather than guessed from the symbol: "USDG" looking like
 * a dollar is a naming convention, not a fact, and the whole point here is to stop inferring
 * units. An asset whose rate cannot be resolved is OMITTED, so `legUsd` returns null for it
 * rather than a number in the wrong currency.
 */
export function usdRates(chain: Chain): UsdRates {
  const quotes = (config.quoteAssets[chain] ?? {}) as Record<string, QuoteAsset>;
  const px = cachedNativeUsd(chain);
  const out: UsdRates = { rate: {}, decimals: {}, symbol: {}, source: {} };
  for (const [addr, q] of Object.entries(quotes)) {
    const a = addr.toLowerCase();
    // Default preserves v1.0 behaviour for any asset not yet annotated: a sizing asset was
    // by definition one whose units were already dollars.
    const src = q.priceSource ?? (q.isSizingAsset ? "dollar" : null);
    let rate: number | null = null;
    if (src === "dollar") rate = 1;
    else if (src === "native") rate = px;
    if (rate === null) continue;
    out.rate[a] = rate;
    out.decimals[a] = q.decimals;
    out.symbol[a] = q.symbol;
    out.source[a] = src === "dollar" ? "dollar" : "native";
  }
  return out;
}

/**
 * A raw quote-asset amount, in dollars. Null when the asset is not a configured quote asset,
 * or when its rate is currently unknown.
 *
 * Null is deliberate and must not be coerced to 0 by callers: "I could not price this" and
 * "this was worth nothing" lead to opposite decisions, and conflating them is what let a
 * $1,420 airdrop read as a $0.00 buy.
 */
export function legUsd(rates: UsdRates, asset: string, raw: bigint): number | null {
  const a = asset.toLowerCase();
  const rate = rates.rate[a];
  const dec = rates.decimals[a];
  if (rate === undefined || dec === undefined) return null;
  const v = (Number(raw) / 10 ** dec) * rate;
  return Number.isFinite(v) ? v : null;
}

/** True when the address is a configured quote asset we can currently price. */
export function priceable(rates: UsdRates, asset: string): boolean {
  return rates.rate[asset.toLowerCase()] !== undefined;
}

/** True when this asset's units already are dollars, so its leg needs no conversion. */
export function isDollarAsset(rates: UsdRates, asset: string): boolean {
  return rates.source[asset.toLowerCase()] === "dollar";
}

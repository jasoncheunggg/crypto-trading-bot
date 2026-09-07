import { gmgn } from "./gmgn.ts";
import type { Chain } from "./types.ts";

/**
 * Token risk metrics, used to refuse one narrow shape of trade.
 *
 * The only rule here is: heavy holder concentration in a SMALL market cap. Measured across
 * all 88 tokens ever traded, five sat above 50% top-10 concentration and four of those were
 * legitimate — $1.2M to $5.3M tokens where whales genuinely hold half the supply and which
 * returned -15%, +10%, +33% and +36%. The fifth was $41,756 with 76% in the top ten, one
 * holder on 37%, and it rugged for -100%.
 *
 * So concentration ALONE is not a signal — it is concentration in a token young enough that
 * the deployer still owns it. Both conditions or neither.
 *
 * Deliberately NOT gated on: `is_show_alert` fires on 7 of 13 recent tokens including the
 * +118.7% and +89.3% winners, and `is_open_source` is false for six tokens averaging +27%.
 * Both would cost far more than they save.
 */

export interface TokenRisk {
  top10Pct: number | null;
  openSource: boolean | null;
}

const cache = new Map<string, { r: TokenRisk; at: number }>();
const TTL_MS = 30 * 60_000;      // a token's holder profile does not change minute to minute

export async function tokenRisk(chain: Chain, token: string): Promise<TokenRisk> {
  const key = `${chain}:${token.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.r;
  try {
    const out = await gmgn(["token", "security", "--chain", chain, "--address", token, "--raw"], 15_000);
    const d = JSON.parse(out) as { top_10_holder_rate?: string; is_open_source?: boolean };
    const top = Number(d.top_10_holder_rate);
    const r: TokenRisk = {
      top10Pct: Number.isFinite(top) ? top * 100 : null,
      openSource: typeof d.is_open_source === "boolean" ? d.is_open_source : null,
    };
    cache.set(key, { r, at: Date.now() });
    return r;
  } catch {
    // FAILS OPEN. A missing risk score must never block a good signal — the alternative is
    // that one gmgn hiccup halts trading entirely.
    return { top10Pct: null, openSource: null };
  }
}

/** The refusal rule. Null concentration means unknown, which never rejects. */
/**
 * Concentration limits, TIGHTER the smaller the token.
 *
 * The original single rule (>50% below $250k) was written after PNS500, which held 76%. The
 * second rug slipped under it at 47% and $42k mcap and cost the position — at that size 47%
 * and 51% are not meaningfully different, because a token that small can be controlled
 * without any single wallet crossing an arbitrary line.
 *
 * The tighter band costs nothing measurable: across 40 entries with a recorded figure, 39 sat
 * below 30% and NOTHING has ever landed between 30% and 47%. The gap is empty, so 38% and 50%
 * reject exactly the same historical trades — the rug — and no others.
 */
const BANDS: { belowMarketCapUsd: number; maxTop10Pct: number }[] = [
  { belowMarketCapUsd: 150_000, maxTop10Pct: 38 },
  { belowMarketCapUsd: 250_000, maxTop10Pct: 50 },
];

export function concentrationBlocks(
  risk: TokenRisk, marketCapUsd: number,
  maxTop10Pct = 50, minMarketCapUsd = 250_000,
): string | null {
  if (risk.top10Pct === null) return null;
  // First matching band wins, so order ascending by market cap.
  for (const b of BANDS) {
    if (marketCapUsd >= b.belowMarketCapUsd) continue;
    if (risk.top10Pct <= b.maxTop10Pct) return null;
    return `top-10 hold ${risk.top10Pct.toFixed(0)}% of a $${Math.round(marketCapUsd).toLocaleString()} token `
      + `(limit ${b.maxTop10Pct}% below $${b.belowMarketCapUsd.toLocaleString()})`;
  }
  // Above every band, fall back to the caller's ceiling.
  if (risk.top10Pct <= maxTop10Pct) return null;
  if (marketCapUsd >= minMarketCapUsd) return null;
  return `top-10 hold ${risk.top10Pct.toFixed(0)}% of a $${Math.round(marketCapUsd).toLocaleString()} token `
    + `(limit ${maxTop10Pct}% below $${minMarketCapUsd.toLocaleString()})`;
}

/**
 * Reject tokens whose contract is far larger than a launchpad token needs to be.
 *
 * Measured across 42 traded tokens: sixteen are 44-byte minimal proxies, twenty are the
 * 3,248-byte launchpad standard, four sit between 4.4k and 7.2k — and the ONLY two above that
 * are the two rugs, both 20,146 bytes, the same template compiled twice. The gap between the
 * largest legitimate contract (7,154) and the rug template is 12,992 bytes wide, so a
 * threshold inside it rejects both rugs and none of the 40 good trades.
 *
 * The reasoning, not just the fit: a factory-produced memecoin is a proxy or a standard
 * template. 20KB of bespoke code at $42k market cap is someone writing custom transfer logic,
 * which is where blacklists, dynamic taxes and sell restrictions live.
 *
 * n=2. This is a defensible prior, not a demonstrated law — a legitimate token with real
 * mechanics (staking, reflections, vesting) would also be large and would be refused. Fails
 * OPEN: an unreadable contract is not evidence of anything.
 */
export const MAX_BYTECODE_BYTES = 13_000;

export function bytecodeBlocks(codeBytes: number | null): string | null {
  if (codeBytes === null || codeBytes <= 0) return null;
  if (codeBytes <= MAX_BYTECODE_BYTES) return null;
  return `contract is ${codeBytes.toLocaleString()} bytes (limit ${MAX_BYTECODE_BYTES.toLocaleString()}) — `
    + `both recorded rugs used a ${(20_146).toLocaleString()}-byte custom contract, while every `
    + `profitable token was a proxy or launchpad template under 7,200`;
}

import { gmgn } from "./gmgn.ts";
import type { Chain } from "./types.ts";

/**
 * Token risk metrics, used to refuse one narrow shape of trade.
 *
 * THE ONLY REMAINING gmgn DEPENDENCY IN v2.0, and it is deliberate. `token/security` is a DATA
 * endpoint, unaffected by the 2026-09-08 reprice that made every `swap` call exceed the plan
 * allowance and 429 — verified working that day while swap stayed blocked. It costs nothing on
 * the current plan and sits nowhere near the trading path.
 *
 * It is kept for ONE field, `top_10_holder_rate`, because nothing else provides it: 0x has no
 * holder data and Alchemy has no top-holders endpoint on the free tier. `is_open_source` rides
 * the same response and is logged, never gated.
 *
 * Explicitly NOT used, measured against realised P&L over 55 tokens on 2026-09-08:
 *   is_honeypot   fired on 9 tokens worth +$76.58, including the two best trades ever
 *                 (+$41.88 / +101.2% and +$54.16 / +40.5%). Gating on it loses money.
 *   is_show_alert fired on 10 tokens worth +$51.92.
 * The honeypot question is answered instead by `roundTripProbe` in execution.ts, which asks
 * whether the token can actually be sold rather than whether someone has labelled it.
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
  /** Sell tax as a PERCENT, 0-100. Null when gmgn did not answer. */
  sellTaxPct: number | null;
}

const cache = new Map<string, { r: TokenRisk; at: number }>();
const TTL_MS = 30 * 60_000;      // a token's holder profile does not change minute to minute

export async function tokenRisk(chain: Chain, token: string): Promise<TokenRisk> {
  const key = `${chain}:${token.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.r;
  try {
    const out = await gmgn(["token", "security", "--chain", chain, "--address", token, "--raw"], 15_000);
    const d = JSON.parse(out) as {
      top_10_holder_rate?: string; is_open_source?: boolean; sell_tax?: string;
    };
    const top = Number(d.top_10_holder_rate);
    const tax = Number(d.sell_tax);
    const r: TokenRisk = {
      top10Pct: Number.isFinite(top) ? top * 100 : null,
      openSource: typeof d.is_open_source === "boolean" ? d.is_open_source : null,
      sellTaxPct: Number.isFinite(tax) ? tax * 100 : null,
    };
    cache.set(key, { r, at: Date.now() });
    return r;
  } catch {
    // FAILS OPEN. A missing risk score must never block a good signal — the alternative is
    // that one gmgn hiccup halts trading entirely.
    return { top10Pct: null, openSource: null, sellTaxPct: null };
  }
}

/**
 * Refuse a token that cannot be sold without surrendering most of it.
 *
 * This exists because `roundTripProbe` CANNOT see a transfer tax. Proven 2026-09-08 against
 * 0x5b234bcf67, which charges 99% on sell: at a $30 position the probe returned 2.97%
 * retention and looked like a catch, but that was price impact from a $3.68 pool — shrink the
 * position to $0.04 and the same token probes at 95.30% and PASSES. 0x reports sellTaxBps 0
 * for it, so the quote the probe is built on never models the tax at all.
 *
 * Measured over 55 tokens with realised P&L: `sell_tax` above 50% fires on exactly ONE token,
 * that honeypot, which returned $0.00. Zero false positives and zero opportunity cost — unlike
 * gmgn's own `is_honeypot`, which fires on 9 of those 55 including the two best trades ever
 * made and would have cost $76.58.
 *
 * FAILS OPEN, like everything else here: a null tax is unknown, not safe, but blocking every
 * signal because gmgn hiccuped is the worse failure.
 */
const MAX_SELL_TAX_PCT = 50;

/**
 * A contract nobody can read is a contract nobody has checked.
 *
 * This was REJECTED as a gate on 2026-09-08 — "is_open_source is false for six tokens
 * averaging +27%" — and re-measured on 2026-09-11 across every token the bot has ever
 * touched. The earlier number was measuring the wrong thing.
 *
 *   82 of 83 tokens answered. 4 were closed source, 5%.
 *
 *   open source     98 live trades   +$173.17   +$1.77/trade   win 60%
 *   CLOSED source    3 live trades    -$24.66   -$8.22/trade   win  0%
 *
 * All three closed-source live trades ended stuck or rugged. Every one peaked hard first —
 * +195%, +157%, +105% — which is the honeypot signature exactly: the chart runs because
 * nobody can sell. That is where "+27%" came from. Measure the price those tokens REACH and
 * they look superb; measure what was actually realised and it is 0 for 3.
 *
 * The one closed-source token that ever booked a profit did it on PAPER (+$28.42), where a
 * sale is arithmetic rather than a transaction. Paper and shadow fills cannot tell a honeypot
 * from a rocket, so they must never be the evidence for a gate about whether an exit exists.
 *
 * Free to check: is_open_source rides the same gmgn response already fetched for
 * top_10_holder_rate, so this costs no extra call and no latency — unlike roundTripProbe,
 * which answers the same question for 1,483ms and was taken off the entry path on 2026-09-08.
 *
 * Thin, and worth revisiting: n=3 live blocks, roughly one per 20 trades at 5% incidence.
 * Null (gmgn did not answer) is NOT a block — absence of evidence only.
 */
export function closedSourceBlocks(risk: TokenRisk): string | null {
  if (risk.openSource !== false) return null;
  return "contract is not open source — 3 of 3 such tokens traded live ended stuck or rugged "
    + "(-$24.66, zero wins), each after peaking 105-195% because the exit did not exist";
}

export function sellTaxBlocks(risk: TokenRisk): string | null {
  if (risk.sellTaxPct === null) return null;
  if (risk.sellTaxPct <= MAX_SELL_TAX_PCT) return null;
  return `sell tax ${risk.sellTaxPct.toFixed(0)}% (limit ${MAX_SELL_TAX_PCT}%) — `
    + `the round-trip probe cannot see a transfer tax, only pool depth`;
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

import { config } from "./config.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(import.meta.dirname, "..", "state", "paths");

interface Meta {
  id: string; entryPrice: number; costUsd: number; tokenAmount: number;
  takeProfitPct: number; stopLossPct: number; breakevenPrice: number; token: string;
}
interface Sample { t: number; price: number; pctFromEntry: number }

export interface Params {
  takeProfitPct: number; stopLossPct: number;
  sellPctOfRemainder: number; intervalSeconds: number;
  minSliceUsd: number; timeCutoffSeconds: number;
  platformFeePct: number; dexFeePct: number;
  breakevenAfterFirstSell: boolean; breakevenPrice: number;
}
export interface Outcome {
  reason: string; proceedsUsd: number; pnlUsd: number; pnlPct: number;
  sells: number; peakPct: number; troughPct: number; heldSec: number;
}

export function loadPath(id: string): { meta: Meta; samples: Sample[] } | null {
  const f = resolve(DIR, `${id}.jsonl`);
  if (!existsSync(f)) return null;
  const rows = readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const meta = rows.find((r) => "meta" in r)?.meta as Meta | undefined;
  const samples = rows.filter((r): r is Sample => "price" in r);
  return meta && samples.length ? { meta, samples } : null;
}
export const listPaths = () =>
  existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(".jsonl", "")) : [];

/**
 * Replay one recorded price path against a parameter set.
 *
 * This is the counterfactual that realised P&L cannot give you: every paper trade used a
 * single parameter set, so comparing outcomes across trades confounds parameters with
 * market conditions. Replaying alternatives against an identical price history does not.
 *
 * Limit: the ladder can only act on sampled prices. An interval finer than the recording
 * interval is not evaluable — it would sell at stale prices and flatter itself.
 */
export function replay(meta: Meta, samples: Sample[], p: Params): Outcome {
  const t0 = samples[0]!.t;
  const tp = meta.entryPrice * (1 + p.takeProfitPct / 100);
  const feeMul = 1 - (p.platformFeePct + p.dexFeePct) / 100;

  let remaining = meta.tokenAmount, proceeds = 0, sells = 0;
  let laddering = false, stopAt = meta.entryPrice * (1 - p.stopLossPct / 100);
  let lastSell = -Infinity, reason = "open";
  let peak = -Infinity, trough = Infinity, heldSec = 0;

  const sell = (px: number, tokens: number) => {
    proceeds += tokens * px * feeMul; remaining -= tokens; sells++;
  };

  for (const s of samples) {
    const el = s.t - t0;
    heldSec = el;
    peak = Math.max(peak, s.pctFromEntry); trough = Math.min(trough, s.pctFromEntry);
    if (remaining <= 1e-9) break;

    if (el >= p.timeCutoffSeconds) { sell(s.price, remaining); reason = "time_cutoff"; break; }
    if (s.price <= stopAt) { sell(s.price, remaining); reason = laddering ? "breakeven_stop" : "stop_loss"; break; }

    if (s.price >= tp || laddering) {
      if (!laddering) { laddering = true; lastSell = -Infinity; }
      if (el - lastSell >= p.intervalSeconds) {
        const want = remaining * (p.sellPctOfRemainder / 100);
        if (want * s.price < p.minSliceUsd) { sell(s.price, remaining); reason = "ladder_swept"; break; }
        sell(s.price, want); lastSell = el; reason = "take_profit_ladder";
      }
    }
  }
  if (remaining > 1e-9) {
    const last = samples[samples.length - 1]!;
    sell(last.price, remaining);
    if (reason === "open") reason = "end_of_data";
  }
  return {
    reason, proceedsUsd: proceeds, pnlUsd: proceeds - meta.costUsd,
    pnlPct: (proceeds / meta.costUsd - 1) * 100, sells,
    peakPct: peak === -Infinity ? 0 : peak, troughPct: trough === Infinity ? 0 : trough, heldSec,
  };
}

export function paramsFrom(meta: Meta, over: Partial<Params> = {}): Params {
  return {
    takeProfitPct: meta.takeProfitPct, stopLossPct: meta.stopLossPct,
    // Defaults track config, not hardcoded copies of it — a stale 300s cutoff here silently
    // made every take-profit sweep answer a question about a bot that no longer exists.
    sellPctOfRemainder: config.exit.ladder.sellPctOfRemainder,
    intervalSeconds: config.exit.ladder.intervalSeconds,
    minSliceUsd: config.exit.ladder.minSliceUsd ?? 1,
    timeCutoffSeconds: config.exit.timeCutoffSeconds,
    platformFeePct: config.exit.breakevenStop.platformFeePctPerSwap,
    dexFeePct: config.exit.breakevenStop.dexFeePctPerSwap,
    breakevenAfterFirstSell: true, breakevenPrice: meta.breakevenPrice, ...over,
  };
}

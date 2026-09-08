import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.ts";
import { all as allPositions } from "./positions.ts";
import { liveBalanceUsd, balanceAt } from "./balance.ts";
import type { Chain } from "./types.ts";

const TRADES = resolve(import.meta.dirname, "..", "state", "trades.jsonl");

/**
 * Realised P&L and capital currently committed, per chain, for compounding paper sizing.
 *
 * Read from the trade ledger rather than held in memory so the balance survives a restart —
 * the runner is restarted often and an in-memory total would silently reset to the starting
 * stake. Shadow arms live in a separate file and cannot reach this, which is what keeps a
 * counterfactual from moving real sizing.
 */
function paperLedger(chain: Chain): { realised: number; committed: number } {
  let realised = 0;
  if (existsSync(TRADES)) {
    for (const line of readFileSync(TRADES, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line) as { chain?: string; realizedPnlUsd?: number };
        if (t.chain === chain && typeof t.realizedPnlUsd === "number") realised += t.realizedPnlUsd;
      } catch { /* a truncated final line is not worth failing sizing over */ }
    }
  }
  let committed = 0;
  for (const p of allPositions()) {
    if (p.chain === chain && p.status === "open" && !p.shadow && p.remainingAmount > 1e-9) committed += p.costUsd;
  }
  return { realised, committed };
}

interface ChainFunds { balanceUsd: number; gasReserveUsd: number; tradableUsd: number; source: "paper" | "live" }

/**
 * Capital cannot move between chains mid-trade, so each chain funds its own signals.
 * Sizing a signal off a combined total would try to spend money that isn't reachable.
 */
export function fundsFor(chain: Chain): ChainFunds | null {
  const pc = config.risk.portfolioValue.perChain?.[chain];
  if (!pc) return null;
  const paper = config.mode.dryRun;
  // The paper override is ignored the moment dryRun is false, so a paper figure
  // can never size a live trade.
  const gasReserveUsd = pc.gasReserveUsd ?? 0;
  if (!paper) {
    // The chain, refreshed on a timer, in preference to config. `lastKnownUsd` is a
    // hand-maintained number that nothing updates: it sat at $16.75 while the wallet held
    // something else entirely, and sizing off it would have refused every trade. It survives
    // only as the fallback for a wallet that has never been read.
    const live = liveBalanceUsd(chain) ?? pc.lastKnownUsd ?? 0;
    // Spending USDG does lower the real balance — but the sweep runs every 30 minutes and
    // positions last 2-7, so three can open against one stale reading and each size itself
    // off money the other two already spent. Subtract only what was committed AFTER the
    // snapshot: anything older is already missing from the figure, and taking it off twice
    // would shrink every position for the rest of the day.
    const since = balanceAt(chain) ?? 0;
    let uncounted = 0;
    for (const p of allPositions()) {
      if (p.chain === chain && p.status === "open" && !p.shadow
          && p.remainingAmount > 1e-9 && p.openedAt > since) uncounted += p.costUsd;
    }
    return {
      balanceUsd: live, gasReserveUsd,
      tradableUsd: Math.max(0, live - gasReserveUsd - uncounted),
      source: "live",
    };
  }
  // Compounding paper balance: the starting stake plus everything realised, minus whatever
  // is still tied up in open positions. Without the committed subtraction, three concurrent
  // positions would each be sized off money the other two had already spent.
  const start = pc.paperOverrideUsd ?? 0;
  const { realised, committed } = config.risk.paperCompounds === false
    ? { realised: 0, committed: 0 }
    : paperLedger(chain);
  const balanceUsd = start + realised;
  const available = Math.max(0, balanceUsd - gasReserveUsd - committed);
  return { balanceUsd, gasReserveUsd, tradableUsd: available, source: "paper" };
}

export interface Sizing {
  positionUsd: number;
  byPortfolio: number;
  byLiquidity: number | null;
  binding: "portfolio" | "liquidity" | "none";
  blocked: string | null;
}

/** Position size is the smaller of a portfolio share and a share of the pool's liquidity. */
export function sizePosition(chain: Chain, poolLiquidityUsd: number | null): Sizing {
  const funds = fundsFor(chain);
  if (!funds) return { positionUsd: 0, byPortfolio: 0, byLiquidity: null, binding: "none", blocked: `no funding configured for ${chain}` };

  /**
   * A FIXED position size, overriding the portfolio percentage.
   *
   * For proving a new execution stack with a known, small stake. The percentage cannot express
   * that on a small balance: at $10.93 tradable, 15% is $1.64, which falls under
   * minPositionSizeUsd and rejects every signal — so a test run would prove only that the
   * sizing gate works.
   *
   * Still bounded by tradableUsd and by the liquidity cap below, so it can shrink but never
   * exceed what the wallet actually has. Leave null for normal operation.
   */
  const fixed = (config.risk as { fixedPositionUsd?: number | null }).fixedPositionUsd ?? null;
  const byPortfolio = fixed !== null
    ? Math.min(fixed, funds.tradableUsd)
    : funds.tradableUsd * (config.risk.positionSizePctOfPortfolio / 100);
  const caps = config.entry.maxPositionPctOfLiquidity as Record<string, number>;
  const capPct = caps[chain] ?? caps["default"] ?? 2;
  const byLiquidity = poolLiquidityUsd === null ? null : poolLiquidityUsd * (capPct / 100);

  const positionUsd = byLiquidity === null ? byPortfolio : Math.min(byPortfolio, byLiquidity);
  const binding = byLiquidity !== null && byLiquidity < byPortfolio ? "liquidity" : "portfolio";

  let blocked: string | null = null;
  const min = config.risk.minPositionSizeUsd;
  if (min != null && positionUsd < min) {
    // Surfaced rather than silently skipped: a chain that can never fund a position
    // would otherwise look like a chain that never gets signals.
    blocked = `position ${positionUsd.toFixed(2)} < minPositionSizeUsd ${min} (${chain} tradable $${funds.tradableUsd.toFixed(2)})`;
  }
  return { positionUsd, byPortfolio, byLiquidity, binding, blocked };
}

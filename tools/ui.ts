/**
 * Local dashboard. READ ONLY, and a SEPARATE PROCESS from the bot.
 *
 *   node --experimental-strip-types tools/ui.ts              127.0.0.1:7777
 *   UI_HOST=0.0.0.0 UI_TOKEN=somesecret node ... tools/ui.ts LAN / Tailscale
 *
 * Three rules this file must keep, because it shares a directory with a program
 * that moves money:
 *
 *   1. It NEVER writes to state/. The bot owns those files and a concurrent
 *      write would corrupt the ledger it trades from.
 *   2. It never competes for API budget. Everything comes from state files
 *      except the live mark on an OPEN position, which is capped and cached —
 *      a diagnostic call once blocked an exit for 31 seconds and cost $3.87.
 *   3. It imports the bot's own modules rather than reimplementing them, so it
 *      shows what the BOT believes rather than a second opinion that can drift.
 *
 * Binding beyond localhost is opt-in and requires UI_TOKEN, because the page
 * shows balances and open positions — information someone could trade against.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const S = resolve(import.meta.dirname, "..", "state");
const HOST = process.env["UI_HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["UI_PORT"] ?? 7777);
const TOKEN = process.env["UI_TOKEN"] ?? "";
if (HOST !== "127.0.0.1" && HOST !== "localhost" && !TOKEN) {
  console.error("refusing to bind beyond localhost without UI_TOKEN set");
  process.exit(1);
}

const { config } = await import("../src/config.ts");
const { openPositions } = await import("../src/positions.ts");
const { checkBreaker } = await import("../src/breaker.ts");
const { fundsFor } = await import("../src/portfolio.ts");
const { dailyAnchor } = await import("../src/balance.ts");
const { nativeUsd } = await import("../src/live.ts");
const { currentGwei, roundTripsLeft, reserveUsdPerSwap } = await import("../src/gas.ts");
const { zeroExSwapTx } = await import("../src/router-0x.ts");
const { account } = await import("../src/signer.ts");

const CHAIN = "robinhood" as const;
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

interface Trade {
  closedAt: number; token: string; paper: boolean; shadow?: boolean; sourceWalletName: string;
  costUsd: number; realizedPnlUsd: number; realizedPnlPct: number; peakPct?: number;
  troughPct?: number; heldSec: number; reason: string; takeProfitPct: number; stopLossPct: number;
  /** Backfilled from gmgn's wallet activity — see tools/backfill-gas.ts. Undefined means
   *  unmeasured, which the UI shows as a dash rather than as zero. */
  entryGasUsd?: number; exitGasUsd?: number;
}
function trades(): Trade[] {
  try {
    return readFileSync(resolve(S, "trades.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as Trade)
      .filter((t) => t.paper === false && !t.shadow)
      .sort((a, b) => b.closedAt - a.closedAt);
  } catch { return []; }
}

/** Marks for OPEN positions only, cached hard. Usually zero calls: the book is normally flat. */
const markCache = new Map<string, { usd: number | null; at: number }>();
const MARK_TTL = 15_000;
async function mark(token: string, rawAmount: bigint, ethUsd: number): Promise<number | null> {
  const hit = markCache.get(token);
  if (hit && Date.now() - hit.at < MARK_TTL) return hit.usd;
  const tx = await zeroExSwapTx({
    chain: CHAIN, sellToken: token, buyToken: NATIVE,
    sellAmountRaw: rawAmount.toString(), slippageBps: 500, taker: account().address,
  }).catch(() => null);
  const usd = tx ? (Number(tx.buyAmount) / 1e18) * ethUsd : null;
  markCache.set(token, { usd, at: Date.now() });
  return usd;
}

async function state() {
  const ts = trades();
  const ethUsd = (await nativeUsd(CHAIN).catch(() => null)) ?? 0;
  const gwei = (await currentGwei(CHAIN).catch(() => null)) ?? 0;
  const funds = fundsFor(CHAIN);
  const bal = funds?.balanceUsd ?? 0;
  const anchor = dailyAnchor(CHAIN, bal);
  const reserve = await reserveUsdPerSwap(CHAIN, ethUsd).catch(() => null);
  const b = checkBreaker(anchor);

  let running = false, uptime = "";
  try {
    const pid = execSync("pgrep -f 'src/index.ts' | head -1", { encoding: "utf8" }).trim();
    if (pid) { running = true; uptime = execSync(`ps -o etime= -p ${pid}`, { encoding: "utf8" }).trim(); }
  } catch { /* not running */ }

  const open = openPositions();
  const openOut = [];
  for (const p of open) {
    const raw = BigInt(Math.floor(p.remainingAmount * 10 ** p.tokenDecimals));
    const m = raw > 0n ? await mark(p.token, raw, ethUsd) : 0;
    openOut.push({
      token: p.token, source: p.sourceWalletName, costUsd: p.costUsd,
      markUsd: m, pnlUsd: m == null ? null : m - p.costUsd,
      pnlPct: m == null ? 0 : (m / p.costUsd - 1) * 100,
      takeProfitPct: p.takeProfitPct, stopLossPct: p.stopLossPct,
      ageMin: Math.floor((Date.now() / 1000 - p.openedAt) / 60),
    });
  }

  /** Gas is only counted where it was actually measured, so a partial ledger cannot understate
   *  it into looking free. `gasKnown` says how much of the sample carries a figure. */
  const gasOf = (t: Trade) => (t.entryGasUsd === undefined && t.exitGasUsd === undefined)
    ? undefined : (t.entryGasUsd ?? 0) + (t.exitGasUsd ?? 0);
  const withGas = ts.filter((t) => gasOf(t) !== undefined);
  const totalGas = withGas.reduce((a, t) => a + (gasOf(t) as number), 0);

  const day = Date.now() / 1000 - 86400;
  const today = ts.filter((t) => t.closedAt >= day);
  const wins = ts.filter((t) => t.realizedPnlUsd > 0).length;
  const holds = ts.map((t) => t.heldSec).sort((a, b) => a - b);
  const byWallet = [...ts.reduce((m, t) => {
    const e = m.get(t.sourceWalletName) ?? { name: t.sourceWalletName, n: 0, pnl: 0, w: 0 };
    e.n++; e.pnl += t.realizedPnlUsd; if (t.realizedPnlUsd > 0) e.w++;
    return m.set(t.sourceWalletName, e);
  }, new Map<string, { name: string; n: number; pnl: number; w: number }>()).values()]
    .map((e) => ({ ...e, winPct: e.w / e.n * 100, avg: e.pnl / e.n })).sort((a, b) => b.pnl - a.pnl);
  const byReason = [...ts.reduce((m, t) => {
    const e = m.get(t.reason) ?? { reason: t.reason, n: 0, pnl: 0, sum: 0 };
    e.n++; e.pnl += t.realizedPnlUsd; e.sum += t.realizedPnlPct;
    return m.set(t.reason, e);
  }, new Map<string, { reason: string; n: number; pnl: number; sum: number }>()).values()]
    .map((e) => ({ ...e, avgPct: e.sum / e.n })).sort((a, b) => b.n - a.n);

  return {
    process: { running, uptime },
    wallet: {
      balanceUsd: bal, tradableUsd: funds?.tradableUsd ?? 0, gasReserveUsd: funds?.gasReserveUsd ?? 0,
      ethUsd, gwei, nativeEth: ethUsd ? bal / ethUsd : 0,
      roundTrips: roundTripsLeft(bal, reserve),
    },
    anchor,
    breaker: {
      tripped: b.tripped, reasons: b.reasons, consecutiveLosses: b.consecutiveLosses,
      windowPnlPct: b.windowPnlPct,
      maxConsecutiveLosses: (config.risk.circuitBreaker as { maxConsecutiveLosses?: number }).maxConsecutiveLosses ?? 0,
    },
    config: {
      positionUsd: (config.risk as { fixedPositionUsd?: number }).fixedPositionUsd ?? null,
      maxConcurrent: config.risk.maxConcurrentPositions,
      wallets: (await import("../src/config.ts")).wallets.length,
      router: (config.execution as { router?: string }).router ?? "?",
    },
    open: openOut,
    stats: {
      n: ts.length, netUsd: ts.reduce((a, t) => a + t.realizedPnlUsd, 0), wins,
      winPct: ts.length ? wins / ts.length * 100 : 0,
      todayUsd: today.reduce((a, t) => a + t.realizedPnlUsd, 0), todayN: today.length,
      avgUsd: ts.length ? ts.reduce((a, t) => a + t.realizedPnlUsd, 0) / ts.length : 0,
      medianHold: holds.length ? holds[holds.length >> 1] : 0,
      // realizedPnlUsd is already NET of gas, so gross is net + gas rather than the reverse.
      totalGasUsd: totalGas,
      grossUsd: ts.reduce((a, t) => a + t.realizedPnlUsd, 0) + totalGas,
      gasKnown: withGas.length,
      todayGasUsd: today.reduce((a, t) => a + (gasOf(t) ?? 0), 0),
    },
    trades: ts.map((t) => ({
      when: new Date(t.closedAt * 1000).toISOString().slice(5, 16).replace("T", " "),
      token: t.token, source: t.sourceWalletName, costUsd: t.costUsd,
      pnlUsd: t.realizedPnlUsd, pnlPct: t.realizedPnlPct,
      peakPct: t.peakPct ?? null, troughPct: t.troughPct ?? null,
      takeProfitPct: t.takeProfitPct, stopLossPct: t.stopLossPct,
      reason: t.reason, heldSec: t.heldSec,
      gasUsd: gasOf(t) ?? null,
    })),
    byWallet, byReason,
    meta: { note: `${open.length} open · marks cached ${MARK_TTL / 1000}s` },
  };
}

const PAGE = readFileSync(resolve(import.meta.dirname, "ui.html"), "utf8");

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (TOKEN && url.searchParams.get("t") !== TOKEN) {
    res.writeHead(401, { "content-type": "text/plain" }); res.end("unauthorized"); return;
  }
  if (url.pathname === "/api/state") {
    try {
      const body = JSON.stringify(await state());
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String((e as Error).message) }));
    }
    return;
  }
  if (url.pathname === "/" ) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); return;
  }
  res.writeHead(404); res.end("not found");
}).listen(PORT, HOST, () => {
  const q = TOKEN ? `?t=${TOKEN}` : "";
  console.log(`dashboard  http://${HOST === "0.0.0.0" ? "<this-machine>" : HOST}:${PORT}/${q}`);
  console.log(`read-only, separate process — killing it cannot affect the bot`);
});

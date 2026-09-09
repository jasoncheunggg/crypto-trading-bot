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
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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

/**
 * Token symbols, resolved on chain and cached for the process lifetime.
 *
 * The ledger stores addresses, never names — correct, because a symbol is a mutable label and
 * an address is the thing itself. But a table of 0x3df3… tells you nothing about WHAT was
 * traded, so the UI resolves them for display only.
 *
 * One eth_call per token ever seen, ~26 CU, then never again. Kept in memory rather than
 * written anywhere: this file's rule is that it never writes to state/, and a cache that
 * rebuilds in a second is not worth breaking that for.
 */
const symbols = new Map<string, string>();
function decodeSymbol(hex: string): string | null {
  if (!hex || hex === "0x") return null;
  const b = hex.slice(2);
  try {
    // ABI dynamic string: offset, length, then the bytes.
    if (b.length >= 128) {
      const len = parseInt(b.slice(64, 128), 16);
      if (len > 0 && len <= 64) {
        const raw = Buffer.from(b.slice(128, 128 + len * 2), "hex").toString("utf8").replace(/\0/g, "").trim();
        if (raw) return raw;
      }
    }
    // bytes32 symbols, which predate the string convention and still exist.
    const raw = Buffer.from(b.slice(0, 64), "hex").toString("utf8").replace(/\0/g, "").trim();
    return /^[\x20-\x7e]{1,32}$/.test(raw) ? raw : null;
  } catch { return null; }
}
async function symbolOf(token: string): Promise<string | null> {
  const k = token.toLowerCase();
  if (symbols.has(k)) return symbols.get(k) ?? null;
  const { rpc } = await import("../src/rpc.ts");
  const hex = await rpc<string>(CHAIN, "eth_call", [{ to: token, data: "0x95d89b41" }, "latest"]).catch(() => null);
  const sym = hex ? decodeSymbol(hex) : null;
  symbols.set(k, sym ?? "");
  return sym;
}

/** Which take-profit band a market cap falls in, as a readable label. */
function tierLabel(mcap: number): string {
  const tiers = config.exit.takeProfitTiers as { maxMarketCapUsd: number; takeProfitPct: number }[];
  let lo = 0;
  for (const t of tiers) {
    if (mcap < t.maxMarketCapUsd) return `${fmtMc(lo)}-${fmtMc(t.maxMarketCapUsd)}`;
    lo = t.maxMarketCapUsd;
  }
  return `>${fmtMc(lo)}`;
}
const fmtMc = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`
  : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

interface Trade {
  closedAt: number; token: string; paper: boolean; shadow?: boolean; sourceWalletName: string;
  costUsd: number; proceedsUsd?: number; realizedPnlUsd: number; realizedPnlPct: number; peakPct?: number;
  entryMarketCapUsd?: number;
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
      symbol: (await symbolOf(p.token)) || null,
      mcapUsd: p.entryMarketCapUsd, tier: tierLabel(p.entryMarketCapUsd),
      ageMin: Math.floor((Date.now() / 1000 - p.openedAt) / 60),
    });
  }

  /** Gas is only counted where it was actually measured, so a partial ledger cannot understate
   *  it into looking free. `gasKnown` says how much of the sample carries a figure. */
  const gasOf = (t: Trade) => (t.entryGasUsd === undefined && t.exitGasUsd === undefined)
    ? undefined : (t.entryGasUsd ?? 0) + (t.exitGasUsd ?? 0);
  const withGas = ts.filter((t) => gasOf(t) !== undefined);
  const totalGas = withGas.reduce((a, t) => a + (gasOf(t) as number), 0);

  /**
   * Realised losses the ledger never recorded.
   *
   * `stuckRecord` zeroes P&L on a stuck trade so an unsold position cannot book an imaginary
   * loss and trip the breaker — correct for the BREAKER, wrong for a P&L headline.
   *
   * Both were later sold by hand, so nothing is outstanding, but the sales recovered almost
   * nothing: GRASS bought at $30.16 sold for $0.0140, and the honeypot at $30.19 sold for
   * $0.0004. About 1.4 cents of $61.96 came back. The positions closed; the money did not
   * return, and those sales happened outside the bot so no trade record exists for them.
   *
   * Counted only where the bot's own proceeds were zero, so a stuck position the bot later
   * sold itself is not double-counted against the record it already wrote.
   */
  const stuckLost = ts.filter((t) => t.reason === "stuck" && (t.proceedsUsd ?? 0) === 0)
    .reduce((a, t) => a + t.costUsd, 0);

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
      unrecordedLossUsd: stuckLost,
      trueNetUsd: ts.reduce((a, t) => a + t.realizedPnlUsd, 0) - stuckLost,
      todayGasUsd: today.reduce((a, t) => a + (gasOf(t) ?? 0), 0),
    },
    trades: await Promise.all(ts.map(async (t) => ({
      when: new Date(t.closedAt * 1000).toISOString().slice(5, 16).replace("T", " "),
      token: t.token, source: t.sourceWalletName, costUsd: t.costUsd,
      pnlUsd: t.realizedPnlUsd, pnlPct: t.realizedPnlPct,
      peakPct: t.peakPct ?? null, troughPct: t.troughPct ?? null,
      takeProfitPct: t.takeProfitPct, stopLossPct: t.stopLossPct,
      reason: t.reason, heldSec: t.heldSec,
      gasUsd: gasOf(t) ?? null,
      symbol: (await symbolOf(t.token)) || null,
      mcapUsd: t.entryMarketCapUsd ?? null,
      tier: t.entryMarketCapUsd ? tierLabel(t.entryMarketCapUsd) : null,
    }))),
    byWallet, byReason,
    rejections: await Promise.all(rejections().map(async (r) => ({ ...r, symbol: (await symbolOf(r.token)) || null }))),
    tunables: tunables(),
    meta: { note: `${open.length} open · marks cached ${MARK_TTL / 1000}s` },
  };
}

/**
 * Signals the bot REFUSED, parsed from its own log.
 *
 * Rejections exist nowhere else: trades.jsonl records what was taken, and the reasoning behind
 * everything skipped lives only in the runner output. That reasoning is the more informative
 * half — a gate that never fires is not protecting anything, and one that fires constantly is
 * probably miscalibrated.
 *
 * Only BUY verdicts are returned. The overwhelming majority of skips are airdrop spam arriving
 * at tracked wallets (RECEIVED, not via a router, $0.00), and listing hundreds of those would
 * bury the handful of real near-misses.
 *
 * Reads the tail of the most recently written log, bounded, and never writes.
 */
interface Rejection {
  when: string; wallet: string; verdict: string; token: string; sizeUsd: number | null;
  mcap: string | null; reason: string; kind: "skip" | "abort";
}
function rejections(limit = 120): Rejection[] {
  let file = "", best = 0;
  for (const f of readdirSync(S)) {
    if (!f.endsWith(".log") || f.startsWith("record-") || f === "alerts.log" || f === "ui.log") continue;
    const st = statSync(resolve(S, f));
    if (st.mtimeMs > best) { best = st.mtimeMs; file = f; }
  }
  if (!file) return [];
  let text = "";
  try {
    const fd = readFileSync(resolve(S, file));
    text = fd.subarray(Math.max(0, fd.length - 2_000_000)).toString("utf8");
  } catch { return []; }

  const out: Rejection[] = [];
  const head = /^\[(\S+ \S+)\] (@\S+) \(evm\)\s+\[robinhood\]\s+(\w+)/;
  let cur: Partial<Rejection> | null = null;
  for (const line of text.split("\n")) {
    const m = head.exec(line);
    if (m) { cur = { when: m[1]!.slice(5, 16), wallet: m[2]!, verdict: m[3]! }; continue; }
    if (!cur) continue;
    const t = line.trim();
    if (t.startsWith("token   0x")) cur.token = t.split(/\s+/).pop();
    else if (t.startsWith("signal")) {
      const q = /\$([\d,]+\.?\d*)/.exec(t);
      cur.sizeUsd = t.includes("nothing paid") ? 0 : q ? parseFloat(q[1]!.replace(/,/g, "")) : null;
    } else if (t.startsWith("mcap")) {
      const q = /\$([\d,]+\.?\d*)/.exec(t); cur.mcap = q ? q[1]! : null;
    } else if (t.startsWith("ACTION  skip") || t.startsWith("ACTION  abort")) {
      if (cur.verdict === "BUY" && cur.token) {
        out.push({
          when: cur.when!, wallet: cur.wallet!, verdict: cur.verdict!, token: cur.token,
          sizeUsd: cur.sizeUsd ?? null, mcap: cur.mcap ?? null,
          kind: t.startsWith("ACTION  abort") ? "abort" : "skip",
          reason: t.replace(/^ACTION\s+(skip|abort)\s+—\s*/, "").trim(),
        });
      }
      cur = null;
    }
  }
  return out.reverse().slice(0, limit);
}

/** The knobs, read live from config so the page can never disagree with what the bot is using. */
function tunables() {
  const e = config.entry as Record<string, unknown>;
  const r = config.risk as Record<string, unknown>;
  const x = config.exit as Record<string, unknown>;
  const pc = (r.portfolioValue as { perChain?: Record<string, { gasReserveUsd?: number }> })?.perChain?.[CHAIN];
  return {
    tiers: (x.takeProfitTiers as { maxMarketCapUsd: number; takeProfitPct: number }[])
      .map((t, i, a) => ({
        band: `${fmtMc(i ? a[i - 1]!.maxMarketCapUsd : 0)}-${fmtMc(t.maxMarketCapUsd)}`,
        takeProfitPct: t.takeProfitPct,
      })),
    groups: [
      { name: "sizing", rows: [
        ["fixed position", (r.fixedPositionUsd as number | null) === null ? "off" : `$${r.fixedPositionUsd}`],
        ["% of portfolio", `${r.positionSizePctOfPortfolio}%`],
        ["min position", `$${r.minPositionSizeUsd}`],
        ["max concurrent", String(r.maxConcurrentPositions)],
        ["gas reserve", `$${pc?.gasReserveUsd ?? "?"}`],
      ] },
      { name: "exit", rows: [
        ["stop loss", `-${r.stopLossPct}%`],
        ["time cutoff", `${x.timeCutoffSeconds ?? (x as { cutoffSeconds?: number }).cutoffSeconds ?? "?"}s`],
        ["ladder", `${(x.ladder as { sellPctOfRemainder?: number })?.sellPctOfRemainder}% every ${(x.ladder as { intervalSeconds?: number })?.intervalSeconds}s`],
        ["breakeven stop", (x.breakevenStop as { enabled?: boolean })?.enabled ? "on" : "off"],
        ["gas per swap (est)", `$${(x.breakevenStop as { gasUsdPerSwap?: number })?.gasUsdPerSwap}`],
      ] },
      { name: "entry gates", rows: [
        ["min signal size", `$${e.minTradeUsd}`],
        ["min pool liquidity", `$${e.minPoolLiquidityUsd}`],
        ["mcap floor / ceiling", `$${e.marketCapFloorUsd} / $${Number(e.marketCapCeilingUsd).toLocaleString()}`],
        ["re-entry cooldown", `${((e.dedupe as { tokenReentry?: { cooldownMinutes?: number } })?.tokenReentry?.cooldownMinutes) ?? 0}m`],
        ["max positions / token", String((e.dedupe as { tokenReentry?: { maxPositionsPerToken?: number } })?.tokenReentry?.maxPositionsPerToken ?? "?")],
      ] },
      { name: "slippage", rows: [
        ["swap tolerance", `${e.swapSlippageTolerancePct}%`],
        ["vs signal price", `${e.maxSlippagePctVsSignalPrice}%`],
        ...((e.maxSlippagePctByMarketCap as { maxMarketCapUsd: number; pct: number }[]) ?? [])
          .map((b) => [`  below ${fmtMc(b.maxMarketCapUsd)} mcap`, `${b.pct}%`] as [string, string]),
        ...((e.maxSlippagePctBySignalMarketCap as { maxSignalMarketCapUsd: number; pct: number }[]) ?? [])
          .map((b) => [`  their fill under ${fmtMc(b.maxSignalMarketCapUsd)}`, `${b.pct}%`] as [string, string]),
      ] },
      { name: "circuit breaker", rows: Object.entries(r.circuitBreaker as Record<string, unknown>)
        .filter(([k, v]) => !k.endsWith("Note") && typeof v !== "object")
        .map(([k, v]) => [k.replace(/([A-Z])/g, " $1").toLowerCase(), String(v)] as [string, string]) },
    ],
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

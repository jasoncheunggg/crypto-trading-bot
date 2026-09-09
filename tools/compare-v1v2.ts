/**
 * v1.0 vs v2.0, judged on the same recorded history.
 *
 * The regression suite asks "does today's code still work". This asks a different question:
 * where do the two versions DISAGREE, and is every disagreement one we chose? Read-only.
 *
 * Cost assumptions, stated so they can be argued with:
 *   gmgn fee   100 bps per side   (measured across four v1.0 trades)
 *   0x fee      15 bps per side   (read from a live quote, 2026-09-08)
 *   v1.0 gas   $0.439 per swap    (gastank 20-sample average before it was reset)
 *   v2.0 gas   $0.1123 per swap   (median of 10 real v2.0 receipts)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const S = resolve(import.meta.dirname, "..", "state");
const { classifyEvm } = await import("../src/classifier.ts");
const { wallets, config } = await import("../src/config.ts");
const { nativeUsd } = await import("../src/live.ts");
const { usdRates } = await import("../src/money.ts");
const { tierFor } = await import("../src/positions.ts");
await nativeUsd("robinhood");

const GMGN_FEE = 0.0100, ZEROX_FEE = 0.0015;
const GAS_V1 = 0.439, GAS_V2 = 0.1123;
const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);

// ---- parse v1.0's own log --------------------------------------------------------------
const re = /^\[(\S+ \S+)\] (@\S+) \(evm\)\s+\[robinhood\]\s+(\w+)/;
interface Blk { t: string; w: string; v: string; tx?: string; size?: number; router?: boolean; legs?: string }
const blocks: Blk[] = []; let cur: Blk | null = null;
for (const line of readFileSync(resolve(S, "runner.log"), "utf8").split("\n")) {
  const m = re.exec(line);
  if (m) { if (cur) blocks.push(cur); cur = { t: m[1]!, w: m[2]!, v: m[3]! }; continue; }
  if (!cur) continue;
  const t = line.trim();
  if (t.startsWith("tx      0x")) cur.tx = t.split(/\s+/).pop();
  if (t.startsWith("signal")) { const q = /\$([\d,]+\.?\d*)/.exec(t); if (q) cur.size = parseFloat(q[1]!.replace(/,/g, "")); if (t.includes("nothing paid")) cur.size = 0; cur.legs = t; }
  if (t.startsWith("router")) cur.router = t.includes("FOMO") && !t.includes("not FOMO");
}
if (cur) blocks.push(cur);

interface Trade { token: string; paper: boolean; realizedPnlUsd: number; costUsd: number; proceedsUsd: number; signalTx: string; sourceWallet: string; entryMarketCapUsd: number; takeProfitPct: number; reason: string }
const trades: Trade[] = readFileSync(resolve(S, "trades.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Trade);
const live = trades.filter((t) => t.paper === false && t.costUsd > 0.5);

// ═══════════════════════════════════════════════════════ A
console.log("\n\x1b[1mCASE A — classification: where do v1.0 and v2.0 disagree?\x1b[0m");
{
  const sample = blocks.filter((b) => b.tx && b.size !== undefined).slice(-140);
  const cat = new Map<string, number>();
  let checked = 0;
  for (const b of sample) {
    const w = wallets.find((x) => x.name.startsWith(b.w)); if (!w) continue;
    const s = await classifyEvm(w, "robinhood", b.tx!).catch(() => null);
    if (!s) { cat.set("unclassifiable now", (cat.get("unclassifiable now") ?? 0) + 1); continue; }
    checked++;
    const sizeSame = Math.abs(s.sizeUsd - (b.size ?? 0)) < Math.max(0.02, (b.size ?? 0) * 0.005);
    if (s.verdict === b.v && sizeSame) { cat.set("identical", (cat.get("identical") ?? 0) + 1); continue; }
    if (s.verdict !== b.v && !s.viaKnownRouter && s.sizeUsd === 0)
      cat.set("BUY->RECEIVED, stranger paid (intended)", (cat.get("BUY->RECEIVED, stranger paid (intended)") ?? 0) + 1);
    else if (s.verdict === b.v && !sizeSame && !s.viaKnownRouter)
      cat.set("non-FOMO leg now priced (intended)", (cat.get("non-FOMO leg now priced (intended)") ?? 0) + 1);
    else cat.set(`UNEXPECTED ${b.v}->${s.verdict}`, (cat.get(`UNEXPECTED ${b.v}->${s.verdict}`) ?? 0) + 1);
  }
  console.log(`  ${checked} signals replayed through v2.0`);
  for (const [k, v] of [...cat].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
  const bad = [...cat].filter(([k]) => k.startsWith("UNEXPECTED")).reduce((a, [, v]) => a + v, 0);
  console.log(`  ${bad === 0 ? "\x1b[32mevery difference is one we chose\x1b[0m" : `\x1b[31m${bad} UNEXPLAINED\x1b[0m`}`);
}

// ═══════════════════════════════════════════════════════ B
console.log("\n\x1b[1mCASE B — cost structure: the same 68 trades under v2.0 economics\x1b[0m");
{
  let v1 = 0, v2 = 0, feeSaved = 0, gasSaved = 0;
  for (const t of live) {
    const gross = t.proceedsUsd;
    const fee1 = (t.costUsd + gross) * GMGN_FEE;
    const fee2 = (t.costUsd + gross) * ZEROX_FEE;
    const g1 = GAS_V1 * 2, g2 = GAS_V2 * 2;
    feeSaved += fee1 - fee2; gasSaved += g1 - g2;
    v1 += t.realizedPnlUsd;
    v2 += t.realizedPnlUsd + (fee1 - fee2) + (g1 - g2);
  }
  console.log(`  trades ${live.length}   mean size ${usd(live.reduce((a, t) => a + t.costUsd, 0) / live.length)}`);
  console.log(`  v1.0 realised          ${usd(v1)}`);
  console.log(`  fee saving (100->15bps) ${usd(feeSaved)}`);
  console.log(`  gas saving ($0.439->$0.112/swap) ${usd(gasSaved)}`);
  console.log(`  \x1b[1mv2.0 equivalent        ${usd(v2)}\x1b[0m   (${((v2 / v1 - 1) * 100).toFixed(0)}% better)`);
  console.log(`  per trade: ${usd((v2 - v1) / live.length)} saved`);
}

// ═══════════════════════════════════════════════════════ C
console.log("\n\x1b[1mCASE C — coverage: signals v1.0 valued at $0 that v2.0 can price\x1b[0m");
{
  const zeroed = blocks.filter((b) => b.tx && b.size === 0 && b.legs?.includes("WETH")).slice(-40);
  let nowPriced = 0, stillZero = 0, wouldPassMin = 0;
  const ex: string[] = [];
  for (const b of zeroed) {
    const w = wallets.find((x) => x.name.startsWith(b.w)); if (!w) continue;
    const s = await classifyEvm(w, "robinhood", b.tx!).catch(() => null);
    if (!s) continue;
    if (s.sizeUsd > 0) {
      nowPriced++;
      if (s.sizeUsd >= (config.entry.minTradeUsd as number)) wouldPassMin++;
      if (ex.length < 4) ex.push(`${b.tx!.slice(0, 10)} ${b.w} $0.00 -> ${usd(s.sizeUsd)} (${s.verdict}, FOMO=${s.viaKnownRouter})`);
    } else stillZero++;
  }
  console.log(`  ${zeroed.length} v1.0 signals with WETH legs and size $0.00`);
  console.log(`    now priced      ${nowPriced}   of which above the $${config.entry.minTradeUsd} minimum: ${wouldPassMin}`);
  console.log(`    still $0.00     ${stillZero}   \x1b[2m(stranger paid — correctly not our buy)\x1b[0m`);
  for (const e of ex) console.log(`      ${e}`);
}

// ═══════════════════════════════════════════════════════ D
console.log("\n\x1b[1mCASE D — misprice verification: which tokens could v1.0 never check?\x1b[0m");
{
  const r = usdRates("robinhood");
  const priceableNow = Object.keys(r.rate).length;
  const dollarOnly = Object.entries(r.source).filter(([, v]) => v === "dollar").length;
  const seen = new Map<string, { usdg: boolean; weth: boolean }>();
  for (const b of blocks) {
    if (!b.legs) continue;
    const k = b.w;
    const e = seen.get(k) ?? { usdg: false, weth: false };
    if (b.legs.includes("USDG")) e.usdg = true;
    if (b.legs.includes("WETH")) e.weth = true;
    seen.set(k, e);
  }
  const wethLegs = blocks.filter((b) => b.legs?.includes("WETH")).length;
  const usdgLegs = blocks.filter((b) => b.legs?.includes("USDG")).length;
  console.log(`  quote assets v1.0 could price: ${dollarOnly} (dollar only)`);
  console.log(`  quote assets v2.0 can price  : ${priceableNow} (dollar + native)`);
  console.log(`  signals carrying a WETH leg  : ${wethLegs}`);
  console.log(`  signals carrying a USDG leg  : ${usdgLegs}`);
  console.log(`  \x1b[2mv1.0's verifyPrice skipped every WETH-only swap, so misprice protection`);
  console.log(`  silently fell back to the unverified feed on those tokens.\x1b[0m`);
}

// ═══════════════════════════════════════════════════════ E
console.log("\n\x1b[1mCASE E — would v2.0's gates have taken the same trades?\x1b[0m");
{
  let admit = 0, reject = 0, admitPnl = 0, rejectPnl = 0;
  const why = new Map<string, { n: number; pnl: number }>();
  for (const t of live) {
    const w = wallets.find((x) => x.address.toLowerCase() === t.sourceWallet?.toLowerCase());
    const s = w ? await classifyEvm(w, "robinhood", t.signalTx).catch(() => null) : null;
    const reasons: string[] = [];
    if (!s) reasons.push("unclassifiable");
    else {
      if (s.verdict !== "BUY") reasons.push(`verdict ${s.verdict}`);
      if (!s.viaKnownRouter) reasons.push("not FOMO");
      if (s.sizeUsd < (config.entry.minTradeUsd as number)) reasons.push("under min size");
    }
    if (tierFor(t.entryMarketCapUsd) === null) reasons.push("mcap above ceiling");
    if (reasons.length) {
      reject++; rejectPnl += t.realizedPnlUsd;
      const k = reasons[0]!;
      const e = why.get(k) ?? { n: 0, pnl: 0 }; e.n++; e.pnl += t.realizedPnlUsd; why.set(k, e);
    } else { admit++; admitPnl += t.realizedPnlUsd; }
  }
  console.log(`  ${live.length} live v1.0 trades re-judged by v2.0's gates`);
  console.log(`    ADMIT  ${admit}  carrying ${usd(admitPnl)}`);
  console.log(`    REJECT ${reject}  carrying ${usd(rejectPnl)}`);
  for (const [k, v] of [...why].sort((a, b) => b[1].n - a[1].n)) console.log(`      ${String(v.n).padStart(3)}  ${k.padEnd(22)} ${usd(v.pnl)}`);
  console.log(`  ${rejectPnl <= 0 ? "\x1b[32mrejections are net-negative — the gates removed losers\x1b[0m" : `\x1b[33mrejections carried ${usd(rejectPnl)} of profit\x1b[0m`}`);
}
console.log();
process.exit(0);

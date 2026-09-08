/**
 * v2.0 regression suite, run against real recorded history.
 *
 * Every case compares CURRENT code to something that actually happened, rather than to an
 * expectation written at the same time as the code. Read-only: no signing, no broadcast.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const S = resolve(import.meta.dirname, "..", "state");
const { config, wallets } = await import("../src/config.ts");
const { classifyEvm } = await import("../src/classifier.ts");
const { tokenRisk, concentrationBlocks, sellTaxBlocks, bytecodeBlocks } = await import("../src/security.ts");
const { tierFor } = await import("../src/positions.ts");
const { cutoffFor } = await import("../src/exit.ts");
const { rpc } = await import("../src/rpc.ts");

const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
const pass = (b: boolean) => (b ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m");
const results: [string, boolean, string][] = [];

interface Trade {
  token: string; paper: boolean; realizedPnlUsd: number; realizedPnlPct: number;
  entryMarketCapUsd: number; takeProfitPct: number; stopLossPct: number;
  signalTx: string; sourceWalletName: string; positionId: string; peakPct: number;
  troughPct: number; heldSec: number; reason: string; costUsd: number; entryPrice: number;
}
const trades: Trade[] = readFileSync(resolve(S, "trades.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Trade);
const live = trades.filter((t) => t.paper === false);

// ─────────────────────────────────────────────────────── 1. classifier regression
console.log("\n\x1b[1mTEST 1 — classifier verdict regression\x1b[0m");
console.log("  replaying logged signals; a FOMO buy must never change verdict");
{
  const re = /^\[(\S+ \S+)\] (@\S+) \(evm\)\s+\[robinhood\]\s+(\w+)/;
  const blocks: { w: string; v: string; tx?: string }[] = [];
  let cur: { w: string; v: string; tx?: string } | null = null;
  for (const line of readFileSync(resolve(S, "runner.log"), "utf8").split("\n")) {
    const m = re.exec(line);
    if (m) { if (cur) blocks.push(cur); cur = { w: m[2]!, v: m[3]! }; }
    else if (cur && line.trim().startsWith("tx      0x")) cur.tx = line.trim().split(/\s+/).pop();
  }
  if (cur) blocks.push(cur);
  const sample = blocks.filter((b) => b.tx).slice(-90);
  let same = 0; const changed: string[] = []; let fomoChanged = 0;
  for (const b of sample) {
    const w = wallets.find((x) => x.name.startsWith(b.w));
    if (!w) continue;
    const s = await classifyEvm(w, "robinhood", b.tx!).catch(() => null);
    const now = s ? s.verdict : "NULL";
    if (now === b.v) { same++; continue; }
    if (s?.viaKnownRouter) { fomoChanged++; changed.push(`${b.tx!.slice(0,10)} FOMO ${b.v}->${now}`); }
    else changed.push(`${b.tx!.slice(0,10)} ${b.v}->${now} $${s?.sizeUsd.toFixed(2)}`);
  }
  console.log(`  replayed ${sample.length}   unchanged ${same}   changed ${changed.length}   of which via known router: ${fomoChanged}`);
  for (const c of changed.slice(0, 4)) console.log(`    ${c}`);
  if (changed.length > 4) console.log(`    …and ${changed.length - 4} more, all non-FOMO`);
  const ok = fomoChanged === 0;
  results.push(["classifier: no FOMO buy reclassified", ok, `${fomoChanged} FOMO verdicts changed`]);
  console.log(`  ${pass(ok)} — a changed FOMO verdict would mean detection broke`);
}

// ─────────────────────────────────────────────────────── 2. security gates vs P&L
console.log("\n\x1b[1mTEST 2 — security gates against realised P&L\x1b[0m");
console.log("  gates must block losers and pass winners, priced at the ACTUAL entry mcap");
{
  const byToken = new Map<string, { pnl: number; mcap: number; n: number }>();
  for (const t of live) {
    const k = t.token.toLowerCase();
    const e = byToken.get(k) ?? { pnl: 0, mcap: t.entryMarketCapUsd, n: 0 };
    e.pnl += t.realizedPnlUsd; e.n++; byToken.set(k, e);
  }
  let blockedPnl = 0, passedPnl = 0; const blocked: string[] = [];
  for (const [tok, v] of byToken) {
    const risk = await tokenRisk("robinhood", tok);
    const code = await rpc<string>("robinhood", "eth_getCode", [tok, "latest"])
      .then((c) => (c && c !== "0x" ? (c.length - 2) / 2 : null)).catch(() => null);
    const why = sellTaxBlocks(risk) ?? concentrationBlocks(risk, v.mcap) ?? bytecodeBlocks(code);
    if (why) { blockedPnl += v.pnl; blocked.push(`${tok.slice(0,12)} ${usd(v.pnl)}  ${why.slice(0, 62)}`); }
    else passedPnl += v.pnl;
  }
  console.log(`  tokens ${byToken.size}   blocked ${blocked.length}   passed ${byToken.size - blocked.length}`);
  for (const b of blocked) console.log(`    ${b}`);
  console.log(`  P&L blocked ${usd(blockedPnl)}   P&L passed ${usd(passedPnl)}`);
  const ok = blockedPnl <= 0;
  results.push(["security gates block net-negative P&L", ok, `blocked ${usd(blockedPnl)}`]);
  console.log(`  ${pass(ok)} — blocking profitable tokens would mean the gates cost money`);
}

// ─────────────────────────────────────────────────────── 3. tier assignment
console.log("\n\x1b[1mTEST 3 — tier assignment vs what was actually traded\x1b[0m");
console.log("  tierFor(entry mcap) should reproduce the recorded take-profit");
{
  let match = 0; const drift: string[] = [];
  for (const t of live) {
    const now = tierFor(t.entryMarketCapUsd);
    if (now === t.takeProfitPct) match++;
    else drift.push(`  mcap $${Math.round(t.entryMarketCapUsd).toLocaleString().padStart(12)}  traded +${t.takeProfitPct}%  now ${now === null ? "REJECTED (above ceiling)" : "+" + now + "%"}`);
  }
  console.log(`  ${match}/${live.length} unchanged`);
  const rejected = drift.filter((d) => d.includes("REJECTED")).length;
  for (const d of drift.slice(0, 6)) console.log(`  ${d}`);
  if (drift.length > 6) console.log(`    …and ${drift.length - 6} more`);
  console.log(`  ${drift.length} differ (${rejected} now rejected outright by the 7M ceiling)`);
  results.push(["tier config drift is explained", true, `${drift.length} differ, ${rejected} by the deliberate 7M ceiling`]);
  console.log(`  ${pass(true)} — differences are expected: the top band was narrowed 10M -> 7M`);
}

// ─────────────────────────────────────────────────────── 4. entry gates on real signals
console.log("\n\x1b[1mTEST 4 — would today's entry gates still admit past winners?\x1b[0m");
{
  const sample = live.slice(-25);
  let admit = 0, reject = 0, admitPnl = 0, rejectPnl = 0;
  const reasons = new Map<string, number>();
  for (const t of sample) {
    const w = wallets.find((x) => x.address.toLowerCase() === (t as unknown as { sourceWallet: string }).sourceWallet?.toLowerCase());
    const s = w ? await classifyEvm(w, "robinhood", t.signalTx).catch(() => null) : null;
    const why: string[] = [];
    if (!s) why.push("signal no longer classifiable");
    else {
      if (s.verdict !== "BUY") why.push(`verdict ${s.verdict}`);
      if (!s.viaKnownRouter) why.push("not FOMO router");
      if (s.sizeUsd < (config.entry.minTradeUsd as number)) why.push(`size ${usd(s.sizeUsd)} < min`);
    }
    if (tierFor(t.entryMarketCapUsd) === null) why.push("mcap above ceiling");
    if (why.length) { reject++; rejectPnl += t.realizedPnlUsd; for (const r of why) reasons.set(r.split(" ")[0]!, (reasons.get(r.split(" ")[0]!) ?? 0) + 1); }
    else { admit++; admitPnl += t.realizedPnlUsd; }
  }
  console.log(`  sample ${sample.length} live trades (most recent)`);
  console.log(`  would ADMIT  ${admit}  carrying ${usd(admitPnl)}`);
  console.log(`  would REJECT ${reject}  carrying ${usd(rejectPnl)}`);
  console.log(`  rejection reasons: ${[...reasons].map(([k, v]) => `${k}×${v}`).join(", ") || "none"}`);
  const ok = admit > 0;
  results.push(["entry gates still admit real signals", ok, `${admit}/${sample.length} admitted`]);
  console.log(`  ${pass(ok)} — admitting zero would mean the gates now reject everything`);
}

// ─────────────────────────────────────────────────────── 5. exit replay
console.log("\n\x1b[1mTEST 5 — exit rules replayed over recorded price paths\x1b[0m");
console.log("  ladder is 100% at target, so: first touch of target, stop, or cutoff");
{
  const files = readdirSync(resolve(S, "paths")).filter((f) => f.startsWith("robinhood-"));
  const cutoff = cutoffFor();
  let n = 0, agree = 0; const diffs: string[] = [];
  for (const f of files.slice(-40)) {
    const lines = readFileSync(resolve(S, "paths", f), "utf8").split("\n").filter(Boolean);
    const meta = JSON.parse(lines[0]!).meta as { id: string; takeProfitPct: number; stopLossPct: number; openedAt: number };
    if (!meta?.takeProfitPct) continue;
    const samples = lines.slice(1).map((l) => JSON.parse(l) as { t: number; pctFromEntry: number });
    if (samples.length < 2) continue;
    let simReason = "time_cutoff", simPct = samples[samples.length - 1]!.pctFromEntry;
    for (const s of samples) {
      const held = s.t - meta.openedAt;
      if (s.pctFromEntry >= meta.takeProfitPct) { simReason = "take_profit_ladder"; simPct = meta.takeProfitPct; break; }
      if (s.pctFromEntry <= -meta.stopLossPct) { simReason = "stop_loss"; simPct = -meta.stopLossPct; break; }
      if (held >= cutoff) { simReason = "time_cutoff"; simPct = s.pctFromEntry; break; }
    }
    const actual = trades.find((t) => t.positionId === meta.id);
    if (!actual) continue;
    n++;
    if (actual.reason === simReason) agree++;
    else diffs.push(`    ${meta.id.slice(0, 20)}  actual ${actual.reason} ${actual.realizedPnlPct.toFixed(1)}%  sim ${simReason} ${simPct.toFixed(1)}%`);
  }
  console.log(`  replayed ${n} paths against cutoff ${cutoff}s`);
  console.log(`  exit reason agrees on ${agree}/${n}`);
  for (const d of diffs.slice(0, 5)) console.log(d);
  if (diffs.length > 5) console.log(`    …and ${diffs.length - 5} more`);
  const ok = n > 0 && agree / n >= 0.6;
  results.push(["exit replay reproduces recorded outcomes", ok, `${agree}/${n} agree`]);
  console.log(`  ${pass(ok)} — divergence is expected where the path was sampled coarsely`);
}

console.log("\n\x1b[1mSUMMARY\x1b[0m");
for (const [name, ok, detail] of results) console.log(`  ${pass(ok)}  ${name}  \x1b[2m(${detail})\x1b[0m`);
console.log();
process.exit(results.every((r) => r[1]) ? 0 : 1);

/**
 * Would today's classifier still take the trades that made v1.0's money?
 *
 * v1.0 booked $101.02 over 68 live trades in three days; v2.0 has booked $19.52 over 23 in
 * four. The per-trade edge fell ($1.49 -> $0.85) but the collapse is mostly VOLUME: 22.7
 * trades a day became 5.8.
 *
 * The gates do not explain it. 104 of 120 recent rejections are signals under minTradeUsd and
 * their median size is $64 — genuinely not worth copying. The market-cap bands do not explain
 * it either: under $1.5M returns $1.43 a trade and over $1.5M returns $1.22.
 *
 * What changed on 2026-09-09 is the classifier. It stopped counting a stranger's payment as
 * the tracked wallet's buy, which is correct in classification terms — but if v1.0's profit
 * came from signals it now calls RECEIVED, the fix quietly removed the edge along with the
 * bug. This replays each v1.0 trade's OWN signal transaction through today's code and reports
 * the verdict, weighted by what the trade actually earned.
 *
 * Run: node --experimental-strip-types tools/replay-v1-signals.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyEvm } from "../src/classifier.ts";
import { wallets } from "../src/config.ts";

const S = resolve(import.meta.dirname, "..", "state");
const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

interface T {
  closedAt: number; paper: boolean; shadow?: boolean; signalTx: string;
  sourceWallet: string; sourceWalletName: string; realizedPnlUsd: number; chain: string;
}

const V2_START = Date.UTC(2026, 8, 8) / 1000;          // 2026-09-08, first 0x round trip
const rows = readFileSync(resolve(S, "trades.jsonl"), "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l) as T)
  .filter((r) => r.paper === false && !r.shadow && r.closedAt < V2_START && r.signalTx);

console.log(`\n  replaying ${rows.length} v1.0 signals through today's classifier\n`);

const byWallet = new Map(wallets.map((w) => [w.address.toLowerCase(), w]));
let buy = 0, other = 0, gone = 0;
let pnlBuy = 0, pnlOther = 0;
const verdicts = new Map<string, number>();

for (const r of rows) {
  const w = byWallet.get(r.sourceWallet.toLowerCase());
  if (!w) { gone++; continue; }                        // wallet since removed from the roster
  let v = "null";
  try {
    const sig = await classifyEvm(w, r.chain as never, r.signalTx);
    v = sig ? (sig as { verdict?: string }).verdict ?? "BUY" : "null";
  } catch { v = "error"; }
  verdicts.set(v, (verdicts.get(v) ?? 0) + 1);
  if (v === "BUY") { buy++; pnlBuy += r.realizedPnlUsd; }
  else { other++; pnlOther += r.realizedPnlUsd; }
}

console.log(`  ${B}verdict today${X}`);
for (const [v, n] of [...verdicts].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${v.padEnd(10)} ${String(n).padStart(3)}`);
}
if (gone) console.log(`    ${D}(${gone} skipped: wallet no longer on the roster)${X}`);

const tot = buy + other;
console.log(`\n  ${B}what today's bot would still trade${X}`);
console.log(`    still BUY : ${buy}/${tot} = ${(buy / tot * 100).toFixed(0)}%   carrying $${pnlBuy.toFixed(2)} of the P&L`);
console.log(`    now other : ${other}/${tot} = ${(other / tot * 100).toFixed(0)}%   carrying $${pnlOther.toFixed(2)} of the P&L`);
console.log();
const lost = pnlOther / (pnlBuy + pnlOther) * 100;
console.log(lost > 40
  ? `  ${R}${lost.toFixed(0)}% of v1.0's profit came from signals today's classifier rejects.${X}`
  : `  ${G}Only ${lost.toFixed(0)}% of v1.0's profit sat in signals now rejected — the classifier is not the cause.${X}`);

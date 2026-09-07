import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Was blocking re-entries the right call?
 *
 * Every refused re-entry is run as a shadow position with identical rules, so this compares
 * like with like: what the shadows actually returned, and what the first position in the
 * same token was doing at the moment the second signal arrived. The second question is the
 * interesting one — a wallet buying again while we are UP is a different animal from one
 * averaging down into a loss, and the blanket rule cannot tell them apart.
 */
const STATE = resolve(import.meta.dirname, "..", "state");
const read = (f: string) => existsSync(f)
  ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

const real = read(resolve(STATE, "trades.jsonl"));
const shadow = read(resolve(STATE, "shadow-trades.jsonl"));

if (!shadow.length) {
  console.log("No shadow re-entries recorded yet.");
  console.log("They are created only when a tracked wallet buys a token already held.");
  process.exit(0);
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
console.log(`SHADOW RE-ENTRIES — ${shadow.length} refused buys, measured anyway\n`);
console.log(`  ${"wallet".padEnd(16)}${"result".padEnd(20)}${"P&L".padStart(9)}${"fillConf".padStart(10)}   first position was`);

let sp = 0, sc = 0, wins = 0;
for (const s of shadow) {
  // the position we were already holding in this token when the second signal landed
  const prior = real.filter((r) => r.token === s.token && r.chain === s.chain
    && r.closedAt >= s.closedAt - 3600 && r.positionId !== s.positionId)
    .sort((a, b) => Math.abs(a.closedAt - s.closedAt) - Math.abs(b.closedAt - s.closedAt))[0];
  sp += s.realizedPnlUsd; sc += s.costUsd;
  if (s.realizedPnlUsd > 0) wins++;
  const ctx = prior ? `${prior.reason} ${pct(prior.realizedPnlPct)}` : "(not matched)";
  console.log(`  ${String(s.sourceWalletName).replace(" (evm)", "").slice(0, 15).padEnd(16)}`
    + `${String(s.reason).padEnd(20)}${pct(s.realizedPnlPct).padStart(9)}`
    + `${(s.fillConfidence !== undefined ? `${Math.round(s.fillConfidence * 100)}%` : "?").padStart(10)}   ${ctx}`);
}

console.log(`\n  shadow re-entries : ${shadow.length}  net ${pct(sp / sc * 100)}  wins ${wins}/${shadow.length}`);
const rn = real.reduce((a, x) => a + x.realizedPnlUsd, 0);
const rc = real.reduce((a, x) => a + x.costUsd, 0);
console.log(`  real trades       : ${real.length}  net ${rc ? pct(rn / rc * 100) : "n/a"}`);
console.log(`\n  VERDICT: re-entry would have ${sp > 0 ? "ADDED" : "COST"} ${Math.abs(sp).toFixed(2)} on `
  + `${sc.toFixed(2)} of extra capital.`);
if (shadow.length < 10) {
  console.log(`  Too few to act on — ${shadow.length} shadow${shadow.length === 1 ? "" : "s"}. Wait for ~20.`);
}

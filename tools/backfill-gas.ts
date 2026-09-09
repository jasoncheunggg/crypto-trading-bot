/**
 * Backfill gas onto the trade ledger from gmgn's wallet activity.
 *
 * `record()` never stored gas: realizedPnlUsd already had it deducted, so the ledger showed a
 * net figure with no way to see how much of a loss was COST rather than PRICE. On 2026-09-09
 * that hid the whole story — three trades lost $2.11, of which $1.70 was gas, and one of them
 * ROSE 2.51% on price and still booked -8.50%.
 *
 * gmgn's portfolio/activity carries gas_usd per transaction and reaches back across BOTH
 * wallets, so history can be recovered rather than only recorded from here on. Verified against
 * a receipt: gmgn 0.16477 vs chain 0.1649 on tx 0xda59285dec.
 *
 * Writes entryGasUsd / exitGasUsd onto live trades. Never invents a figure: a trade gmgn cannot
 * match keeps no gas field at all, and the UI shows a dash rather than a zero, because a missing
 * measurement and a free transaction are different things.
 *
 *   node --experimental-strip-types tools/backfill-gas.ts          dry run
 *   node --experimental-strip-types tools/backfill-gas.ts --write  writes trades.jsonl
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const S = resolve(import.meta.dirname, "..", "state");
const WRITE = process.argv.includes("--write");
const WALLETS = [process.env["BOT_WALLET_ADDRESS"], process.env["WALLET_ADDRESS"]].filter(Boolean) as string[];

interface Act {
  tx_hash: string; timestamp: number; event_type: string;
  token: { address: string }; gas_usd?: string | number;
}
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

async function activity(wallet: string): Promise<Act[]> {
  const out: Act[] = [];
  let cursor = "";
  for (let page = 0; page < 12; page++) {
    const args = ["portfolio", "activity", "--chain", "robinhood", "--wallet", wallet,
      "--limit", "100", "--raw", ...(cursor ? ["--cursor", cursor] : [])];
    let body: { activities?: Act[]; next?: string; cursor?: string };
    try {
      const { stdout } = await run("gmgn-cli", args, { timeout: 30_000, maxBuffer: 8 << 20 });
      body = JSON.parse(stdout) as typeof body;
    } catch { break; }
    const acts = body.activities ?? [];
    out.push(...acts);
    const next = body.next ?? body.cursor ?? "";
    if (!next || !acts.length) break;
    cursor = next;
    await new Promise((r) => setTimeout(r, 250));   // gmgn is 5/s per IP; stay far under
  }
  return out;
}

interface Trade {
  positionId: string; token: string; paper: boolean; shadow?: boolean;
  closedAt: number; heldSec: number; entryGasUsd?: number; exitGasUsd?: number;
}

const lines = readFileSync(resolve(S, "trades.jsonl"), "utf8").split("\n").filter(Boolean);
const rows = lines.map((l) => JSON.parse(l) as Trade);

const acts: Act[] = [];
for (const w of WALLETS) {
  const a = await activity(w);
  console.log(`  ${w.slice(0, 12)}  ${a.length} activities`);
  acts.push(...a);
}
const byToken = new Map<string, Act[]>();
for (const a of acts) {
  const k = a.token?.address?.toLowerCase();
  if (!k) continue;
  (byToken.get(k) ?? byToken.set(k, []).get(k)!).push(a);
}

let entryHits = 0, exitHits = 0, live = 0, unmatched = 0;
for (const r of rows) {
  if (r.paper !== false || r.shadow) continue;
  live++;
  const openedAt = r.closedAt - r.heldSec;
  const cands = byToken.get(r.token.toLowerCase()) ?? [];
  // A buy at or just before the position opened, and sells inside the hold window. The
  // 90-second tolerance covers the gap between our fill and gmgn indexing it.
  const buy = cands.filter((a) => a.event_type === "buy"
      && a.timestamp >= openedAt - 90 && a.timestamp <= openedAt + 90)
    .sort((a, b) => Math.abs(a.timestamp - openedAt) - Math.abs(b.timestamp - openedAt))[0];
  const sells = cands.filter((a) => a.event_type === "sell"
      && a.timestamp >= openedAt - 5 && a.timestamp <= r.closedAt + 120);
  const eg = buy ? num(buy.gas_usd) : undefined;
  const xg = sells.reduce<number | undefined>((acc, s) => {
    const g = num(s.gas_usd);
    return g === undefined ? acc : (acc ?? 0) + g;
  }, undefined);
  // Fill gaps, never overwrite: re-running must be safe, and a value already on the record
  // came from a receipt at the time rather than from gmgn's index afterwards.
  if (eg !== undefined && r.entryGasUsd === undefined) { r.entryGasUsd = eg; entryHits++; }
  if (xg !== undefined && r.exitGasUsd === undefined) { r.exitGasUsd = xg; exitHits++; }
  if (eg === undefined && xg === undefined) unmatched++;
}

const tot = rows.reduce((a, r) => a + (r.entryGasUsd ?? 0) + (r.exitGasUsd ?? 0), 0);
console.log(`\n  live trades      ${live}`);
console.log(`  entry gas found  ${entryHits}`);
console.log(`  exit gas found   ${exitHits}`);
console.log(`  no match at all  ${unmatched}   (left without a gas field, shown as "—")`);
console.log(`  total gas found  $${tot.toFixed(2)}`);

if (WRITE) {
  copyFileSync(resolve(S, "trades.jsonl"), resolve(S, `trades.jsonl.pre-gas-${Date.now()}`));
  writeFileSync(resolve(S, "trades.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\n  WRITTEN (backup alongside)`);
} else {
  console.log(`\n  dry run — pass --write to apply`);
}
process.exit(0);

/**
 * Is the $7M market-cap ceiling protecting the bot, or starving it?
 *
 * The ceiling rejects 44% of every signal that clears minTradeUsd — 65 of 147 measured over
 * 2026-09-09/10, the single largest filter in the funnel. It is also the one gate with NO
 * evidence behind it: nothing above $7M has ever been traded, so the config note records it
 * as "the operator's judgement that 10M was too generous" and nothing more.
 *
 * This replays the rejected signals. Each one's token is priced from V4 pool state over the
 * 420 seconds after the tracked wallet bought (see tools/v4price.mjs for why nothing cheaper
 * works here), and the bot's own exit rules run against that path.
 *
 * Two honest limits:
 *   - Above $7M there is no configured tier, so a take-profit has to be assumed. The top
 *     band's +20% is used, which is conservative: a bigger token moving less is the whole
 *     reason the ladder tapers.
 *   - Entry is re-based to the first post-signal sample, so the tracked wallet's own price
 *     impact is not counted as profit. Every round trip is charged the 2.18 points of
 *     slippage measured in tools/v4price-check.mjs.
 *
 * Run: node tools/ceiling-study.mjs <scratchdir>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { discoverPool, pricesAt, blockForTime, sleep } from "./v4price.mjs";

const S = process.argv[2];
if (!S) { console.error("usage: node tools/ceiling-study.mjs <scratchdir>"); process.exit(1); }

const ASSUMED_TP = 20, STOP_PCT = 20, CUTOFF_S = 420, SAMPLES = 20, SLIPPAGE_PTS = 2.18;
const LOG = resolve(import.meta.dirname, "..", "state", "shakedown.log");
const POSITIONS = resolve(import.meta.dirname, "..", "state", "positions.json");

const load = (f, d) => (existsSync(`${S}/${f}`) ? JSON.parse(readFileSync(`${S}/${f}`, "utf8")) : d);
const save = (f, v) => writeFileSync(`${S}/${f}`, JSON.stringify(v));

// ── pull the rejected signals out of the log ────────────────────────────────
const head = /^\[(\S+) (\S+)\] (@\S+) \(evm\)\s+\[robinhood\]\s+(\w+)/;
const sigs = [];
let cur = null;
for (const line of readFileSync(LOG, "utf8").split("\n")) {
  const m = head.exec(line);
  if (m) {
    cur = m[4] === "BUY" ? { day: m[1], time: m[2], wallet: m[3] } : null;
    continue;
  }
  if (!cur) continue;
  const t = line.trim();
  if (t.startsWith("token   0x")) cur.token = t.split(/\s+/).pop();
  else if (t.startsWith("signal")) {
    const q = /\$([\d,]+\.?\d*)/.exec(t);
    cur.sizeUsd = q ? parseFloat(q[1].replace(/,/g, "")) : 0;
  } else if (t.startsWith("mcap")) {
    const q = /\$([\d,]+\.?\d*)/.exec(t);
    cur.mcap = q ? parseFloat(q[1].replace(/,/g, "")) : null;
  } else if (t.startsWith("ACTION")) {
    if (/market cap .* >= ceiling/.test(t) && cur.token && cur.mcap) {
      const q = /\$([\d,]+)/.exec(t);
      sigs.push({
        token: cur.token, wallet: cur.wallet, sizeUsd: cur.sizeUsd ?? 0,
        mcap: q ? parseFloat(q[1].replace(/,/g, "")) : cur.mcap,
        t: Math.floor(Date.parse(`${cur.day}T${cur.time}`) / 1000),
        key: `${cur.token}:${cur.day}${cur.time}`,
      });
    }
    cur = null;
  }
}
console.log(`  ${sigs.length} signals rejected by the ceiling, ${new Set(sigs.map(s => s.token)).size} distinct tokens`);

// ── never compete with a live trade for Alchemy ─────────────────────────────
async function waitWhileTrading() {
  for (;;) {
    let open = 0;
    try {
      open = JSON.parse(readFileSync(POSITIONS, "utf8"))
        .filter((p) => p.status === "open" && !p.shadow).length;
    } catch { open = 0; }
    if (!open) return;
    console.log("    live position open — pausing");
    await sleep(20000);
  }
}

const pools = load("cpools.json", {});
const paths = load("cpaths.json", {});

const tokens = [...new Set(sigs.map((s) => s.token))];
const need = tokens.filter((t) => !(t in pools));
console.log(`  ${need.length} pools to discover`);
for (let i = 0; i < need.length; i++) {
  await waitWhileTrading();
  const first = sigs.find((s) => s.token === need[i]);
  const at = await blockForTime(first.t);
  pools[need[i]] = at ? (await discoverPool(need[i], at.block) ?? null) : null;
  if (i % 20 === 0) { save("cpools.json", pools); console.log(`    ${i}/${need.length}`); }
}
save("cpools.json", pools);
console.log(`  pools found for ${Object.values(pools).filter(Boolean).length}/${tokens.length}`);

const todo = sigs.filter((s) => pools[s.token] && !(s.key in paths));
console.log(`  ${todo.length} paths to build`);
for (let i = 0; i < todo.length; i++) {
  if (i % 10 === 0) await waitWhileTrading();
  const s = todo[i], p = pools[s.token];
  const a = await blockForTime(s.t), b = await blockForTime(s.t + CUTOFF_S);
  if (!a || !b) { paths[s.key] = null; continue; }
  const blocks = [a.block];
  for (let k = 1; k <= SAMPLES; k++) blocks.push(Math.round(a.block + ((b.block - a.block) * k) / SAMPLES));
  const px = await pricesAt(p.poolId, p.isCurrency1, blocks);
  paths[s.key] = px[0] ? px.map((x) => (x ? x / px[0] : null)) : null;
  if (i % 25 === 0) { save("cpaths.json", paths); console.log(`    ${i}/${todo.length}`); }
  await sleep(40);
}
save("cpaths.json", paths);

// ── simulate ────────────────────────────────────────────────────────────────
const out = [];
for (const s of sigs) {
  const rel = paths[s.key];
  if (!rel) continue;
  const clean = rel.slice(1).filter((x) => x !== null && x > 0.02 && x < 50);
  if (clean.length < 6) continue;
  const basis = clean[0];
  const pts = clean.slice(1).map((x) => x / basis);
  let reason = "time_cutoff", pct = (pts[pts.length - 1] - 1) * 100;
  for (const r of pts) {
    const m = (r - 1) * 100;
    if (m >= ASSUMED_TP) { reason = "take_profit"; pct = ASSUMED_TP; break; }
    if (m <= -STOP_PCT) { reason = "stop_loss"; pct = -STOP_PCT; break; }
  }
  out.push({ ...s, pct: pct - SLIPPAGE_PTS, reason, peak: (Math.max(...pts) - 1) * 100 });
}
save("ceiling-results.json", out);

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? 0;
console.log(`\n  simulated ${out.length} of ${sigs.length} rejected signals\n`);
const bands = [[7e6, 15e6], [15e6, 50e6], [50e6, 1e9]];
console.log(`  ${"band".padEnd(16)}${"n".padStart(4)}${"mean%".padStart(9)}${"med%".padStart(8)}${"win%".padStart(7)}${"peak%".padStart(8)}${"TP".padStart(4)}${"SL".padStart(4)}`);
for (const [lo, hi] of bands) {
  const v = out.filter((o) => o.mcap >= lo && o.mcap < hi);
  if (!v.length) continue;
  const p = v.map((o) => o.pct);
  console.log(`  ${`$${(lo / 1e6).toFixed(0)}M-${hi >= 1e9 ? "∞" : `$${(hi / 1e6).toFixed(0)}M`}`.padEnd(16)}${String(v.length).padStart(4)}${mean(p).toFixed(2).padStart(9)}${med(p).toFixed(2).padStart(8)}${(v.filter((o) => o.pct > 0).length / v.length * 100).toFixed(0).padStart(6)}%${mean(v.map((o) => o.peak)).toFixed(1).padStart(8)}${String(v.filter((o) => o.reason === "take_profit").length).padStart(4)}${String(v.filter((o) => o.reason === "stop_loss").length).padStart(4)}`);
}
const all = out.map((o) => o.pct);
console.log(`\n  ALL rejected-by-ceiling signals: mean ${mean(all).toFixed(2)}%  median ${med(all).toFixed(2)}%  win ${(out.filter((o) => o.pct > 0).length / out.length * 100).toFixed(0)}%`);
console.log(`  your live book, for comparison:  mean +7.80%  win 63%`);

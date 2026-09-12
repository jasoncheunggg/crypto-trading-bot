/**
 * Which wallets are worth copy-trading, judged by OUR exit rules rather than their own P&L.
 *
 * Every trader on FOMO's leaderboard is profitable by construction — that is what a
 * leaderboard is. The question this answers is different: when they buy, does the chart move
 * far enough, fast enough, for a 420-second copy with a tiered take-profit and a -20% stop to
 * make money? A trader who grinds out gains over days is useless to this bot and still ranks.
 *
 * Entries come from FOMO (/v2/users/{h}/swaps), filtered to this chain and to the bot's own
 * gates: the KOL's buy must clear entry.minTradeUsd, and entry market cap must sit under the
 * $7M ceiling. Prices come from V4 pool state at historical blocks — see tools/v4price.mjs
 * for why nothing cheaper works.
 *
 * Two things are deliberately conservative:
 *   - The entry basis is pool mid immediately AFTER the trader's own buy, which is what a
 *     copier actually faces — never the price they got.
 *   - Every simulated round trip is charged SLIPPAGE_PTS, measured at 2.18 points on a real
 *     position (22.03% mid-to-mid against 19.85% realized, tools/v4price-check.mjs).
 *
 * Resumable: pools and paths are cached, so a rerun costs nothing.
 *
 * Run: node tools/backtest-wallets.mjs <scratchdir>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { discoverPool, pricesAt, blockForTime, sleep } from "./v4price.mjs";

const S = process.argv[2];
if (!S) { console.error("usage: node tools/backtest-wallets.mjs <scratchdir>"); process.exit(1); }

const TP_TIERS = [[100_000, 80], [300_000, 55], [600_000, 35],
                  [1_000_000, 30], [4_000_000, 30], [7_000_000, 20]];
const STOP_PCT = 20, CUTOFF_S = 420, SAMPLES = 20;
/** Measured round-trip cost, in percentage points. See the file comment. */
const SLIPPAGE_PTS = 2.18;

const tpFor = (mc) => { for (const [cap, tp] of TP_TIERS) if (mc <= cap) return tp; return null; };
const load = (f, d) => (existsSync(`${S}/${f}`) ? JSON.parse(readFileSync(`${S}/${f}`, "utf8")) : d);
const save = (f, v) => writeFileSync(`${S}/${f}`, JSON.stringify(v));

const collected = load("collected.json", {});
const supply = load("supply.json", {});
const pools = load("pools.json", {});
const paths = load("paths.json", {});

// ── the entries that would actually have been taken ──────────────────────────
const work = [];
for (const [handle, v] of Object.entries(collected)) {
  for (const b of v.buys) {
    if (!b.qualifies || !b.entryPrice || !b.token) continue;
    const sup = supply[b.token];
    if (!sup) continue;
    const mcap = b.entryPrice * sup;
    const tp = tpFor(mcap);
    if (tp === null) continue;                       // over the $7M ceiling
    const t = Date.parse(b.at) / 1000;
    if (!t) continue;
    work.push({ handle, token: b.token, symbol: b.symbol, t, tp, mcap,
                key: `${b.token}:${Math.round(t)}` });
  }
}
console.log(`  ${work.length} entries clear the gates, across ${new Set(work.map(w => w.handle)).size} wallets`);

// ── pool discovery, once per token ───────────────────────────────────────────
const tokens = [...new Set(work.map((w) => w.token))];
const need = tokens.filter((t) => !(t in pools));
console.log(`  ${tokens.length} tokens, ${tokens.length - need.length} cached, ${need.length} to discover`);
for (let i = 0; i < need.length; i++) {
  const tk = need[i];
  const first = work.find((w) => w.token === tk);
  const at = await blockForTime(first.t);
  pools[tk] = at ? (await discoverPool(tk, at.block) ?? null) : null;
  if (i % 25 === 0) { save("pools.json", pools); console.log(`    discovered ${i}/${need.length}`); }
}
save("pools.json", pools);
const okPools = Object.values(pools).filter(Boolean).length;
console.log(`  pools found for ${okPools}/${tokens.length} tokens`);

/**
 * Never compete with a live trade for Alchemy.
 *
 * This makes hundreds of calls a minute; the bot's entry path needs the same provider, and a
 * 429 there costs a real position. Diagnostics alongside a running bot are fine — during an
 * open position they are not. Checked from disk because the bot holds positions in memory in
 * its own process.
 */
const POSITIONS = resolve(import.meta.dirname, "..", "state", "positions.json");
async function waitWhileTrading() {
  for (;;) {
    let open = 0;
    try {
      open = JSON.parse(readFileSync(POSITIONS, "utf8"))
        .filter((p) => p.status === "open" && !p.shadow).length;
    } catch { open = 0; }
    if (!open) return;
    console.log(`    live position open — pausing`);
    await sleep(20000);
  }
}

// ── price paths ──────────────────────────────────────────────────────────────
const todo = work.filter((w) => pools[w.token] && !(w.key in paths));
console.log(`  ${todo.length} paths to build`);
for (let i = 0; i < todo.length; i++) {
  const w = todo[i];
  const p = pools[w.token];
  /**
   * Resolve the two ENDS properly and interpolate between them. The block rate is stable
   * over 420 seconds even though it drifts badly over days, so two lookups buy the same
   * accuracy as twenty-one. The linear estimate alone put these paths up to 100s off the
   * entry, which is a different chart on a token like these.
   */
  if (i % 10 === 0) await waitWhileTrading();
  const a = await blockForTime(w.t);
  const b = await blockForTime(w.t + CUTOFF_S);
  if (!a || !b) { paths[w.key] = null; continue; }
  const blocks = [a.block];
  for (let k = 1; k <= SAMPLES; k++) {
    blocks.push(Math.round(a.block + ((b.block - a.block) * k) / SAMPLES));
  }
  const px = await pricesAt(p.poolId, p.isCurrency1, blocks);
  paths[w.key] = px[0] ? px.map((x) => (x ? x / px[0] : null)) : null;
  if (i % 40 === 0) { save("paths.json", paths); console.log(`    pathed ${i}/${todo.length}`); }
  await sleep(40);
}
save("paths.json", paths);

// ── simulate ─────────────────────────────────────────────────────────────────
const byWallet = {};
let noPath = 0, dropped = 0;
for (const w of work) {
  const rel = paths[w.key];
  if (!rel) { noPath++; continue; }
  /**
   * Discard impossible samples before simulating.
   *
   * A slot read can come back near-zero — an uninitialised pool, a gap — and because a
   * currency1 token inverts the price, near-zero becomes astronomical: one path read
   * 1.00 0.81 4.3e+44 0.85 0.76, a single bad sample among good ones. Left in, that sample
   * trips the take-profit instantly and books a fictional win. 9 of 960 paths carried one.
   *
   * The band is deliberately wide: these tokens really can do 10x or -90% inside 420
   * seconds, and the job here is to reject reads that are not prices at all, not to second
   * guess violent ones.
   */
  const raw = rel.slice(1);
  const clean = raw.filter((x) => x !== null && x > 0.02 && x < 50);
  /**
   * Re-base to the first post-entry sample, discarding the block the entry sits in.
   *
   * The tracked wallet's own buy moves the price, and the timestamp FOMO reports resolves to
   * a block that can precede it — so measuring from there counts THEIR impact as OUR gain.
   * Measured: 63% of paths were already up at the first sample, median +1.89% and p90
   * +16.57%, where an unbiased basis gives ~50%. It flattered exactly the wallets whose buys
   * are big enough to move a small cap: our own roster simulated at 100% wins against a live
   * 63%. Re-based, the same measurement reads 47% up and a median of +0.00%.
   *
   * The cost is that entry is now dated ~21s after the signal rather than the few seconds the
   * bot really takes, which understates a fast entry. Conservative in the right direction.
   */
  const basis = clean[0];
  const pts = basis ? clean.slice(1).map((x) => x / basis) : [];
  dropped += raw.filter((x) => x !== null).length - clean.length;
  // Too much of the path missing to judge an exit against.
  if (pts.length < 5 || clean.length < raw.length * 0.6) { noPath++; continue; }
  let reason = "time_cutoff", pct = (pts[pts.length - 1] - 1) * 100;
  for (const r of pts) {
    const m = (r - 1) * 100;
    if (m >= w.tp) { reason = "take_profit"; pct = w.tp; break; }
    if (m <= -STOP_PCT) { reason = "stop_loss"; pct = -STOP_PCT; break; }
  }
  pct -= SLIPPAGE_PTS;                               // what a copier actually keeps
  (byWallet[w.handle] ??= []).push({ pct, reason, peak: (Math.max(...pts) - 1) * 100 });
}

const rows = Object.entries(byWallet).map(([handle, s]) => {
  const p = s.map((x) => x.pct).sort((a, b) => a - b);
  const mean = p.reduce((a, b) => a + b, 0) / p.length;
  return {
    handle, wallet: collected[handle]?.wallet ?? "", n: p.length,
    mean, median: p[p.length >> 1], total: p.reduce((a, b) => a + b, 0),
    win: s.filter((x) => x.pct > 0).length / p.length * 100,
    tp: s.filter((x) => x.reason === "take_profit").length,
    sl: s.filter((x) => x.reason === "stop_loss").length,
    cut: s.filter((x) => x.reason === "time_cutoff").length,
    avgPeak: s.reduce((a, x) => a + x.peak, 0) / s.length,
  };
});
save("ranked.json", rows);

const tot = rows.reduce((a, r) => a + r.n, 0);
const allSl = rows.reduce((a, r) => a + r.sl, 0), allTp = rows.reduce((a, r) => a + r.tp, 0);
console.log(`\n  simulated ${tot} entries; no usable path for ${noPath}; ${dropped} impossible samples discarded`);
console.log(`  exit mix: take_profit ${(allTp / tot * 100).toFixed(0)}%  stop_loss ${(allSl / tot * 100).toFixed(0)}%  cutoff ${((tot - allTp - allSl) / tot * 100).toFixed(0)}%`);
console.log(`  (your live book: take_profit 39%  stop_loss 18%  cutoff 34%)`);

const elig = rows.filter((r) => r.n >= 8).sort((a, b) => b.mean - a.mean);
console.log(`\n  ${elig.length} wallets with >=8 simulated entries\n`);
console.log(`  ${"handle".padEnd(22)}${"n".padStart(4)}${"mean%".padStart(8)}${"med%".padStart(8)}${"win%".padStart(7)}${"peak%".padStart(8)}${"TP".padStart(4)}${"SL".padStart(4)}${"cut".padStart(5)}`);
for (const r of elig.slice(0, 25)) {
  console.log(`  ${r.handle.slice(0, 22).padEnd(22)}${String(r.n).padStart(4)}${r.mean.toFixed(2).padStart(8)}${r.median.toFixed(2).padStart(8)}${r.win.toFixed(0).padStart(6)}%${r.avgPeak.toFixed(1).padStart(8)}${String(r.tp).padStart(4)}${String(r.sl).padStart(4)}${String(r.cut).padStart(5)}`);
}
if (elig.length) {
  const m = elig.map((r) => r.mean);
  console.log(`\n  spread across eligible wallets: ${Math.min(...m).toFixed(1)}% to ${Math.max(...m).toFixed(1)}%`);
}

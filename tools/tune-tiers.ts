/**
 * What take-profit does each market-cap band actually deserve?
 *
 * The current ladder was set from small samples and judgement: +35% in the $600k band came
 * from 18 mostly-paper replays, and the top band was narrowed 10M -> 7M on the operator's
 * view that 10M was too generous. Neither was wrong, but neither was measured against the
 * data that now exists.
 *
 * state/paths holds 308 recorded price paths with a median of 471 samples each — the bot's
 * own feed, second by second, from OUR fill rather than the tracked wallet's. So a candidate
 * ladder can be replayed exactly: first touch of the target, the stop, or the cutoff, in the
 * order they actually happened. That ordering is the thing peakPct alone cannot give.
 *
 * Every simulated round trip is charged COST_PCT for gas and fees, so the sweep cannot cheat
 * by picking a target so low it books a "win" that does not cover its own costs.
 *
 * Run: node --experimental-strip-types tools/tune-tiers.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const S = resolve(import.meta.dirname, "..", "state");
const B = "\x1b[1m", D = "\x1b[2m", G = "\x1b[32m", X = "\x1b[0m";

/** Round-trip gas and fees, as a percentage of position. ~$0.50 on a $35 position. */
const COST_PCT = 1.4;
const CUTOFF_S = 420;
const STOP = 20;

interface Path { mcap: number; tp: number; samples: { t: number; pct: number }[]; }

const paths: Path[] = [];
for (const f of readdirSync(resolve(S, "paths")).filter((x) => x.startsWith("robinhood-"))) {
  const lines = readFileSync(resolve(S, "paths", f), "utf8").split("\n").filter(Boolean);
  if (lines.length < 5) continue;
  let meta: Record<string, number>;
  try { meta = JSON.parse(lines[0]!).meta; } catch { continue; }
  if (!meta?.["entryMarketCapUsd"] || !meta["openedAt"]) continue;
  const samples: { t: number; pct: number }[] = [];
  for (const l of lines.slice(1)) {
    try {
      const s = JSON.parse(l) as { t: number; pctFromEntry: number };
      if (typeof s.pctFromEntry === "number" && Number.isFinite(s.pctFromEntry)) {
        samples.push({ t: s.t - meta["openedAt"]!, pct: s.pctFromEntry });
      }
    } catch { /* a truncated final line is normal on a live file */ }
  }
  if (samples.length < 4) continue;
  paths.push({ mcap: meta["entryMarketCapUsd"]!, tp: meta["takeProfitPct"]!, samples });
}
console.log(`\n  ${paths.length} recorded paths loaded`);

/** Replay one path under a candidate ladder. Returns net percent after costs. */
function replay(p: Path, tp: number, stop = STOP, cutoff = CUTOFF_S): number {
  for (const s of p.samples) {
    if (s.t > cutoff) break;
    if (s.pct >= tp) return tp - COST_PCT;
    if (s.pct <= -stop) return -stop - COST_PCT;
  }
  const last = [...p.samples].reverse().find((s) => s.t <= cutoff) ?? p.samples[p.samples.length - 1]!;
  return last.pct - COST_PCT;
}

const BANDS: [number, number][] = [
  [0, 100_000], [100_000, 300_000], [300_000, 600_000], [600_000, 1_000_000],
  [1_000_000, 2_000_000], [2_000_000, 4_000_000], [4_000_000, 7_000_000],
];
const CANDIDATES = [15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100];
const label = (lo: number, hi: number) =>
  `$${lo >= 1e6 ? `${lo / 1e6}M` : `${lo / 1e3}k`}-$${hi >= 1e6 ? `${hi / 1e6}M` : `${hi / 1e3}k`}`;

console.log(`\n${B}  best take-profit per band, by mean net return${X}  ${D}(stop -${STOP}%, cutoff ${CUTOFF_S}s, ${COST_PCT}% costs)${X}\n`);
console.log(`  ${"band".padEnd(15)}${"n".padStart(4)}${"current".padStart(9)}${"now".padStart(8)}${"best".padStart(7)}${"at".padStart(8)}${"gain".padStart(8)}`);
const recommend: [number, number, number][] = [];
for (const [lo, hi] of BANDS) {
  const v = paths.filter((p) => p.mcap >= lo && p.mcap < hi);
  if (v.length < 6) { console.log(`  ${label(lo, hi).padEnd(15)}${String(v.length).padStart(4)}   ${D}too few paths to tune${X}`); continue; }
  const cur = v[0]!.tp;
  const curMean = v.reduce((a, p) => a + replay(p, cur), 0) / v.length;
  let bestTp = cur, bestMean = -Infinity;
  for (const tp of CANDIDATES) {
    const m = v.reduce((a, p) => a + replay(p, tp), 0) / v.length;
    if (m > bestMean) { bestMean = m; bestTp = tp; }
  }
  recommend.push([lo, hi, bestTp]);
  const mark = bestTp !== cur ? G : "";
  console.log(`  ${label(lo, hi).padEnd(15)}${String(v.length).padStart(4)}${`+${cur}%`.padStart(9)}${curMean.toFixed(2).padStart(8)}${`${mark}+${bestTp}%${X}`.padStart(bestTp !== cur ? 14 : 7)}${bestMean.toFixed(2).padStart(8)}${(bestMean - curMean).toFixed(2).padStart(8)}`);
}

// Whole-book effect, and how sensitive the answer is to the stop.
const cur = paths.reduce((a, p) => a + replay(p, p.tp), 0) / paths.length;
const tpFor = (mc: number) => recommend.find(([lo, hi]) => mc >= lo && mc < hi)?.[2];
const tuned = paths.filter((p) => tpFor(p.mcap) !== undefined);
const tunedMean = tuned.reduce((a, p) => a + replay(p, tpFor(p.mcap)!), 0) / tuned.length;
console.log(`\n${B}  whole book${X}  current ${cur.toFixed(2)}% -> tuned ${tunedMean.toFixed(2)}% per trade  ${D}(${tuned.length} paths in tunable bands)${X}`);

console.log(`\n${B}  stop sensitivity, under the tuned ladder${X}`);
for (const st of [10, 15, 20, 25, 30, 40]) {
  const m = tuned.reduce((a, p) => a + replay(p, tpFor(p.mcap)!, st), 0) / tuned.length;
  console.log(`    stop -${String(st).padStart(2)}%   ${m.toFixed(2)}%`);
}
console.log(`\n${B}  cutoff sensitivity, under the tuned ladder${X}`);
for (const c of [180, 300, 420, 600, 900]) {
  const m = tuned.reduce((a, p) => a + replay(p, tpFor(p.mcap)!, STOP, c), 0) / tuned.length;
  console.log(`    cutoff ${String(c).padStart(3)}s   ${m.toFixed(2)}%`);
}

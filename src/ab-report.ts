import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Compare the live exit policy against its A/B twin.
 *
 * Both sides trade the same coin at the same instant with the same tier and stop, differing
 * only in the minimum hold. That removes the usual confound in this kind of tuning — that a
 * change looks good because the night it ran was a good night.
 */
const STATE = resolve(import.meta.dirname, "..", "state");
const rd = (f: string) => existsSync(f)
  ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

const real = rd(resolve(STATE, "trades.jsonl"));
const shadows = rd(resolve(STATE, "shadow-trades.jsonl"));
const controls = shadows.filter((s) => s.variant === "control");
// Group by variant: a 30s hold and a 60s hold are different experiments and averaging them
// would report a policy neither arm ever ran.
const byVariant = new Map<string, any[]>();
for (const s of shadows) {
  const v = String(s.variant ?? "");
  if (!v.startsWith("minhold")) continue;
  if (!byVariant.has(v)) byVariant.set(v, []);
  byVariant.get(v)!.push(s);
}
const variants = [...byVariant.keys()].sort();
const twins = byVariant.get(variants[variants.length - 1] ?? "") ?? [];

if (!twins.length) {
  console.log("No A/B twins closed yet. Each real entry spawns one; they close on their own schedule.");
  process.exit(0);
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
if (variants.length > 1) {
  console.log(`variants on file: ${variants.map((v) => `${v} (${byVariant.get(v)!.length})`).join(", ")}`);
  console.log(`reporting the most recent below; earlier variants are separate experiments.\n`);
}
const label = variants[variants.length - 1] ?? "minhold";
console.log(`A/B — live policy vs ${label} twin, ${twins.length} paired trades\n`);
console.log(`  ${"wallet".padEnd(15)}${"live".padStart(9)}${"twin".padStart(9)}${"diff".padStart(9)}   ${"live exit".padEnd(20)}twin exit`);

let lp = 0, tp = 0, cost = 0, twinWins = 0;
for (const t of twins) {
  const base = real.find((r) => `${r.positionId}-mh` === t.positionId.replace(/\d+$/, "").replace(/-mh$/, "-mh"))
    ?? real.find((r) => t.positionId.startsWith(r.positionId));
  if (!base) continue;
  lp += base.realizedPnlUsd; tp += t.realizedPnlUsd; cost += base.costUsd;
  if (t.realizedPnlPct > base.realizedPnlPct) twinWins++;
  console.log(`  ${String(base.sourceWalletName).replace(" (evm)", "").slice(0, 14).padEnd(15)}`
    + `${pct(base.realizedPnlPct).padStart(9)}${pct(t.realizedPnlPct).padStart(9)}`
    + `${pct(t.realizedPnlPct - base.realizedPnlPct).padStart(9)}   ${String(base.reason).padEnd(20)}${t.reason}`);
}
if (!cost) { console.log("\nNo twins matched a real trade yet."); process.exit(0); }
console.log(`\n  live policy : ${pct(lp / cost * 100)}`);
console.log(`  min-hold    : ${pct(tp / cost * 100)}`);
console.log(`  difference  : ${pct((tp - lp) / cost * 100)}   twin better on ${twinWins}/${twins.length} trades`);
// The control runs the LIVE policy. Its spread against the live arm is the noise floor:
// any minimum-hold effect smaller than this is indistinguishable from timing luck.
if (controls.length) {
  const diffs: number[] = [];
  for (const c of controls) {
    const base = real.find((r) => c.positionId.startsWith(r.positionId));
    if (base) diffs.push(c.realizedPnlPct - base.realizedPnlPct);
  }
  if (diffs.length) {
    const abs = diffs.map(Math.abs).sort((a, b) => a - b);
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    console.log(`\n  NOISE FLOOR — control arm, same policy as live, ${diffs.length} pairs`);
    console.log(`    mean drift ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}%   median |drift| ${abs[Math.floor(abs.length / 2)]!.toFixed(2)}%   worst ${abs[abs.length - 1]!.toFixed(2)}%`);
    console.log(`    a min-hold effect smaller than the median drift is not measurable yet.`);
  }
}
if (twins.length < 15) console.log(`\n  ${twins.length} pairs — too few to decide on. Aim for 20+.`);

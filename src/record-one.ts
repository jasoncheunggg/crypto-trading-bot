import { all } from "./positions.ts";
import { PathRecorder, summarise } from "./pricepath.ts";
import { SwapPriceFeed } from "./swapprice.ts";
import { config } from "./config.ts";

/**
 * Standalone recorder for a single position.
 *
 * The runner now records in-process, sharing one price feed with the exit manager so a
 * recording cannot disagree with the decision it explains. This remains as a manual tool
 * for re-recording a position by hand.
 */
const id = process.argv[2];
if (!id) { console.error("usage: record-one.ts <positionId>"); process.exit(1); }

const pos = all().find((p) => p.id === id);
if (!pos) { console.error(`position ${id} not found`); process.exit(1); }

// Deliberately finer than the ladder interval so faster ladders stay evaluable in replay.
const intervalMs = (config.exit.pathRecorder?.sampleIntervalSeconds ?? 1) * 1000;
const windowMs = (config.exit.timeCutoffSeconds + config.exit.timeCutoffJitterSeconds +
  (config.exit.pathRecorder?.tailSecondsAfterCutoff ?? 600)) * 1000;
const feed = new SwapPriceFeed(() => {}, (m) => console.log(m));
const recorder = new PathRecorder(intervalMs, windowMs, feed);
await feed.watch(pos.chain, pos.token, pos.entryPrice);

const t = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
console.log(`[${t()}] recording ${id}  token ${pos.token}  entry $${pos.entryPrice.toPrecision(6)}`);
console.log(`[${t()}] every ${intervalMs / 1000}s for ${Math.round(windowMs / 60000)} min (cutoff ${config.exit.timeCutoffSeconds}s +/- ${config.exit.timeCutoffJitterSeconds}s, plus 10 min tail)`);

recorder.start(pos, (s) => {
  const tag = s.pctFromEntry >= pos.takeProfitPct ? "  <- TAKE PROFIT REACHED"
    : s.pctFromEntry <= -pos.stopLossPct ? "  <- STOP REACHED" : "";
  console.log(`[${t()}] ${s.pctFromEntry >= 0 ? "+" : ""}${s.pctFromEntry.toFixed(2)}%  $${s.price.toPrecision(6)}${tag}`);
});

setTimeout(() => {
  recorder.stopAll();
  console.log(`\n[${t()}] done. ${JSON.stringify(summarise(id))}`);
  process.exit(0);
}, windowMs + 5000);

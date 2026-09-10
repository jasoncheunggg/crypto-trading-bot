/**
 * Ground-truth check for v4price.mjs, against the one position measured by hand.
 *
 * Position robinhood-b1a08466: bought 12,068.44 tokens at block 59077161, sold at 59081206
 * for 0.01654 ETH. Entry price $0.002827864, exit $40.9026/12068.44 = $0.00338921 — a move
 * of +19.85%. If the pool reads do not reproduce that, the orientation or the slot is wrong,
 * and every backtest built on them is fiction.
 */
import { discoverPool, pricesAt, blockAt, ANCHOR } from "./v4price.mjs";

const TOKEN = "0x8d1612b4b78ebf08cfbf01a04fa270ccbb0509a2";
const ENTRY_BLOCK = 59077161, EXIT_BLOCK = 59081206;
const TRUE_MOVE_PCT = 19.85;

const pool = await discoverPool(TOKEN, ENTRY_BLOCK);
console.log("  discovered:", pool
  ? `poolId ${pool.poolId.slice(0, 18)}…  token is currency${pool.isCurrency1 ? "1" : "0"}`
  : "NOT FOUND");
if (!pool) process.exit(1);

const px = await pricesAt(pool.poolId, pool.isCurrency1, [ENTRY_BLOCK, EXIT_BLOCK]);
if (!px[0] || !px[1]) { console.log("  no price read", px); process.exit(1); }

const move = (px[1] / px[0] - 1) * 100;
/**
 * Mid-to-mid is NOT the realized move and must not be asserted against it. We bought above
 * mid and sold below it, so the pool always shows more than the fills did — measured here at
 * 22.03% mid against 19.85% realized, a 2.2-point round trip of slippage plus 0x's 15bps.
 * The like-for-like check is the PEAK, which the bot records from its own quote feed.
 */
console.log(`  entry->exit mid-to-mid: ${move.toFixed(2)}%   realized was ${TRUE_MOVE_PCT}%`);
console.log(`  implied round-trip slippage+fees: ${(move - TRUE_MOVE_PCT).toFixed(2)} points`);
const ok = move > TRUE_MOVE_PCT && move - TRUE_MOVE_PCT < 5;
console.log(ok ? "  \x1b[32mPASS — mid exceeds realized by a plausible slippage margin\x1b[0m"
               : "  \x1b[31mFAIL — orientation or slot is wrong\x1b[0m");

// A full path, as the backtest will build it: 20 samples over the 420s hold.
const t0 = ANCHOR.time + (ENTRY_BLOCK - ANCHOR.block) / ANCHOR.rate;
const blocks = Array.from({ length: 20 }, (_, i) => blockAt(t0 + (i + 1) * 21));
const path = await pricesAt(pool.poolId, pool.isCurrency1, blocks);
const got = path.filter(Boolean).length;
console.log(`\n  420s path: ${got}/20 samples read`);
const rel = path.map((p) => (p ? ((p / px[0] - 1) * 100).toFixed(1) : "—"));
console.log("  % from entry:", rel.join(" "));
const peak = Math.max(...path.filter(Boolean).map((p) => (p / px[0] - 1) * 100));
const trough = Math.min(...path.filter(Boolean).map((p) => (p / px[0] - 1) * 100));
console.log(`  peak ${peak.toFixed(1)}%   trough ${trough.toFixed(1)}%   (recorded peak 21.3%, trough -4.1%)`);
const peakOk = Math.abs(peak - 21.3) < 2;
console.log(peakOk ? "  \x1b[32mPASS — pool peak matches the bot's recorded peak\x1b[0m"
                   : "  \x1b[31mFAIL — peak disagrees with the recorded path\x1b[0m");
process.exit(ok && peakOk ? 0 : 1);

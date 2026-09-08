/**
 * Simulate an entry end-to-end WITHOUT broadcasting.
 *
 * Runs the real quote, the real floor arithmetic, the real transaction the bot would sign, and
 * the same eth_call simulation signer.send performs — then stops. Nothing is signed and no
 * nonce is consumed.
 */
const [, , token, usdArg] = process.argv;
const positionUsd = Number(usdArg ?? 5);

const { config } = await import("../src/config.ts");
const { quote, inputAsset } = await import("../src/execution.ts");
const { swapTxFromQuote } = await import("../src/router-0x.ts");
const { account, publicClient } = await import("../src/signer.ts");
const { tokenDecimals, totalSupply } = await import("../src/rpc.ts");
const { toRawUnits } = await import("../src/reconcile.ts");

const CHAIN = "robinhood" as const;
const acct = account();
const pub = publicClient(CHAIN);
const input = inputAsset(CHAIN)!;
const dec = await tokenDecimals(CHAIN, token);
const supply = await totalSupply(CHAIN, token, dec);

console.log(`token ${token}  decimals ${dec}`);
console.log(`input ${input.symbol} (${input.address.slice(0, 10)}…)\n`);

const t0 = Date.now();
const q = await quote(CHAIN, token, positionUsd, dec, supply, null);
const quoteMs = Date.now() - t0;
if (!q) { console.log("no quote"); process.exit(1); }

console.log(`QUOTE  (${quoteMs}ms)`);
console.log(`  $${positionUsd} -> ${q.outputAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })} tokens`);
console.log(`  fill $${q.fillPrice.toPrecision(6)}   implied mcap $${Math.round(q.impliedMarketCapUsd).toLocaleString()}`);

// exactly what attemptEntry computes
const MIN_FILL_RATIO = 0.92;
const ourFloor = toRawUnits(q.outputAmount * MIN_FILL_RATIO, dec);

const tx = swapTxFromQuote(q);
if (!tx) { console.log("quote carried no transaction — swapTxFromQuote returned null"); process.exit(1); }

console.log(`\nFLOORS`);
console.log(`  our floor    ${ourFloor}  (${(MIN_FILL_RATIO * 100).toFixed(0)}% of quote)`);
console.log(`  0x minBuy    ${tx.minBuyAmount}  (${config.entry.swapSlippageTolerancePct}% slippage)`);
const clears = tx.minBuyAmount >= ourFloor;
console.log(`  0x floor >= our floor?  ${clears ? "YES — broadcast the quote as-is" : "NO — would refuse"}`);
console.log(`  binding floor is ${clears ? "0x's (tighter)" : "ours"}`);

console.log(`\nTRANSACTION the bot would sign`);
console.log(`  to     ${tx.to}`);
console.log(`  value  ${tx.value} wei${tx.value > 0n ? "  <- native, no approval needed" : ""}`);
console.log(`  gas    ${tx.gas}`);
console.log(`  data   ${(tx.data.length - 2) / 2} bytes`);

console.log(`\nSIMULATION (eth_call against live state — what signer.send runs)`);
const s0 = Date.now();
try {
  await pub.call({ account: acct.address, to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: tx.value });
  console.log(`  PASS (${Date.now() - s0}ms) — this transaction would succeed if broadcast now`);
} catch (e) {
  console.log(`  REVERT (${Date.now() - s0}ms) — ${String((e as Error).message).slice(0, 200)}`);
}
console.log(`\ntotal entry latency to broadcast-ready: ${Date.now() - t0}ms`);
process.exit(0);

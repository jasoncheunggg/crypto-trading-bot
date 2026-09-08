/**
 * Phase B end-to-end: one real swap through 0x + the self-signer, then sell it back.
 *
 *   node --experimental-strip-types tools/phaseB-swap.ts <token> <wethAmount> --confirm
 *
 * --confirm arms signing for THIS PROCESS ONLY.
 */
const [, , token, amtStr, ...rest] = process.argv;
if (rest.includes("--confirm")) process.env["BOT_ALLOW_AUTOMATED_TRADES"] = "1";

const { executeSwap } = await import("../src/live.ts");
const { account, publicClient } = await import("../src/signer.ts");
const { tokenDecimals } = await import("../src/rpc.ts");

const CHAIN = "robinhood" as const;
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const amt = Number(amtStr);
const acct = account();
const pub = publicClient(CHAIN);
const dec = await tokenDecimals(CHAIN, token);
const pad = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
const bal = async (t: string) =>
  BigInt((await pub.call({ to: t as `0x${string}`, data: ("0x70a08231" + pad(acct.address)) as `0x${string}` })).data ?? "0x0");

console.log(`wallet ${acct.address}`);
console.log(`WETH before  ${Number(await bal(WETH)) / 1e18}`);

const sellRaw = BigInt(Math.floor(amt * 1e18)).toString();
console.log(`\n--- BUY: ${amt} WETH -> token ---`);
const buy = await executeSwap(CHAIN, WETH, token, sellRaw, 5, 90_000);
console.log(buy.ok
  ? `  ok ${buy.hash}\n  in ${buy.inputAmount}  out ${buy.outputAmount}  gas $${buy.gasUsd?.toFixed(4)}`
  : `  FAILED: ${buy.error}`);
if (!buy.ok) process.exit(1);

const held = await bal(token);
console.log(`\n--- SELL: ${Number(held) / 10 ** dec} token -> WETH ---`);
const sell = await executeSwap(CHAIN, token, WETH, held.toString(), 5, 90_000);
console.log(sell.ok
  ? `  ok ${sell.hash}\n  in ${sell.inputAmount}  out ${sell.outputAmount}  gas $${sell.gasUsd?.toFixed(4)}`
  : `  FAILED: ${sell.error}`);

const after = Number(await bal(WETH)) / 1e18;
console.log(`\nWETH after   ${after}`);
console.log(`round trip   ${((after / (Number(await bal(WETH)) / 1e18 + amt)) * 100).toFixed(2)}% (see raw numbers above)`);
process.exit(0);

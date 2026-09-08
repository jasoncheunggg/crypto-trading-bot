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
const { inputAsset } = await import("../src/execution.ts");
const IN = inputAsset("robinhood")!;
const WETH = IN.address;
const amt = Number(amtStr);
const acct = account();
const pub = publicClient(CHAIN);
const dec = await tokenDecimals(CHAIN, token);
const pad = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
const bal = async (t: string) =>
  BigInt((await pub.call({ to: t as `0x${string}`, data: ("0x70a08231" + pad(acct.address)) as `0x${string}` })).data ?? "0x0");

console.log(`wallet ${acct.address}`);
const nat = async () => Number(await pub.getBalance({ address: acct.address })) / 1e18;
console.log(`${IN.symbol} before  ${await nat()}`);

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

const after = await nat();
console.log(`\n${IN.symbol} after   ${after}`);

process.exit(0);

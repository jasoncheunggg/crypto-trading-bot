/** Sell whatever the wallet holds of one token, through the v2.0 path. */
const [, , token, ...rest] = process.argv;
if (rest.includes("--confirm")) process.env["BOT_ALLOW_AUTOMATED_TRADES"] = "1";
const { executeSwap } = await import("../src/live.ts");
const { account, publicClient } = await import("../src/signer.ts");
const { tokenDecimals } = await import("../src/rpc.ts");
const CHAIN = "robinhood" as const;
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const acct = account(); const pub = publicClient(CHAIN);
const pad = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
const bal = async (t: string) =>
  BigInt((await pub.call({ to: t as `0x${string}`, data: ("0x70a08231" + pad(acct.address)) as `0x${string}` })).data ?? "0x0");
const dec = await tokenDecimals(CHAIN, token);
const held = await bal(token);
const wethBefore = Number(await bal(WETH)) / 1e18;
console.log(`holding ${Number(held) / 10 ** dec} token   WETH ${wethBefore}`);
const r = await executeSwap(CHAIN, token, WETH, held.toString(), 5, 90_000);
console.log(r.ok ? `SELL ok ${r.hash}\n  out ${r.outputAmount} WETH  gas $${r.gasUsd?.toFixed(4)}` : `SELL FAILED: ${r.error}`);
console.log(`WETH after ${Number(await bal(WETH)) / 1e18}`);
process.exit(0);

/** Sell whatever the wallet holds of one token, through the v2.0 path. */
const [, , token, ...rest] = process.argv;
if (rest.includes("--confirm")) process.env["BOT_ALLOW_AUTOMATED_TRADES"] = "1";
const { executeSwap } = await import("../src/live.ts");
const { account, publicClient } = await import("../src/signer.ts");
const { tokenDecimals } = await import("../src/rpc.ts");
const CHAIN = "robinhood" as const;
const { inputAsset } = await import("../src/execution.ts");
const OUT = inputAsset(CHAIN)!.address;   // whatever the bot actually trades from
const acct = account(); const pub = publicClient(CHAIN);
const pad = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
const bal = async (t: string) =>
  BigInt((await pub.call({ to: t as `0x${string}`, data: ("0x70a08231" + pad(acct.address)) as `0x${string}` })).data ?? "0x0");
const dec = await tokenDecimals(CHAIN, token);
const held = await bal(token);
const natBefore = Number(await pub.getBalance({ address: acct.address })) / 1e18;
console.log(`holding ${Number(held) / 10 ** dec} token   native ${natBefore}`);
const r = await executeSwap(CHAIN, token, OUT, held.toString(), 5, 90_000);
console.log(r.ok ? `SELL ok ${r.hash}\n  out ${r.outputAmount} WETH  gas $${r.gasUsd?.toFixed(4)}` : `SELL FAILED: ${r.error}`);
console.log(`native after ${Number(await pub.getBalance({ address: acct.address })) / 1e18}   (proceeds USD ${r.outputUsd?.toFixed(4) ?? "n/a"})`);
process.exit(0);

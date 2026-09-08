/**
 * Phase A gate-chain test. Runs the REAL planEntry() over known-good and known-bad tokens.
 *
 * dryRun is flipped IN MEMORY so sizing uses the paper figure — the live wallet holds no WETH
 * yet, so every case would otherwise stop at "position < minPositionSizeUsd" before reaching
 * the gate under test. Nothing is written to disk and no swap path is touched.
 */
import { config } from "../src/config.ts";
(config.mode as { dryRun: boolean }).dryRun = true;
// Drop the liquidity floor so the round-trip probe is the ONLY thing left standing between
// a honeypot and a buy. Proves it is a real second line of defence, not decoration.
if (process.env["PROBE_ONLY"] === "1") {
  (config.entry as { minPoolLiquidityUsd: number }).minPoolLiquidityUsd = 0;
  (config.risk as { minPositionSizeUsd: number }).minPositionSizeUsd = 0.01;
  (config.entry as { marketCapFloorUsd: number | null }).marketCapFloorUsd = null;
}

const { planEntry } = await import("../src/entry.ts");
const { tokenDecimals, totalSupply } = await import("../src/rpc.ts");
import type { Signal, Wallet } from "../src/types.ts";

const wallet: Wallet = {
  name: "@test", address: "0x0eb6f8e5c8bc7d5c920d485b7b3d52e56cdef21f",
  family: "evm", chains: ["robinhood"], platform: "fomo", enabled: true,
};

const CASES: [string, string, string][] = [
  ["healthy",      "0x16391c40e85fb2246a2c8c17bfa2594c5d3ef84b", "should PASS"],
  ["honeypot",     "0x5b234bcf67f6725fbe01b9bfb2bc9db095589c56", "99% sell tax"],
  ["rug",          "0xa80ebb6d983d16e2c74ed5f8782c9e39e8a364ac", "liquidity pulled"],
  ["no-sell-route","0xe4b8723d202fdd0298b1d7496a86656b2986c532", "buyable, unexitable"],
];

for (const [label, token, note] of CASES) {
  const dec = await tokenDecimals("robinhood", token).catch(() => 18);
  const sup = await totalSupply("robinhood", token, dec).catch(() => 0);
  const px = 0.001;
  const signal: Signal = {
    wallet, chain: "robinhood", txHash: "0x" + "1".repeat(64), blockNumber: 1,
    timestamp: Math.floor(Date.now() / 1000), verdict: "BUY", token,
    tokenAmount: 1_000_000, tokenDecimals: dec, sizeUsd: 5000,
    quoteLegs: [{ symbol: "WETH", amount: 2, isSizingAsset: true }],
    impliedMarketCapUsd: px * sup, viaKnownRouter: true,
  };
  const plan = await planEntry(signal);
  console.log(`\n${label}  (${note})`);
  console.log(`  act=${plan.act}  size=$${plan.sizing?.positionUsd.toFixed(2) ?? "-"}` +
    `  liquidity=$${plan.poolLiquidityUsd?.toFixed(0) ?? "-"}`);
  for (const r of plan.rejections) console.log(`  REJECT: ${r}`);
}
// The gates that live in index.ts rather than planEntry — verified directly.
const { tokenRisk, sellTaxBlocks, concentrationBlocks } = await import("../src/security.ts");
console.log("\n=== index.ts gates (sell tax / concentration) ===");
for (const [label, token] of CASES.map((c) => [c[0], c[1]] as const)) {
  const r = await tokenRisk("robinhood", token);
  const dec = await tokenDecimals("robinhood", token).catch(() => 18);
  const sup = await totalSupply("robinhood", token, dec).catch(() => 0);
  const { quote } = await import("../src/execution.ts");
  const q = await quote("robinhood", token, 30, dec, sup, null);
  const tax = sellTaxBlocks(r);
  const con = q ? concentrationBlocks(r, q.impliedMarketCapUsd) : null;
  console.log(`  ${label.padEnd(14)} sellTax=${r.sellTaxPct?.toFixed(0) ?? "?"}%  top10=${r.top10Pct?.toFixed(0) ?? "?"}%` +
    `  ${tax ? "BLOCKED(tax)" : con ? "BLOCKED(conc)" : "pass"}`);
}
process.exit(0);

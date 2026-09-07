/** Phase A smoke test. Read-only: quotes only, no signing, no broadcast. */
import { nativeUsd } from "../src/live.ts";
import { quote, roundTripProbe, sellQuoteUsd, inputAmountRaw, inputSymbol } from "../src/execution.ts";
import { tokenRisk, concentrationBlocks } from "../src/security.ts";
import { totalSupply, tokenDecimals } from "../src/rpc.ts";

const CHAIN = "robinhood" as const;
const GOOD    = "0x16391c40e85fb2246a2c8c17bfa2594c5d3ef84b";  // GRASS, healthy
const HONEY   = "0x5b234bcf67f6725fbe01b9bfb2bc9db095589c56";  // 99% sell tax
const RUG     = "0xa80ebb6d983d16e2c74ed5f8782c9e39e8a364ac";  // liquidity pulled
const NOSELL  = "0xe4b8723d202fdd0298b1d7496a86656b2986c532";  // buyable, no sell route

const px = await nativeUsd(CHAIN);
console.log(`nativeUsd (0x)          : $${px?.toFixed(2)}   [input asset ${inputSymbol(CHAIN)}]`);
console.log(`inputAmountRaw($30)     : ${await inputAmountRaw(CHAIN, 30)}  (raw WETH wei)`);

for (const [name, token] of [["GOOD ", GOOD], ["HONEY", HONEY], ["RUG  ", RUG], ["NOSEL", NOSELL]] as const) {
  const dec = await tokenDecimals(CHAIN, token).catch(() => 18);
  const sup = await totalSupply(CHAIN, token, dec).catch(() => 0);
  const q = await quote(CHAIN, token, 30, dec, sup, null);
  const rt = await roundTripProbe(CHAIN, token, 30, dec);
  const risk = await tokenRisk(CHAIN, token);
  const block = risk.top10Pct !== null && q ? concentrationBlocks(risk, q.impliedMarketCapUsd) : null;
  console.log(
    `${name}  quote=${q ? `${q.outputAmount.toLocaleString("en-US",{maximumFractionDigits:0})} tok  mcap $${Math.round(q.impliedMarketCapUsd).toLocaleString("en-US")}` : "NULL"}` +
    `  retention=${rt ? (rt.sellable ? `${(rt.retention*100).toFixed(2)}%` : "NO SELL ROUTE") : "n/a"}` +
    `  top10=${risk.top10Pct?.toFixed(1) ?? "?"}%${block ? "  BLOCKED: " + block : ""}`,
  );
}

const dec = await tokenDecimals(CHAIN, GOOD).catch(() => 18);
const worth = await sellQuoteUsd(CHAIN, GOOD, (1000n * 10n ** BigInt(dec)).toString(), dec);
console.log(`sellQuoteUsd(1000 GRASS): $${worth?.toFixed(4)}   <- must be USD, not WETH`);
process.exit(0);

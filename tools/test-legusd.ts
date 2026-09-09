/** Verify the single conversion boundary. Read-only. */
const { nativeUsd } = await import("../src/live.ts");
const { usdRates, legUsd, cachedNativeUsd } = await import("../src/money.ts");
const { classifyEvm } = await import("../src/classifier.ts");
const { verifyPrice } = await import("../src/verify.ts");
const { wallets } = await import("../src/config.ts");

const C = "robinhood" as const;
const ok = (b: boolean) => (b ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m");
const fails: string[] = [];
const check = (name: string, cond: boolean, detail: string) => {
  console.log(`  ${ok(cond)} ${name}  \x1b[2m${detail}\x1b[0m`);
  if (!cond) fails.push(name);
};

console.log("\n\x1b[1mA. rates resolve\x1b[0m");
console.log(`  before warm: cachedNativeUsd = ${cachedNativeUsd(C)}`);
const px = await nativeUsd(C);
console.log(`  after  warm: cachedNativeUsd = ${cachedNativeUsd(C)?.toFixed(2)}   (nativeUsd $${px?.toFixed(2)})`);
const r = usdRates(C);
for (const [a, rate] of Object.entries(r.rate)) {
  console.log(`    ${r.symbol[a]!.padEnd(5)} ${a.slice(0, 12)}  ${r.decimals[a]} dec  $${rate.toFixed(2)}/unit`);
}
check("both quote assets priceable", Object.keys(r.rate).length === 2, `${Object.keys(r.rate).length} assets`);

console.log("\n\x1b[1mB. legUsd converts correctly\x1b[0m");
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const u = legUsd(r, USDG, 4993520000n);              // 4993.52 USDG, 6 dec
const w = legUsd(r, WETH, 1940000000000000000n);      // 1.94 WETH, 18 dec
const junk = legUsd(r, "0xdead000000000000000000000000000000000000", 10n ** 18n);
check("USDG 4993.52 -> $4993.52", Math.abs((u ?? 0) - 4993.52) < 0.01, `got $${u?.toFixed(2)}`);
check("WETH 1.94 -> ~$4800", (w ?? 0) > 4000 && (w ?? 0) < 6000, `got $${w?.toFixed(2)} at $${px?.toFixed(0)}/ETH`);
check("unknown asset -> null (not 0)", junk === null, `got ${junk}`);

console.log("\n\x1b[1mC. the ETH blind spot is closed\x1b[0m");
console.log("  the old code sized any WETH-settled leg at $0.00 and rejected it under minTradeUsd");
const before = 0, after = w ?? 0;
check("a 1.94 WETH leg now sizes above the $950 minimum", after > 950, `was $${before.toFixed(2)}, now $${after.toFixed(2)}`);

console.log("\n\x1b[1mD. the honeypot hole stays shut\x1b[0m");
console.log("  8Stock was airdropped by a STRANGER; sizing it must not make it a BUY");
for (const [name, tx] of [
  ["@Quanterty", "0x6cd809acf42a5cb423dcd69af543b9f0492b0ea0166baeb40d023ba5fd16984d"],
  ["@unipcs", "0x0b5540a511b1bf9080e014f5100729b5d7572fe45c1a67e7dfd7b46a4535f2a8"],
] as const) {
  const wal = wallets.find((x) => x.name.startsWith(name))!;
  const s = await classifyEvm(wal, C, tx).catch(() => null);
  check(`${name} bait stays RECEIVED at $0`, s?.verdict === "RECEIVED" && s.sizeUsd === 0,
    `verdict ${s?.verdict} size $${s?.sizeUsd.toFixed(2)}`);
}

console.log("\n\x1b[1mE. a real FOMO buy is unchanged\x1b[0m");
const w2 = wallets.find((x) => x.name.startsWith("@unipcs"))!;
const good = await classifyEvm(w2, C, "0xe248a8e7330657a1279a5c3e98419931204e6361cd00dbd8996439e09235df64").catch(() => null);
check("BUY at $97.64 via known router", good?.verdict === "BUY" && Math.abs(good.sizeUsd - 97.64) < 0.5,
  `verdict ${good?.verdict} size $${good?.sizeUsd.toFixed(2)}`);
console.log(`    legs: ${good?.quoteLegs.map((l) => `${l.symbol} ${l.amount.toFixed(4)}=$${l.usd?.toFixed(2) ?? "?"}`).join(", ")}`);

console.log("\n\x1b[1mF. verifyPrice can now price a non-USDG token\x1b[0m");
const v = await verifyPrice(C, "0x04d6f2d2b21d77662c2848651b676f7177455928").catch(() => null);
console.log(`  CHAOS -> ${v ? "$" + v.price.toPrecision(6) : "null (no recent trades in window — inconclusive)"}`);

console.log(`\n${fails.length ? "\x1b[31m" + fails.length + " FAILED: " + fails.join(", ") : "\x1b[32mall checks passed"}\x1b[0m\n`);
process.exit(fails.length ? 1 : 0);

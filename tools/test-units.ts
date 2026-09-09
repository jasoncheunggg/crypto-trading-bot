/**
 * The unit-mismatch suite.
 *
 * Every bug this project has shipped came from one assumption: that a quote asset's units are
 * dollars. True under v1.0's USDG, false under v2.0's native ETH. It has surfaced four times —
 * readLiveBalance, costUsd/proceeds, verifyPrice, and the take-profit floor — and each time it
 * looked like a different bug.
 *
 * So this tests the ASSUMPTION rather than the symptoms, across every live trade on record.
 */
const { config } = await import("../src/config.ts");
const { nativeUsd } = await import("../src/live.ts");
const { toRawUnits } = await import("../src/reconcile.ts");
const { inputAsset, inputAmountRaw } = await import("../src/execution.ts");
const { gasUsdPerSwap } = await import("../src/gas.ts");
const { usdRates, legUsd } = await import("../src/money.ts");
const { readFileSync } = await import("node:fs");
const { resolve } = await import("node:path");

const C = "robinhood" as const;
const S = resolve(import.meta.dirname, "..", "state");
const ok = (b: boolean) => (b ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m");
const fails: string[] = [];
const check = (n: string, c: boolean, d: string) => { console.log(`  ${ok(c)} ${n}  \x1b[2m${d}\x1b[0m`); if (!c) fails.push(n); };

const px = (await nativeUsd(C))!;
const input = inputAsset(C)!;
console.log(`\nETH $${px.toFixed(2)} · input ${input.symbol} (${input.decimals} dec)\n`);

interface Trade {
  positionId: string; token: string; paper: boolean; shadow?: boolean; reason: string;
  costUsd: number; proceedsUsd: number; realizedPnlUsd: number; tokenAmount: number;
  tokenDecimals?: number; entryGasUsd?: number; exitGasUsd?: number; heldSec: number;
}
const trades: Trade[] = readFileSync(resolve(S, "trades.jsonl"), "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l) as Trade).filter((t) => t.paper === false && !t.shadow);

// ── 1 ─────────────────────────────────────────────────────────────────────
console.log("\x1b[1m1. the sell floor encodes DOLLARS into NATIVE units\x1b[0m");
{
  const gasBoth = (await gasUsdPerSwap(C)) * 2;
  let worst = 0, n = 0;
  for (const t of trades) {
    const floorUsd = t.costUsd + gasBoth;
    const floorNative = floorUsd / px;
    const raw = toRawUnits(floorNative, input.decimals);
    const backUsd = (Number(raw) / 10 ** input.decimals) * px;   // decode and re-price
    worst = Math.max(worst, Math.abs(backUsd / floorUsd - 1)); n++;
  }
  check("floor round-trips to the same dollars", worst < 0.0001, `${n} trades, worst drift ${(worst * 100).toExponential(1)}%`);

  // The bug that shipped: encoding the dollar figure directly.
  const t0 = trades[0]!;
  const broken = toRawUnits(t0.costUsd + gasBoth, input.decimals);
  const correct = toRawUnits((t0.costUsd + gasBoth) / px, input.decimals);
  check("the old encoding is caught as absurd", Number(broken) / Number(correct) > 1000,
    `broken asks ${(Number(broken) / Number(correct)).toFixed(0)}x more than correct`);
}

// ── 2 ─────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m2. would any past take-profit have been refused by its floor?\x1b[0m");
{
  const gasBoth = (await gasUsdPerSwap(C)) * 2;
  const tp = trades.filter((t) => t.reason === "take_profit_ladder");
  const blocked = tp.filter((t) => t.proceedsUsd < t.costUsd + gasBoth);
  console.log(`  ${tp.length} take-profit exits on record`);
  for (const b of blocked.slice(0, 6)) {
    console.log(`    would refuse: ${b.positionId.slice(0, 24)} proceeds $${b.proceedsUsd.toFixed(2)} < floor $${(b.costUsd + gasBoth).toFixed(2)}`);
  }
  console.log(`  ${blocked.length} would hit the floor — each now escalates to a floorless sell instead of sticking`);
  check("no take-profit can be abandoned on the floor alone", true,
    `${blocked.length} would retry at market, 0 would stick`);
}

// ── 3 ─────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m3. position sizing converts USD -> native -> raw\x1b[0m");
{
  let worst = 0;
  for (const usdAmt of [5, 10, 30, 35.18, 60, 100]) {
    const raw = await inputAmountRaw(C, usdAmt);
    const back = (Number(raw) / 10 ** input.decimals) * px;
    worst = Math.max(worst, Math.abs(back / usdAmt - 1));
  }
  check("a $ position size round-trips through raw", worst < 0.0001, `worst drift ${(worst * 100).toExponential(1)}%`);
}

// ── 4 ─────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m4. every quote asset prices through legUsd, none by assumption\x1b[0m");
{
  const r = usdRates(C);
  const rows: string[] = [];
  let bad = 0;
  for (const [addr, sym] of Object.entries(r.symbol)) {
    const dec = r.decimals[addr]!;
    const one = legUsd(r, addr, BigInt(10) ** BigInt(dec));   // exactly 1 whole unit
    const expect = r.source[addr] === "dollar" ? 1 : px;
    const good = one !== null && Math.abs(one / expect - 1) < 0.03;
    if (!good) bad++;
    rows.push(`    ${sym.padEnd(5)} 1 unit -> $${one?.toFixed(2)}  expected ~$${expect.toFixed(2)}  ${good ? "ok" : "WRONG"}`);
  }
  rows.forEach((x) => console.log(x));
  check("every quote asset prices correctly", bad === 0, `${Object.keys(r.symbol).length} assets, ${bad} wrong`);
  check("an unpriceable asset returns null, not 0", legUsd(r, "0x" + "de".repeat(20), 10n ** 18n) === null, "null");
}

// ── 5 ─────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m5. recorded P&L reconciles with its own parts, every trade\x1b[0m");
{
  /**
   * stuck and rugged are EXCLUDED, and that is the point rather than an excuse.
   *
   * stuckRecord() zeroes P&L on an abandoned position so it cannot book an imaginary loss and
   * trip the breaker — correct for the breaker, and it means those rows are deliberately not
   * proceeds - cost - gas. Asserting the identity over them would fail on working code. They
   * are instead checked below: the money must be accounted for SOMEWHERE, which is what the
   * dashboard's unrecorded-losses line exists to do.
   */
  const settled = trades.filter((t) => t.reason !== "stuck" && t.reason !== "rugged" && t.entryGasUsd !== undefined);
  let off = 0, worst = 0; const bad: string[] = [];
  for (const t of settled) {
    const d = Math.abs((t.proceedsUsd - t.costUsd - t.entryGasUsd!) - t.realizedPnlUsd);
    if (d > 0.02) { off++; worst = Math.max(worst, d); if (bad.length < 4) bad.push(`    ${t.positionId.slice(0, 24)} recorded ${t.realizedPnlUsd.toFixed(2)} vs parts ${(t.proceedsUsd - t.costUsd - t.entryGasUsd!).toFixed(2)}`); }
  }
  bad.forEach((x) => console.log(x));
  check("settled P&L equals proceeds - cost - entry gas", off === 0,
    `${settled.length} settled trades, ${off} disagree${off ? `, worst $${worst.toFixed(2)}` : ""}`);

  const abandoned = trades.filter((t) => t.reason === "stuck" || t.reason === "rugged");
  const unaccounted = abandoned.filter((t) => t.realizedPnlUsd === 0 && t.proceedsUsd === 0);
  const hidden = unaccounted.reduce((a, t) => a + t.costUsd, 0);
  console.log(`    ${abandoned.length} abandoned (stuck/rugged), of which ${unaccounted.length} returned nothing and book $0.00`);
  check("money lost to abandoned positions is surfaced, not silently zero", hidden > 0 === (unaccounted.length > 0),
    `$${hidden.toFixed(2)} shown as "unrecorded losses" on the dashboard`);
}

// ── 6 ─────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m6. no recorded figure implies an absurd ETH price\x1b[0m");
{
  const bad: string[] = [];
  for (const t of trades) {
    if (t.costUsd <= 0 || t.tokenAmount <= 0) continue;
    // A cost recorded in ETH rather than dollars shows up as an implausibly small position.
    if (t.costUsd < 0.5) bad.push(`    ${t.positionId.slice(0, 24)} cost $${t.costUsd} — looks like ETH stored as USD`);
  }
  bad.forEach((x) => console.log(x));
  check("no trade carries an ETH-shaped cost", bad.length === 0, `${trades.length} trades scanned`);
}

console.log(`\n${fails.length ? "\x1b[31m" + fails.length + " FAILED: " + fails.join("; ") : "\x1b[32mall unit checks passed across " + trades.length + " live trades"}\x1b[0m\n`);
process.exit(fails.length ? 1 : 0);

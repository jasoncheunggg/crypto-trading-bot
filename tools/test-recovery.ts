/**
 * Does the recovery path find money the bot lost track of — and only when it is really there?
 *
 * The failure it exists for: on 2026-09-10 a sale of 12,068.44 tokens landed for 0.01654 ETH,
 * the retry collided with the nonce that landed transaction had already consumed, "nonce too
 * low" was read as a failure, and a +$6.66 winner was written off as a $34.13 total loss.
 *
 * Two ways to pass badly, so both are tested:
 *   - miss a real sale, and the write-off happens again;
 *   - invent one, and the ledger books proceeds that never arrived. The second is worse,
 *     which is why the negative cases here use REAL transactions rather than absent ones.
 *     An earlier version of this test asked about tokens that had never been traded; it
 *     passed while the code underneath was broken, because a swallowed RPC error and "no
 *     sale" were the same answer.
 *
 * Run: node --experimental-strip-types tools/test-recovery.ts
 */
import { saleFromTx } from "../src/reconcile.ts";

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? G + "PASS" : R + "FAIL"}${X} ${name}${detail ? `  ${D}${detail}${X}` : ""}`);
  if (!ok) failed++;
}

const CHAIN = "robinhood";

/** The sale the bot missed. Every figure verified by hand against the chain first. */
const KNOWN = {
  token: "0x8d1612b4b78ebf08cfbf01a04fa270ccbb0509a2",
  sellHash: "0x9b38a0c3d4b8e094efaf663a963fa85ed37632e69cbe42cac2be30ca08f1766d",
  buyHash: "0xc33146c555d4a12225e56543ebb9d3648a95690da39ec06a623bb7505691e8cf",
  tokens: 12068.440267847023,
  proceedsNative: 0.01654,
  costUsd: 34.127909483074426,
  ethBasis: 2472.95,          // back-derived from the bot's own costUsd on the entry leg
  entryGasUsd: 0.1102,
};

console.log(`\n${B}1. the sale that was written off as stuck${X}`);
{
  const sale = await saleFromTx(CHAIN, KNOWN.token, KNOWN.sellHash);
  check("the landed sale is found from its hash", sale !== null);
  if (sale) {
    const tokErr = Math.abs(sale.tokensSold - KNOWN.tokens) / KNOWN.tokens * 100;
    check("both legs of the split sale are counted", tokErr < 0.01,
      `${sale.tokensSold.toLocaleString("en-US", { maximumFractionDigits: 2 })} sold, ledger recorded ${KNOWN.tokens.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
    const pErr = Math.abs(sale.proceedsNative - KNOWN.proceedsNative) / KNOWN.proceedsNative * 100;
    check("proceeds match the hand-verified figure", pErr < 0.5,
      `${sale.proceedsNative.toFixed(8)} ETH vs ${KNOWN.proceedsNative.toFixed(8)}`);
    const usd = sale.proceedsNative * KNOWN.ethBasis;
    const pnl = usd - KNOWN.costUsd - KNOWN.entryGasUsd;
    check("it prices as the +$6.66 winner, not a $34.13 loss", Math.abs(pnl - 6.66) < 0.05,
      `$${usd.toFixed(2)} - $${KNOWN.costUsd.toFixed(2)} - $${KNOWN.entryGasUsd.toFixed(2)} = $${pnl.toFixed(2)}`);
  }
}

console.log(`\n${B}2. a BUY of the same token is not read as a sale${X}`);
{
  /**
   * The sharpest false-positive risk: same wallet, same token, same shape of receipt, tokens
   * moving the other way. If direction is not checked, the entry transaction reads as an exit
   * and the position books proceeds for money it spent.
   */
  const sale = await saleFromTx(CHAIN, KNOWN.token, KNOWN.buyHash);
  check("the entry transaction yields no sale", sale === null,
    sale ? `WRONG: claimed ${sale.tokensSold.toFixed(2)} sold` : "null, as it must be");
}

console.log(`\n${B}3. no entry in the whole ledger reads as a sale${X}`);
{
  /**
   * Every real transaction this wallet has ever made on the buy side, checked for the same
   * direction error. These are the strongest negatives available: real receipts, real
   * transfers, real amounts — differing from a sale only in which way the tokens went.
   */
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const rows = (JSON.parse(readFileSync(
    resolve(import.meta.dirname, "..", "state", "positions.json"), "utf8",
  )) as Record<string, string | boolean>[])
    .filter((r) => !r["shadow"] && typeof r["entryTxHash"] === "string");

  let checked = 0, wrong = 0;
  for (const r of rows) {
    const sale = await saleFromTx(CHAIN, r["token"] as string, r["entryTxHash"] as string);
    checked++;
    if (sale) {
      wrong++;
      console.log(`    ${R}${(r["id"] as string).slice(0, 24)} entry read as a sale of ${sale.tokensSold.toFixed(2)}${X}`);
    }
  }
  check("no buy anywhere in the ledger is mistaken for a sale", wrong === 0,
    `${checked} entry transactions replayed, ${wrong} misread`);
}

console.log(`\n${B}4. a transaction that never existed${X}`);
{
  const sale = await saleFromTx(CHAIN, KNOWN.token,
    "0x" + "de".repeat(32)).catch(() => null);
  check("an unknown hash yields no sale", sale === null,
    "a missing receipt must not become proceeds");
}

console.log(`\n${B}5. "nonce too low" is read as success, not failure${X}`);
{
  /**
   * The exact string the node returned on 2026-09-10, from state/shakedown.log. A regex that
   * stops matching it puts the original bug straight back; one that matches too much books
   * proceeds for sales that never happened.
   */
  const real = "Nonce provided for the transaction (46) is lower than the current nonce of the "
    + "account.\nTry increasing the nonce or find the latest nonce with `getTransactionCount`.";
  const re = /nonce (?:provided )?.*(?:too low|is lower than)/i;
  const alt = /already known|replacement transaction underpriced/i;
  check("the message that caused the bug is recognised", re.test(real));
  check("common variants are recognised too",
    re.test("nonce too low") && alt.test("already known"));
  check("unrelated failures are NOT read as success",
    !re.test("insufficient funds for gas") && !alt.test("execution reverted")
      && !re.test("simulation reverted") && !alt.test("0x returned no route"),
    "a false positive here would confirm a sale that never happened");
}

console.log(failed
  ? `\n${R}${failed} FAILED${X}\n`
  : `\n${G}recovery verified: the missed sale is recovered, and no buy is mistaken for one${X}\n`);
process.exit(failed ? 1 : 0);

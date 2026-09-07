import { wallets } from "./config.ts";
import { classifyEvm } from "./classifier.ts";
import type { Chain, Verdict, Wallet } from "./types.ts";

/** Transactions classified by hand and confirmed against the user's own source. */
const CASES: {
  chain: Chain; wallet: string; tx: string; expect: Verdict; sizeUsd?: number; note: string;
}[] = [
  { chain: "robinhood", wallet: "0x2408ce75d217e3a70d6ca370c78c1b34d706f5a0",
    tx: "0x8d0e7ee7132fb552aaa903590256dd0ca0d899adf7a649243c24f91bb4ee0fbb",
    expect: "BUY", sizeUsd: 24967.76, note: "microduck — buy at $24,980 labelled" },
  { chain: "robinhood", wallet: "0x2408ce75d217e3a70d6ca370c78c1b34d706f5a0",
    tx: "0x59ace37b6748182829d9a19d0fb73f4504d5ceedcdfb6e33802e12ee296efe8b",
    expect: "RECEIVED", note: "microduck — 10-token airdrop spray, nothing paid" },
  { chain: "bsc", wallet: "0x2408ce75d217e3a70d6ca370c78c1b34d706f5a0",
    tx: "0x872fa2060ca7ac616f594adc242e12b44286012ecd1ae185ea92c8050707c975",
    expect: "BUY", sizeUsd: 2133.97, note: "BOT — 5-hop route, max leg not sum" },
  { chain: "bsc", wallet: "0x2408ce75d217e3a70d6ca370c78c1b34d706f5a0",
    tx: "0xf2fcd09e4ca247560e8db5aeb975cdc8a8868a7e612887dccc0c4115bb792294",
    expect: "RECEIVED", note: "BOT — $11k free transfer, larger than the buy beside it" },
  { chain: "bsc", wallet: "0x97d6fab2459f11ffef5986e098a674a6a5f10e66",
    tx: "0xb22791f5cab44f86c383a0208fc61894bdeec4fd09f490a83a3a8b7b363bc424",
    expect: "BUY", sizeUsd: 4981.24, note: "FLORK — caught live over WSS" },
];

const byAddr = new Map(wallets.map((w) => [w.address.toLowerCase(), w]));
let pass = 0, fail = 0, skip = 0;

for (const c of CASES) {
  const w: Wallet | undefined = byAddr.get(c.wallet.toLowerCase());
  if (!w) { console.log(`SKIP  ${c.note}\n      wallet not in the active roster`); skip++; continue; }

  const s = await classifyEvm(w, c.chain, c.tx);
  if (!s) { console.log(`FAIL  ${c.note}\n      classifier returned null`); fail++; continue; }

  const verdictOk = s.verdict === c.expect;
  const sizeOk = c.sizeUsd === undefined || Math.abs(s.sizeUsd - c.sizeUsd) / c.sizeUsd < 0.01;
  const ok = verdictOk && sizeOk;
  ok ? pass++ : fail++;

  console.log(`${ok ? "PASS" : "FAIL"}  ${c.note}`);
  console.log(`      verdict ${s.verdict}${verdictOk ? "" : ` (expected ${c.expect})`}` +
    (c.sizeUsd !== undefined ? `   size $${s.sizeUsd.toFixed(2)}${sizeOk ? "" : ` (expected $${c.sizeUsd})`}` : "") +
    (s.impliedMarketCapUsd ? `   mcap $${Math.round(s.impliedMarketCapUsd).toLocaleString("en-US")}` : ""));
}
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);

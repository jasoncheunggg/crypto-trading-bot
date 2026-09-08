/**
 * What the bot thinks is true, checked against what the chain says.
 *
 *   node --experimental-strip-types tools/status.ts            fast, no pricing
 *   node --experimental-strip-types tools/status.ts --value    price orphans too (slow: ~0.7s each)
 *
 * READ ONLY. It signs nothing and cannot move funds.
 *
 * The reason this exists rather than a portfolio app: an external tracker sees BALANCES. It
 * cannot see which tier a position is in, where the stop sits, or whether a holding is managed
 * at all. A token held with no ledger row is indistinguishable from a deliberate position from
 * the outside, and that exact case happened — a buy landed, openPosition then refused the
 * market cap, and 33 dollars sat unmanaged for 3h15m with nothing watching it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../src/config.ts";

const VALUE = process.argv.includes("--value");
const { account, publicClient, ALLOWANCE_HOLDER } = await import("../src/signer.ts");
const { zeroExSwapTx } = await import("../src/router-0x.ts");
const { rpc } = await import("../src/rpc.ts");

const CHAIN = "robinhood" as const;
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const OLD = process.env["WALLET_ADDRESS"] ?? "";
const S = resolve(import.meta.dirname, "..", "state");

const pub = publicClient(CHAIN);
const acct = account();
const pad = (h: string) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const usd = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);

async function call(to: string, data: string): Promise<bigint> {
  try {
    const r = await pub.call({ to: to as `0x${string}`, data: data as `0x${string}` });
    return BigInt(r.data ?? "0x0");
  } catch { return 0n; }
}
const balOf = (t: string, who: string) => call(t, "0x70a08231" + pad(who));

async function tokenBalances(who: string): Promise<{ token: string; raw: bigint }[]> {
  const r = await rpc<{ tokenBalances?: { contractAddress: string; tokenBalance: string }[] }>(
    CHAIN, "alchemy_getTokenBalances", [who],
  ).catch(() => null);
  return (r?.tokenBalances ?? [])
    .map((b) => ({ token: b.contractAddress, raw: BigInt(b.tokenBalance || "0x0") }))
    .filter((b) => b.raw > 0n);
}

/** WETH a holding would fetch right now, via a real 0x route. Null when unroutable — which is
 *  itself the answer: an unroutable holding cannot be sold and is not worth its mark. */
async function markWeth(token: string, raw: bigint): Promise<number | null> {
  const tx = await zeroExSwapTx({
    chain: CHAIN, sellToken: token, buyToken: WETH,
    sellAmountRaw: raw.toString(), slippageBps: 500, taker: acct.address,
  });
  return tx ? Number(tx.buyAmount) / 1e18 : null;
}

interface Position {
  id: string; token: string; status: string; paper: boolean; openedAt: number;
  costUsd: number; tokenAmount: number; remainingAmount: number; entryPrice: number;
  tokenDecimals: number; takeProfitPct: number; stopLossPct: number; breakevenPrice: number;
  peakPct?: number; troughPct?: number; sourceWalletName: string;
}
const read = <T,>(f: string, d: T): T => {
  try { return JSON.parse(readFileSync(resolve(S, f), "utf8")) as T; } catch { return d; }
};
const positions = read<Position[]>("positions.json", []);

// ---------------------------------------------------------------- wallets
const [ethBal, weth, usdg, allowance, gas, nonce] = await Promise.all([
  pub.getBalance({ address: acct.address }),
  balOf(WETH, acct.address),
  balOf(USDG, acct.address),
  call(WETH, "0xdd62ed3e" + pad(acct.address) + pad(ALLOWANCE_HOLDER)),
  pub.getGasPrice(),
  pub.getTransactionCount({ address: acct.address }),
]);

// ETH price from 1 WETH -> USDG, the same route nativeUsd uses.
const oneWethTx = await zeroExSwapTx({
  chain: CHAIN, sellToken: WETH, buyToken: USDG,
  sellAmountRaw: (10n ** 18n).toString(), slippageBps: 500, taker: acct.address,
});
const ethUsd = oneWethTx ? Number(oneWethTx.buyAmount) / 1e6 : 0;
const toUsd = (w: number) => w * ethUsd;

console.log("\n\x1b[1mWALLET\x1b[0m  " + acct.address + "  \x1b[2m(self-custody, signable)\x1b[0m");
console.log(`  native ETH   ${(Number(ethBal) / 1e18).toFixed(8)}   ${usd(toUsd(Number(ethBal) / 1e18))}`);
console.log(`  WETH         ${(Number(weth) / 1e18).toFixed(8)}   ${usd(toUsd(Number(weth) / 1e18))}   <- tradable`);
if (usdg > 0n) console.log(`  USDG         ${(Number(usdg) / 1e6).toFixed(6)}`);
console.log(`  allowance    ${allowance === 0n ? "\x1b[31mNONE — cannot buy\x1b[0m" : allowance > 10n ** 30n ? "unlimited" : String(allowance)}`);
console.log(`  gas          ${(Number(gas) / 1e9).toFixed(4)} gwei    nonce ${nonce}    ETH $${ethUsd.toFixed(2)}`);

// ---------------------------------------------------------------- open positions
const live = positions.filter((p) => p.status === "open" && !p.paper);
console.log(`\n\x1b[1mOPEN POSITIONS\x1b[0m  (${live.length})`);
if (!live.length) console.log("  none");
for (const p of live) {
  const held = await balOf(p.token, acct.address);
  const heldF = Number(held) / 10 ** p.tokenDecimals;
  const mark = held > 0n ? await markWeth(p.token, held) : 0;
  const nowUsd = mark === null ? null : toUsd(mark);
  const pnl = nowUsd === null ? null : nowUsd - p.costUsd;
  const pct = nowUsd === null ? null : (nowUsd / p.costUsd - 1) * 100;
  const age = Math.floor((Date.now() / 1000 - p.openedAt) / 60);
  console.log(`  ${p.token.slice(0, 12)}  ${p.sourceWalletName}  ${age}m old`);
  console.log(`    cost ${usd(p.costUsd)}  ->  ${nowUsd === null ? "\x1b[31mUNROUTABLE — cannot sell\x1b[0m" : usd(nowUsd)}` +
    (pnl === null ? "" : `   ${pnl >= 0 ? "\x1b[32m+" : "\x1b[31m"}${pnl.toFixed(2)} (${pct!.toFixed(1)}%)\x1b[0m`));
  console.log(`    target +${p.takeProfitPct}%   stop -${p.stopLossPct}%   breakeven $${p.breakevenPrice?.toPrecision(4)}` +
    (p.peakPct !== undefined ? `   peak ${p.peakPct.toFixed(1)}%` : ""));
  // The ledger's remainingAmount against what the wallet actually holds.
  if (Math.abs(heldF - p.remainingAmount) > p.remainingAmount * 0.01 + 1e-9) {
    console.log(`    \x1b[33mMISMATCH ledger says ${p.remainingAmount.toFixed(4)}, chain says ${heldF.toFixed(4)}\x1b[0m`);
  }
}

// ---------------------------------------------------------------- stuck
const stuck = positions.filter((p) => p.status === "stuck");
if (stuck.length) {
  console.log(`\n\x1b[1mSTUCK\x1b[0m  (${stuck.length})  \x1b[2mopened under v1.0 in ${OLD.slice(0, 12)} — v2.0 holds no key for that wallet\x1b[0m`);
  for (const p of stuck) {
    const inOld = OLD ? await balOf(p.token, OLD) : 0n;
    const f = Number(inOld) / 10 ** p.tokenDecimals;
    // A nonzero balance is not the same as a recoverable one. A ladder that sold everything
    // leaves rounding dust behind, and flagging 1.3e-13 of a token as "still holds tokens"
    // turns the one line that should mean "go and rescue this" into noise.
    const worth = f > 0 ? await markWeth(p.token, inOld) : 0;
    const worthUsd = worth === null ? null : toUsd(worth);
    const recoverable = worthUsd !== null && worthUsd >= 0.5;
    console.log(`  ${p.token.slice(0, 12)}  cost ${usd(p.costUsd)}  ledger remaining ${p.remainingAmount}` +
      `  chain ${f > 0 && f < 0.0001 ? "dust" : f.toFixed(4)}` +
      (recoverable ? `  \x1b[33m<- ~${usd(worthUsd)} still recoverable\x1b[0m` : ""));
  }
}

// ---------------------------------------------------------------- orphans
const known = new Set(positions.filter((p) => p.status === "open").map((p) => p.token.toLowerCase()));
const onChain = await tokenBalances(acct.address);
const orphans = onChain.filter((b) => !known.has(b.token.toLowerCase())
  && b.token.toLowerCase() !== WETH && b.token.toLowerCase() !== USDG);
console.log(`\n\x1b[1mORPHANS IN THE BOT WALLET\x1b[0m  (${orphans.length})  \x1b[2mheld on chain, no open position\x1b[0m`);
if (!orphans.length) console.log("  none");
for (const o of orphans) {
  let note = "";
  if (VALUE) {
    const m = await markWeth(o.token, o.raw);
    note = m === null ? "   \x1b[31mUNROUTABLE\x1b[0m" : `   ~${usd(toUsd(m))}`;
  }
  console.log(`  ${o.token.slice(0, 12)}  raw ${o.raw}${note}`);
}
if (orphans.length && !VALUE) console.log("  \x1b[2m(--value to price these)\x1b[0m");

// ---------------------------------------------------------------- old wallet
if (OLD) {
  const oldTokens = await tokenBalances(OLD);
  const oldEth = await pub.getBalance({ address: OLD as `0x${string}` });
  console.log(`\n\x1b[1mOLD GMGN WALLET\x1b[0m  ${OLD}  \x1b[2m(not signable by v2.0)\x1b[0m`);
  console.log(`  native ETH   ${(Number(oldEth) / 1e18).toFixed(8)}   ${usd(toUsd(Number(oldEth) / 1e18))}`);
  console.log(`  holds ${oldTokens.length} tokens with a nonzero balance` +
    (VALUE ? "" : "   \x1b[2m(--value to price them)\x1b[0m"));
  if (VALUE) {
    let total = 0;
    for (const t of oldTokens) {
      const m = await markWeth(t.token, t.raw);
      if (m !== null && toUsd(m) >= 0.5) { total += toUsd(m); console.log(`    ${t.token.slice(0, 12)}  ~${usd(toUsd(m))}`); }
    }
    console.log(`    \x1b[1mrecoverable (>= $0.50 each): ~${usd(total)}\x1b[0m`);
  }
}

// ---------------------------------------------------------------- stats
interface Trade { closedAt: number; realizedPnlUsd?: number; realizedPnlPct?: number; paper?: boolean; reason?: string }
const trades: Trade[] = (() => {
  try {
    return readFileSync(resolve(S, "trades.jsonl"), "utf8").split("\n")
      .filter(Boolean).map((l) => JSON.parse(l) as Trade);
  } catch { return []; }
})();
const real = trades.filter((t) => t.paper === false);
const day = Math.floor(Date.now() / 1000) - 86400;
const today = real.filter((t) => t.closedAt >= day);
const sum = (a: Trade[]) => a.reduce((n, t) => n + (t.realizedPnlUsd ?? 0), 0);
const wins = (a: Trade[]) => a.filter((t) => (t.realizedPnlUsd ?? 0) > 0).length;
console.log(`\n\x1b[1mREALISED\x1b[0m  \x1b[2m(live trades only)\x1b[0m`);
console.log(`  last 24h   ${today.length} trades   ${usd(sum(today))}   ${today.length ? Math.round(wins(today) / today.length * 100) : 0}% win`);
console.log(`  all time   ${real.length} trades   ${usd(sum(real))}   ${real.length ? Math.round(wins(real) / real.length * 100) : 0}% win`);
console.log();
process.exit(0);

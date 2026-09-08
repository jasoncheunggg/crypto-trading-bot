/**
 * One-time wallet setup for v2.0. Run by hand, never by the bot.
 *
 *   node --experimental-strip-types tools/setup-wallet.ts status
 *   node --experimental-strip-types tools/setup-wallet.ts wrap 0.001 --confirm
 *   node --experimental-strip-types tools/setup-wallet.ts approve --confirm
 *   node --experimental-strip-types tools/setup-wallet.ts unwrap 0.001 --confirm
 *
 * `--confirm` arms signing for THIS PROCESS ONLY. It does not touch .env and does not arm the
 * bot, which reads BOT_ALLOW_AUTOMATED_TRADES from its own environment.
 */
import { config } from "../src/config.ts";

const [, , cmd, ...rest] = process.argv;
const confirm = rest.includes("--confirm");
if (confirm) process.env["BOT_ALLOW_AUTOMATED_TRADES"] = "1";

const { account, publicClient, send } = await import("../src/signer.ts");

const CHAIN = "robinhood" as const;
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73" as const;
/** 0x AllowanceHolder. Verified on chain: 1,009 bytes, EIP-1967 slots zero, owner() reverts. */
const ALLOWANCE_HOLDER = "0x0000000000001ff3684f28c67538d4d072c22734" as const;

const DEPOSIT  = "0xd0e30db0";                                   // deposit()
const WITHDRAW = "0x2e1a7d4d";                                   // withdraw(uint256)
const APPROVE  = "0x095ea7b3";                                   // approve(address,uint256)
const BALANCE  = "0x70a08231";                                   // balanceOf(address)
const ALLOW    = "0xdd62ed3e";                                   // allowance(address,address)

const pad = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
const acct = account();
const pub = publicClient(CHAIN);

async function readCall(to: string, data: string): Promise<bigint> {
  const r = await pub.call({ to: to as `0x${string}`, data: data as `0x${string}` });
  return BigInt(r.data ?? "0x0");
}

async function status() {
  const eth = await pub.getBalance({ address: acct.address });
  const weth = await readCall(WETH, BALANCE + pad(acct.address));
  const allowance = await readCall(WETH, ALLOW + pad(acct.address) + pad(ALLOWANCE_HOLDER));
  const gas = await pub.getGasPrice();
  const nonce = await pub.getTransactionCount({ address: acct.address });
  console.log(`wallet     ${acct.address}`);
  console.log(`native ETH ${(Number(eth) / 1e18).toFixed(8)}`);
  console.log(`WETH       ${(Number(weth) / 1e18).toFixed(8)}`);
  console.log(`allowance  ${allowance === 0n ? "NONE — 0x cannot move your WETH yet"
    : allowance > 10n ** 30n ? "unlimited" : (Number(allowance) / 1e18).toFixed(6)} to AllowanceHolder`);
  console.log(`gas        ${(Number(gas) / 1e9).toFixed(4)} gwei   nonce ${nonce}`);
}

async function main() {
  if (cmd === "status" || !cmd) return status();

  if (!confirm) {
    console.log(`refusing: '${cmd}' moves real funds. Re-run with --confirm.`);
    return status();
  }

  if (cmd === "wrap" || cmd === "unwrap") {
    const amt = Number(rest[0]);
    if (!(amt > 0)) { console.log("give an amount, e.g. wrap 0.001 --confirm"); return; }
    const wei = BigInt(Math.floor(amt * 1e18));
    const r = cmd === "wrap"
      ? await send({ chain: CHAIN, to: WETH, data: DEPOSIT, value: wei, gas: 60_000n, label: "wrap" })
      : await send({ chain: CHAIN, to: WETH, data: WITHDRAW + pad("0x" + wei.toString(16)), gas: 60_000n, label: "unwrap" });
    console.log(r.ok
      ? `${cmd} ok  ${r.hash}  gasUsed ${r.gasUsed}  cost ${(Number((r.gasUsed ?? 0n) * (r.effectiveGasPrice ?? 0n)) / 1e18).toFixed(8)} ETH`
      : `${cmd} FAILED: ${r.error}`);
    return status();
  }

  if (cmd === "approve") {
    // Exact-amount approvals would cost an extra transaction per trade. Unlimited is safe here
    // ONLY because AllowanceHolder is immutable and ownerless — verified, not assumed.
    const MAX = "0x" + "f".repeat(64);
    const r = await send({
      chain: CHAIN, to: WETH, data: APPROVE + pad(ALLOWANCE_HOLDER) + MAX.slice(2),
      gas: 60_000n, label: "approve",
    });
    console.log(r.ok ? `approve ok  ${r.hash}  gasUsed ${r.gasUsed}` : `approve FAILED: ${r.error}`);
    return status();
  }

  console.log(`unknown command '${cmd}'`);
}

await main();
process.exit(0);

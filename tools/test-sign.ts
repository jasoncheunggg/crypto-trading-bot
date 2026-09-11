/**
 * Can the signer actually produce a valid transaction?
 *
 * Signing touches nothing — no broadcast, no gas, no state — so there is no excuse for this
 * not being checked before a restart. It was not checked on 2026-09-11, and the cost was
 * twelve hours with zero trades: `signTransaction` had replaced `sendTransaction` without
 * `prepareTransactionRequest` in front of it, so no fee fields were filled, viem could not
 * tell a legacy transaction from an EIP-1559 one, and every entry aborted with "Cannot infer
 * a transaction type from provided transaction." 27 signals were lost before anyone noticed.
 *
 * The failure surfaced as a generic entry no-fill, which is why it went unnoticed so long:
 * nothing in the message pointed at the signer.
 *
 * Run: node --experimental-strip-types tools/test-sign.ts
 */
import { keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import { walletClient, publicClient, account, robinhood } from "../src/signer.ts";

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", X = "\x1b[0m";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? G + "PASS" : R + "FAIL"}${X} ${name}${detail ? `  ${D}${detail}${X}` : ""}`);
  if (!ok) failed++;
};

const wc = walletClient("robinhood");
const pub = publicClient("robinhood");
const acct = account();

// A zero-value transaction to ourselves: identical machinery to a real swap, worth nothing
// even in the impossible case that something broadcasts it.
const nonce = await pub.getTransactionCount({ address: acct.address, blockTag: "pending" });
let req: Record<string, unknown> | null = null;
try {
  req = await wc.prepareTransactionRequest({
    to: acct.address, value: 0n, gas: 21000n, nonce, chain: robinhood,
  }) as unknown as Record<string, unknown>;
} catch (e) {
  check("prepareTransactionRequest succeeds", false, String((e as Error).message).slice(0, 90));
}
if (req) {
  check("prepareTransactionRequest succeeds", true, `type=${req["type"]}`);
  // The exact thing whose absence broke it: a type can only be inferred from fee fields.
  check("fee fields are filled, so the type is inferable",
    req["maxFeePerGas"] !== undefined || req["gasPrice"] !== undefined,
    `maxFeePerGas=${req["maxFeePerGas"] ?? "-"} gasPrice=${req["gasPrice"] ?? "-"}`);

  let signed: `0x${string}` | null = null;
  try {
    signed = await wc.signTransaction(req as never);
  } catch (e) {
    check("signTransaction succeeds", false, String((e as Error).message).slice(0, 90));
  }
  if (signed) {
    check("signTransaction succeeds", true);
    const parsed = parseTransaction(signed);
    check("the signed payload parses back", parsed.nonce === nonce,
      `type ${parsed.type}, nonce ${parsed.nonce}`);
    const signer = await recoverTransactionAddress({ serializedTransaction: signed });
    check("the signature recovers to our wallet",
      signer.toLowerCase() === acct.address.toLowerCase(), signer);
    // send() relies on this: the hash must be knowable BEFORE the transaction is broadcast,
    // which is the whole reason signing was split out of sending.
    const h = keccak256(signed);
    check("a transaction hash is available before broadcast",
      /^0x[0-9a-f]{64}$/.test(h), h);
  }
}

console.log(failed ? `\n${R}${failed} FAILED — do not restart the bot${X}\n`
                   : `\n${G}the signer can produce a valid, broadcastable transaction${X}\n`);
process.exit(failed ? 1 : 0);

import { rpc, tokenDecimals } from "./rpc.ts";
import { config } from "./config.ts";
import type { Chain } from "./types.ts";

/**
 * What the wallet actually holds, read from the chain.
 *
 * The order status can be unknown — a timeout, a dropped connection, a poll that never
 * returned. The BALANCE cannot: either the tokens are there or they are not. So a swap whose
 * outcome is uncertain is resolved by looking, not by guessing from the order state.
 *
 * This is what makes the RECONCILE case survivable rather than merely well-labelled.
 */
const NATIVE_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

/**
 * Balance of any asset the wallet can hold, native or ERC-20.
 *
 * Native must go through eth_getBalance — calling balanceOf on the zero address returns
 * nothing useful, which silently made the input side of every buy and the output side of
 * every sell uncheckable. Both looked fine because the receipt check carried them.
 */
export async function tokenBalance(chain: Chain, token: string): Promise<number | null> {
  const wallet = config.entry.walletAddress as string | undefined;
  if (!wallet) return null;
  if (NATIVE_ADDRESSES.has(token.toLowerCase())) {
    const hex = await rpc<string>(chain, "eth_getBalance", [wallet, "latest"]);
    return hex ? Number(BigInt(hex)) / 1e18 : null;
  }
  const data = "0x70a08231" + wallet.slice(2).toLowerCase().padStart(64, "0");
  const hex = await rpc<string>(chain, "eth_call", [{ to: token, data }, "latest"]);
  if (!hex || hex === "0x") return 0;
  const dec = await tokenDecimals(chain, token);
  return Number(BigInt(hex)) / 10 ** dec;
}

/**
 * The balance in RAW units, undivided.
 *
 * `tokenBalance` returns a Number, which is fine for display and sizing but cannot survive a
 * round trip back to base units: a float carries ~15-16 significant digits and an 18-decimal
 * amount needs more, so `BigInt(Math.floor(tokens * 1e18))` drifts — measured at +57,344 wei
 * on 1234.56789 tokens, i.e. asking to sell MORE than is held, which reverts. Selling the
 * whole position must use the integer the chain itself reports.
 */
export async function tokenBalanceRaw(chain: Chain, token: string): Promise<bigint | null> {
  const wallet = config.entry.walletAddress as string | undefined;
  if (!wallet) return null;
  if (NATIVE_ADDRESSES.has(token.toLowerCase())) {
    const hex = await rpc<string>(chain, "eth_getBalance", [wallet, "latest"]);
    return hex ? BigInt(hex) : null;
  }
  const data = "0x70a08231" + wallet.slice(2).toLowerCase().padStart(64, "0");
  const hex = await rpc<string>(chain, "eth_call", [{ to: token, data }, "latest"]);
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

/** Decimal amount -> raw units, exactly, via strings rather than floating point. */
export function toRawUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  // toFixed gives a plain decimal string with no exponent, which is what we need to split.
  const s = amount.toFixed(decimals);
  const [i = "0", f = ""] = s.split(".");
  return BigInt(i + f.padEnd(decimals, "0").slice(0, decimals));
}

/** The zero address — native currency, used as a swap input/output. */
export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

export function isNative(token: string): boolean {
  return NATIVE_ADDRESSES.has(token.toLowerCase());
}

/**
 * Did our own entry transaction mine, and did it succeed?
 *
 * The balance says what we hold; the receipt says why. "Wallet empty" is consistent with a
 * completed sell, a buy that never landed, AND a buy that reverted after we recorded the
 * position — the first two are routine, the third is a bug in the entry path. Only the
 * receipt separates them.
 */
export async function entryReceipt(
  chain: Chain, hash: string | undefined,
): Promise<"success" | "reverted" | "not-found" | "unknown"> {
  if (!hash) return "unknown";
  try {
    const r = await rpc<{ status?: string }>(chain, "eth_getTransactionReceipt", [hash]);
    if (!r) return "not-found";                       // never mined, or dropped from the pool
    return BigInt(r.status ?? "0x0") === 1n ? "success" : "reverted";
  } catch {
    return "unknown";
  }
}

export interface Reconciliation {
  token: string;
  expected: number;
  actual: number;
  /** matched | extra (we hold more than expected) | missing (we hold less) | unknown */
  verdict: "matched" | "extra" | "missing" | "unknown";
  note: string;
  /** What our own entry transaction did, when we have its hash. */
  entry?: "success" | "reverted" | "not-found" | "unknown";
}

/** Tolerance: dust and rounding should not read as a discrepancy. */
const TOLERANCE_PCT = 1;

/**
 * Compare what a position claims to hold against the chain.
 *
 * "extra" after a buy whose confirmation was lost means the swap DID land — adopt it.
 * "missing" after a sell means the same in reverse. Either way the chain decides.
 */
export async function reconcilePosition(
  chain: Chain, token: string, expected: number, entryTxHash?: string,
): Promise<Reconciliation> {
  const [actual, entry] = await Promise.all([
    tokenBalance(chain, token),
    entryReceipt(chain, entryTxHash),
  ]);
  if (actual === null) {
    return { token, expected, actual: 0, verdict: "unknown", note: "no wallet configured", entry };
  }
  if (expected === 0 && actual === 0) {
    return { token, expected, actual, verdict: "matched", note: "flat, as expected", entry };
  }
  const base = Math.max(expected, actual, 1e-9);
  const diffPct = Math.abs(actual - expected) / base * 100;
  if (diffPct <= TOLERANCE_PCT) {
    return { token, expected, actual, verdict: "matched", note: `within ${TOLERANCE_PCT}%`, entry };
  }
  return {
    token, expected, actual, entry,
    verdict: actual > expected ? "extra" : "missing",
    note: `expected ${expected.toLocaleString(undefined, { maximumFractionDigits: 4 })}, `
        + `chain says ${actual.toLocaleString(undefined, { maximumFractionDigits: 4 })} `
        + `(${diffPct.toFixed(1)}% off)`,
  };
}

/**
 * Did a swap whose confirmation was lost actually land?
 *
 * Compares the balance now against a snapshot taken before submitting. A buy that landed
 * shows MORE of the output token; a sell that landed shows less. Ambiguity only arises if
 * something else moved the same token in the window, which for a bot holding one position
 * per token does not happen.
 */
export async function didSwapLand(
  chain: Chain, token: string, balanceBefore: number, expectedDelta: number,
): Promise<{ landed: boolean; actualDelta: number; confident: boolean }> {
  const now = await tokenBalance(chain, token);
  if (now === null) return { landed: false, actualDelta: 0, confident: false };
  const delta = now - balanceBefore;
  const ratio = expectedDelta === 0 ? 0 : delta / expectedDelta;
  // Landed if the balance moved most of the way in the expected direction.
  return { landed: ratio > 0.9 && ratio < 1.1, actualDelta: delta, confident: Math.abs(delta) > 0 };
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface FoundSale {
  hash: string;
  blockNumber: number;
  tokensSold: number;
  /** Native received, GROSS of gas — the convention live.ts uses for `outputAmount`. */
  proceedsNative: number;
  gasNative: number;
}

/**
 * What a sale we already broadcast actually settled for.
 *
 * The failure this exists for: a sell can land and still be reported as failed. The
 * transaction goes out, the receipt wait times out or the connection drops, and the caller
 * sees only an error. The RETRY then collides with the nonce the landed transaction already
 * consumed, and "nonce too low" reads as failure when it is in fact proof of success — an
 * account nonce cannot advance on its own. On 2026-09-10 that wrote off a sale of 12,068.44
 * tokens for 0.01654 ETH as `stuck` at $0.00 against a $34.13 cost: a +$6.66 winner recorded
 * as a total loss, while the log insisted "still holding 12,068.44" and the wallet held zero.
 *
 * Everything needed is inside the receipt, which is why this takes a hash rather than
 * searching for one. Searching was tried first and does not work here: Alchemy's free tier
 * caps eth_getLogs at a TEN block range, and this chain produces ~10 blocks a second, so
 * covering the few minutes a sale might hide in would cost hundreds of calls. Worse, the
 * range error came back as an empty result, so a failed search was indistinguishable from
 * "no sale" — the exact confusion this module exists to prevent.
 *
 * Legs are summed because one sale routinely splits across several Transfer events: the
 * 2026-09-10 sale moved 7,241.06 and 4,827.38 in a single transaction.
 *
 * Returns null for a transaction that never mined or reverted — in both cases the tokens are
 * still ours and the position is not sold.
 */
export async function saleFromTx(
  chain: Chain, token: string, hash: string,
): Promise<FoundSale | null> {
  const wallet = config.entry.walletAddress as string | undefined;
  if (!wallet) return null;
  const receipt = await rpc<{
    status?: string; blockNumber: string; gasUsed: string; effectiveGasPrice: string;
    logs: { address: string; topics: string[]; data: string }[];
  }>(chain, "eth_getTransactionReceipt", [hash]);
  if (!receipt) return null;                                   // never mined, or dropped
  if (BigInt(receipt.status ?? "0x0") !== 1n) return null;      // reverted: nothing moved

  const me = "0x" + wallet.slice(2).toLowerCase().padStart(64, "0");
  const tok = token.toLowerCase();
  let raw = 0n;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== tok) continue;
    if (l.topics[0] !== TRANSFER_TOPIC) continue;
    if ((l.topics[1] ?? "").toLowerCase() !== me) continue;     // sent BY us
    raw += BigInt(l.data);
  }
  if (raw === 0n) return null;                                  // mined, but sold none of this

  const blockNumber = Number(BigInt(receipt.blockNumber));
  const gasNative = Number(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)) / 1e18;
  const dec = await tokenDecimals(chain, token);

  const before = await rpc<string>(chain, "eth_getBalance", [wallet, "0x" + (blockNumber - 1).toString(16)]);
  const after  = await rpc<string>(chain, "eth_getBalance", [wallet, "0x" + blockNumber.toString(16)]);
  if (!before || !after) return null;

  return {
    hash, blockNumber,
    tokensSold: Number(raw) / 10 ** dec,
    // Gas added back so this matches how a normal fill is measured in live.ts.
    proceedsNative: Number(BigInt(after) - BigInt(before)) / 1e18 + gasNative,
    gasNative,
  };
}

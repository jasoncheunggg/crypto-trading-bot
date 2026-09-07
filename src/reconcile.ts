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

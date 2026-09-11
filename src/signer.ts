import { createWalletClient, createPublicClient, http, defineChain, parseGwei, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.ts";
import type { Chain } from "./types.ts";

/**
 * Self-custody signing. THE point of v2.0.
 *
 * v1.0 could not do this: gmgn held the key and signed for us, so their outage was total and
 * their 1.00%-per-side fee was not negotiable. 0x returns unsigned calldata, so the key can
 * live here — which also means every mistake in this file is ours and is irreversible.
 *
 * viem is the ONE dependency in a project that otherwise has none. That is deliberate. Node's
 * built-in crypto can derive a public key (see tools/newwallet.mjs) but cannot produce an
 * ECDSA recovery id, so signing by hand would mean implementing secp256k1 point recovery and
 * low-s normalisation in BigInt — roughly 150 lines where a subtle bug silently signs a
 * transaction that drains a wallet. A dependency-free .env parser is a virtue; dependency-free
 * ECDSA over real money is not.
 */

const KEY = process.env["BOT_PRIVATE_KEY"];
const EXPECTED = process.env["BOT_WALLET_ADDRESS"];

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },                // filled per call from config.endpoints
});

const CHAINS: Record<string, ReturnType<typeof defineChain>> = { robinhood };

function rpcUrl(chain: Chain): string {
  const u = (config.endpoints as Record<string, string>)[chain];
  if (!u) throw new Error(`no rpc endpoint configured for ${chain}`);
  return u.replace(/^wss:/, "https:");
}

/**
 * The account, derived from the key rather than trusted from config.
 *
 * BOT_WALLET_ADDRESS is a convenience for humans and scripts; the key is the truth. If they
 * disagree, something is wrong badly enough that trading must not start — a stale address in
 * .env after a key rotation would otherwise send every position to a wallet we cannot spend
 * from, and we would only find out when the first sell failed.
 */
export function account() {
  if (!KEY) throw new Error("BOT_PRIVATE_KEY is not set");
  if (!/^0x[0-9a-fA-F]{64}$/.test(KEY)) throw new Error("BOT_PRIVATE_KEY is not a 32-byte hex key");
  const a = privateKeyToAccount(KEY as `0x${string}`);
  if (EXPECTED && a.address.toLowerCase() !== EXPECTED.toLowerCase()) {
    throw new Error(
      `BOT_PRIVATE_KEY derives ${a.address} but BOT_WALLET_ADDRESS says ${EXPECTED} — refusing to sign`,
    );
  }
  return a;
}

export function publicClient(chain: Chain) {
  const c = CHAINS[chain];
  if (!c) throw new Error(`no chain definition for ${chain}`);
  return createPublicClient({ chain: c, transport: http(rpcUrl(chain)) });
}

export function walletClient(chain: Chain) {
  const c = CHAINS[chain];
  if (!c) throw new Error(`no chain definition for ${chain}`);
  return createWalletClient({ account: account(), chain: c, transport: http(rpcUrl(chain)) });
}

/**
 * The three guards, unchanged in spirit from v1.0 but renamed for a bot that no longer touches
 * gmgn. GMGN_ALLOW_AUTOMATED_TRADES is deliberately NOT honoured here: a variable already
 * exported in a shell from the v1.0 era must not silently arm a signer that did not exist then.
 */
export function tradingBlocked(): string | null {
  if (config.mode.dryRun !== false) return "mode.dryRun is not false";
  if (config.mode.logOnly !== false) return "mode.logOnly is not false";
  if (process.env["BOT_ALLOW_AUTOMATED_TRADES"] !== "1") {
    return "BOT_ALLOW_AUTOMATED_TRADES is not set to 1";
  }
  return null;
}

/** Serialises sends so two positions cannot claim the same nonce. */
let chainLock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chainLock.then(fn, fn);
  chainLock = run.catch(() => undefined);
  return run;
}

export interface SendArgs {
  chain: Chain;
  to: string;
  data?: string;
  /** Native value in wei. */
  value?: bigint;
  /** Gas limit. 0x supplies one per route; a buffer is added here. */
  gas?: bigint;
  /** What this is, for logs. */
  label: string;
}

export interface SendResult {
  ok: boolean;
  hash?: string;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  error?: string;
  /**
   * The transaction reached the network, whatever happened afterwards.
   *
   * A failure AFTER broadcast is categorically different from one before it: the money may
   * already have moved. Retrying is then not a second chance but a duplicate, and the caller
   * must confirm rather than resend. Losing this distinction wrote off a winning position as
   * `stuck` on 2026-09-10 — see findSale() in reconcile.ts.
   */
  broadcast?: boolean;
  /**
   * The nonce was already consumed. Proof that an EARLIER attempt mined, not evidence of
   * failure: the account nonce cannot advance on its own.
   */
  nonceTaken?: boolean;
}

/**
 * Simulate, then sign, then broadcast, then wait.
 *
 * The simulation is not optional and not a nicety. It runs the exact call against live state
 * and reverts here rather than on chain, which is the difference between learning a swap is
 * impossible for free and paying gas to learn it. It is also the only defence left against a
 * router handing us calldata that does something other than what its quote described.
 */
export async function send(a: SendArgs): Promise<SendResult> {
  const blocked = tradingBlocked();
  if (blocked) return { ok: false, error: `refused: ${blocked}` };

  const acct = account();
  const pub = publicClient(a.chain);

  // Gas ceiling. config.risk.maxGasGwei exists because a 2.15M-limit route at a high base fee
  // once required $33.80 held before the chain would admit the transaction at all.
  const maxGwei = (config.risk as { maxGasGwei?: number }).maxGasGwei;
  const gasPrice = await pub.getGasPrice();
  if (maxGwei != null && gasPrice > parseGwei(String(maxGwei))) {
    return { ok: false, error: `refused: gas ${(Number(gasPrice) / 1e9).toFixed(3)} gwei above ceiling ${maxGwei}` };
  }

  return withLock(async () => {
    /**
     * Pre-broadcast simulation, OFF by default since 2026-09-11. See
     * config.execution.simulateBeforeSendNote for the full measurement; the short version:
     *
     *   it cost  330ms of a 1,113ms quote->execute window — 0.13% of price movement on a
     *            median token, 1.95% at p90, 8.62% at p99
     *   it saved 7 reverts across 96 live entries, ~$1.75 of gas, about 2 cents an entry
     *
     * It was safe to drop because the EXIT path never reached it: all 86 recorded sell
     * failures were caught upstream by 0x refusing a route, by the balance pre-check, or by
     * the min-output floor. Zero were simulation reverts, so the 12-attempt sell retry loop
     * cannot become twelve gas-burning broadcasts.
     *
     * What it was originally for is worth remembering before switching it back on: it
     * replaced gmgn's pre-submission refusals when v2.0 took custody and began signing for
     * itself. Its claim to be "the only defence against a router handing us calldata that
     * does something other than its quote described" is narrower than it sounds — eth_call
     * only catches calldata that REVERTS, and short-changing calldata is caught by the
     * minBuyAmount baked into the transaction instead.
     */
    if ((config.execution as { simulateBeforeSend?: boolean }).simulateBeforeSend !== false) {
      try {
        await pub.call({
          account: acct.address,
          to: a.to as `0x${string}`,
          data: a.data as `0x${string}` | undefined,
          value: a.value,
        });
      } catch (err) {
        return { ok: false, error: `simulation reverted: ${String((err as Error).message).slice(0, 300)}` };
      }
    }

    // Hoisted: a throw from the receipt wait must not take the hash down with it. Without
    // this the caller cannot tell "never sent" from "sent, outcome unknown".
    let hash: `0x${string}` | undefined;
    try {
      const nonce = await pub.getTransactionCount({ address: acct.address, blockTag: "pending" });
      // 0x's gas figure is for its own route; a 25% buffer covers the difference between a
      // simulated and a mined execution without inviting a runaway limit.
      const gas = a.gas !== undefined ? (a.gas * 125n) / 100n : undefined;

      /**
       * SIGN FIRST, SEND SECOND. Never let one call do both.
       *
       * sendTransaction signs and broadcasts atomically, so anything it throws leaves no
       * hash — and a transaction can land and still throw, because the RPC may resend and
       * report the DUPLICATE's "nonce too low" as the error. The caller is then told the sale
       * failed while the money has already moved, with no handle on the transaction that
       * moved it.
       *
       * That cost three positions in two days, every one of them a winner booked as stuck at
       * $0.00: +$6.66 on 09-10, +$10.58 and +$17.85 on 09-11. Each time the nonce error was
       * proof the sale had SUCCEEDED, and each time the hash needed to confirm it had been
       * thrown away by this line.
       *
       * Signing locally is deterministic and cannot fail for network reasons, and the hash is
       * keccak256 of the signed payload — known before anything touches the wire. So whatever
       * the send does afterwards, `hash` is already set and confirm() has something to ask
       * about.
       */
      const wc = walletClient(a.chain);
      /**
       * PREPARE before signing. sendTransaction used to do this for us.
       *
       * signTransaction signs exactly what it is handed and fills in nothing. Without fee
       * fields there is no way to tell a legacy transaction from an EIP-1559 one, so viem
       * refuses with "Cannot infer a transaction type from provided transaction" — and since
       * that throws before any hash exists, it surfaced as a plain entry no-fill.
       *
       * Omitting this broke every entry for twelve hours on 2026-09-11: 27 signals aborted,
       * zero trades taken, while the fix it was part of was busy solving a rarer problem.
       * prepareTransactionRequest is what fills gas price, fee cap and type.
       */
      const request = await wc.prepareTransactionRequest({
        to: a.to as `0x${string}`,
        data: a.data as `0x${string}` | undefined,
        value: a.value ?? 0n,
        gas,
        nonce,
        chain: CHAINS[a.chain],
      });
      const signed = await wc.signTransaction(request as never);
      hash = keccak256(signed);
      await pub.sendRawTransaction({ serializedTransaction: signed });

      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") {
        return { ok: false, hash, broadcast: true, error: `reverted on chain (status ${receipt.status})` };
      }
      return {
        ok: true, hash,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
      };
    } catch (err) {
      const msg = String((err as Error).message);
      const nonceTaken = /nonce (?:provided )?.*(?:too low|is lower than)/i.test(msg)
        || /already known|replacement transaction underpriced/i.test(msg);
      return { ok: false, hash, broadcast: hash !== undefined || nonceTaken, nonceTaken,
               error: msg.slice(0, 300) };
    }
  });
}

/**
 * Wait again on a transaction we already broadcast.
 *
 * The counterpart to `broadcast` on SendResult: when the first receipt wait fell over, the
 * transaction is still out there and the only wrong move is to send another one. Short
 * timeout, because this runs on an exit path where the alternative is abandoning a position.
 */
export async function confirm(
  chain: Chain, hash: string, timeout = 20_000,
): Promise<SendResult> {
  try {
    const receipt = await publicClient(chain)
      .waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout });
    if (receipt.status !== "success") {
      return { ok: false, hash, broadcast: true, error: `reverted on chain (status ${receipt.status})` };
    }
    return { ok: true, hash, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice };
  } catch (err) {
    return { ok: false, hash, broadcast: true, error: String((err as Error).message).slice(0, 200) };
  }
}

/** 0x AllowanceHolder — the only contract we ever approve. Immutable and ownerless: 1,009
 *  bytes, EIP-1967 implementation and admin slots zero, owner() reverts. Same address on
 *  every chain 0x supports, deployed deterministically. */
export const ALLOWANCE_HOLDER = "0x0000000000001ff3684f28c67538d4d072c22734";

const ERC20_ALLOWANCE = "0xdd62ed3e";
const ERC20_APPROVE   = "0x095ea7b3";
const pad32 = (h: string) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/**
 * Make sure `spender` can move `need` of `token` on our behalf, approving if not.
 *
 * NON-OBVIOUS AND LOAD BEARING. Approving WETH lets us BUY; it does nothing for selling. Every
 * token bought needs its own approval before it can be sold, and without this a position can
 * be entered and never exited — the precise failure that stranded a position under v1.0.
 *
 * Found on the first live round trip of v2.0 on 2026-09-08: the buy filled 260.95 GRASS, and
 * the sell reverted in simulation with GRASS allowance at 0.
 *
 * Unlimited, because the alternative is a second transaction on every exit — the moment when
 * latency is worth the most and a stuck sell costs the whole position. Safe only because
 * AllowanceHolder is verifiably immutable and ownerless.
 */
export async function ensureAllowance(
  chain: Chain, token: string, need: bigint, spender = ALLOWANCE_HOLDER,
): Promise<{ ok: boolean; approved: boolean; hash?: string; error?: string }> {
  const acct = account();
  const pub = publicClient(chain);
  try {
    const r = await pub.call({
      to: token as `0x${string}`,
      data: (ERC20_ALLOWANCE + pad32(acct.address) + pad32(spender)) as `0x${string}`,
    });
    const current = BigInt(r.data ?? "0x0");
    if (current >= need) return { ok: true, approved: false };
  } catch (err) {
    return { ok: false, approved: false, error: `allowance read failed: ${String((err as Error).message).slice(0, 200)}` };
  }

  const sent = await send({
    chain, to: token, label: "approve",
    data: ERC20_APPROVE + pad32(spender) + "f".repeat(64),
    gas: 60_000n,
  });
  return sent.ok
    ? { ok: true, approved: true, hash: sent.hash }
    : { ok: false, approved: false, error: sent.error };
}

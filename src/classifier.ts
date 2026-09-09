import { config } from "./config.ts";
import { usdRates, legUsd, isDollarAsset } from "./money.ts";
import { rpc, tokenDecimals, totalSupply } from "./rpc.ts";
import type { Chain, Signal, Verdict, Wallet } from "./types.ts";

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface Log { address: string; topics: string[]; data: string }
interface Receipt { status?: string; blockNumber: string; logs: Log[] }
interface Tx { to: string | null; input: string }

const addrFromTopic = (t: string) => ("0x" + t.slice(26)).toLowerCase();
const big = (d: string) => (d && d !== "0x" ? BigInt(d) : 0n);

/**
 * Classify one EVM transaction from a tracked wallet's point of view.
 *
 * The rule is that a purchase costs money and a transfer does not. Deliberately NOT used:
 *  - tx.from === wallet   — false on every FOMO buy; a router signs, not the wallet
 *  - value leaving wallet — zero on Robinhood buys; the router settles internally
 *  - a Swap event         — absent on bonding-curve buys, present only once graduated
 *  - trade size           — an $11,000 airdrop passes any dollar threshold
 */
export async function classifyEvm(
  wallet: Wallet, chain: Chain, txHash: string,
): Promise<Signal | null> {
  const [receipt, tx] = await Promise.all([
    rpc<Receipt>(chain, "eth_getTransactionReceipt", [txHash]),
    rpc<Tx>(chain, "eth_getTransactionByHash", [txHash]),
  ]);
  if (!receipt || (receipt.status !== undefined && BigInt(receipt.status) === 0n)) return null;

  const quotes = config.quoteAssets[chain] ?? {};
  const rates = usdRates(chain);
  const me = wallet.address.toLowerCase();
  /**
   * Whether FOMO executed this. Needed BEFORE the payment legs are read, because it decides
   * whose money counts as the tracked wallet's payment.
   *
   * Under FOMO the wallet NEVER appears in the quote leg — verified 2026-09-08 on a real buy:
   * USDG went 0xf70da978 (FOMO's relayer) -> 0xb92fe925 -> 0x8f10b468 -> the pool, and the
   * wallet showed up only at the end receiving tokens. So payment cannot be attributed by
   * asking who sent it; the router is what says the trade was made on the wallet's behalf.
   */
  const viaKnownRouter = config.knownRouters.includes((tx?.to ?? "").toLowerCase());
  const tokenDelta = new Map<string, bigint>();
  const quoteMax = new Map<string, bigint>();

  for (const log of receipt.logs) {
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const asset = log.address.toLowerCase();
    const from = addrFromTopic(log.topics[1]!);
    const to = addrFromTopic(log.topics[2]!);
    const amount = big(log.data);

    if (quotes[asset]) {
      /**
       * Whose payment is this?
       *
       * Counting every quote-asset transfer in the receipt, regardless of who moved it, turns
       * a STRANGER'S purchase into an apparent buy by the tracked wallet. On 2026-09-08 four
       * signals arrived that way: someone bought 8Stock with their own ETH and airdropped it
       * to four influencer wallets seventeen minutes apart, seven minutes after the token was
       * created. The classifier saw WETH move and tokens arrive and called it a BUY. The token
       * held 74.7% in ten wallets and gmgn flagged it a honeypot.
       *
       * Two ways a leg can be the wallet's own payment, and it needs only one:
       *   - a known router executed it, which is how FOMO settles (the wallet is never a party)
       *   - the wallet is itself a party to the transfer, for trades made directly
       *
       * Largest single leg, never the sum: routes are multi-hop and the same money reappears
       * at each hop. Summing turned a $2k buy into an apparent $11k one.
       */
      if (viaKnownRouter || from === me || to === me) {
        if (amount > (quoteMax.get(asset) ?? 0n)) quoteMax.set(asset, amount);
      }
      continue;
    }
    if (to === me) tokenDelta.set(asset, (tokenDelta.get(asset) ?? 0n) + amount);
    if (from === me) tokenDelta.set(asset, (tokenDelta.get(asset) ?? 0n) - amount);
  }

  // Every leg carries BOTH its own units and its dollar value, so nothing downstream has to
  // know which asset it is looking at. `usd` is null when the rate is unknown — never 0,
  // because "could not price" and "worth nothing" lead to opposite decisions.
  const legs = [...quoteMax.entries()].map(([addr, raw]) => {
    const q = quotes[addr]!;
    return {
      symbol: q.symbol,
      amount: Number(raw) / 10 ** q.decimals,
      usd: legUsd(rates, addr, raw),
      dollarLeg: isDollarAsset(rates, addr),
      isSizingAsset: q.isSizingAsset,
    };
  });
  // Dust below the floor is fee/routing noise, not payment. Compared in DOLLARS: the old
  // version compared a raw amount against a USD threshold, so 0.0003 WETH — 75 cents, well
  // above the floor — was discarded as dust while 0.57 WETH passed as though it were 57 cents.
  const paid = legs.filter((l) => l.usd !== null && l.usd >= config.minQuoteMovementUsd);
  /**
   * The PAYMENT leg sizes the trade, and a dollar-denominated one is preferred when present.
   *
   * A routed FOMO buy carries the same money twice — USDG in, WETH through the hop — and the
   * two differ by fees and by whatever the ETH rate has done. Taking the max across legs
   * silently sized 18 of 70 historical buys off the hop instead of the payment, moving them
   * ~1.5%. Preferring the dollar leg reproduces v1.0 exactly where a dollar leg exists.
   *
   * Falling back to any priceable leg is what closes the ETH blind spot: a buy settled purely
   * in ETH has no dollar leg at all, and used to size at $0.00 and be rejected under
   * minTradeUsd — which in the logs was indistinguishable from a quiet market.
   */
  const dollarPaid = paid.filter((l) => l.dollarLeg);
  const sizing = dollarPaid.length ? dollarPaid : paid;
  const sizeUsd = Math.max(0, ...sizing.map((l) => l.usd as number));

  const biggest = [...tokenDelta.entries()]
    .sort((a, b) => (b[1] < 0n ? -b[1] : b[1]) > (a[1] < 0n ? -a[1] : a[1]) ? 1 : -1)[0];

  let verdict: Verdict;
  let token = "";
  let amount = 0;
  let decimals = 18;

  if (!biggest || biggest[1] === 0n) {
    // Never silently dropped: quote moved but the wallet's token balance did not.
    verdict = paid.length ? "QUOTE_NO_TOKEN" : "NO_OP";
  } else {
    token = biggest[0];
    decimals = await tokenDecimals(chain, token);
    amount = Number(biggest[1]) / 10 ** decimals;
    verdict = amount > 0 ? (paid.length ? "BUY" : "RECEIVED")
                         : (paid.length ? "SELL" : "SENT_OUT");
  }

  // Market cap implied by this fill, rather than a fresh lookup: a lookup reads the price
  // AFTER the tracked wallet's buy has already moved it (+19% on one observed trade).
  let impliedMarketCapUsd = 0;
  if (token && sizeUsd > 0 && amount !== 0) {
    const supply = await totalSupply(chain, token, decimals);
    impliedMarketCapUsd = (sizeUsd / Math.abs(amount)) * supply;
  }

  return {
    wallet, chain, txHash,
    blockNumber: parseInt(receipt.blockNumber, 16),
    timestamp: 0,
    verdict, token, tokenAmount: amount, tokenDecimals: decimals,
    sizeUsd, quoteLegs: legs, impliedMarketCapUsd,
    viaKnownRouter,
    routerUsed: (tx?.to ?? "").toLowerCase() || undefined,
  };
}

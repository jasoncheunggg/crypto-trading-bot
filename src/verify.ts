import { rpc, tokenDecimals } from "./rpc.ts";
import { config } from "./config.ts";
import { affordable } from "./cu.ts";
import type { Chain } from "./types.ts";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const big = (h: string) => (h && h !== "0x" ? BigInt(h) : 0n);

/** Alchemy's free tier answers eth_getLogs for at most 10 blocks at a time. */
const SPAN = 10;

export interface Verified {
  price: number;
  txHash: string;
  ageBlocks: number;
  /** Roughly what this lookup cost, for the log line. */
  cu: number;
  /**
   * How many independent transactions backed this price (1-3). A price carried by a single
   * sample is the LNKS case — believable arithmetic with nothing to check it against — so
   * callers about to act irreversibly can weigh it differently from a voted one.
   */
  samples: number;
}

/**
 * The exact price of the most recent trade, read from the chain.
 *
 * Called only at moments that matter — when the cheap feed claims a stop or a target has
 * been crossed — because it costs about 90 CU a look. Streaming the same information cost
 * ~40M CU/hour and drained a month's allowance in 45 minutes.
 *
 * Sizing rule is the classifier's, validated by it: largest single quote leg over largest
 * single token leg, never the sum, since multi-hop routing moves one amount through several
 * legs. Batched aggregator transactions are rejected rather than guessed at — they pair our
 * token against a stranger's money and once produced $2.86 for a token worth $0.004.
 */
/**
 * Windows of 10 blocks to search before giving up; on robinhood a window is ~1 second.
 *
 * Set back to 6 after measuring: the binding constraint is Alchemy's ~10 requests/second cap,
 * not round-trip latency, so widening the search made a miss slower (6.6s) AND ten times more
 * expensive (1,551 CU vs ~150) without finding much more. A coin that has not traded in six
 * seconds has no fresh price to find, and a stale one is not worth a stop-loss waiting for.
 * Safety on a miss comes from the plausibility bound on the fallback price, not from
 * searching harder.
 */
const DEFAULT_WINDOWS = 6;

/**
 * A verified price beyond this multiple of the reference is refused. Chain derivation is
 * exact arithmetic on whatever legs a transaction contains, so a batch that survives the
 * leg-count filter still pairs our token against a stranger's money — observed once at
 * +1489% on a coin trading near +40%, which was then SOLD INTO and booked as a 190% gain.
 * "Verified" means the arithmetic is real, not that the pairing was right.
 *
 * Held at 3 to MATCH the exit loop's band for quoted prices. At 5 the two paths disagreed:
 * a chain-derived price 3.22x the rolling reference was accepted while the identical number
 * from the feed would have been refused, and it wrote a +311.6% peak onto a trade whose real
 * excursion was +38%. The reference is a rolling median, so a genuine sustained climb moves
 * it along — the bound only catches a JUMP, which is what a mispairing looks like.
 */
const SANITY_MULTIPLE = 3;

/**
 * How many independent transactions to price before answering, taking the median.
 *
 * Returning the FIRST passing transaction made every verified price hostage to one trade.
 * Measured over 1,484 verified samples, 0.40% came back more than 1.5x off the surrounding
 * feed — roughly one lookup in 250 — and one of those booked a fill at 1.26x the position's
 * own peak. The failure is always a single mispaired transaction: multi-hop routing moves
 * money and tokens between different intermediaries, so a transaction carrying two people's
 * trades pairs our token against a stranger's money and the arithmetic on it is exact but
 * meaningless. Three candidates cannot be outvoted by one of those.
 *
 * Deliberately NOT done by comparing the A/B arms against each other: measured over 53
 * crossings, the arms landed on the SAME transaction 58.5% of the time, so they agree on a
 * bad price more often than not. The independence that matters is between transactions, not
 * between observers.
 *
 * MEASURED COST, interleaved against QUORUM=1 on the same tokens: **+200ms and +100 CU** per
 * lookup. Not the "+30 CU, no latency" it looks like on paper — a 10-block window usually
 * holds only one priceable trade, so filling a quorum reaches further back and pays for more
 * windows. Hit rate is unchanged (quorum never turns an answer into a miss).
 *
 * Only about HALF of lookups actually reach three candidates; the rest answer with one or
 * two. That is why `samples` is reported rather than assumed — a caller about to act
 * irreversibly can see how much backing the number really has.
 *
 * Worth it at ~0.1% expected price drift over 200ms against a 0.4% chance of a grossly wrong
 * price, but it is a real trade, not a free one.
 */
const QUORUM = 3;

/** Median of what we actually found — the middle of three, or the mean of two. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export async function verifyPrice(
  chain: Chain, token: string, maxWindows = DEFAULT_WINDOWS, referencePrice?: number,
): Promise<Verified | null> {
  try {
    // The bound is applied per CANDIDATE inside the search, not to its result. A batched
    // transaction that misprices is skipped and the next one is tried, rather than
    // abandoning the lookup and falling back to a quoted price — there is usually a clean
    // trade a few blocks further back. Survivors are then VOTED on rather than raced: see
    // QUORUM.
    return await lookup(chain, token, maxWindows, referencePrice);
  } catch {
    // A failed verification must never take the position with it. The caller treats null
    // as "could not confirm" and falls back to the cheap feed's claim.
    return null;
  }
}

async function lookup(
  chain: Chain, token: string, maxWindows: number, referencePrice?: number,
): Promise<Verified | null> {
  if (!affordable()) return null;
  const quotes = config.quoteAssets[chain] ?? {};
  const dec = await tokenDecimals(chain, token);
  // Two blocks back: logs for the very newest block are not always indexed yet, and asking
  // for them fails the whole range rather than returning fewer results.
  const head = parseInt((await rpc<string>(chain, "eth_blockNumber", [])) as string, 16) - 2;
  let cu = 10 + 26;

  /** One transaction's implied price, or null if it cannot be priced honestly. */
  type Receipt = { logs: { address: string; topics: string[]; data: string }[] };
  const priceOf = (r: Receipt | null): number | null => {
    if (!r) return null;
    let maxToken = 0n, maxQuoteUsd = 0, tokenLegs = 0, quoteLegs = 0;
    for (const l of r.logs) {
      if (l.topics[0] !== TRANSFER) continue;
      const a = l.address.toLowerCase();
      const v = big(l.data);
      const q = quotes[a];
      if (q?.isSizingAsset) { quoteLegs++; maxQuoteUsd = Math.max(maxQuoteUsd, Number(v) / 10 ** q.decimals); }
      else if (a === token.toLowerCase()) { tokenLegs++; if (v > maxToken) maxToken = v; }
    }
    if (tokenLegs > 6 || quoteLegs > 4) return null;      // batched: unpriceable, not guessable
    const tokens = Number(maxToken) / 10 ** dec;
    if (tokens <= 0 || maxQuoteUsd <= 0) return null;
    const price = maxQuoteUsd / tokens;
    if (referencePrice && referencePrice > 0) {
      const ratio = price / referencePrice;
      if (ratio > SANITY_MULTIPLE || ratio < 1 / SANITY_MULTIPLE) return null;
    }
    return price;
  };

  const found: { price: number; txHash: string; ageBlocks: number }[] = [];

  // Windows are searched in PARALLEL BATCHES, newest first.
  //
  // The FIRST batch is three windows, not one. With a quorum to fill, a single 10-block
  // window usually holds only one priceable trade, so a one-window first batch fell through
  // to the second batch almost every time and paid for all six windows: measured 531 CU and
  // 3.2-3.8s against 126 CU and 1.3-1.8s for the old first-past-the-post lookup. Asking for
  // three windows up front is one round trip instead of two and covers ~3s of trades, which
  // is where three candidates actually live.
  const batches = [[0, 1, 2], [3, 4, 5]];
  for (const batch of batches) {
    if (found.length >= QUORUM) break;
    const windows = batch.filter((w) => w < maxWindows);
    if (!windows.length) break;
    if (!affordable()) break;

    const fetched = await Promise.all(windows.map(async (w) => {
      const to = head - w * SPAN;
      const from = to - (SPAN - 1);
      if (from < 0) return { w, logs: [] as { transactionHash: string }[] };
      const logs = await rpc<{ transactionHash: string }[]>(
        chain, "eth_getLogs",
        [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: token, topics: [TRANSFER] }],
      );
      return { w, logs: logs ?? [] };
    }));
    cu += windows.length * 75;

    // Candidates from every window in the batch are pooled before any receipt is read, so the
    // quorum is filled in ONE parallel round trip. Walking window by window instead made each
    // window its own sequential round trip, which is where the extra ~1.5s came from.
    const seen = new Set<string>();
    const pool: { h: string; w: number }[] = [];
    for (const { w, logs } of fetched) {              // newest window first
      for (const h of [...new Set(logs.map((l) => l.transactionHash))].reverse()) {
        if (seen.has(h)) continue;
        seen.add(h);
        pool.push({ h, w });
      }
    }

    for (let i = 0; i < pool.length && found.length < QUORUM; i += QUORUM) {
      if (!affordable()) break;
      const chunk = pool.slice(i, i + QUORUM);
      const receipts = await Promise.all(chunk.map((c) =>
        rpc<Receipt>(chain, "eth_getTransactionReceipt", [c.h]).catch(() => null)));
      cu += chunk.length * 15;
      for (let k = 0; k < chunk.length && found.length < QUORUM; k++) {
        const price = priceOf(receipts[k] ?? null);
        if (price === null) continue;                 // batched, unpriceable, or out of bounds
        found.push({ price, txHash: chunk[k]!.h, ageBlocks: chunk[k]!.w * SPAN });
      }
    }
  }

  if (!found.length) return null;
  // The median is the answer; the transaction reported is whichever sits closest to it, so a
  // log line still points at something real that can be opened in an explorer.
  const price = median(found.map((f) => f.price));
  const pick = found.reduce((a, b) =>
    Math.abs(b.price - price) < Math.abs(a.price - price) ? b : a);
  return { price, txHash: pick.txHash, ageBlocks: pick.ageBlocks, cu, samples: found.length };
}

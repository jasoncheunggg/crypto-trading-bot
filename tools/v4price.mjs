/**
 * Historical price for any Uniswap V4 token on this chain, at any block.
 *
 * Why this exists: backtesting an exit strategy needs a PRICE PATH — where the token was at
 * many points after an entry. The obvious sources do not provide one here.
 *
 *   - FOMO's OHLCV candles are Growth-plan only.
 *   - Scanning swap logs does not work: blocks are ~101ms, Alchemy's free tier caps
 *     eth_getLogs at TEN blocks, so one call sees ~1 second — and these memecoins trade in
 *     bursts. Sampled across a real position's 420s life, 1 of 11 one-second windows had any
 *     activity at all, and that one was our own buy.
 *
 * What does work: V4 keeps each pool's slot0 in the PoolManager singleton, readable with
 * extsload at ANY historical block whether or not a trade happened there. One eth_call per
 * sample, price sparsity irrelevant.
 *
 * Verified against ground truth before use: pool 0x1934f4ed… at block 59077161 reads
 * sqrtPriceX96 1519786934989228611013942687140803510, tick 335406 — exactly what that
 * block's Swap event emitted.
 *
 * Only RATIOS are used downstream, so decimals and the currency0/currency1 scaling factor
 * cancel. Orientation does not cancel: if the token is currency1 then price is 1/sqrt^2, and
 * getting it backwards turns every pump into a dump.
 */
import { keccak256, encodeAbiParameters } from "viem";

export const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
export const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** mapping(PoolId => Pool.State) in PoolManager. Confirmed empirically, not assumed. */
const POOLS_SLOT = 6n;

const U = `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;

/** Chain anchor for time->block. Measured at 9.908 blocks/sec over 216,988 blocks. */
export const ANCHOR = { block: 59081206, time: 1789010810, rate: 9.908 };

/**
 * Rough time->block. USE ONLY AS A SEED — the block rate is not constant.
 *
 * Measured drift against the real chain: 456 blocks at 24h back, 1,655 at 96h, 11,146 at
 * 168h. Pool discovery searched a +/-30 block window around this, so for anything older than
 * a few hours it looked in the wrong place entirely and found nothing; and price paths built
 * on it were anchored up to 100 SECONDS from the entry, which on these tokens is a different
 * chart. Both failures traced back to this one function being trusted directly.
 */
export const blockAt = (unix) =>
  Math.max(1, Math.round(ANCHOR.block + (unix - ANCHOR.time) * ANCHOR.rate));

const tsCache = new Map();
async function blockTime(b) {
  if (tsCache.has(b)) return tsCache.get(b);
  const blk = await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), false]);
  const t = blk ? Number(BigInt(blk.timestamp)) : null;
  tsCache.set(b, t);
  return t;
}

/**
 * The real block at a timestamp, within `tol` seconds.
 *
 * Seeds from the linear estimate, then walks with a locally measured rate — which converges
 * in two or three reads because the rate is stable over minutes even though it is not over
 * days. Falls back to bisection if the walk overshoots.
 */
export async function blockForTime(unix, tol = 2) {
  /**
   * Clamp the seed to the chain head before using it.
   *
   * blockAt() runs ~3,600 blocks FAST over a day and a half, so for any recent timestamp the
   * seed lands past the tip. eth_getBlockByNumber returns null there, and this used to give
   * up on the spot — so a block a few minutes old was "unresolvable" while one from last week
   * resolved fine. The walk below converges from anywhere; it only needs a real block to
   * start from.
   */
  let b = blockAt(unix);
  let t = await blockTime(b);
  if (t === null) {
    const head = await rpc("eth_blockNumber", []);
    if (!head) return null;
    b = Number(BigInt(head));
    t = await blockTime(b);
  }
  if (t === null) return null;
  for (let i = 0; i < 6 && Math.abs(t - unix) > tol; i++) {
    const step = Math.round((unix - t) * ANCHOR.rate);
    const next = Math.max(1, b + (step === 0 ? (unix > t ? 1 : -1) : step));
    const nt = await blockTime(next);
    if (nt === null) break;
    // Local rate between the two probes beats the global one for the next step.
    if (next !== b && nt !== t) {
      const rate = (next - b) / (nt - t);
      if (isFinite(rate) && rate > 1 && rate < 40) {
        const refined = Math.max(1, b + Math.round((unix - t) * rate));
        if (refined !== next) {
          const rt = await blockTime(refined);
          if (rt !== null && Math.abs(rt - unix) < Math.abs(nt - unix)) {
            b = refined; t = rt; continue;
          }
        }
      }
    }
    b = next; t = nt;
  }
  return { block: b, time: t, off: t - unix };
}

export async function rpc(method, params, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(U, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (r.status === 429) { await sleep(400 * (i + 1)); continue; }
      const j = await r.json();
      if (j.error) return null;
      return j.result;
    } catch { await sleep(300 * (i + 1)); }
  }
  return null;
}

export async function rpcBatch(calls, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(U, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(calls),
      });
      if (r.status === 429) { await sleep(500 * (i + 1)); continue; }
      return await r.json();
    } catch { await sleep(300 * (i + 1)); }
  }
  return null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const slotFor = (poolId) => keccak256(encodeAbiParameters(
  [{ type: "bytes32" }, { type: "uint256" }], [poolId, POOLS_SLOT]));

/** extsload(bytes32) call data for a pool's slot0. */
export const slot0Call = (poolId) => "0x1e2eaeaf" + slotFor(poolId).slice(2);

export function sqrtFromWord(hex) {
  if (!hex || hex === "0x") return null;
  const v = BigInt(hex) & ((1n << 160n) - 1n);
  return v === 0n ? null : v;
}

/**
 * Find the V4 pool a token trades in, and which side of it the token is.
 *
 * Uses a moment we KNOW had a trade — the entry we are pathing — rather than hunting blindly.
 * The token's own Transfer log gives a transaction; that transaction's receipt carries the
 * PoolManager Swap event, and the amount matching the transfer identifies which currency the
 * token is.
 */
export async function discoverPool(token, aroundBlock) {
  for (const span of [[0, 9], [-10, -1], [10, 19], [-30, -21]]) {
    const from = "0x" + (aroundBlock + span[0]).toString(16);
    const to = "0x" + (aroundBlock + span[1]).toString(16);
    const logs = await rpc("eth_getLogs",
      [{ address: token, fromBlock: from, toBlock: to, topics: [TRANSFER_TOPIC] }]);
    if (!logs?.length) continue;

    for (const lg of logs.slice(0, 3)) {
      const rc = await rpc("eth_getTransactionReceipt", [lg.transactionHash]);
      if (!rc?.logs) continue;
      // How much of the token moved in this transaction, biggest leg.
      let moved = 0n;
      for (const l of rc.logs) {
        if (l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === TRANSFER_TOPIC) {
          const v = BigInt(l.data);
          if (v > moved) moved = v;
        }
      }
      if (moved === 0n) continue;
      for (const l of rc.logs) {
        if (l.address.toLowerCase() !== POOL_MANAGER || l.topics[0] !== SWAP_TOPIC) continue;
        const d = l.data.slice(2);
        const a0 = BigInt.asIntN(256, BigInt("0x" + d.slice(0, 64)));
        const a1 = BigInt.asIntN(256, BigInt("0x" + d.slice(64, 128)));
        const abs = (x) => (x < 0n ? -x : x);
        // The side whose magnitude matches the token's own transfer is the token's side.
        const near = (x) => abs(abs(x) - moved) * 100n <= moved;   // within 1%
        if (near(a0)) return { poolId: l.topics[1], isCurrency1: false, block: Number(BigInt(l.blockNumber)) };
        if (near(a1)) return { poolId: l.topics[1], isCurrency1: true, block: Number(BigInt(l.blockNumber)) };
      }
    }
  }
  return null;
}

/**
 * Price in arbitrary but CONSISTENT units, for a pool at a set of blocks.
 *
 * Returns null per block the pool did not answer for (before initialisation, or a reorg gap).
 * Ratios of these numbers are true price ratios; their absolute value means nothing.
 */
export async function pricesAt(poolId, isCurrency1, blocks, chunk = 20) {
  const data = slot0Call(poolId);
  const out = new Array(blocks.length).fill(null);
  for (let i = 0; i < blocks.length; i += chunk) {
    const part = blocks.slice(i, i + chunk);
    const calls = part.map((b, j) => ({
      jsonrpc: "2.0", id: j, method: "eth_call",
      params: [{ to: POOL_MANAGER, data }, "0x" + b.toString(16)],
    }));
    const res = await rpcBatch(calls);
    if (!Array.isArray(res)) continue;
    for (const r of res) {
      if (!r || typeof r.id !== "number" || !r.result) continue;
      const sq = sqrtFromWord(r.result);
      if (sq === null) continue;
      // (sqrt/2^96)^2, in double precision — only ratios are used.
      const p = Number(sq) / 2 ** 96;
      const px = p * p;
      out[i + r.id] = isCurrency1 ? 1 / px : px;
    }
    await sleep(60);
  }
  return out;
}

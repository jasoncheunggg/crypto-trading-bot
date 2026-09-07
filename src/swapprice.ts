import { config } from "./config.ts";
import { rpc, tokenDecimals } from "./rpc.ts";
import type { Chain } from "./types.ts";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Logs of one tx arrive as separate messages; wait this long for the set to be complete. */
const SETTLE_MS = 400;
/** A tx that never gathers both legs is dropped after this. Bounds memory. */
const TX_TTL_MS = 30_000;

export interface PricePoint {
  chain: Chain;
  token: string;
  price: number;
  txHash: string;
  at: number;
}

interface Pending {
  maxToken: bigint;
  maxQuoteUsd: number;
  tokenLegs: number;
  quoteLegs: number;
  first: number;
  timer: NodeJS.Timeout | null;
}

/**
 * A single swap routes one amount through a handful of legs. A batched aggregator tx
 * carries several unrelated swaps, and taking the max of each side then pairs our token
 * against a stranger's stablecoin — measured once at $2.86 on a token worth $0.004.
 * Leg counts separate the two cleanly: a plain swap shows a handful, a batch shows dozens.
 */
const MAX_TOKEN_LEGS = 6;
const MAX_QUOTE_LEGS = 4;

/**
 * Leg counts remove most batches but not all: ~5% of accepted trades stay ambiguous,
 * measured live. That tail is not noise to be averaged away — each one is a real number
 * from the wrong trade — so it is gated rather than smoothed.
 *
 * A price far from the recent median is held back until CONFIRMATIONS successive trades
 * agree in the same direction AND with each other. A genuine crash confirms itself in about
 * a second at observed volume; a mispaired batch does not repeat.
 *
 * BAND is set from the measured tick distribution on this venue — median 2.6%, p95 10.8% —
 * not from taste. At 0.35 a mispairing 27% below the truth was admitted unchallenged.
 */
const BAND = 0.15;
const CONFIRMATIONS = 3;
/**
 * Confirmations required when the price is already at or below a position's stop. A false
 * stop costs one bad exit; a slow one rides the whole fall. Two still rejects any single
 * mispaired batch, which is what the tail actually consists of — and mispairings disagree
 * with each other, so two in a row that agree within BAND is not a thing we observed.
 */
const CONFIRMATIONS_URGENT = 2;
const WINDOW = 9;
/** Samples needed before the gate engages at all. */
const BOOTSTRAP = 5;

const big = (hex: string) => (hex && hex !== "0x" ? BigInt(hex) : 0n);

/**
 * Live token price, derived from the trades themselves.
 *
 * A price is the arithmetic of a swap that actually happened — dollars paid divided by
 * tokens received — not a third party's quote. This exists because GMGN's price field was
 * observed alternating between two levels 1.61x apart on a single token, which the exit
 * manager acted on: a -44.9% sample one second after entry that no trade produced.
 *
 * Sizing rule is the classifier's, and validated by it: take the LARGEST single quote
 * transfer and the LARGEST single token transfer, never the sum. Multi-hop routing moves
 * the same value through several legs, so summing double-counts.
 *
 * Only dollar-denominated quote legs are priced. A WETH-quoted swap would need an ETH/USD
 * rate to be worth anything, and a wrong rate is worse than no sample — measured at 88% of
 * this venue's trades carrying a stablecoin leg, skipping the rest costs little.
 */
export class SwapPriceFeed {
  private sockets = new Map<Chain, WebSocket>();
  private backoff = new Map<Chain, number>();
  private stopped = false;

  /** token -> how many positions want it. Rebuys mean the same token can be watched twice. */
  private watched = new Map<string, number>();
  private decimals = new Map<string, number>();
  private last = new Map<string, PricePoint>();
  private recent = new Map<string, number[]>();
  private urgentBelow = new Map<string, number>();
  private streak = new Map<string, { dir: 1 | -1; prices: number[] }>();
  /** Trades discarded as unpriceable — surfaced so a rising rate is visible, not silent. */
  skipped = 0;
  private pending = new Map<string, Map<string, Pending>>();

  private onStatus: (msg: string) => void;
  private onPrice: (p: PricePoint) => void;
  private listeners = new Set<(p: PricePoint) => void>();

  constructor(onPrice: (p: PricePoint) => void = () => {}, onStatus: (msg: string) => void = () => {}) {
    this.onPrice = onPrice;
    this.onStatus = onStatus;
  }

  private key(chain: Chain, token: string) { return `${chain}:${token.toLowerCase()}`; }

  /** Additional price listener. Returns an unsubscribe function. */
  subscribe(fn: (p: PricePoint) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(p: PricePoint): void {
    this.onPrice(p);
    for (const fn of this.listeners) {
      try { fn(p); } catch { /* one bad listener must not stall the feed */ }
    }
  }

  /**
   * Begin pricing a token. Idempotent per position; refcounted so rebuys are safe.
   *
   * `seedPrice` should be the entry price derived from the signal transaction. It arms the
   * outlier gate from the very first trade, instead of letting the first few samples in
   * unchecked — which is precisely the window where a bad price trips the stop-loss.
   */
  async watch(chain: Chain, token: string, seedPrice?: number, urgentBelow?: number): Promise<void> {
    const k = this.key(chain, token);
    this.watched.set(k, (this.watched.get(k) ?? 0) + 1);
    // Keep the tightest stop across concurrent positions in the same token.
    if (urgentBelow && urgentBelow > 0) {
      const cur = this.urgentBelow.get(k);
      this.urgentBelow.set(k, cur === undefined ? urgentBelow : Math.max(cur, urgentBelow));
    }
    if (seedPrice && seedPrice > 0 && !this.recent.has(k)) {
      this.recent.set(k, Array<number>(BOOTSTRAP).fill(seedPrice));
    }
    if (!this.decimals.has(k)) {
      this.decimals.set(k, await tokenDecimals(chain, token));
    }
    if (!this.sockets.has(chain)) this.connect(chain);
    else this.subscribeToken(chain, token);
  }

  unwatch(chain: Chain, token: string): void {
    const k = this.key(chain, token);
    const n = (this.watched.get(k) ?? 1) - 1;
    if (n > 0) { this.watched.set(k, n); return; }
    this.watched.delete(k);
    this.pending.delete(k);
    this.recent.delete(k);
    this.streak.delete(k);
    this.urgentBelow.delete(k);
    if (![...this.watched.keys()].some((w) => w.startsWith(`${chain}:`))) this.close(chain);
  }

  /** Most recent priced trade, or null if none has landed yet. */
  latest(chain: Chain, token: string): PricePoint | null {
    return this.last.get(this.key(chain, token)) ?? null;
  }

  stop(): void {
    this.stopped = true;
    for (const c of [...this.sockets.keys()]) this.close(c);
    this.watched.clear();
  }

  private close(chain: Chain): void {
    const ws = this.sockets.get(chain);
    this.sockets.delete(chain);
    try { ws?.close(); } catch { /* already gone */ }
  }

  private send(chain: Chain, params: unknown[], id: number): void {
    const ws = this.sockets.get(chain);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "eth_subscribe", params }));
    }
  }

  private subscribeToken(chain: Chain, token: string): void {
    this.send(chain, ["logs", { address: token.toLowerCase(), topics: [TRANSFER] }], 2);
  }

  private connect(chain: Chain): void {
    if (this.stopped) return;
    const ws = new WebSocket(config.endpoints[chain]);
    this.sockets.set(chain, ws);

    ws.onopen = () => {
      this.backoff.set(chain, 0);
      // Chain-wide quote-asset transfers. ~272/s on robinhood — cheap to receive, and the
      // only way to see the paying leg, since log filters cannot express "same tx as".
      const quotes = Object.keys(config.quoteAssets[chain] ?? {});
      if (quotes.length) this.send(chain, ["logs", { address: quotes, topics: [TRANSFER] }], 1);
      for (const k of this.watched.keys()) {
        if (k.startsWith(`${chain}:`)) this.subscribeToken(chain, k.slice(chain.length + 1));
      }
      this.onStatus(`price feed connected [${chain}]`);
    };

    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as {
          method?: string;
          params?: { result: { address: string; topics: string[]; data: string; transactionHash: string } };
        };
        if (m.method !== "eth_subscription" || !m.params?.result) return;
        this.ingest(chain, m.params.result);
      } catch { /* a malformed frame is not worth killing the feed over */ }
    };

    ws.onclose = () => {
      if (this.stopped || !this.sockets.has(chain)) return;
      const n = (this.backoff.get(chain) ?? 0) + 1;
      this.backoff.set(chain, n);
      const wait = Math.min(30_000, 500 * 2 ** n);
      this.onStatus(`price feed dropped [${chain}], retry in ${wait}ms`);
      setTimeout(() => this.connect(chain), wait);
    };

    ws.onerror = () => { /* onclose follows and owns the retry */ };
  }

  private ingest(chain: Chain, log: { address: string; topics: string[]; data: string; transactionHash: string }): void {
    if (log.topics[0] !== TRANSFER) return;
    const addr = log.address.toLowerCase();
    const amount = big(log.data);
    if (amount === 0n) return;

    const quote = config.quoteAssets[chain]?.[addr];
    if (quote) {
      if (!quote.isSizingAsset) return;   // no USD rate for it; a guess is worse than a gap
      const usd = Number(amount) / 10 ** quote.decimals;
      for (const k of this.watched.keys()) {
        if (k.startsWith(`${chain}:`)) this.touch(k, log.transactionHash, (p) => {
          p.quoteLegs++;
          p.maxQuoteUsd = Math.max(p.maxQuoteUsd, usd);
        });
      }
      return;
    }

    const k = this.key(chain, addr);
    if (!this.watched.has(k)) return;
    this.touch(k, log.transactionHash, (p) => {
      p.tokenLegs++;
      if (amount > p.maxToken) p.maxToken = amount;
    });
  }

  private touch(k: string, txHash: string, apply: (p: Pending) => void): void {
    let byTx = this.pending.get(k);
    if (!byTx) { byTx = new Map(); this.pending.set(k, byTx); }
    let p = byTx.get(txHash);
    if (!p) {
      p = { maxToken: 0n, maxQuoteUsd: 0, tokenLegs: 0, quoteLegs: 0, first: Date.now(), timer: null };
      byTx.set(txHash, p);
    }
    apply(p);
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => this.settle(k, txHash), SETTLE_MS);
    if (byTx.size > 500) this.sweep(k);
  }

  /**
   * Gate on the median of recent accepted prices. Returns true if the price should be
   * published. The published value is always the exact observed price — the median decides
   * whether to believe it, and never replaces it.
   *
   * An out-of-band price is held until CONFIRMATIONS of them arrive that agree with EACH
   * OTHER as well as in direction. Three mispaired batches disagree wildly, so they cannot
   * confirm one another; three trades after a real crash cluster tightly, so they can.
   */
  private admit(k: string, price: number): boolean {
    const buf = this.recent.get(k) ?? [];
    if (buf.length < BOOTSTRAP) { this.push(k, buf, price); return true; }
    const med = [...buf].sort((a, b) => a - b)[Math.floor(buf.length / 2)]!;
    if (Math.abs(price / med - 1) <= BAND) {
      this.streak.delete(k);
      this.push(k, buf, price);
      return true;
    }
    const dir: 1 | -1 = price > med ? 1 : -1;
    const st = this.streak.get(k);
    const run = st && st.dir === dir ? [...st.prices, price] : [price];
    const lo = Math.min(...run), hi = Math.max(...run);
    const stop = this.urgentBelow.get(k);
    const need = stop !== undefined && price <= stop && dir === -1
      ? CONFIRMATIONS_URGENT : CONFIRMATIONS;
    if (run.length >= need && hi / lo - 1 <= BAND) {
      // A real move, corroborated by trades that agree with each other. Re-centre on it
      // without granting the window a run of unchecked admissions.
      this.streak.delete(k);
      this.recent.set(k, Array<number>(BOOTSTRAP).fill(price));
      return true;
    }
    // Keep only the tail that could still form a coherent run.
    this.streak.set(k, { dir, prices: run.slice(-CONFIRMATIONS) });
    return false;
  }

  private push(k: string, buf: number[], price: number): void {
    buf.push(price);
    if (buf.length > WINDOW) buf.shift();
    this.recent.set(k, buf);
  }

  private sweep(k: string): void {
    const byTx = this.pending.get(k);
    if (!byTx) return;
    const cut = Date.now() - TX_TTL_MS;
    for (const [h, p] of byTx) {
      if (p.first < cut) { if (p.timer) clearTimeout(p.timer); byTx.delete(h); }
    }
  }

  private settle(k: string, txHash: string): void {
    const byTx = this.pending.get(k);
    const p = byTx?.get(txHash);
    if (!byTx || !p) return;
    byTx.delete(txHash);
    if (p.maxToken === 0n || p.maxQuoteUsd === 0) return;   // one-legged: a plain transfer
    // Ambiguous batch. A skipped trade costs one sample out of thousands; a guessed one
    // moves the stop-loss.
    if (p.tokenLegs > MAX_TOKEN_LEGS || p.quoteLegs > MAX_QUOTE_LEGS) { this.skipped++; return; }
    const [chain, token] = [k.slice(0, k.indexOf(":")) as Chain, k.slice(k.indexOf(":") + 1)];
    const dec = this.decimals.get(k);
    if (dec === undefined) return;
    const tokens = Number(p.maxToken) / 10 ** dec;
    if (!(tokens > 0)) return;
    const price = p.maxQuoteUsd / tokens;
    if (!this.admit(k, price)) { this.skipped++; return; }
    const point: PricePoint = { chain, token, price, txHash, at: Math.floor(Date.now() / 1000) };
    this.last.set(k, point);
    this.emit(point);
  }
}

/**
 * Price a single transaction from its receipt. Used to price an entry off the signal tx
 * itself, and as the regression check that the live feed's arithmetic is right.
 */
export async function priceFromTx(
  chain: Chain, token: string, txHash: string,
): Promise<{ price: number; quoteUsd: number; tokens: number } | null> {
  const receipt = await rpc<{ logs: { address: string; topics: string[]; data: string }[] }>(
    chain, "eth_getTransactionReceipt", [txHash],
  );
  if (!receipt) return null;
  const dec = await tokenDecimals(chain, token);
  const quotes = config.quoteAssets[chain] ?? {};
  let maxToken = 0n, maxQuoteUsd = 0;
  for (const log of receipt.logs) {
    if (log.topics[0] !== TRANSFER) continue;
    const addr = log.address.toLowerCase();
    const amount = big(log.data);
    const q = quotes[addr];
    if (q?.isSizingAsset) maxQuoteUsd = Math.max(maxQuoteUsd, Number(amount) / 10 ** q.decimals);
    else if (addr === token.toLowerCase() && amount > maxToken) maxToken = amount;
  }
  const tokens = Number(maxToken) / 10 ** dec;
  if (!(tokens > 0) || !(maxQuoteUsd > 0)) return null;
  return { price: maxQuoteUsd / tokens, quoteUsd: maxQuoteUsd, tokens };
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Chain } from "./types.ts";
import type { Position } from "./positions.ts";
import type { SwapPriceFeed } from "./swapprice.ts";
import { gmgn } from "./gmgn.ts";

const run = promisify(execFile);
const DIR = resolve(import.meta.dirname, "..", "state", "paths");

/** GMGN rate-limits at 10 req/s per IP, and a ban is extended by retries during cooldown. */
/**
 * Price cache lifetime.
 *
 * Raised 1000 -> 2000 after measuring gmgn's own refresh rate: 8 calls at 430ms intervals
 * returned only 3 distinct prices, so the backend updates every ~0.9-2.1s. Polling every
 * second spent roughly half its requests re-fetching a number that had not changed — and
 * those wasted requests are drawn from a 5/s IP budget that a live position depends on for
 * its exit.
 */
const GMGN_TTL_MS = 2000;

/**
 * `t` stays in seconds so existing recordings and the replay tool keep working; `ms` carries
 * the precision needed to measure sub-second reaction, which whole seconds cannot express.
 * `tx` is the trade the price came from — present when the price was read from the chain,
 * absent when it came from the gmgn poll and is therefore unverified.
 */
export interface Sample { t: number; ms: number; price: number; pctFromEntry: number; tx?: string }

/**
 * Records the price path of a position for the full hold window.
 *
 * Purpose is tuning, not trading. Exit parameters cannot be optimised from realised P&L
 * because every paper trade used ONE parameter set — there is no counterfactual for what
 * +40% or a 15%/5s ladder would have returned. Replaying alternative rules against a
 * recorded path gives that counterfactual.
 *
 * Prices come from SwapPriceFeed — the arithmetic of trades that actually happened — and a
 * sample is written per trade rather than per tick, so the recording has a row exactly when
 * the market moved and none when it did not. gmgn-cli remains as a fallback for tokens the
 * feed cannot price, polled only while the feed is silent.
 */
export class PathRecorder {
  private timers = new Map<string, NodeJS.Timeout>();
  private unsub = new Map<string, () => void>();
  private lastAt = new Map<string, number>();

  private intervalMs: number;
  private maxDurationMs: number;
  private feed: SwapPriceFeed | null;
  private gmgnCache = new Map<string, { price: number; at: number }>();
  private gmgnInflight = new Map<string, Promise<number | null>>();

  constructor(intervalMs = 3000, maxDurationMs = 20 * 60_000, feed: SwapPriceFeed | null = null) {
    this.intervalMs = intervalMs;
    this.maxDurationMs = maxDurationMs;
    this.feed = feed;
  }

  private file(id: string) { return resolve(DIR, `${id}.jsonl`); }

  /**
   * Current price. The live feed first; gmgn-cli only when the feed has nothing recent,
   * since a stale exact price is still worth more than a fresh invented one — but not
   * indefinitely, hence the staleness bound.
   *
   * The gmgn result is cached for GMGN_TTL_MS. The exit loop ticks every 200ms so a stop is
   * noticed promptly, but each gmgn-cli call spawns a process and GMGN rate-limits per IP at
   * 10/s — three positions ticking uncached is 15/s, which earned a ban that returned null
   * for whole positions. Three trades closed at exactly -1.30% (the round-trip fee) because
   * they never saw a single price. Ticking fast and fetching slowly are different things.
   */
  async priceOf(chain: Chain, token: string): Promise<number | null> {
    const live = this.feed?.latest(chain, token);
    if (live && Date.now() / 1000 - live.at < 20) return live.price;

    const k = `${chain}:${token.toLowerCase()}`;
    const hit = this.gmgnCache.get(k);
    if (hit && Date.now() - hit.at < GMGN_TTL_MS) return hit.price;

    // Collapse concurrent callers onto one in-flight request.
    const pending = this.gmgnInflight.get(k);
    if (pending) return pending;
    const req = this.gmgnPrice(chain, token).then((price) => {
      this.gmgnInflight.delete(k);
      if (price !== null) this.gmgnCache.set(k, { price, at: Date.now() });
      return price;
    }).catch(() => { this.gmgnInflight.delete(k); return null; });
    this.gmgnInflight.set(k, req);
    return req;
  }

  private async gmgnPrice(chain: Chain, token: string): Promise<number | null> {
    try {
      const stdout = await gmgn(["token", "info", "--chain", chain, "--address", token, "--raw"], 15_000);
      const d = JSON.parse(stdout) as { price?: { price?: string } | string };
      const p = typeof d.price === "object" ? Number(d.price?.price ?? 0) : Number(d.price ?? 0);
      return p > 0 ? p : null;
    } catch { return null; }
  }

  start(p: Position, onSample?: (s: Sample) => void): void {
    if (this.timers.has(p.id) || this.unsub.has(p.id)) return;
    mkdirSync(DIR, { recursive: true });
    // Header row carries everything needed to replay without consulting the position store.
    appendFileSync(this.file(p.id), JSON.stringify({
      meta: {
        id: p.id, chain: p.chain, token: p.token, openedAt: p.openedAt,
        entryPrice: p.entryPrice, costUsd: p.costUsd, tokenAmount: p.tokenAmount,
        entryMarketCapUsd: p.entryMarketCapUsd, takeProfitPct: p.takeProfitPct,
        stopLossPct: p.stopLossPct, breakevenPrice: p.breakevenPrice,
        sourceWallet: p.sourceWallet, sourceWalletName: p.sourceWalletName, signalTx: p.signalTx,
      },
    }) + "\n");

    const began = Date.now();
    const write = (price: number, tx?: string) => {
      const now = Date.now();
      const s: Sample = {
        t: Math.floor(now / 1000),
        ms: now,
        price,
        pctFromEntry: (price / p.entryPrice - 1) * 100,
        ...(tx ? { tx } : {}),
      };
      appendFileSync(this.file(p.id), JSON.stringify(s) + "\n");
      this.lastAt.set(p.id, Date.now());
      onSample?.(s);
    };

    // One row per trade. Nothing is written while the price is not moving, because it isn't.
    if (this.feed) {
      const token = p.token.toLowerCase();
      const handler = (pt: { chain: Chain; token: string; price: number; txHash: string }) => {
        if (pt.chain !== p.chain || pt.token.toLowerCase() !== token) return;
        if (Date.now() - began > this.maxDurationMs) return this.stop(p.id);
        write(pt.price, pt.txHash);
      };
      this.unsub.set(p.id, this.feed.subscribe(handler));
    }

    // Fallback poll, active only when the feed has produced nothing recently.
    const tick = async () => {
      if (Date.now() - began > this.maxDurationMs) return this.stop(p.id);
      const quiet = Date.now() - (this.lastAt.get(p.id) ?? began);
      // Sample every interval, not every third one. The old threshold produced ~0.29
      // samples/s, coarser than the 2s ladder it is meant to let us tune — a recording
      // cannot answer questions finer than its own resolution. priceOf is used rather than
      // gmgnPrice so the recorder shares the exit loop's 1s cache instead of doubling the
      // call rate against GMGN's 10/s limit.
      if (quiet >= this.intervalMs) {
        const price = await this.priceOf(p.chain, p.token);
        if (price !== null) write(price);
      }
      const timer = this.timers.get(p.id);
      if (timer) this.timers.set(p.id, setTimeout(tick, this.intervalMs));
    };
    this.timers.set(p.id, setTimeout(tick, this.intervalMs));
  }

  /**
   * Record a price obtained outside the normal sampling loop — in practice a chain-verified
   * price from an exit decision. Without this the recording keeps the cheap feed's version
   * of a moment the bot explicitly refused to believe, and a replay of that path reaches the
   * opposite conclusion from the live run. Measured at 3 of 18 replays inverting outright.
   */
  note(id: string, price: number, entryPrice: number, tx?: string): void {
    if (!this.timers.has(id) && !this.unsub.has(id)) return;
    const now = Date.now();
    const s: Sample = {
      t: Math.floor(now / 1000), ms: now, price,
      pctFromEntry: (price / entryPrice - 1) * 100,
      ...(tx ? { tx } : {}),
    };
    appendFileSync(this.file(id), JSON.stringify(s) + "\n");
    this.lastAt.set(id, now);
  }

  stop(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.unsub.get(id)?.();
    this.unsub.delete(id);
    this.lastAt.delete(id);
  }
  stopAll(): void { for (const id of new Set([...this.timers.keys(), ...this.unsub.keys()])) this.stop(id); }
  recording(): string[] { return [...new Set([...this.timers.keys(), ...this.unsub.keys()])]; }
}

/** Max favourable / adverse excursion — the two numbers tuning actually needs. */
export function summarise(id: string): {
  samples: number; mfePct: number; maePct: number; finalPct: number; durationSec: number;
} | null {
  const f = resolve(DIR, `${id}.jsonl`);
  if (!existsSync(f)) return null;
  const rows = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Sample | { meta: unknown });
  const samples = rows.filter((r): r is Sample => "price" in r);
  if (!samples.length) return null;
  const pcts = samples.map((s) => s.pctFromEntry);
  return {
    samples: samples.length,
    mfePct: Math.max(...pcts),
    maePct: Math.min(...pcts),
    finalPct: pcts[pcts.length - 1]!,
    durationSec: samples[samples.length - 1]!.t - samples[0]!.t,
  };
}

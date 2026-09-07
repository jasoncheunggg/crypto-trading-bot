import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Every gmgn-cli call in the process goes through here, paced by one shared token bucket.
 *
 * GMGN's free tier allows 5 requests/second PER IP. The bot's sustained load is comfortably
 * under that — about 3.2/s with three positions open, most of it price polling — but the
 * limit is broken by BURSTS, not by the average: three position polls, two entry lookups and
 * a swap can all land inside the same second, which is 7/s. Four days of paper never tripped
 * it; ten minutes of live trading did.
 *
 * The cost of tripping it is not a slow request. It is a 30-second throttle that escalates to
 * a FIVE MINUTE ban on repeat, and during that ban a position cannot be sold. One such ban
 * stranded a live position through its cutoff and cost a managed exit.
 *
 * So: a bucket, not a retry. A burst waits a few hundred milliseconds and proceeds, instead
 * of being rejected and hammered.
 */

/**
 * Refill rate and burst allowance, chosen so we CANNOT exceed 5/s in any one-second window.
 *
 * A token bucket's worst case in a window is BURST + rate: start full, drain instantly, then
 * consume the refill. At 4/s with a burst of 4 that is 8 requests in the first second — over
 * the limit, and exactly the shape that got the IP banned. BURST 1 + 3/s caps the worst case
 * at 4.
 *
 * 3/s is enough because the price cache does the heavy lifting: sustained demand at three
 * concurrent positions is ~1.7/s, so the bucket is a burst absorber rather than a throttle.
 */
const MAX_PER_SEC = 3;
const BURST = 1;

let tokens = BURST;
let lastRefill = Date.now();
/** Epoch ms until which GMGN has told us to stop. Nothing is sent before this passes. */
/**
 * The ban is shared across PROCESSES, via a file, not held in a module variable.
 *
 * gmgn enforces per IP, so every process on this machine draws on one budget — the runner,
 * and any diagnostic script run alongside it. A module-level `bannedUntil` starts at 0 in each
 * new process, so a script would call straight into a ban the runner already knew about, and
 * gmgn adds 5s to the ban for every request made during it, up to five minutes. That is how a
 * 30-second throttle became an hour of intermittent failures on 2026-09-05: not one long ban,
 * but a short one repeatedly renewed by callers who could not see it.
 */
const BAN_FILE = resolve(import.meta.dirname, "..", "state", "gmgn-ban.json");

function readBan(): number {
  try { return JSON.parse(readFileSync(BAN_FILE, "utf8")).until ?? 0; } catch { return 0; }
}
function writeBan(until: number): void {
  try { writeFileSync(BAN_FILE, JSON.stringify({ until, at: new Date().toISOString() })); }
  catch { /* never fatal — a missed write only costs one wasted request */ }
}
let bannedUntil = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Raised when GMGN rate-limits us. A DISTINCT type on purpose: this is the one failure that
 * must never be retried in a tight loop. Retrying inside an active limit is what converts
 * "wait 30 seconds" into "banned for five minutes" — gmgn's own error text says each repeat
 * adds 5s. Callers must treat it as "back off", never as "nothing landed, try again".
 */
export class GmgnRateLimit extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, detail: string) {
    super(`gmgn rate limited, retry after ${Math.ceil(retryAfterMs / 1000)}s: ${detail}`);
    this.name = "GmgnRateLimit";
    this.retryAfterMs = retryAfterMs;
  }
}

/** True while we are serving out a rate-limit penalty; callers can skip work entirely. */
export function rateLimited(): boolean {
  bannedUntil = Math.max(bannedUntil, readBan());
  return Date.now() < bannedUntil;
}

export function rateLimitRemainingMs(): number {
  return Math.max(0, bannedUntil - Date.now());
}

async function take(): Promise<void> {
  for (;;) {
    const now = Date.now();
    // Refresh from the shared file FIRST: a ban recorded by another process is invisible to
    // this one's module state, and calling into it is what renews the ban.
    bannedUntil = Math.max(bannedUntil, readBan());
    if (now < bannedUntil) { await sleep(Math.min(1000, bannedUntil - now)); continue; }
    tokens = Math.min(BURST, tokens + ((now - lastRefill) / 1000) * MAX_PER_SEC);
    lastRefill = now;
    if (tokens >= 1) { tokens -= 1; return; }
    await sleep(Math.ceil(((1 - tokens) / MAX_PER_SEC) * 1000));
  }
}

/**
 * Run gmgn-cli, paced and rate-limit aware. Returns stdout.
 *
 * On a 429 it reads the reset time out of gmgn's message, records it, and throws
 * GmgnRateLimit. Every other caller in the process then waits for that window to pass rather
 * than discovering the limit independently — one process, one penalty.
 */
export async function gmgn(args: string[], timeoutMs = 20_000): Promise<string> {
  await take();
  try {
    const { stdout } = await run("gmgn-cli", args, { timeout: timeoutMs });
    return stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/RATE_LIMIT|HTTP 429/.test(msg)) {
      // "Rate limit resets at ... (~30s remaining)" — believe it, and add a second of slack.
      const m = /\(~(\d+)s remaining\)/.exec(msg);
      const waitMs = ((m?.[1] ? Number(m[1]) : 60) + 1) * 1000;
      bannedUntil = Math.max(bannedUntil, Date.now() + waitMs);
      writeBan(bannedUntil);
      throw new GmgnRateLimit(waitMs, msg.slice(0, 160));
    }
    throw err;
  }
}

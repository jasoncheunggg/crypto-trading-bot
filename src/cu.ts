import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Alchemy compute-unit accounting.
 *
 * This exists because nothing in the bot knew what it was spending. A chain-wide log
 * subscription burned 15.4M CU in half an hour — visible only on Alchemy's dashboard,
 * hours later. Every call is now counted as it happens and the total is printed with the
 * status line, so the burn is legible from the log alone.
 *
 * Costs are Alchemy's published per-method figures where known; the subscription figure is
 * derived from that incident (15.4M CU over ~550k delivered logs). Treat them as close
 * estimates, not billing truth — the dashboard is authoritative.
 */
const COST: Record<string, number> = {
  eth_getLogs: 75,
  eth_getTransactionReceipt: 15,
  eth_getTransactionByHash: 17,
  eth_call: 26,
  eth_getBlockByNumber: 16,
  eth_blockNumber: 10,
  eth_subscribe: 10,
  subscription_log: 28,
};
const DEFAULT_COST = 20;

const STATE = resolve(import.meta.dirname, "..", "state");

const LEDGER = resolve(STATE, "cu-usage.json");

/**
 * Spend is tracked per calendar month and persisted, because a per-process counter is not a
 * budget: it resets on every restart, and this runner is restarted often. Six restarts in a
 * day would have meant six times the intended ceiling.
 *
 * The month key is calendar-based. If Alchemy's billing period does not start on the 1st,
 * this drifts from the dashboard by a few days — the dashboard is authoritative; set
 * `alreadyUsedThisMonth` from it to re-anchor.
 */
function monthKey(): string { return new Date().toISOString().slice(0, 7); }

interface Ledger { month: string; spent: number; seeded: number }

function load(): Ledger {
  const fresh: Ledger = { month: monthKey(), spent: 0, seeded: 0 };
  if (!existsSync(LEDGER)) return fresh;
  try {
    const d = JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
    return d.month === monthKey() ? d : fresh;   // new month, start again
  } catch { return fresh; }
}

let ledger = load();
let sessionSpent = 0;
let byMethod = new Map<string, { calls: number; cu: number }>();
let budget = Infinity;
let exhaustedAnnounced = false;
let lastFlush = 0;

/** Monthly ceiling, and what the dashboard says was already spent before this ledger began. */
export function setBudget(cu: number, alreadyUsedThisMonth = 0): void {
  budget = cu > 0 ? cu : Infinity;
  if (alreadyUsedThisMonth > ledger.seeded) {
    ledger.spent += alreadyUsedThisMonth - ledger.seeded;
    ledger.seeded = alreadyUsedThisMonth;
    flush();
  }
}

function flush(): void {
  try { writeFileSync(LEDGER, JSON.stringify(ledger)); lastFlush = Date.now(); } catch { /* non-fatal */ }
}

export function charge(method: string, n = 1): void {
  const c = (COST[method] ?? DEFAULT_COST) * n;
  sessionSpent += c;
  ledger.spent += c;
  const e = byMethod.get(method) ?? { calls: 0, cu: 0 };
  e.calls += n; e.cu += c;
  byMethod.set(method, e);
  if (Date.now() - lastFlush > 10_000) flush();   // survive a kill without writing per call
}

/** True while there is budget left to spend on verification. */
export function affordable(): boolean {
  if (ledger.spent < budget) return true;
  if (!exhaustedAnnounced) {
    exhaustedAnnounced = true;
    flush();
    appendFileSync(resolve(STATE, "alerts.log"),
      `${new Date().toISOString()} CU BUDGET EXHAUSTED — ${ledger.spent.toLocaleString()} used this month of ${budget.toLocaleString()}; verification off, gmgn only\n`);
  }
  return false;
}

export function spentCu(): number { return sessionSpent; }
export function monthSpent(): number { return ledger.spent; }
export function remaining(): number { return Math.max(0, budget - ledger.spent); }

export function summary(): string {
  const rows = [...byMethod.entries()].sort((a, b) => b[1].cu - a[1].cu)
    .map(([m, e]) => `${m} ${e.calls}x=${e.cu.toLocaleString()}`);
  return `${sessionSpent.toLocaleString()} CU this run, ${ledger.spent.toLocaleString()} this month` +
    (rows.length ? `  [${rows.join(", ")}]` : "");
}

export function persist(): void { flush(); }

/** Reset for tests — in-memory only, leaves the ledger on disk alone. */
export function reset(): void {
  sessionSpent = 0; byMethod = new Map(); exhaustedAnnounced = false;
  ledger = { month: monthKey(), spent: 0, seeded: 0 };
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Chain, QuoteAsset, Wallet } from "./types.ts";

const root = resolve(import.meta.dirname, "..");

/** Minimal .env reader — no dependency, and the file is gitignored. */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(root, ".env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m?.[1]) out[m[1]] = (m[2] ?? "").trim();
    }
  } catch { /* .env is optional when the vars are already exported */ }
  return { ...out, ...process.env } as Record<string, string>;
}

const env = loadEnv();

/** Resolve ${VAR} placeholders so secrets stay out of config.json. */
function expand(s: string): string {
  return s.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, k: string) => {
    const v = env[k];
    if (!v) throw new Error(`config references \${${k}} but it is unset — add it to .env`);
    return v;
  });
}

const raw = JSON.parse(readFileSync(resolve(root, "config.json"), "utf8"));
const walletsFile = JSON.parse(
  readFileSync(resolve(root, raw.detection.trackedWalletsFile), "utf8"),
);

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A wrong `family` routes a wallet to the wrong decoder, which presents as a wallet
 * that simply never trades. Fail at startup instead.
 */
function validate(w: Wallet): void {
  const ok = w.family === "evm" ? EVM_ADDR.test(w.address) : B58.test(w.address);
  if (!ok) throw new Error(`${w.name}: address ${w.address} is not valid for family "${w.family}"`);
  if (!raw.detection.activePlatforms.includes(w.platform)) {
    throw new Error(`${w.name}: platform "${w.platform}" is not in detection.activePlatforms`);
  }
}

const activeChains: Chain[] = raw.detection.chains;

export const wallets: Wallet[] = (walletsFile.wallets as Wallet[])
  .filter((w) => w.enabled)
  .filter((w) => raw.detection.activePlatforms.includes(w.platform))
  .map((w) => {
    validate(w);
    return { ...w, chains: w.chains.filter((c) => activeChains.includes(c)) };
  })
  .filter((w) => w.chains.length > 0);

export const config = {
  chains: activeChains,
  endpoints: Object.fromEntries(
    Object.entries(raw.detection.endpoints as Record<string, string>)
      .filter(([c]) => activeChains.includes(c as Chain))
      .map(([c, u]) => [c, expand(u)]),
  ) as Record<Chain, string>,
  decoders: raw.detection.decoders as Record<Chain, string>,
  quoteAssets: Object.fromEntries(
    Object.entries(raw.detection.classifier.quoteAssets as Record<string, Record<string, QuoteAsset>>)
      .map(([chain, assets]) => [
        chain,
        Object.fromEntries(Object.entries(assets).map(([addr, a]) => [addr.toLowerCase(), a])),
      ]),
  ) as Record<Chain, Record<string, QuoteAsset>>,
  knownRouters: (raw.detection.classifier.knownRouters as string[]).map((r) => r.toLowerCase()),
  minQuoteMovementUsd: raw.detection.classifier.minQuoteMovementUsd as number,
  emitStagingTransfers: raw.detection.classifier.emitStagingTransfers as boolean,
  reorgSafetyBlocks: raw.detection.reorgSafetyBlocks as number,
  detection: raw.detection,
  // walletAddress is expanded here, not left raw: it holds ${WALLET_ADDRESS} so the
  // committed config carries no real address. expand() throws if the var is unset, which
  // is the right failure — a bot that silently trades from the wrong wallet is worse.
  entry: { ...raw.entry, walletAddress: expand(String(raw.entry.walletAddress ?? "")) },
  exit: raw.exit,
  livePriceFeed: (raw.exit as { livePriceFeed?: { enabled?: boolean } }).livePriceFeed ?? { enabled: false },
  risk: raw.risk,
  execution: (raw.execution ?? {}) as { router?: string },
  alchemy: (raw.alchemy ?? {}) as { cuBudgetPerMonth?: number; alreadyUsedThisMonth?: number },
  mode: raw.mode,
};

/**
 * Slippage ceiling for a given fill, in percent above the tracked wallet's own price.
 *
 * Banded by OUR implied market cap because the gate's premise — a big gap means the move
 * already happened — holds for large caps and fails for small ones, where the tracked
 * wallet's buy is itself what starts the move. Every signal this gate has ever rejected
 * would have been profitable, so it is deliberately loose at the small end.
 */
export function maxSlippagePctFor(marketCapUsd: number): number {
  const bands = (config.entry.maxSlippagePctByMarketCap ?? []) as { maxMarketCapUsd: number; pct: number }[];
  for (const b of bands) if (marketCapUsd < b.maxMarketCapUsd) return b.pct;
  return config.entry.maxSlippagePctVsSignalPrice as number;
}

/**
 * The ENTRY ceiling, which asks a second question the band table cannot.
 *
 * `maxSlippagePctFor` is keyed on OUR implied market cap — how expensive the thing we are
 * about to buy already is. This adds an override keyed on THEIRS: how early the tracked
 * wallet got in. Below the threshold their buy is frequently what STARTS the move, so a wide
 * gap between their fill and our quote is the normal shape of a live runner, not the stale
 * price the band exists to refuse.
 *
 * Combined with MAX, deliberately: the override can only ever LOOSEN. A band tighter than the
 * override still applies above the threshold, and no configuration of this can tighten a
 * ceiling that the band table already set.
 *
 * ENTRY ONLY. The sell path calls `maxSlippagePctFor` directly against the position's own
 * entry mcap and must keep doing so — a sell ceiling derived from how early someone else got
 * in has nothing to do with what our exit can afford to give up.
 */
export function entrySlippageCap(
  impliedMarketCapUsd: number, signalMarketCapUsd?: number | null,
): { pct: number; rule: string } {
  const band = maxSlippagePctFor(impliedMarketCapUsd);
  const bySignal = (config.entry.maxSlippagePctBySignalMarketCap ?? []) as
    { maxSignalMarketCapUsd: number; pct: number }[];
  if (signalMarketCapUsd != null && signalMarketCapUsd > 0) {
    // First match wins, so the table must be ascending — same convention as the mcap bands.
    for (const b of bySignal) {
      if (signalMarketCapUsd >= b.maxSignalMarketCapUsd) continue;
      return b.pct > band
        ? { pct: b.pct, rule: `their fill under $${b.maxSignalMarketCapUsd.toLocaleString("en-US")}` }
        : { pct: band, rule: `$${Math.round(impliedMarketCapUsd).toLocaleString("en-US")} mcap` };
    }
  }
  return { pct: band, rule: `$${Math.round(impliedMarketCapUsd).toLocaleString("en-US")} mcap` };
}

/** Redacted for logs — the endpoints contain the API key. */
export function describe(): string {
  return [
    `chains   : ${config.chains.join(", ")}`,
    `wallets  : ${wallets.length} enabled`,
    ...wallets.map((w) => `           ${w.name} [${w.chains.join(",")}] ${w.address}`),
    `mode     : dryRun=${config.mode.dryRun} logOnly=${config.mode.logOnly}`,
  ].join("\n");
}

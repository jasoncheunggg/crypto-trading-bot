import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Chain } from "./types.ts";
import { gmgn } from "./gmgn.ts";

const run = promisify(execFile);
const cache = new Map<string, { liquidityUsd: number; marketCapUsd: number; at: number }>();
const TTL_MS = 60_000;

export interface TokenFacts { liquidityUsd: number; marketCapUsd: number }

/**
 * Pool liquidity and market cap.
 *
 * Uses gmgn-cli, which costs 429-766ms of Node startup per call — acceptable while the
 * bot is log-only, NOT on a live hot path. Replace with GMGN's HTTP API (or on-chain pool
 * reserves read from the signal transaction's own Swap logs) before trading.
 */
export async function tokenFacts(chain: Chain, token: string): Promise<TokenFacts | null> {
  const key = `${chain}:${token.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  try {
    const stdout = await gmgn(["token", "info", "--chain", chain, "--address", token, "--raw"], 15_000);
    const d = JSON.parse(stdout) as {
      price?: { price?: string } | string; total_supply?: string; liquidity?: string;
    };
    const price = typeof d.price === "object" ? Number(d.price?.price ?? 0) : Number(d.price ?? 0);
    const supply = Number(d.total_supply ?? 0);
    const facts = { liquidityUsd: Number(d.liquidity ?? 0), marketCapUsd: price * supply };
    cache.set(key, { ...facts, at: Date.now() });
    return facts;
  } catch {
    return null;
  }
}

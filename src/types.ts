/** A quote asset on a given chain — what a purchase is paid in. */
export interface QuoteAsset {
  symbol: string;
  decimals: number;
  /** True when this asset is dollar-denominated, so its amount IS the trade size in USD. */
  isSizingAsset: boolean;
}

export type Family = "evm" | "solana";
export type Chain = "robinhood" | "bsc" | "base" | "solana";

export interface Wallet {
  name: string;
  address: string;
  family: Family;
  chains: Chain[];
  platform: string;
  enabled: boolean;
}

/** What the classifier decided a transaction was, from the tracked wallet's point of view. */
export type Verdict =
  | "BUY"
  | "SELL"
  | "RECEIVED"        // token in, nothing paid — staging transfer or airdrop
  | "SENT_OUT"        // token out, nothing received
  | "QUOTE_NO_TOKEN"  // quote moved but the wallet's token balance did not: anomaly, never silently dropped
  | "NO_OP";

export interface Signal {
  wallet: Wallet;
  chain: Chain;
  txHash: string;
  blockNumber: number;
  /** Seconds since epoch, from the block. */
  timestamp: number;
  verdict: Verdict;
  token: string;
  /** Signed: positive means the wallet received tokens. */
  tokenAmount: number;
  tokenDecimals: number;
  /** Trade size in USD, from the largest single sizing-asset transfer. 0 when nothing was paid. */
  sizeUsd: number;
  /** Every quote asset that moved, for diagnostics. */
  /** Every quote leg, in its OWN units and in dollars. `usd` is null when the rate is
   *  unknown — never 0, which would read as "worth nothing". */
  quoteLegs: { symbol: string; amount: number; usd: number | null; dollarLeg: boolean; isSizingAsset: boolean }[];
  /** Market cap implied by this fill: sizeUsd / tokenAmount * totalSupply. 0 when not a paid trade. */
  impliedMarketCapUsd: number;
  viaKnownRouter: boolean;
  /** The contract the transaction was sent to — named when it is not a known router. */
  routerUsed?: string;
  /** Set when the signal should not be acted on, with the reason. */
  rejectedReason?: string;
}

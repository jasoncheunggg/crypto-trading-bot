# Prompt for Claude Code: Memecoin Copy-Trading Bot

Copy the section below into Claude Code as your starting instruction. Fill in the bracketed values first.

---

## Project

Build a Node.js/TypeScript CLI bot that watches a handpicked list of wallets across **`sol`, `bsc`, `base`, `eth`, and `robinhood`**, detects when they buy (not receive) a memecoin, and scalps the resulting copytrader pump with a short hold time. It uses the `gmgn-cli` tool (from GMGNAI/gmgn-skills) for wallet tracking and swap execution — `gmgn-cli` supports all five chains natively via `--chain`, so no separate integration is needed per chain. `sol` uses base58 addresses; `bsc`, `base`, `eth`, and `robinhood` all use standard `0x...` EVM addresses.

`arc` and `stable` are explicitly out of scope. The CLI does accept them, but they are young enough that their behaviour is unproven, and dropping them removes the address-format and feature-parity unknowns entirely. Do not add them back without a deliberate decision.

### Verified against the installed CLI (2026-08-30)

Findings below come from running `gmgn-cli` directly, not from reading docs. Re-verify if the CLI is upgraded.

- **The command reference is `cli-usage.md` at the repo root** (971 lines), not `docs/cli-usage.md`, and it does not ship with the `GMGNAI/gmgn-skills` package — that package installs only nine `SKILL.md` files under `.agents/skills/`. Use `cli-usage.md` for response schemas, error codes and rate-limit behaviour, which `--help` does not cover.
- **`cli-usage.md` understates chain support; `--help` is right.** The reference lists `--chain` for both `portfolio activity` and `track follow-wallet` as `sol` / `bsc` / `base` only. This is provably wrong for `portfolio activity`: a live `--chain robinhood` call returned real records (see below). `--help` declares all seven chains on both commands. **Trust `--help` over the reference on chain support, and confirm with a live call.** Use the reference for response schemas, error codes and rate-limit behaviour, which `--help` does not cover. Note separately that the `gmgn-swap` SKILL.md summary line claims only Solana/BSC/Base/Ethereum, understating both sources; `swap` is documented as all seven in both.
- **`portfolio activity --wallet` is NOT repeatable — passing two silently uses only the last.** Live test with two addresses returned records for the second one only, with no error and no warning. There is no batch form of this command (contrast `portfolio stats`, where `--wallet` *is* repeatable). Detection is therefore strictly one request per wallet per tick, and any attempt to batch will silently watch one wallet while appearing to watch many.
- **`follow-wallet` DOES support `robinhood` — `cli-usage.md` is wrong, `--help` is right.** Resolved by following one robinhood wallet on gmgn.ai and querying: `track follow-wallet --chain robinhood` returned 20 real records with a live `next_page_token`. The reference's `sol`/`bsc`/`base` claim for this command is outdated; treat `--help` as authoritative on chain support throughout. (For the record, this cannot be tested from an account with an empty follow list: every chain returns an identical `{"next_page_token":"","list":null}`, an invalid chain name is rejected client-side before any request is sent, and `--wallet` does *not* bypass the follow-list gate — a wallet with proven robinhood activity still returned empty. Following a wallet is the only way through.)
- **`follow-wallet` carries per-wallet attribution via `maker`.** Each record's `maker` field is the followed wallet's address, so the per-wallet stats module works on this path. Full field set, confirmed live: `id`, `chain`, `transaction_hash`, `maker`, `maker_info`, `side`, `timestamp`, `base_address`, `base_token{symbol,logo,total_supply,token_create_time,...}`, `base_amount`, `quote_address`, `quote_symbol`, `quote_amount`, `token_amount`, `cost_usd`, `buy_cost_usd`, `amount_usd`, `price`, `price_usd`, `price_now`, `price_change`, `is_open_or_close`, `balance_info`, `launchpad`, `launchpad_platform`, `migrated_pool_exchange`. Note it carries `price_now` and `price_change` — live position context that `portfolio activity` does not return.
- **`follow-wallet --side` is SERVER-side, unlike `track kol`/`smartmoney`.** `--side buy --limit 3` returned exactly 3 buys; `--limit 20` returned 20 buys. So the low-limit trap that afflicts `kol` does **not** apply here — but the two commands need opposite paging strategies, so never share filter logic between them.
- **Field names differ between the two detection paths.** `follow-wallet` uses `transaction_hash` / `maker` / `side` / `base_address`; `portfolio activity` uses `tx_hash` / `wallet` / `event_type` / `token.address`. A hybrid design must normalize both into one internal shape at the boundary, or the dedupe and stats logic will silently disagree with itself.
- **GMGN tracking was evaluated and rejected; GMGN execution was kept.** `track follow-wallet` costs one request per chain regardless of wallet count and returns byte-identical trades to `portfolio activity` (0 s freshness delta, all 30 hashes matching), so the mechanics were sound. What failed is interpretation: GMGN recorded **0 buys against 65 sells** on a token this wallet demonstrably traded, and valued zero-liquidity airdrops at millions. Detection therefore reads the chain directly via Alchemy (see Detection); GMGN is retained for quoting and swap execution, where it does not have to interpret anything.
- **Response envelopes are inconsistent across commands — do not write one shared parser.** `portfolio activity` returns `{"activities":[...],"next":<cursor>}`; `track kol` returns `{"list":[...]}`; `track follow-wallet` returns `{"next_page_token":"","list":null}` — note `null`, not `[]`, so `.list.length` throws on the empty case. Normalize per-command at the boundary.
- **Rate limits are a first-class design constraint, not an edge case.** GMGN runs a leaky bucket at `rate=10, capacity=10` across all business routes, keyed by IP. Exceeding it returns `429 RATE_LIMIT_EXCEEDED`, and — critically — *every request sent during the cooldown extends the ban by 5 seconds, up to 5 minutes* (`RATE_LIMIT_BANNED`). A naive poll loop over N wallets that keeps retrying through a 429 will lock the bot out of the market for minutes at exactly the wrong moment. Budget the poll interval against 10 req/s total across every chain and wallet, and make the 429 handler back off on `X-RateLimit-Reset` rather than retry. I triggered this ban during verification by probing chains in a tight loop; it is easy to hit.
- **`robinhood` is confirmed working end-to-end, including detection.** Live calls: `portfolio activity --chain robinhood --wallet 0x878a...76a6 --type buy` returned real buy records for an arbitrary wallet; `market trending --chain robinhood --interval 24h` returned PONS/SPY/CASHCAT; `track kol --chain robinhood --side buy` returned a KOL buy. Cross-validation: the same trade (`tx_hash 0x7c83afa6...`) appeared through both `track kol` and `portfolio activity`, so the two views agree. `swap` is documented for robinhood in both `--help` and `cli-usage.md`, though execution there is untested — verify with a minimum-size live trade before trusting it.
- **`portfolio activity --type` is a real server-side filter — unlike `--side` on the `track` commands.** `--type buy --limit 2` returned 2 buys; `--type transferIn --limit 3` returned 3 records, all `event_type: "transfer_in"`. This is the detection filter, working at the API rather than something to reimplement. Contrast `track kol --side`, which `cli-usage.md` marks "(client-side filter)" and which is a genuine trap: `--side buy --limit 2` returns 0 records while `--limit 100` returns 78, so a low limit yields an empty list indistinguishable from "no signals". Since detection uses `portfolio activity`, the trap does not apply to the hot path — but it does to any use of `kol`/`smartmoney`.
- **The `--type` flag value and the response value use different casing.** The flag takes camelCase (`transferIn`, `transferOut`); the response field `event_type` returns snake_case (`transfer_in`, `transfer_out`). `buy` and `sell` are identical in both. `cli-usage.md` lists the types as `buy / sell / add / remove / transfer` — `--help` is more precise, splitting transfer into in/out. Map explicitly in both directions; do not round-trip the string.
- **The Robinhood liquidity warning is measured, not hypothetical.** From a live `market trending --chain robinhood --interval 24h` call: PONS showed $288.07M market cap against $3.20M liquidity (1.1%), and CASHCAT $223.80M against $5.81M (2.6%). At those ratios the `%`-of-pool-liquidity cap in Entry logic will be the binding constraint on nearly every robinhood entry, not the `%`-of-portfolio cap. Size that cap deliberately rather than treating it as a rarely-hit backstop.

Treat this as a real-money trading system: prioritize correctness of the exit logic and failure handling over features. Every code path that can lose money needs a test or a clear manual-verification note.

## Tracked wallets

Wallets live in their own file, **`wallets.json`**, referenced from `config.json` → `detection.trackedWalletsFile`. Keeping them separate matters because the roster changes often while the rest of the config rarely does — you edit one small file rather than picking through tuning parameters. Nothing needs following on gmgn.ai; the platform's follow list is not used at all. Each entry:

```
{ name, address, chain, family, platform, enabled }
```

- **`name`** — **yours to choose.** Free text, display only: it appears in logs, alerts and the stats command so you can tell wallets apart at a glance. Change it whenever you like.
- **`address`** — the **immutable primary key**. Per-wallet statistics are keyed on the address, never on the name, so renaming a wallet never splits its history or resets its win rate.
- **`family`** — `evm` or `solana`. Picks the decoder. EVM reads ERC-20 `Transfer` logs from a receipt; Solana diffs `preTokenBalances`/`postTokenBalances`. Same classifier, different extraction.
- **`platform`** — `fomo`, `gmgn`, … The venue the wallet trades through. **A wallet whose platform is not in `detection.activePlatforms` is skipped entirely.** Currently `["fomo"]`.
- **`chain`** — `robinhood` / `bsc` / `base` / `solana`.
- **`enabled`** — `false` keeps an entry as a record without subscribing to it, so you can retire a wallet without losing why it was there.

**Validate `family` against the address format at load time and refuse to start on a mismatch** — `solana` is base58 (32–44 chars), `evm` is `0x` plus 40 hex. A wrong `family` silently routes the wallet to the wrong decoder, which looks like a wallet that never trades rather than an error.

### Why platform matters, not just chain

The venue determines how a buy looks on-chain, and the two observed platforms differ in every respect that the decoder cares about:

| | **fomo** | **gmgn** |
|---|---|---|
| Solana program | `DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH` | `FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9` |
| EVM router | `0xccc88a9d…c315be`, selector `0x0a2b8f36` | — |
| Who signs | **a third party** — the wallet does not sign its own buys | the wallet itself |
| Settles in | **stablecoins** (USDC / USDG / USDT) | **native SOL** |
| Trade size | **exact** — the stablecoin amount *is* the USD size | **approximate** — needs a SOL/USD price at block time |

`platform` is therefore a real behavioural switch, not a label. It is also free to verify: the top-level program or router identifies the venue with no extra call, so the bot can assert that a wallet still trades where its config says and flag it if that changes.

**Currently tracking fomo only.** The practical benefit is that every trade size is exact — no price feed on the hot path, and `entry.minTradeUsd` compares against a real dollar figure rather than an estimate. Enabling `gmgn` later means accepting approximate sizing on those wallets, since a stale SOL price of a few percent shifts the number (one observed trade priced at $274 against GMGN's $262 for the same buy, purely from which SOL price was used).

### Detection coverage differs by family

- **EVM** — `Transfer` logs are indexed by owner address, so a wallet-level subscription sees both buys and inbound transfers.
- **Solana** — a wallet-level subscription sees **buys** (the wallet's balances change) but **misses free receives**, because an inbound transfer to an associated token account never mentions the owner. Confirmed: a $50k USDC buy appeared at wallet level; a 205.85-token receive on the same wallet and mint did not.

Buys are what you trade on, so this gap costs no tradeable signal. It costs the **staging warning** — the inbound transfer that precedes a buy. To recover it on Solana you must watch token accounts rather than the wallet, or use GMGN's `portfolio activity` purely as a discovery index and classify on-chain as usual. Do not adopt GMGN's own buy/transfer labels.

**Robinhood liquidity note:** Robinhood Chain is young and its meme-coin liquidity runs far below market cap — a pool that can't absorb a rush of sellers. Measured, not assumed: PONS at 1.1% of market cap, CASHCAT at 2.6%. Default `entry.maxPositionPctOfLiquidity` tighter for `robinhood`, and expect that cap — not the portfolio-percentage cap — to size almost every robinhood entry.

**But liquidity varies enormously and must be checked per token, not assumed per chain.** TRIPLET showed 19.1% liquidity-to-market-cap on the same chain. Worse, of one tracked wallet's holdings the **top twelve by nominal value all had $0.00 liquidity** — one marked at $7,753,436 against a pool that cannot absorb a single dollar. `entry.minPoolLiquidityUsd` is therefore a hard entry gate, not a sizing input, and portfolio valuation must exclude zero-liquidity positions or every percentage-of-portfolio calculation is wrong by orders of magnitude.

## Detection

**Architecture: Alchemy WSS detects, GMGN executes.** GMGN's own tracking is not usable — it misclassifies this wallet's acquisitions (0 recorded buys against 65 sells on one token) and values unsellable airdrops at their nominal mark ($7.75M against $0.00 pool liquidity). Its *balances* are accurate and its *execution* works; its interpretation of on-chain activity is not trusted. So signals come from the chain directly.

- **Subscribe, don't poll.** `logsSubscribe` over Alchemy WSS per chain, filtered to `Transfer` events where `to` is a tracked wallet. Push-based, so wallet count costs nothing and GMGN's 10 req/s budget is reserved entirely for execution. Endpoints and chains live in `config.json` under `detection`.
- **Classify with the quote-asset test.** On each hit, fetch `eth_getTransactionReceipt` and scan its logs:

  ```
  maxQuoteTransfer(tx) > 0   ->  BUY, size = that amount
  maxQuoteTransfer(tx) == 0  ->  staging transfer, no purchase
  ```

  **A purchase costs money; a transfer doesn't.** That invariant is the whole classifier. Validated 14/14 against hand-labelled trades across five tokens and two chains.

- **Take the *maximum* single quote transfer, never the sum.** Routes are multi-hop and the same money reappears at each leg — one BSC buy showed five hops of ~$2,132 that summed to $10,664 and turned a $2k buy into an apparent $11k one. Max matched labelled values to within 0.12%.
- **Quote assets are the only per-chain maintenance.** `config.json` → `detection.classifier.quoteAssets`. Robinhood settles in USDG (`0x5fc5360d…`, **6 decimals**) with WETH in the routing path; BSC uses USDT/USDC (**18 decimals on BSC, not 6**). Mark exactly one per chain `isSizingAsset` — the dollar stablecoin — since its transfer amount *is* the trade size in USD, with no price lookup on the hot path.
- **Four signals that look right and are not.** Each was tested against labelled data and each would have silently broken the bot:

  | discarded signal | why |
  |---|---|
  | `tx.from == trackedWallet` | **false on every buy** — a router signs, not the wallet |
  | value leaving the wallet | **zero on every Robinhood buy** — the router settles internally |
  | requiring a `Swap` event | **absent on most buys** — bonding-curve routing emits custom events; only graduated tokens emit V2/V3 `Swap` |
  | trade size ≥ $1,000 alone | an **$11,000 airdrop** passes straight through |

  Token *quantity* is the most misleading of all — airdrops were repeatedly the largest token counts (18.6M vs 1.86M on one token; 8.47M vs 2.4–3.4M on another).

- **Corroborating, never deciding:** `tx.to == 0xccc88a9d1b4ed6b0eaba998850414b24f1c315be` (the same router on both chains) and selector `0x0a2b8f36` for buys vs `0xa9059cbb` for bare transfers. Cheap pre-filters, but a new router breaks them while the quote-asset test survives.
- **Emit staging transfers as a distinct signal, not noise.** This wallet moves inventory in from an address it controls *before* buying and promoting. Those transfers classify correctly as non-purchases, but they are a **leading indicator**: pre-warm the token's liquidity and pool metadata on a staging signal so that when the buy fires only the swap remains. That is worth far more than any millisecond shaved off detection.
- **Latency budget.** Classification logic costs **29 µs**; the `eth_getTransactionReceipt` round trip costs **~380 ms** and dominates. Do not optimise this before execution — a `gmgn-cli` invocation costs 429–766 ms of Node startup and an entry needs two. Dual-subscribe (correlating a wallet filter against a quote-asset filter to skip the receipt) would remove the 380 ms but replaces a complete, atomic receipt with a timeout heuristic over two lossy streams: a dropped quote log silently reclassifies a real buy as a transfer. Not worth it until execution is fixed.
- **Reorg safety.** Robinhood produces ~9.7 blocks/sec. Confirm `detection.reorgSafetyBlocks` before acting, or accept acting on logs that may be reorged out.
- **Dedupe on transaction hash, persisted across restarts** — a restart mid-session must not re-enter a position it already took.
- Do NOT filter out wash trades or self-swaps between linked wallets — every detected buy is a valid entry signal regardless of the KOL's intent, since the strategy targets the copytrader reaction, not the KOL's conviction.
- Dedupe on transaction hash always (`entry.dedupe.byTransactionHash`). Whether a repeat buy on an already-held token opens another position is `entry.dedupe.tokenReentry`, per platform — currently enabled for `fomo`, capped at `maxPositionsPerToken`.

## Configuration

All tunables live in **`config.json`** at the repo root — a real file, not an example. Nothing in this document should be hardcoded. Values that are `null` there are **required and unset**: the bot must refuse to start until they are filled in, rather than substituting a default on a real-money path.

Currently unset and blocking: `risk.stopLossPct`, `risk.portfolioValue`, `risk.minPositionSizeUsd`, `risk.dailyLoss.maxRealizedLossPctOfPortfolio`, `risk.dailyLoss.maxConsecutiveStopLosses`, `entry.marketCapFloorUsd`, `exit.ladder.minSliceUsd`, `exit.trailingStopPct`.

**Tier semantics.** `exit.takeProfitTiers` is evaluated in order; the first entry whose `maxMarketCapUsd` exceeds the token's market cap wins, so bounds are upper-exclusive (a token at exactly `100000` falls into the `300000` tier). A market cap at or above `entry.marketCapCeilingUsd` is **not bought at all** — an entry filter, not an exit rule. Adding, removing or reordering tiers must require no code change.

**Concurrency: `maxConcurrentPositions: 3`.** Detection is push-based on Alchemy and no longer competes for GMGN's 10 req/s, which now serves execution alone. Measured worst case at 3: ladders 4.0 + price checks 1.5 + one entry burst 3.0 = **~8.5 req/s**; five would reach ~12.2 and breach the limit. This only fits because `exit.ladder.minSliceUsd` cuts the ladder from ~17 sells to ~4 — lowering that floor spends the headroom. Note the original case for 1 was that same-token clusters collapse under dedupe (24% of a wallet's buys land within 60 s of the previous, all same-token); with `entry.dedupe.tokenReentry` now enabled for `fomo`, those clusters become separate positions, so the slots will fill more often than that measurement implied.

**Stuck positions are the hazard at concurrency 1.** One unsellable token would otherwise halt the bot permanently, so `stuckPositions.countTowardConcurrencyCap: false` is mandatory: a position that exhausts `exit.sellRetries` moves to quarantine, frees the slot, and the bot continues — still counted in P&L and logged distinctly. Halt only at `maxQuarantined`.

## Entry logic

1. On a valid buy signal — a `BUY` classification from Detection, with `size >= entry.minTradeUsd` — immediately fetch a swap quote and construct the buy transaction. No pre-buy or post-buy security/honeypot/rug check is performed — entry speed is prioritized and position sizing (below) is the only backstop against a bad token.
1a. **Market-cap gate.** Read `market_cap` from `gmgn-cli token info` and **skip the signal entirely** if it is at or above `entry.marketCapCeilingUsd` (default **$10M**) — a KOL's social reach does not move a coin that size, so the copytrader pump this strategy harvests does not materialize. Record the same market cap on the position: it selects the exit tier and is frozen for the life of the trade. Note this costs one extra request on the hot path, before the quote.
2. **Max acceptable entry slippage:** abort the buy if the quoted price is more than `entry.maxSlippagePctVsSignalPrice` above the price observed at signal time.
2a. **Liquidity gate.** Reject the signal outright if pool liquidity is below `entry.minPoolLiquidityUsd`. This is not sizing, it is a validity check: tokens with $0.00 liquidity carry nominal marks in the millions and cannot be sold at any price. Verified on this wallet's holdings — the top twelve by nominal value all had zero liquidity.
2b. **Portfolio value is read from the GMGN wallet, not hardcoded.** `risk.portfolioValue` refreshes every `refreshIntervalHours` (24) and on startup, summing the balances of the API-key-bound wallets across `includeChains`, plus open positions.

   Four rules make this safe rather than dangerous:

   - **`excludeZeroLiquidityPositions: true`** — count a held token only if its pool clears `minPoolLiquidityUsdToCount`. Non-negotiable: GMGN marks unsellable airdrops at nominal price, and one observed wallet showed **$7,753,436 against $0.00 liquidity**. If the bot's own wallet is ever airdropped such a token, an unfiltered refresh would inflate portfolio value by orders of magnitude and size the next position accordingly.
   - **`maxChangePctBeforeHalt: 50`** — if a refresh moves portfolio value more than 50% in either direction, halt new entries and log loudly instead of trusting it. A genuine 50% move in a day is worth a human look; a spurious one is a bug you do not want sizing trades.
   - **`onRefreshFailure: "keepLastKnown"`** — a failed or rate-limited refresh keeps the previous value. Never fall back to zero (every signal silently rejected) or to a default (positions sized against money that isn't there).
   - **`resizeOpenPositionsOnRefresh: false`** — a refresh never changes a position already open. Size is fixed at entry; the exit ladder sells what was actually bought.

   `lastKnownUsd` and `lastRefreshedAt` are written back by the bot, so a restart resumes from the last good figure rather than blocking on a fresh fetch.

   **Before going live, reconcile the configured value against the real balance and refuse to start on a large mismatch** — otherwise a paper-phase number left in place would size live trades against capital that does not exist.

3. **Position sizing** — take the smaller of:
   - `risk.positionSizePctOfPortfolio` of current portfolio value (see 2b — refreshed from the wallet, not static)
   - `entry.liquidityCapPctByChain` of the pool's current liquidity (hard cap; read pool liquidity from `gmgn-cli token pool` before sizing). Defaulted tighter for `robinhood` — see the Robinhood liquidity note.
4. **Max concurrent positions:** never hold more than `risk.maxConcurrentPositions` open at once; `risk.onSignalAtPositionCap` decides skip vs queue (default `skip` — a queued entry after a delay defeats the speed-edge thesis). Remember each open position also consumes rate budget until it closes.
5. **Daily loss limit / circuit breaker:** track realized P&L for the trading day (`risk.dailyLoss.resetTimezone`, default UTC). Halt all new entries when either `maxRealizedLossPctOfPortfolio` or `maxConsecutiveStopLosses` trips — implement both, either can fire. Log the halt clearly; with `haltRequiresManualReset` it must not silently resume.

## Exit logic (checked continuously against live price, in this priority order)

All thresholds come from `config.json` — see Configuration. Nothing here is hardcoded.

1. **Stop-loss:** sell the entire remaining position if price drops `risk.stopLossPct` from **your** entry fill, not the KOL's. Unset by default; the bot must refuse to start without it.

2. **Tiered take-profit.** The profit target scales inversely with market cap, on the reasoning that a KOL's social reach moves a $100k coin far more than a $10M one. Measure gain against **your entry fill price**, never the KOL's.

   | Market cap at entry | Take profit at | Then sell |
   |---|---|---|
   | < $100k | **+75%** | 25% of remainder every 3s |
   | $100k – $300k | **+60%** | 25% of remainder every 3s |
   | $300k – $600k | **+50%** | 25% of remainder every 3s |
   | $600k – $1M | **+40%** | 25% of remainder every 3s |
   | $1M – $4M | **+30%** | 25% of remainder every 3s |
   | $4M – $10M | **+20%** | 25% of remainder every 3s |
   | ≥ $10M | **do not enter** — see Entry logic |

   Read market cap once, at entry, and **freeze the tier for the life of the position** (`exit.tierSelection: "atEntry"`). A coin that pumps across a tier boundary must not silently retarget mid-trade.

3. **The ladder.** On hitting the take-profit threshold, sell `25%` of the **remaining** position immediately, then another 25% of whatever is left every `3` seconds until the time cutoff sweeps the rest. Decay is geometric — `remaining(n) = 0.75^n`:

   | elapsed | sells | position left |
   |---|---|---|
   | 0s | 1 | 75% |
   | 6s | 3 | 42% |
   | 12s | 5 | 24% |
   | 24s | 9 | 7.5% |
   | 48s | 17 | 1.0% |

   So ~90% is out inside 24 seconds and the tail is dust. `exit.timeCutoffSeconds` is what actually closes the trade — the ladder alone never reaches zero.

   Enforce `exit.ladder.minSliceUsd`: if the next slice is worth less than that, sell the entire remainder instead. Percentage fees (1.0% GMGN platform + 0.3% DEX) are proportional and cost the same whether you exit in 1 slice or 17, but **per-transaction gas is fixed and multiplies with slice count** — roughly $0.012 per sell on Solana, so a 17-slice ladder burns ~$0.20 in gas regardless of position size. On a small position that is the whole edge.

4. **Breakeven stop.** As soon as the initial take-profit sell confirms, raise the stop on the remainder to **true breakeven, not the raw entry price** — entry gas + entry DEX fee + projected exit gas + projected exit DEX fee + `breakevenStop.extraBufferPct`. Observed robinhood fees were ~$0.06 gas and ~$0.076 DEX per trade (`gas_usd` / `dex_usd` on the activity record); on a small position that is a real percentage, and a stop set at the nominal entry price would exit at a loss while reporting breakeven.

5. **Time cutoff:** at `exit.timeCutoffSeconds` after entry, sell whatever remains regardless of P&L.

6. **Simultaneous triggers:** if a single price update gaps through both the stop-loss and the take-profit, `exit.simultaneousTriggerWins` decides. Default `"stopLoss"` — capital preservation outranks profit-taking, and illiquid coins wick through both routinely.

7. **Rate-budget interaction — this is a correctness concern, not a performance one.** A laddering position issues a swap plus order-status polls every `ladderIntervalSeconds`. At a 2s interval that is roughly 1.5 req/s per laddering position against a 10 req/s IP-wide cap; three positions laddering at once consume nearly half the budget while detection and price monitoring still run. Exceeding the cap escalates to a ban that extends 5s per retry, up to 5 minutes — during which **you cannot sell at all**. Exit calls therefore take absolute priority in the shared limiter (`rateLimit.reserveForExits`), and detection is shed first. Never let a ladder tick and a detection poll contend on equal footing.

8. **Self-inflicted slippage.** Each ladder slice sells into the same pool and pushes the price down, so later slices fill worse than earlier ones. On robinhood, where measured liquidity runs 1–2% of market cap, a fast ladder is partly competing with itself. Log realized price per slice so this is measurable rather than theoretical — if late slices consistently underperform the first, lengthen `ladderIntervalSeconds` or raise `initialSellPct`.

9. **Herd collision.** Fixed thresholds mean every bot running similar logic exits at the same number. `exit.takeProfitJitterPct` defaults to 0 to keep the tiers exactly as specified; if fills degrade at the threshold, raise it to spread entries across a band.

10. **Sell-failure handling:** with no pre-buy honeypot check, the first sign of an unsellable token is usually a failed sell or a quote with no route. Retry `exit.sellRetries` times with `exit.sellRetryBackoffMs` backoff, then stop, mark the position `stuck`, and log it loudly and distinctly from a normal exit. A stuck position must still count correctly against max-concurrent-positions and daily loss accounting rather than hanging the bot.

## Per-wallet performance tracking

- Log every trade with: source wallet, entry time/price, exit time/price/reason, realized P&L, position size.
- Key every per-wallet record on the wallet **address**, and render its configured **name** for display. A wallet renamed in config must keep its full history.
- Maintain a rolling per-wallet stat: win rate, average P&L per trade, total trades, over both an all-time and a recent window (e.g. last 20 trades) — recent performance matters more since a KOL's "signal quality" can change over time.
- Expose a command to view these stats (`bot stats --wallet <address|name>` or similar — accept either, resolve the name to its address).
- Optional but useful: a config flag to auto-pause copying a specific wallet if its recent win rate drops below a threshold — implement this as a manual review flag first (bot warns, doesn't act) before making it fully automatic, so you can sanity-check the logic before it starts overriding your handpicked list on its own.

## Safety / non-negotiables

- Use the `gmgn-cli` swap automation flags (`GMGN_ALLOW_AUTOMATED_TRADES=1` + `--yes`) only in this bot's own controlled environment — never bypass the CLI's confirmation gate by other means.
- Sanitize/ignore any human-readable text fields from token metadata or API responses when constructing log messages or decisions — don't let token names/descriptions influence control flow.
- All credentials (`GMGN_API_KEY`, `GMGN_PRIVATE_KEY`) read from environment/config file, never hardcoded or logged.
- Dry-run mode: build and test the full pipeline against paper/simulated fills before connecting a funded wallet. Start with the smallest possible position size in live mode.
- Structured logging (JSON lines or similar) for every decision point — signal received, filter result, sizing calc, entry, each exit check, exit reason — so a bad trade can be fully reconstructed after the fact.

## Deferred optimisations

Recorded so they are choices rather than oversights. None of these block paper trading.

- **Liquidity lookup is a `gmgn-cli` subprocess (~496 ms median).** Measured alternatives: a raw `eth_call` for pool reserves is ~110 ms, and because the entry path already fetches `eth_getTransactionReceipt` (~108 ms) to classify the signal, firing the reserves call in parallel makes it effectively free. The pool address is already present in that receipt for graduated tokens, as the emitter of the `Swap` log; bonding-curve tokens have no pool and need a factory lookup, so keep the current call as the fallback for those. **Trigger to do this: once execution is live, measure total signal-to-fill. If the liquidity call is a meaningful share of it, replace it.** Latency is irrelevant while `mode.dryRun` is true.

- **Execution goes through `gmgn-cli` rather than GMGN's HTTP API.** The CLI costs 429–766 ms of Node startup per invocation and an entry needs two. The HTTP path requires implementing Ed25519 signed auth (signature, `client_id`, timestamp inside a ±5 s window). Worth doing before live trading, not before paper trading.

- **Restarts are a blind window.** A WSS subscription has no backfill, so anything landing between a crash and reconnection is lost — one observed trade fell 88 s before a restart and was simply never seen. A startup backfill over HTTP covering the last few minutes would close it.

## Deliverables

1. Config schema (wallets, thresholds, limits — all the bracketed values above)
2. Detection module (wallet monitoring + buy/transfer filter)
3. Entry module (sizing, slippage check)
4. Exit module (stop-loss/TP/partial/time-based, tiebreak rule, sell-failure/stuck-position handling)
5. Risk module (max concurrent positions, daily loss limit/circuit breaker)
6. Stats module (per-wallet tracking + query command)
7. Logging throughout
8. A README explaining how to configure and run it, including the dry-run flow

Ask me for any of the bracketed values you need before writing code, rather than guessing defaults for the ones that materially affect risk (stop-loss %, daily loss limit, max concurrent positions).

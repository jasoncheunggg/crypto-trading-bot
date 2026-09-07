# Scalper — working state

Last updated 2026-09-03. Read this first after a context reset.

## What this is

Copy-trading scalper. Watches 11 KOL wallets on **robinhood** and **bsc**, detects FOMO
buys, copies them, exits on a market-cap-tiered take profit, a stop, or a time cutoff.
Detection via Alchemy WSS. Execution via `gmgn-cli`. Currently **paper only**.

## Run it

```
nohup caffeinate -dimsu node --experimental-strip-types src/index.ts >> state/runner.log 2>&1 &
```

`caffeinate -dimsu` keeps it alive with the lid closed **on AC power only** — on battery a
lid close sleeps the machine and stops the bot. Verified over a 40-minute clamshell test.

## Current config (and why)

```
tiers        under $100k +80% | $300k +55% | $600k/$1M/$4M +30% | $10M +20%
stop         -20%      executes nearer -26%: price gaps past the line, ~6pt overshoot typical
cutoff       420s ±60s
ladder       100% single slice
sizing       15% of available, compounding, max 3 concurrent, $200/chain start
slippage     55% under $600k mcap, 25% above
min trade    $950 (FOMO takes ~0.3% before the observable leg, so a $1000 buy shows ~$997)
fees         1.0% platform + 0.3% dex + $0.525/swap gas
breaker      -25% in 24h | 5 consecutive losses | 80 trades/24h | $60 position cap
```

**Ladder is 100% because of gas.** Gas is flat per swap (~$0.48), so an 8-slice exit paid it
9 times. Replayed over 115 trades: 25% slices netted −2.86%, 100% netted +11.02%. Gross
return barely moved (+15.3% to +17.6%), so the ladder was buying almost nothing even before
fees. Lower it again when positions are large enough that gas is under ~3% (roughly $100+).

**Slippage is loose below $600k** because the gate's premise — a wide gap means the move
already happened — fails on small caps where the tracked wallet's buy *is* what moves it.
11 gate rejections on record; 10 would have reached take-profit, 0 would have stopped out.

**80 trades/24h is too tight** (busiest real day was 64). Raise to ~150 or drop it; the loss
limit is the condition that matters.

## Hard-won facts

- **GMGN prices are usually right, occasionally catastrophic.** 787 paired samples: median
  2.4% off chain truth, but 0.4% are >50% wrong. Fine for watching, fatal for deciding.
- **Chain-derived prices can also be wrong** — not from bad arithmetic but bad pairing.
  A transaction with one token leg and four identical $4 money legs produced a price 3.2x
  too high. Multi-hop routing means money and tokens move between *different* intermediaries,
  so there is no structural way to tell "one trade, four hops" from "two trades bundled".
- **Therefore: bound every price against a rolling median of the last 7** (3x band), verified
  and quoted alike, with an escape valve (3 mutually-consistent readings adopt a new level) so
  a real crash still trips the stop. Three separate mispricing bugs came from applying this
  inconsistently across paths.
- **verifyPrice is good but not safe on one sample.** Over 1,484 verified samples the median
  is 0.999x the surrounding feed (unbiased), p99 1.19x — but **0.40% come back >1.5x off**,
  about one lookup in 250. Every mispricing incident traces to that single bad lookup being
  believed. Hence QUORUM=3: three candidate transactions, median wins.
- **Cross-checking the A/B arms against each other does NOT work as a price guard.** Over 53
  crossings the arms landed on the SAME transaction **58.5%** of the time and returned an
  identical price, so they agree on a bad price more often than not. Worse, they agree most
  at the moment of an action, when they fire simultaneously off a shared feed cache. The
  independence that matters is **between transactions, not between observers**. (The polled
  feed price is even more useless for this — `pricepath.ts:66` has a 1s cache AND in-flight
  request collapsing, so arms receive literally the same number: measured 0.00% difference
  at p99 over 2,019 matched pairs.)
- **A fill above the position's own peak is fiction.** Over 338 recorded slices the highest
  legitimate fill is 1.0933x of the observed peak and the lowest fabrication is 1.2614x, with
  **nothing in between** — every threshold from 1.10x to 1.25x rejects the same 2 fills, both
  known fabrications (+85.6% and +143.3%), zero false positives. Guard set at **1.17x**, mid
  band: the lower edge is well measured (n=336) so headroom matters there, the upper edge is
  n=2. Revisit if a legitimate fill ever lands above 1.09x — costs are asymmetric (a rejected
  fill only falls back to the ~2.4%-less-accurate feed; a missed fabrication books 26-55%).
- **The guard is deliberately upside-only.** Across 10 recorded stops not one filled below
  the observed trough — `confirm()` updates the trough with the very price that trips the
  stop — so a downward guard never fires on real data, and the only thing that could trip it
  is a genuine crash, which is exactly when refusing to sell is worst. The upside guard works
  only because the ladder's fill is a SECOND lookup that never feeds back into `peak`.
- **gmgn's backend refreshes every ~0.9-2.1s**, so the 1s price cache is matched to the
  source, not arbitrary. Reading faster returns a COPY of the same number — 8 calls at 430ms
  apart gave 3 distinct prices — and a copy agreeing with itself reads as confirmation. Any
  "check it again" scheme must wait for the value to CHANGE, never for a fixed delay.
- **The stop side is protected by TIME instead**: a stop below 0.70x the pre-tick reference,
  or below 0.85x on a single-sample verification, holds until the feed price actually moves
  (cap 2.5s) before selling. Once per stop event, never twice. All 11 recorded stops filled between 0.770x and
  1.001x, so none would have been delayed — LNKS filled at 1.001x because a real collapse
  looks like a LEVEL, not a gap. Waiting measured near-free: price 1.4s after a stop fill was
  median +1.72%, mean +0.14%, with 2 of 10 bounced >5%.
- **Alchemy free tier**: `eth_getLogs` capped at 10 blocks; ~10 req/s throughput cap;
  no Solana WSS (`logsSubscribe` → Method not found). Public Solana RPC does work.
- **Chain-wide WSS log subscriptions cost ~40M CU/hour** — a month's budget in 45 minutes.
  Never subscribe to an asset chain-wide. Wallet-filtered subscriptions are ~2,400 CU/hour.
- **`alchemy_getAssetTransfers` exists and works** — far cheaper than scanning `eth_getLogs`
  for wallet history.
- **Gas is invisible in settled amounts.** It is paid in native currency, so the USDG proceeds
  of a sale read identically whether gas cost $0.40 or $4. Percentage fees (1.0% platform +
  0.3% dex) ARE already inside the settled output. So live P&L deducts gas explicitly and must
  NOT re-run the paper `net()`, which would charge the percentages twice. Live now reads
  `gasUsed x effectiveGasPrice` from each receipt; `entryGasUsd` is stored on the position so
  the exit can charge the real buy-side figure.
- **Re-measured 2026-09-03, our own 4 swaps: $0.5046/swap average** (~440k gas at 0.46 gwei) —
  the configured $0.525 is accurate within 4%. But tracked wallets' swaps in the same window
  cost $1.74-$3.08 (667-808k gas at 0.85-1.83 gwei), so gas price varies 4x and routing depth
  varies 2x. The receipt beats the constant whenever it is available.
- **Real gas measured over 4 live swaps**: ~445k gas at 0.46 gwei = **$0.48/swap**,
  **$0.96 round trip**. Gas price is already at base fee; the cost is high gas *usage* from
  multi-hop routing (14 logs/tx vs ~150k gas for a plain V2 swap).
- **Live swap latency ~2.4–2.5s**, dominated by GMGN's submit pipeline, not the chain
  (0.1s blocks). The quote returns a signable `tx` payload, so self-signing would cut this to
  ~700ms — deferred because it needs the private key in-process.
- **BSC has never produced a single trade** in 4 days. 63 buys detected, all rejected: not via
  a FOMO router and/or under $950. Effective capital is robinhood-only.
- **Stops mostly do not recover**: of 14 stopped positions, 4 would have been profitable at
  the cutoff, 10 would have been the same or far worse (two reached −61% and −68%).
- **Continuous sizing beats a daily-refreshed balance, and is also more predictable.** Over
  3,000 shuffled orderings of 134 recorded trades from $200 at 15%: continuous returned
  $3,397 in EVERY ordering (compounding is commutative, so sequencing cannot change it),
  daily returned $1,510-$1,659. Daily does cut typical drawdown (p50 12.8% vs 17.2%) but the
  tail is no better (worst 37.9% vs 35.8%) — after a bad morning a stale basis keeps betting
  the pre-loss size. So: sizing continuous, breaker on a **once-a-day anchor**, which is a
  different question ("how far down am I today") and needs a fixed denominator or a slow
  bleed never trips it.
- **Quietest hours are 08:00-10:00 UTC** — zero entries across the whole sample, and the bot
  was verifiably running then (116/248/178 log lines). Busiest is 17:00-22:00 UTC.
- **A/B tested and rejected**: a 60s minimum hold before profit-taking. Backtest predicted
  +36 points; live A/B on identical trades gave ~0 at both 60s and 30s, with one −78% outlier
  where the twin held through a reversal the live arm had banked. Backtests that replay only
  trades which already laddered select for exactly the cases where holding looks good.


## Gas — the thing that changed everything (2026-09-03)

Robinhood Chain fee revenue went from **$56k/day on 23 Aug to $3.75M by 1 Sep** — an 82-fold
jump in eleven days, caused by memecoin traders flooding the chain. That is the same activity
this bot trades, so the strategy is paying a toll it helps create.

- Measured swaps ranged **$0.14 to $2.72** on the same day. `gasUsdPerSwap: 0.525` in config
  was accurate on 1 Sep and half-wrong by 3 Sep. **Never trust it as a constant** —
  `src/gas.ts` reads `eth_gasPrice` live (Alchemy, free, 60s cache) and the config value is
  only a fallback.
- Gas USED varies 3x with routing depth, and the driver is whether the token has a direct
  USDG pair:
  ```
  7 legs   ~366k gas    memecoin -> USDG          direct
  19 legs  ~1.04-1.14M  memecoin -> WETH -> USDG  extra hop
  3 legs   ~178k gas    USDG <-> WETH             pure pair
  ```
- **OPEN QUESTION**: trading in WETH instead of USDG would avoid that extra hop on the tokens
  that need it (2 of 5 observed sells were direct USDG, 3 went via WETH). Rejected once
  already because ETH-denominated capital puts price beta into the breaker anchor and the
  tier stats, and `inputAmountRaw` would need a USD->ETH conversion at 18 decimals. Revisit
  with a real sample of what fraction of signals have a direct USDG pair.
- At $23 positions, breakeven is +7.9% at $0.56/swap and **+14.8% at $2.72/swap**. Four of six
  tiers target +20-30%, so in congestion the edge is mostly gas. Position size is the only
  lever that fixes this: gas is 4.7% of a $23 round trip and 1.2% of a $100 one.


## Diagnostics: no gmgn calls while a LIVE POSITION IS OPEN

GMGN rate-limits at **5 req/s per IP**, shared between the bot and any diagnostic command run
from the same machine. With the book FLAT it is fine to query; with a position open it is not,
because a rate limit lands on the exit. On 2026-09-04 a ~90-token security/holder scan run during live trading
blocked a confirmed take-profit for 31 seconds: it had confirmed at +32.91% and sold at
+14.54%, costing **$3.87 on one trade**. Earlier the same night, retries into a rate limit
escalated to a five-minute ban that stranded a position through its cutoff.

Everything below is Alchemy (separate quota) and should be used instead:

| need | use |
|---|---|
| balances | `tokenBalance` / `tokenBalanceRaw` (`reconcile.ts`) |
| price | `verifyPrice` (`verify.ts`) — derived from chain swaps |
| receipts, gas, reverts | `eth_getTransactionReceipt` |
| transfer / trade history | `alchemy_getAssetTransfers` |
| symbol, decimals, supply | `eth_call` on the contract |
| pool reserves | `eth_call` balanceOf on the pool |
| gas price | `eth_gasPrice` (`gas.ts`) |

Only quotes, order status and gmgn's security/holder metrics require gmgn. Wait for a stop.


## Live trading — first session, 2026-09-03/04

**22 trades, 11W/11L, net +$42.07.** Wallet $200 -> $232.55. Absorbed one total-loss rug
(-$24.69) and a self-inflicted $3.87 (my own gmgn queries rate-limited a confirmed exit).

Numbers worth keeping:
- **Gas is 76% of net profit.** $31.77 across 46 swaps against $42.07 net; $0.691 avg,
  $0.787 median, range $0.158-$2.721. At $25 positions that is 5.8% per round trip. **Position
  size is the only lever** — the same trades at $100 would have cleared ~$170 not $42.
- **Fills land ~7 points below the market 2s later, on 8 of 8 trades.** Stops overshoot 8.5-14.5
  points (a stop decided at -25.24% settled at -34.51%). Both are the ~2.5s submit-and-mine
  window. Self-signing (~700ms) is the only real fix and would pay on both sides.
- Capture ratio on take-profits is ~72-80% of peak. Any tier should be read as `x0.72`.
- Only 4 of 22 trades reached their tier target; 11 peaked above +40%, 11 barely moved. The
  distribution is bimodal, which is why HIGHER targets beat lower ones — there is almost
  nothing between +20% and +35% to give up.

**Staged but never run** (take effect on next start): $300k-$600k tier +30 -> +35, stop recheck
skipped at full quorum, chain fallback 8s -> 6s, bsc removed from detection.chains.

**Never fired in live trading**, still unproven: excursion guard, concentration gate, rug
detection, feed-silence fallback, min-output rejection, auto gas top-up (`risk.autoGasTopUp`,
default OFF).

**Proven in live trading**: the balance clamp (24 saves, ~$12-14 of gas not burned on tokens
already sold by hand) and the stuck-position fix (kept ~$40 of fiction out of the breaker).

## Files

```
src/index.ts        runner: signals -> entry -> exit, A/B twins, resume, breaker
src/detector.ts     Alchemy WSS, wallet-filtered Transfer logs, per-chain reconnect
src/classifier.ts   buy vs receive. THE rule: a purchase costs money, a transfer does not.
                    Uses maxSingleQuoteTransfer — never sum, multi-hop double-counts.
src/entry.ts        gates: verdict, router, size, mcap, liquidity, reentry, slippage
src/exit.ts         stop / take-profit ladder / cutoff, chain-verified crossings,
                    rolling plausibility band, per-slice verification
src/verify.ts       verifyPrice() — chain price from recent trades, 6 windows, 3x bound,
                    median of 3 candidate transactions (QUORUM), reports `samples`
src/swapprice.ts    live WSS price feed — BUILT BUT DISABLED (livePriceFeed.enabled=false)
                    because it cost 40M CU/hour
src/pricepath.ts    per-trade price recording, ~1/s, verified anchors every 90s
src/replay-exit.ts  counterfactual replay for tuning; defaults read from config
src/portfolio.ts    compounding paper balance = start + realised − capital in open positions
src/positions.ts    position store; entryTxHash/entryOrderId/partialFill for live
src/breaker.ts      circuit breaker + hard position cap, read from the ledger not memory
src/balance.ts      real wallet balance swept every 30 min (off the entry path) + the
                    once-a-day anchor the breaker measures against
src/live.ts         executeSwap() + attemptEntry() — REAL MONEY, three gates, not wired in
src/reconcile.ts    tokenBalance (native + ERC20), reconcilePosition, entryReceipt
src/cu.ts           Alchemy CU accounting, persistent monthly ledger, 5M cap
src/ab-report.ts    A/B report incl. control-arm noise floor
```

## Live trading — status

```
DONE   manual round trip proven (2 buys, 2 sells, real money)
DONE   executeSwap() — submits, confirms via receipt AND wallet balance, both directions
DONE   attemptEntry() — classifies outcomes by whether a rebuy is SAFE
DONE   startup reconciliation — chain vs positions.json, wired into resume
DONE   circuit breaker — wired into every entry
TODO   wire executeSwap into index.ts  <- last step, where money starts
TODO   fund the wallet (~$14 on robinhood; $200 needed for $30 positions)
```

**Retry rule**: rebuy only when both chain checks agree nothing landed (no receipt AND no
balance movement). Anything ambiguous — revert, timeout, unreadable response, guard refusal —
is `error` and must never be retried. A rebuy after a swap that actually landed doubles the
position with nothing recording the first half.

**Partial fills** (under 95% of quote) are kept and managed as normal positions, flagged
`partialFill`. Unwinding costs another swap's gas and locks in a loss on a position that may
still work.

## Gates protecting real money

```
mode.dryRun                    true       config.json
mode.logOnly                   true       config.json
GMGN_ALLOW_AUTOMATED_TRADES    unset      gmgn-cli refuses without it
.claude/settings.json          gmgn-cli swap -> ask
```

## Wallets

Real: `${WALLET_ADDRESS}` (evm),
`Fx3zoY1My2smQP7HMhLS8chShwcqWtNesSLqFY1tBDQt` (sol).
Tracked wallets in `wallets.json`, keyed by address so renames preserve stats.
Best performers by a distance: @orangie, @lizzerd, @econoar.

## Open threads

- Wire `executeSwap` into the runner (the last build step). When wiring: live P&L must come
  from the settled order report (`live.ts:64`) and the wallet balance delta (`live.ts:97`),
  NOT from the exit loop's `fills[]`. Otherwise the paper fill-pricing problem follows you
  into live reporting. In live mode the fill price is read, not estimated.
- QUORUM cost is **measured**: +200ms and +100 CU per lookup, hit rate unchanged, and only
  ~half of lookups actually reach 3 candidates (the rest answer with 1-2, reported in
  `samples`). First batch was widened to 3 windows because a 1-window first batch fell
  through to all six almost every time (531 CU / 3.2s vs 336 CU / 1.2s).
- Consider raising `UNVERIFIABLE_LIMIT` (now 3, was 5) or making it time-based. It is the
  give-up path that acts on an unverified feed price — it fired twice, both stops, and in the
  LNKS case it was CORRECT (the coin really had died). Tuned toward acting; the risk is a
  broken feed on a healthy coin.
- Partial-fill reconciliation path is written but never exercised
- Should the market-cap tier bands be redesigned? Four of six now carry +30%, so the
  boundaries do little. Needs several more nights before it is more than a guess.
- Solana: 6 of 11 wallets active, ~14 qualifying buys/24h, but Alchemy has no Solana WSS.
  Deferred by choice.
- FOMO API (`api.fomoapi.io`) works for manual wallet research; leaderboard is keyless.

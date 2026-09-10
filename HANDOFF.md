# HANDOFF — v2.0 copy-trading scalper

Written 2026-09-10. Branch `v2-0x-router`. If anything here contradicts the code, the code wins
— but read the *reasoning* here before changing it, because most of these numbers were paid for
with real money.

If you need detail this file omits, the full session transcript is at
`~/.claude/projects/-Users-jasoncheung-Documents-scalper/76d297c9-6b08-4777-bdd4-a961682f1c26.jsonl`.

---

## 1. What this is

A memecoin copy-trading bot on **Robinhood Chain (4663)**. It watches 13 tracked KOL wallets via
Alchemy WSS, detects when one buys through the FOMO router, and mirrors the trade with its own
capital — entering within seconds, then managing the exit on a market-cap-banded take-profit,
a -20% stop and a ~420s time cutoff.

**v1.0 → v2.0 was a rewrite of the execution layer, not the strategy.** The strategy is unchanged.

---

## 2. Current state

```
branch      v2-0x-router (not merged to main)
bot         running under `caffeinate -i -s`, ~11h uptime
dashboard   http://127.0.0.1:7777
wallet      0x2E59433dcd600ac180f533AE48a99891f57684E5  (self-custody, key in .env)
balance     ~$236 native ETH
net P&L     +$38.21 over 76 live trades (gross $182.31, gas -$82.14, unrecorded losses -$61.95)
```

Live config: `fixedPositionUsd=null` (15% rule → ~$34), `maxConcurrent=2`, `stopAfterTrades=null`,
slippage 2%, ceiling $7M, minTrade $950, gasReserve $8, `dryRun=false`, `logOnly=false`.

**Trading is armed only when `BOT_ALLOW_AUTOMATED_TRADES=1` is in the environment.** It is not in
`.env` — it is passed on the launch line, deliberately.

---

## 3. Architecture, and why

### v1.0 was GMGN for everything
Quoting, routing, signing, submission. GMGN held the private key. On 2026-09-05 they repriced
their `swap` endpoint so that a single call exceeded the plan allowance — every request 429'd
instantly, from 5 IPs across 3 countries. **The bot could not trade at all**, because no quote
meant no price, no tier, no min-output and no calldata. That single point of failure is what
v2.0 exists to remove.

GMGN's **data** endpoints were unaffected and still work.

### v2.0 stack
```
detection    Alchemy WSS  →  classifier.ts
pricing      0x Swap API v2 (api.0x.org, chainId 4663)
security     gmgn token/security  (top-10 holders, sell tax)  ← data endpoint only
liquidity    gmgn token/info      (pool liquidity, market cap)
signing      viem + BOT_PRIVATE_KEY, local nonce, eth_sendRawTransaction via Alchemy
trading asset NATIVE ETH
```

### Why 0x over LiquidSwap
Measured against GMGN's price on all 54 tokens with a reference: **0x accurate within 15% on
48/54 and routed all 54; liqd 25/54 with six 404s.** liqd's failure was routing *coverage* — it
indexes fewer venues and silently fell back to bad pools, quoting CHROME at 332x where 0x found
a Uniswap_V3 route at 0.79x. Re-tested over all 112 robinhood tokens ever traded: 0x buys
112/112, round-trips 111/112.

Costs: 0x needs an API key (~5 rps) and takes **15 bps** vs liqd's none — but GMGN took **200 bps**.

### Why native ETH (not USDG, not WETH)
Measured 2026-09-08 — all three cost the *same* to trade:
- native vs WETH: identical output to the wei, +$0.016/round trip in gas
- native vs USDG: 96.21% vs 96.39% median retention over 16 tokens (inside per-token noise)

So the choice is **failure modes, not fills**. Native makes *"rich in the trading asset but out
of gas, so cannot SELL"* unreachable by construction. That state stranded a position on 09-04.
`gastank.ts` was deleted rather than rewired, because the routed USDG→ETH swap it protected no
longer exists.

Cost accepted: idle capital is exposed to ETH price (~±2%/day). Symmetric and zero-mean, versus
an unsellable position which is -100% and permanent.

### Why NOT a "USDG mode / ETH mode" switch
Considered and rejected. **40% of buy signals carry BOTH a USDG and a WETH leg** (755 USDG-only,
5 WETH-only, 500 both) — a routed FOMO buy carries the same money twice, so the currencies aren't
alternatives to switch between. And an ETH mode would still need the conversion, since every
threshold in config is denominated in dollars. See §4.

---

## 4. THE bug class — read this before touching anything money-related

**One assumption caused every serious bug in this project: that a quote asset's units are
dollars.** True under v1.0's USDG (1 unit = $1). False under native ETH. It surfaced *five*
times and looked like a different bug each time:

| where | symptom |
|---|---|
| `readLiveBalance` | reported 0.00099 ETH as "$0.00099"; would have sized every position at 1/100 of a cent |
| `costUsd` / proceeds | recorded a $5.19 entry as **$0.00**, corrupting entry price, stop, price feed and sell floor, and stranding a position |
| `verifyPrice` | could not price a non-USDG swap at all, so misprice protection silently degraded to the unverified feed on 1,276 signals |
| the take-profit floor | encoded $35.35 as `35.35e18` and compared it to an ETH payout — **2,500x too high**, so no take-profit could ever execute. Cost a +32.7% winner |
| gas in the measured legs | the traded asset IS the gas asset now, so the balance delta captured both; gas was counted up to **three** times |

### The fix: `src/money.ts`
There is now **one** place a quote-asset amount becomes dollars:

```ts
legUsd(rates, asset, raw) -> number | null
usdRates(chain)     // from config's explicit `priceSource: "dollar" | "native"`
```

Threaded through all five sites that turned a leg into money: `classifier.ts`, `verify.ts`,
`swapprice.ts` (×2), `live.ts`. **`isSizingAsset` no longer governs any pricing** — it survives
only as a log marker and an address lookup.

`legUsd` returns **null**, never 0, when a rate is unknown. *"Could not price this"* and *"worth
nothing"* lead to opposite decisions, and conflating them is what let a $1,420 airdrop read as a
$0.00 buy.

**Sizing prefers the dollar leg** when one exists. Taking `max()` across legs sized 18 of 70
historical buys off the routing hop instead of the payment, moving them ~1.5%.

### If you add a chain, an asset, or any dollar↔raw conversion
Run `tools/test-units.ts`. It tests the *assumption* across every live trade, not the five
symptoms. It also asserts the shipped bug is caught: encoding a dollar figure directly asks
~2,489x too much.

---

## 5. Every other significant bug found (and how)

Ordered by how they were found, because the pattern matters: **almost none were found by
tests. They were found by running the thing and looking at two numbers that should agree.**

1. **Entry aborted on a good trade.** The entry path made *three* sequential 0x calls; the
   min-output floor was measured against call #1 and validated against call #3, ~2.3s later.
   Fixed by broadcasting the quote the gates approved (`swapTxFromQuote`), which also removed
   two round trips. `quote()` already returns signable calldata — `buildSwap()` had been written
   in Phase 1 and never wired up.
2. **Missing token approval.** Approving WETH lets you *buy*; every token bought needs its own
   approval before it can be *sold*. Found on the first live round trip — the buy filled, the
   sell reverted in simulation. Would have stranded **every** position. `ensureAllowance` now
   guarantees it, and the bought token is approved right after entry so the exit never pays for it.
3. **False BUY signals.** The classifier counted the largest quote-asset transfer *anywhere* in
   the receipt, without asking whose it was. A stranger buying a token and airdropping it to a
   KOL wallet read as the KOL buying. Found via the 8Stock honeypot bait (§7).
   **The obvious fix — require the wallet to be a party to the payment — is WRONG and was checked
   before being written**: under FOMO the wallet is *never* a party (FOMO's relayer pays). That
   rule would have reclassified every genuine buy as RECEIVED and ended all detection. What
   shipped: a leg counts if a **known router** executed it **or** the wallet is a party.
4. **`nativeUsd` returned $3,350 for $2,512 ETH.** `nativeUsdFromChain` divides the largest WETH
   leg of one receipt by its largest USDG leg — on a split route those aren't the same money.
   The only guard spanned 100x. Now **corroborated: 0x against gmgn, agree within 2% or hold the
   last good price**. Chain-derived survives only as the last resort (it's the only source that
   answers when both APIs are down). Testing the disagree path exposed a second flaw: probe
   functions were writing the cache, so "holding last" held the probe's own answer.
5. **Positions abandoned before their cutoff.** `SELL_ATTEMPT_LIMIT = 12` (~25s) exists for a
   token that cannot be sold *at all*. A take-profit that won't fill at its floor is different —
   it can be sold, just not at that price, and the cutoff would drop the floor minutes later.
   Treating them identically abandoned a position at 288s with its cutoff at 479s. Now: on
   exhausting the budget, **drop the floor and try once at market** before giving up.
6. **Dashboard showed a frozen snapshot.** `positions.ts` does `let positions = load()` once at
   import. The dashboard is a *separate process*, so it saw whatever was on disk when it started.
   A position ran 412s with the OPEN panel empty. Now reads from disk every request.

---

## 6. Config values that were bought with evidence

Do not change these on a hunch. Each note in `config.json` records the measurement.

| setting | value | why |
|---|---|---|
| `swapSlippageTolerancePct` | **2%** | Was 5% for GMGN, which applied it to *their* re-quote across a seconds-long gap. Under 0x the tx is frozen at quote time and simulated before broadcast, so exposure is one block (0.094s). Verified `buyAmount` is identical at 0.5/1/1.5/2/5% — slippage sets only the floor, never the price |
| `marketCapCeilingUsd` | **$7M** | Narrowed from 10M on operator judgement. **Rejects 59% of all buy signals** — it is by far the biggest filter |
| `maxSlippagePctByMarketCap` | 55% below $600k | 11 gate rejections scored: 10 would have reached take-profit, 0 would have stopped out |
| `MIN_FILL_RATIO` | 0.92 | No longer the binding floor — 0x's own minBuyAmount at 2% is tighter. It survives to bind the **re-quote path** when a prebuilt quote goes stale |
| `gasReserveUsd` | **$8** | Gas and capital are the same asset now, so this is the only thing stopping a position spending the money needed to exit it. ~65 swaps at measured cost, but sized for a *spike* (gmgn-era routing hit $2.72/swap) |
| `GAS_UNITS` / `WORST_GAS_LIMIT` | 200k / 1.3M | Recalibrated from gmgn's deep routing (700k / 2.25M). Real v2.0: 173,790 gas buy, 143,679 sell. The old value inflated breakeven by 2.6 points on a $30 position |
| security gates | sell_tax >50%, top-10 banded 38%/50%, bytecode 13k | Scored against realised P&L: these block **-$24.66** and pass **+$125.68** |

**Never gate on `is_honeypot` or `is_show_alert`.** Measured over 55 tokens: `is_honeypot` fires
on 9 including the two best trades ever (+$41.88, +$54.16) and would cost **$76.58**.

---

## 7. Things that will confuse you

### The 8Stock bait pattern
Someone creates a token, buys it themselves, and **airdrops it to influencer wallets** so
copy-trading bots see "KOL bought this". 8Stock was 7 minutes old, 74.7% held by ten wallets,
flagged a honeypot, and ran 4,491% on the bots that took it. Your bot correctly refused it —
`requireKnownRouter` is the defence that fired, with the $950 minimum as an accidental second
layer. This is why §5.3's fix matters.

### 88% of pre-09-09 "BUY" signals were not buys
Replaying 60 signals logged as BUY on 09-03 through today's classifier: **7 still BUY, 53 now
RECEIVED**. The historical trade rate (36 trades on 09-04) is **not a baseline to expect**.
Three to seven real trades a day is closer to the truth.

### The dashboard's P&L is not the trade ledger's sum
`stuckRecord()` zeroes P&L on abandoned positions so they can't book an imaginary loss and trip
the breaker — correct for the breaker, wrong for a headline. Two positions put in $61.96 and
returned $0.00 while booking zero. The dashboard nets that out as **"unrecorded losses"**.
Ledger says +$98.43; truth is **+$38.21**, and even that is a ceiling (excludes gas on failed
txs, wrap/unwrap round trips, and $8.73 stranded on Ethereum mainnet).

### GMGN cannot sell
Their swap endpoint exceeds the plan allowance and 429s instantly. Selling by hand goes through
**Axiom**. Their data endpoints work fine and the bot still uses them.

---

## 8. Tools

```
tools/status.ts          terminal snapshot: wallet, open, stuck, orphans, realised
tools/ui.ts + ui.html    dashboard on :7777 — READ ONLY, separate process
tools/regress.ts         5 cases vs recorded history
tools/test-units.ts      the unit-mismatch suite (§4) — run after ANY money change
tools/test-legusd.ts     the money boundary
tools/compare-v1v2.ts    v2.0 judged against v1.0's own record
tools/backfill-gas.ts    pulls gas from gmgn activity into trades.jsonl (idempotent)
tools/setup-wallet.ts    status / wrap / unwrap / approve  (--confirm arms THIS process only)
tools/phaseB-simulate.ts a full entry simulated against live state, no broadcast
tools/phaseB-swap.ts     a real round trip
tools/phaseB-sell.ts     sell a holding through the v2.0 path
```

**Dashboard rules** (keep these): never writes to `state/`; never competes for API budget
(balance and marks cached 15s); imports the bot's own modules rather than reimplementing them.
`UI_STATE_DIR` points it at a copy for testing. `UI_HOST` beyond localhost **refuses to start
without `UI_TOKEN`**.

---

## 9. Running it

```bash
# bot — caffeinate stops macOS idle-sleep suspending it mid-position
BOT_ALLOW_AUTOMATED_TRADES=1 caffeinate -i -s node --experimental-strip-types src/index.ts

# dashboard
node --experimental-strip-types tools/ui.ts

# phone access (LAN or Tailscale)
UI_HOST=0.0.0.0 UI_TOKEN=something node --experimental-strip-types tools/ui.ts
```

`caffeinate` does **not** override clamshell sleep — closing the lid still stops it.

Breaker: `-20%` of a daily anchor, 5 consecutive losses, 120 trades/window, $60 per-position cap.
Halts **entries only**; exits always continue. Clear with `clearBreaker()` — but check *why* it
tripped first. It once tripped on 5 losses spanning four days and three code versions, two of
which were bug artifacts rather than market outcomes.

---

## 10. Open items

**Blocking nothing, ordered by value:**

1. **The $7M ceiling is the real strategy question.** It rejects 59% of signals. The 7M–10M band
   produced +$11.91 over 3 trades (mean +8.6%) vs 8.0% for 4M–7M — nearly identical, n=3.
   Replaying what the 1,522 above-ceiling signals would have returned under the tier rules turns
   this into a measured question. That's the same method that set the 55% slippage band.
2. **Solana.** 76 qualifying buy signals over 22 days from the same wallets (~3.5/day, a third
   more flow than Robinhood). Needs a non-Alchemy provider (Helius) and a non-EVM signer —
   a v3 project, not a config change.
3. **Telegram bot** for push alerts. Would reuse the dashboard's `/api/state`.
4. **Hosting.** Latency is *not* the reason — measured 141ms Alchemy / 274ms 0x warm, of which
   only ~37ms is network. A VPS or Pi buys **uptime**, not speed. Pi is now the better call.
5. **Base / BNB.** 0x supports both; the code is two one-line additions. But BNB is not ETH (gas
   token differs), and the signal flow doesn't justify it: over 22 days, robinhood 21 qualifying
   buys, bsc 1, base 0. BSC was already tried and removed on 09-04.
6. Two v1.0 `stuck` positions remain as bookkeeping; no value at risk.
7. The shadow/live pricing gap — shadows are marked at feed prices while live gets real fills,
   which likely biases `ab-report.ts`. Seen once (-29.23% vs -8.73%), n=1.

---

## 11. How to work on this

The pattern that actually found bugs here:

- **Put two numbers that should agree next to each other.** The ETH-as-dollars bug surfaced
  because a balance card showed `$236` next to `0.072 ETH`. The `for $0` entry log exposed the
  cost-basis bug. Neither was caught by a passing test suite.
- **Test the failure path deliberately.** Forcing the price-agreement threshold to zero exposed
  a cache side-effect. Disabling the liquidity floor exposed that the round-trip probe cannot
  see a transfer tax.
- **When a test fails, check whether the test is wrong before changing code.** `test-units.ts`
  check 5 failed on 7 trades; all were `stuck`/`rugged`, where P&L is deliberately special-cased.
  Nearly "fixed" working code to satisfy a bad assertion.
- **Verify a fix before shipping it.** The classifier fix that would have killed all detection
  looked obviously correct.

Commit messages in this branch carry the measurements. `git log` is the real design document.

# scalper

A copy-trading bot for Robinhood Chain (EVM, chain id 4663). It watches a set of tracked
wallets, and when one of them buys a token the bot decides — in about a second — whether to
buy the same thing, then manages the exit on a fixed clock.

Self-custody: the bot holds its own key and signs its own transactions. Swaps route through
the [0x Swap API](https://0x.org); nothing else can move the funds.

> **Real money.** This trades a live wallet on a live chain. Three independent switches must
> all be set before it can sign anything — see [Arming it](#arming-it). Read that section
> before running it, not after.

---

## How it works

```
  Alchemy WSS ──► classifier ──► entry gates ──► 0x quote ──► sign ──► exit manager
   (transfers)     is this a      size, mcap,     route +      local      ladder / stop /
                   real buy?      liquidity,      calldata     key        time cutoff
                                  security
```

**Detection.** A websocket subscription to token transfers involving the tracked wallets.
Each candidate transaction is classified: a *buy* means the wallet received tokens and
something paid for them through a known router. That last condition matters more than it
sounds — under the platform these wallets trade on, the wallet is never the party that pays,
so attributing payment by "who sent the money" classifies every real buy as a non-event.

**Entry gates.** A signal has to clear all of them: minimum size of the tracked wallet's own
buy, a market-cap floor and ceiling, pool liquidity, holder concentration scaled to market
cap, contract bytecode size, sell tax, and whether the contract is open source. Each gate
exists because something specific went wrong once; the reasoning is written into
`config.json` beside the value, and into `src/security.ts` for the security gates.

**Execution.** 0x returns unsigned calldata with a `minBuyAmount` baked in. The bot signs
locally and broadcasts. Either the fill matches the quote or the transaction reverts — there
is no partial acceptance of a worse price.

**Exit.** Every position gets a take-profit tier chosen by market cap, a stop loss, and a
hard time cutoff. Whichever comes first wins. The cutoff is the important one: this is a
scalper, and a position that has not worked in a few minutes is closed regardless.

**Shadow twins.** Every real entry is mirrored by counterfactual positions that cost nothing
and hold no capital — a control, and a variant with a minimum hold. They exist to measure
whether a rule change would have helped, using the same price path the real position saw.

---

## Layout

```
src/
  index.ts        the runner: detection, gates, entry, and the manage loop
  classifier.ts   is this transaction a buy by the tracked wallet?
  security.ts     the refusal rules, each with its measured basis
  execution.ts    quoting and position sizing
  router-0x.ts    0x Swap API v2
  signer.ts       local key, gas ceiling, nonce serialisation, broadcast
  live.ts         swap submission and settlement measurement
  exit.ts         the exit state machine
  money.ts        the single conversion boundary between assets and dollars
  reconcile.ts    what the chain says we hold, versus what we believe
tools/
  status.ts       what the bot believes, checked against the chain
  ui.ts           a local read-only dashboard on 127.0.0.1:7777
  test-*.ts       assertion suites over recorded history
  regress.ts      replays recorded trades against the current rules
  v4price.mjs     historical Uniswap V4 price at any block
```

---

## Running it

### Prerequisites

- **Node 22+.** The runtime type-strips TypeScript directly; there is no build step.
- **An Alchemy key with websocket access** — detection is a WSS subscription.
- **A 0x API key.**
- **`gmgn-cli` on your PATH.** *Not on npm, and not shipped here.* The bot shells out to it
  for three things nothing else provides on this chain: token security fields (top-10 holder
  concentration, sell tax, open-source flag), pool liquidity, and the price feed the exit
  loop watches. `cli-usage.md` documents the commands used.

  **Without it the bot does not crash — it degrades quietly, which is worse.** The security
  gates fail open, so nothing gets blocked; and `priceOf` returns null, so open positions
  have no price and are effectively unmanaged until the time cutoff fires. If you run this
  without `gmgn-cli`, run it with `mode.dryRun: true` and watch the log for
  `*** NO PRICE ... position is UNMANAGED`.


```bash
git clone https://github.com/jasoncheunggg/crypto-trading-bot.git
cd crypto-trading-bot
npm install

cp .env.example .env          # fill in the keys
cp wallets.example.json wallets.json   # the wallets to copy

node --experimental-strip-types src/index.ts
```

`wallets.json` is gitignored. So is `.env`, and so is `state/`, which holds the trade ledger,
open positions and recorded price paths.

### Arming it

Three switches, all required, deliberately separate:

| switch | where | meaning |
|---|---|---|
| `mode.dryRun: false` | `config.json` | stop simulating |
| `mode.logOnly: false` | `config.json` | stop watching without acting |
| `BOT_ALLOW_AUTOMATED_TRADES=1` | environment | permit signing |

The third is environment-only **on purpose** — it is not read from a file, so a stray restart
can never arm live trading by itself. Start the bot with it set explicitly:

```bash
BOT_ALLOW_AUTOMATED_TRADES=1 node --experimental-strip-types src/index.ts
```

Without it the bot runs, watches and records, but every entry is marked paper and no
transaction is ever signed.

### Dashboard

```bash
node --experimental-strip-types tools/ui.ts     # 127.0.0.1:7777
```

Read-only. It never writes to `state/` and never competes for API budget. Open positions,
trade history with gas, rejected signals with the reason each was refused, and the current
value of every tunable.

### Checking on it

```bash
node --experimental-strip-types tools/status.ts    # belief vs chain
node --experimental-strip-types tools/regress.ts   # replay history against current rules
node --experimental-strip-types tools/test-units.ts
```

---

## A note on the comments

Unusually long, and deliberately so. Nearly every constant in `config.json` carries a
sibling `…Note` recording what was measured, over how many trades, and what the alternative
cost. Several record that a change was made on judgement rather than evidence, and what
would justify reverting it.

The reason is that a trading bot accumulates numbers whose origin is forgotten within days,
and a forgotten threshold is indistinguishable from an arbitrary one. If you change a value
here, the note beside it is the argument you are overruling.

---

## Licence

See [LICENSE](LICENSE).

This is a personal project published as-is. It is not financial advice, not a product, and
carries no warranty. Trading memecoins with an automated system is an efficient way to lose
money.

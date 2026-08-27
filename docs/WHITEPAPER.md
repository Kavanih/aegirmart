# AEGIRMART

**Automated strategies for short-horizon event contracts on Somnia**

*Working draft — last updated 2026-08-27. Written alongside the build; every
number here is measured against the live venue unless marked otherwise.*

---

## 1. Abstract

AEGIRMART is a trading front end and strategy runner for binary event contracts
on DreamDEX, a venue on Somnia testnet. Contracts settle every sixty seconds or
every five minutes on whether BTC or ETH is above a strike at expiry.

The venue has order books but very few participants, so most windows open and
close with almost nothing resting on them. AEGIRMART exists to change that: it
lets a person hold automated strategies that quote and take continuously, and
gives them the instrumentation to see whether those strategies are actually
working.

Three strategies ship: a **market maker** that quotes both sides and takes no
view, a **quant** that prices the contract from spot, time and volatility, and
an **AI** strategy that prices it from a language model's read of the same
evidence. All three are configurable per bot, run against a per-bot signing key,
and report their own record.

This paper documents the venue mechanics that shaped the design, the strategies
themselves, and — at some length — the measurement problems we hit. That last
part is deliberate. Most of the engineering effort in this project went not into
placing orders but into being able to trust the numbers on the screen, and that
turned out to be the harder problem.

---

## 2. The instrument

A binary event contract on this venue is a market with two outcome tokens, YES
and NO. At expiry one redeems for 1.00 collateral and the other for nothing.
Collateral is tUSDC.

Because a winning share is always worth exactly 1.00, **the price of a share is
the market's probability**. A YES token trading at 44c is the market saying
"44% chance". This identity is what makes the whole product legible: every price
on every screen can be read as a percentage, and every strategy is ultimately a
disagreement about a probability.

Two mechanics follow from it and both shaped the code.

**Complete sets.** Depositing N collateral mints N YES *and* N NO. At expiry one
leg pays N and the other expires worthless, so minting and holding both is
exactly break-even before fees. The interface calls this outcome "Even" rather
than a win or a loss, because a position that was never directional should not
be scored as either.

**Complements.** YES at *p* and NO at *1 − p* are the same statement. Buying NO
is economically identical to offering YES, which means a market maker can quote
both sides of a market **using only buy orders** — bidding YES and bidding NO is
a bid and an offer on YES. It never needs to hold or mint an outcome token to
make a two-sided market. This is the single most useful structural fact we
found, and section 5.1 explains what it saves.

### 2.1 The venue always stores a YES price

The pool records one price per order, and it is always the YES price. A buy of
the NO leg at 56c is written to the chain as 44c:

```ts
const priceYes = q.side === "yes" ? ownPrice : ONE - ownPrice;
```

Reading that field back and printing it next to a "DOWN" label reports a bet as
44c that actually cost 56c a share. Every cost, average price and P&L built on
top of it is then wrong in the same direction. We shipped this bug and it is
documented in section 8.3, because the fix is not complicated but *noticing* it
required a check we did not initially have.

### 2.2 Grid

Prices snap to a tick of 0.001 and quantities to a lot of 0.01 shares, both
scaled by 1e6 on chain. Quantity floors to a whole lot, so a stake never rounds
upward into more risk than the operator asked for.

Order sizing is by **collateral, not shares**:

```
quantity = floor(stake / price)   ->   cost = quantity x price = stake
```

Every order therefore risks exactly the configured stake regardless of price. A
bet at 17c and a bet at 83c both put the same amount at risk; they differ in how
many shares that buys and therefore in the payout, not in the downside. This is
worth stating plainly because the intuition that "longshots are riskier" is
false under flat-collateral sizing, and we reasoned from that wrong intuition
once before checking.

Measured across every order one bot placed: cost landed on 50.00 tUSDC to the
cent, on all six, at prices from 17c to 82c. That is the check that the sizing
and the price convention are both right.

### 2.3 Selling does not work here

The venue exposes SELL_YES and SELL_NO order types. We sampled 500 sell orders
across all accounts on the venue:

```
SELL orders on the venue: 500, of which ever filled: 0
```

Not one has ever filled. There is no resting bid to lift, because there are
almost no participants. **In practice a position on this venue can be entered
and held to settlement, but not closed.** AEGIRMART therefore does not offer a
sell or close-position control. Offering a button that cannot work would be a
worse lie than the absence of one, and every risk statement in the product is
written on the assumption that entry is a commitment to expiry.

---

## 3. Architecture

```
                    +---------------------------+
   browser  <--->   |  backend (Node, Express)  |
   React/wagmi      +---------------------------+
                       |        |          |
              +--------+        |          +-----------+
              |                 |                      |
     +--------v------+  +-------v--------+   +---------v--------+
     | Somnia RPC    |  | GraphQL indexer|   | OpenRouter       |
     | writes: order |  | reads: books,  |   | model reads,     |
     | placement     |  | orders, fills, |   | free tier        |
     |               |  | redemptions    |   |                  |
     +---------------+  +----------------+   +------------------+
```

- **Chain**: Somnia testnet, chain id 50312, RPC `dream-rpc.somnia.network`.
  Collateral is tUSDC at `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E`.
- **Indexer**: a GraphQL endpoint carrying `Market`, `Order`, `Fill`,
  `OutcomeBalance` and `RedemptionRecord`. All reads go here; the chain is used
  only for writes and allowance checks.
- **Backend**: owns the strategy runner, the model tracker, key custody, plan
  state and the venue counters. State is small and file-backed.
- **Frontend**: React with hash routing, wagmi for the user's own wallet.

The user's own trading is signed in their browser. **Bot** trading is signed on
the server, which is what section 6 is about.

---

## 4. Reading a window

Everything a strategy sees is assembled per market, per window:

| Input | Source | Note |
|---|---|---|
| Spot | indexer price series | last observed |
| Strike | market | fixed at mint |
| Time to expiry | market | drives everything |
| Realised volatility | recent series | over a trailing sample |
| Best bid / best ask | order book | often absent |
| Historical base rate | settled markets | same asset and window |

The base rate is worth a note. Outcome encoding is `0 = up / YES`,
`1 = down / NO`, confirmed by reconstructing spot from the following window's
mint. Across 500 settled markets sampled today:

```
winningOutcome distribution: { '0': 277, '1': 217, null: 6 }
```

Roughly balanced, as a coin-flip instrument should be, with a mild up bias over
this sample. **Six finalized markets carry a null winner.** Any code that reads
a winner must treat null as "no result" rather than coercing it to 0, or it will
silently report those markets as DOWN wins.

---

## 5. The strategies

### 5.1 Market maker

Quotes both sides around a fair value at a configurable half spread, and earns
the gap when both sides fill. It takes no directional view.

Both quotes are **buys** — bid YES, bid NO — per the complement identity in
section 2. This matters more than it sounds. The obvious way to offer YES is to
mint a complete set and sell one leg, which requires collateral, a mint
transaction, and on this venue a faucet draw when the balance runs low. Quoting
with two buys needs none of that. It also sidesteps the fact that sells never
fill.

Quotes are **post-only**. A maker that crosses the book is taking, which is the
opposite of what it is for; the venue rejects those with `PostOnlyWouldCross`,
which is the guard working rather than an error. Quotes are clamped inside the
existing book, which took revert rates from roughly half of all attempts to
zero. They expire with their window, so a stale quote can never outlive its
market and the runner never has to cancel anything.

**How a market maker loses.** Two ways. If only one side fills it is left
holding a directional position it never wanted, and that position settles at
0 or 1. And if the market moves through its quotes, the side that fills is
always the wrong one — the classic adverse selection problem. The spread is
payment for accepting exactly that risk.

### 5.2 Quant

Prices the contract directly. Given spot, strike, time to expiry and realised
volatility, the probability of finishing above the strike is a digital option
value under a lognormal assumption, blended with the historical base rate for
that asset and window length. No model call, no network dependency, no
allowance to spend.

It takes one side when its price and the book disagree.

### 5.3 AI

Sends the same evidence to a language model and asks for a probability, a
confidence and a short reasoning. Runs on the **five minute lane only**: a read
takes tens of seconds, and an answer that arrives against a sixty-second window
is an answer about a price that has already moved.

Models are free-tier and ranked by their own settled record. A window with no
stored read is skipped rather than triggering a read on a timer — reads are a
scarce resource, and section 7 explains how scarce.

### 5.4 What a directional bot actually trades

This is the most commonly misunderstood part of the system, so it is stated
explicitly.

**A directional bot does not back the model's favoured side. It trades
disagreement between the model and the book.**

```
buy UP   if  fair - bestAsk  >= MIN_EDGE
buy DOWN if  bestBid - fair  >= MIN_EDGE
```

with `MIN_EDGE` at 0.05. If the model says UP 60% and the book already asks 58c
for UP, the bot does nothing: the price is right, so there is nothing to win.
Only when the book is empty does it fall back to backing the model's side
outright.

A consequence that surprises people: the bot will buy the side its own model
thinks is *less* likely, when the other side is overpriced enough. That is
value betting and it is correct by expectation. It is also the behaviour that
motivated the conviction floor in the next section.

---

## 6. The conviction floor

Operators can set a minimum probability on quant and AI bots — "only bet when
the model gives this side at least X% chance". It is checked against the leg
about to be bought, after the normal analysis, in addition to the edge test.

**Edge asks whether the book is wrong. The floor asks whether the side is
likely.** They are different questions and a bet can pass one while failing the
other.

### 6.1 What it does, measured

Observed live on 2026-08-27 with the floor at 50%:

```
[12:52:27] BTC fair=0.55 bid=0.401 ask=0.431  -> BUY UP  chance=0.55  PASS  (traded, lost -50.00)
[12:52:27] ETH fair=0.49 bid=0.311 ask=0.339  -> BUY UP  chance=0.49  BLOCKED
```

The ETH signal was refused for missing the floor by one point. The market was
asking 34c for something the model valued at 49c — a 15c edge, positive by
expectation, declined.

### 6.2 Does it improve results?

**On current evidence, no — and the evidence is far too thin to say otherwise.**
The complete settled record of the AI bot at time of writing is six orders, two
of five settled windows won, net −47.07 tUSDC. Nothing can be concluded from
six trades on an instrument whose true win rate is near 50%. Any claim that the
floor helps or hurts would be noise dressed as a finding.

What can be said from first principles:

- The floor **removes positive-expectation bets**. A cheap 49% shot is a good
  bet and the floor refuses it. Filtering on probability is not filtering on
  edge, and only edge drives expected value.
- The floor **reduces variance and trade count**. Fewer, higher-conviction
  positions swing less. For an operator who cannot stomach a run of losses on
  technically-correct longshots, that is worth paying for.
- On five-minute crypto, true probabilities cluster near 50%. A floor above
  roughly 60% approaches "never trade", not "trade selectively".

### 6.3 Recommendation

**Keep the control; default it off.**

It is a legitimate risk-appetite setting and operators should have it. But it is
not an accuracy filter, and defaulting it to 50% silently rejects about half of
all signals on an instrument that is inherently a coin flip — which reads to a
new user as a broken bot rather than a conservative one. Ship it at 0, document
it as variance control rather than edge control, and let operators who want
fewer and firmer positions raise it. The useful range, if raised at all, is
55–60%.

The honest version of the feature is not "only bet when the AI is confident" but
"decline bets below this confidence even when they are cheap". That is a real
choice and it should be labelled as one.

---

## 7. The allowance problem

The AI strategy depends on model reads, and free-tier model access is capped at
**50 requests per account per UTC day** — account-wide, not per model.

Against that:

| | |
|---|---|
| Five-minute windows per day, per asset | 288 |
| Across BTC and ETH | **576** |
| Free reads available per day | **50** |

**Continuous AI coverage is arithmetically impossible on a free allowance.** At
best the AI strategy can see under 9% of windows. This is a hard constraint, not
an optimisation target, and the design has to be honest about it.

Three mechanisms manage it:

1. **Lane restriction.** The tracker reads the five-minute lane only. Spending
   an allowance on sixty-second windows buys an answer that arrives after the
   window it describes has moved on.
2. **Demand-driven reads.** Nothing is read speculatively. The tracker reads
   only windows that a *running* AI bot wants — matching asset, eligible lane —
   and charges the read to that bot's own daily allowance. A bot that is
   switched off, or out of allowance, generates no spend at all.
3. **Shared reads.** A read requested by hand is written to the same store the
   tracker and the bots use. It counts on the scoreboard, a bot can act on it,
   and nobody spends the allowance twice for the same answer.

### 7.1 Why pacing was removed

An earlier design spread the allowance evenly across the day: 60% of the budget,
released in proportion to elapsed UTC time. The arithmetic works out to **one
read every 48 minutes**, which is not coverage of a five-minute window in any
useful sense.

The deeper problem was diagnostic. A paced-out tracker is *silent* — it declines
to spend and logs nothing — so an operator watching a bot sit idle cannot
distinguish a working system from a broken one. We spent real time chasing a
strategy question that was actually a budget question.

The replacement puts the throttle where the operator can see it: **the on/off
switch on the bot is the spend control.** This is legible, immediate, and
matches the mental model people already have. Verified after the change: all
bots paused, sixty seconds elapsed, zero requests spent.

### 7.2 Budgeting bots in reads

An AI bot is configured with a **daily read allowance**, not a daily trade cap.
Reads are what binds — a bot cannot trade a window it has not read — so a trade
ceiling on an AI bot constrains the wrong resource.

| Tier | Model reads / day |
|---|---|
| Free | none (no AI bots) |
| Starter | 20 |
| Pro | 50 |

The ceiling is enforced on save and again at the moment of spend.

One honest caveat: the free model allowance in this section is **per upstream
account, not per user**. A single Pro operator at 50 reads a day consumes the
entire daily budget on their own. The per-tier numbers are therefore a fair
sharing rule for a testnet deployment, not a capacity guarantee. Paid model
access is what makes them one, which is the clearest argument for it in the
product's economics.

---

## 8. Measurement

Placing orders was the easy part. Being able to trust what the screen says was
not. Every defect below shipped, was found against live data, and is recorded
because the class of error repeats.

### 8.1 The recurring shape

Nearly every reporting bug had the same structure: **a displayed number computed
from a different source than the number it claimed to describe.**

- A preview priced from the book beside an order priced from a default.
- A last-traded price beside a resting offer that would actually fill.
- A token balance used as a payout, when claiming burns the balance to zero.
- An expected value that priced a model against a number derived from the same
  model, and so was always exactly zero.

The fix in each case was not better arithmetic but collapsing two sources into
one.

### 8.2 Claimed winners were invisible

Positions were fetched filtered on `balance > 0`. Redeeming a winning position
burns the tokens, so every claimed win had a zero balance and was dropped. The
portfolio was computed from the losers, and reported a win rate near 1%.

Compounding it, the query capped at 100 rows ordered by balance descending —
which put every claimed winner last and then cut it. Fixing both moved the
measured win rate from 1% to 40% without a single trade changing.

**Lesson: a filter written for the common case silently defined the sample.**

### 8.3 Every DOWN order was priced at its complement

Per section 2.1, the venue stores only YES prices. Order rows printed that value
next to the direction, so a DOWN bet that cost 56c a share displayed as 44c, on
three different pages.

It was caught by a consistency check rather than by inspection: reconstructed
costs did not land on the configured stake. Once the price was inverted for NO
legs, all six orders came out at exactly 50.00 — the stake, to the cent.

**Lesson: a wrong number that is merely plausible survives review. Find an
invariant it must satisfy and test that instead.** Here the invariant was
`cost == stake`, which the sizing rule guarantees.

With prices corrected, each filled order can carry its own result: a winning
share redeems at 1.00, so a buy at price *p* makes `(1 − p)` a share and
otherwise loses the `p` it paid.

### 8.4 Every trade was billed twice

The daily allowance counter was incremented in two places for one order — once
by the function that records and persists the trade, then again on the following
line by its caller.

The second increment landed *after* the write to disk, so a restart discarded
it. The counter came to rest somewhere between the true count and double it:
a bot with five orders reported eight trades. Not reproducible, which is what
made it look like a strategy question rather than a counting bug.

Underneath it, the runner was handed a *copy* of any bot whose trading day had
rolled over. On the first cycle of each day the count it read and the cap it
tested belonged to an object nothing persisted — so a 20-trade cap would not
have stopped that bot at 20.

**Lesson: a counter that drifts non-deterministically is usually two writers,
and an off-by-a-restart is a write-ordering tell.**

### 8.5 Minted sets are not calls

Holding both legs of a market is break-even by construction. Scoring it as one
win and one loss inflated every trader's settled count and pushed every win rate
toward 50%, which made the leaderboard nearly uniform. Complete sets are now
excluded from the record and counted only toward volume.

### 8.6 Orders on settled markets read as "Open"

The indexer never transitions a resting order once its market finalizes. Nothing
can fill there, so reporting it as working is false. Status is now derived from
the window rather than trusted from the field.

---

## 9. Key custody

A bot signs on the server, which is a real risk and is treated as one.

- Keys are entered once by the operator, sealed with **AES-256-GCM** under a
  per-record scrypt salt, and written sealed.
- Plaintext never leaves the sealing module, is never returned by any endpoint,
  and is never written to disk.
- Without a configured encryption secret of adequate length the server **refuses
  to accept a key at all** rather than degrading to weaker storage.
- The interface states plainly that the server must decrypt to sign, and that a
  bot key should be funded as a hot wallet with what that bot should risk.

Orders belong to whichever key signed them. Replacing a bot's key therefore
leaves its history with the old one, and the interface says so rather than
showing a trade count beside an empty table.

---

## 10. Economics

| Tier | Price | Bots | Running at once | Trades/day | Reads/day | Strategies |
|---|---|---|---|---|---|---|
| Free | — | 3 | 1 | — | — | Market maker |
| Starter | 15 tUSDC/mo | 10 | 3 | 50 | 20 | + Quant, AI (free models) |
| Pro | 30 tUSDC/mo | 10 | 5 | uncapped | 50 | + paid models |

Yearly billing discounts 10% on Starter and 15% on Pro. Payment is an ERC20
transfer to the treasury, verified by reading the Transfer log on chain before
the plan is granted.

The tier split follows the constraint in section 7 rather than being arbitrary:
the thing Pro actually buys is a larger share of the model read budget, and
eventually escape from it entirely. Reads are the binding limit on the AI
strategy, so reads are what the tiers meter.

A platform fee of 1% per trade is specified and not yet implemented. The venue
supports it natively through a builder address and fee parameter on order
placement; approval is per pool, per user, per builder, and pools recycle, so it
costs one approval per pool rather than one per trade.

---

## 11. Venue counters

Volume, trade count and trader count accumulate in the backend and only ever
climb. Volume is computed from **fills**, not balances — a redeemed winner has a
zero balance, so summing balances undercounts exactly the positions that
mattered most.

---

## 12. Limitations

Stated plainly, because a paper that only lists strengths is not useful.

1. **No exit.** Positions cannot be closed, only held to settlement (2.3).
2. **AI coverage under 9% of windows** on a free allowance (7).
3. **The strategy record is too small to evaluate.** Six settled orders. Every
   performance figure in this document is an illustration of the instrument, not
   evidence about the strategies.
4. **Server-side keys** are a real custody risk, mitigated but not eliminated.
5. **Cost basis is incomplete for minted positions**, where shares were acquired
   by minting rather than buying; a subset of historical rows remain unpriced.
6. **The platform fee is unimplemented.**
7. **Testnet only.** Liquidity, counterparties and faucet behaviour are not
   representative of a live market.

---

## 13. Roadmap

- Implement the builder fee, with a single approval per pool.
- Mint-aware cost basis for the remaining unpriced rows.
- Paid model access, removing the constraint in section 7.
- Enough settled volume to say something honest about strategy performance.
- Revisit exits if the venue ever develops a resting bid.

---

## Appendix A — Constants

| | |
|---|---|
| Chain | Somnia testnet, id 50312 |
| RPC | `https://dream-rpc.somnia.network` |
| Indexer | `https://dev.smk.somnia.host/v1/graphql` |
| Collateral | tUSDC `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |
| Treasury | `0x803f09058F436b760ea241923De14dcE51Fb53ea` |
| Scale | `ONE = 1e6` |
| Tick | `1000` (0.001) |
| Lot | `10000` (0.01 shares) |
| Outcome encoding | `0 = YES / up`, `1 = NO / down` |
| Order types | `0 = limit (takes)`, `3 = post-only` |
| Windows | 60s, 300s |
| Free model allowance | 50 requests / account / UTC day |

## Appendix B — Invariants worth testing

Derived from section 8; each one caught or would have caught a shipped defect.

1. `filled x pricePaid == configured stake`, for every order.
2. A claimed winner must still appear in the portfolio after its balance is zero.
3. A position holding both legs must score as neither a win nor a loss.
4. The daily trade counter must equal the number of orders the venue holds for
   that key, that day.
5. A finalized market with a null winner must produce no result, not a DOWN win.
6. An order on a finalized market must never report as open.

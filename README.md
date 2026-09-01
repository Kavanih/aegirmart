# 
# AEGIRMART

**Automated strategies for short-horizon event contracts on Somnia**


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
quantity = floor(stake / limitPrice)   ->   worst case cost = stake
```

The stake is therefore a **ceiling** on what an order can cost, not the amount
it will cost. A directional order is marketable: it crosses the book and fills
against whatever is resting, which is by definition at or better than its limit.
An order carrying a 97c limit has been observed filling at an average of 76c,
and one carrying a 50c limit filling at 2c.

This distinction matters more than it looks, and section 8.5 records what it
cost us to learn.

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

### 5.2.1 The quant is right, and was far too timid

Backtested across settled five minute windows, priced halfway through each one
from the sixty second tape:

| Raw estimate | BTC finished up | ETH finished up |
|---|---|---|
| said 55-65% up | **69%** | **80%** |
| said 35-55% up | **17%** | **25%** |

Directionally correct in every bucket on both assets — and understated in every
one. A lognormal digital on a five minute window sits too close to a coin flip
for this instrument.

That timidity is not harmless, because the bot pays at most what its own model
says a leg is worth (section 5.6). Underestimating its own calls means the
ceiling refuses trades it should take: the book would quote 87c against a
model saying 75c, and the bot would sit out a call it was about to get right.

Stretching the estimate away from 0.5 takes the tradeable windows from 47 to 82
and lines the buckets up — a calibrated 65-80% now finishes up 67-83% of the
time. The gain is deliberately set below what the sample argues for, roughly
half the correction, because 47 windows is a thin basis for a constant.

The first three trades after calibration: two settled, both won, **+75.26**.
That is three trades and proves nothing on its own; the backtest is the reason
to believe it, not the live run.

**Lesson: a model can be worth trading while its numbers are not worth
quoting.** Direction and magnitude are separate claims, and only the second one
needed fixing.

### 5.3 AI

Sends the same evidence to a language model and asks for a probability, a
confidence and a short reasoning. Runs on the **five minute lane only**: a read
takes tens of seconds, and an answer that arrives against a sixty-second window
is an answer about a price that has already moved.

Models are free-tier and ranked by their own settled record. That ranking
originally scored only latency and success rate — how fast a model answers and
how often it answers at all — with no term for whether it was ever right, so the
quickest model led regardless of accuracy. Accuracy now leads and speed breaks
near ties, with small samples pulled toward a coin flip so two lucky calls
cannot top the table.

A bot may name its model, which is then tried first and given a second attempt
at the back of the queue. Free providers answer "temporarily overloaded" often
enough that one refusal should not silently hand the read to a model the
operator did not choose: the preferred model here was failing 19 calls in 22 and
the reads were quietly coming from elsewhere. A window with no
stored read is skipped rather than triggering a read on a timer — reads are a
scarce resource, and section 7 explains how scarce.

### 5.4 Three things that are not edge

The first live sessions lost money in a way that looked like bad luck and was
not. Seven of thirteen settled trades came from a read where the model had
answered **0.50** — "spot equals strike; digital and historical estimates both
50%" — and every one of those seven lost.

Nothing was wrong with the model. It was reporting honestly that it had no
view. The error was on our side: `0.50` was fed into the edge test as a *fair
value*, and a fair value of 0.50 manufactures enormous edge against any cheap
price. The bot was sizing up on the absence of a signal.

Two related mistakes came out of the same review.

**A collapsing price is information, not a bargain.** A leg offered at 2c with
ninety seconds left is not mispriced — spot has left the strike behind and the
book knows. A read taken minutes earlier cannot see that, so the huge gap it
opens is evidence the read is stale, not evidence of a mispricing.

**A read expires with the price it described.** Reads were being acted on more
than 200 seconds into a 300 second window.

Three guards follow, and all three are properties of the *read*, not the market:

| Guard | Rule | Reasoning |
|---|---|---|
| No view | require `abs(p - 0.5) >= 0.05` | 0.50 is an answer of "I don't know" |
| Staleness | read age `<= interval / 3` | a snapshot stops describing a moving price |
| Max edge | reject disagreement `> 0.35` | the book is better informed than a stale read |

Replayed against the settled record, the guards block eight trades worth
**−217.82** and keep five worth **+123.29**, blocking no winner. That is a
retrospective check on thirteen trades and is not offered as proof. The
mechanism does not depend on it: a 0.50 read carries no information by
construction, whatever the sample says.

The general lesson is worth stating separately, because it is not specific to
this venue. **A model's uncertainty and a market's error produce identical
arithmetic.** Both appear as a large gap between a model's number and a price.
Only one of them is worth betting on, and telling them apart requires asking
whether the model actually said anything — which a subtraction cannot do.

### 5.5 What a directional bot actually trades

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
motivated the conviction floor in section 6.

---

## 5.6 Why the price is the probability

A share pays exactly 1.00 if the call is right and nothing if it is wrong.
Price and probability are therefore the same number in different units: a leg
offered at 70c is the market saying "70% likely", and a model answering 70% is
saying "this is worth 70c". The model is not appraising shares. It reads spot,
strike, time remaining and volatility, produces a probability, and that
probability *is* a valuation because of how the instrument settles.

This makes the break-even price for any call equal to its own probability, and
that has a consequence which is easy to state and easy to disbelieve: **being
right most of the time does not make money if the price is wrong.**

A call the model gives 70%, offered at 97.7c, staking 50:

```
  stake 50 buys 51.2 shares
  right (70% of the time):  gain   1.18
  wrong (30% of the time):  lose  50.00

  over 100 such bets
    70 rights x  1.18  =   +82
    30 wrongs x 50.00  = -1500
    net                = -1418
```

Right seventy times in a hundred and down 1418, because each loss costs
forty-two times what a win pays. The same 68% call across prices:

| Price | 68 wins pay | 32 losses cost | Net over 100 |
|---|---|---|---|
| 30c | +7933 | -1600 | **+6333** |
| 50c | +3400 | -1600 | **+1800** |
| 68c | +1600 | -1600 | 0 |
| 80c | +850 | -1600 | -750 |
| 90c | +378 | -1600 | -1222 |

68c is the line, and it is the model's own number. Below it the call earns,
above it the call loses however often it is right.

A directional bot therefore pays **up to** what the model says the leg is
worth, and passes anything above. This is not a demand for a discount — a price
equal to fair value is taken. It only refuses prices the model itself has
already called too high.

## 5.7 A win is not money until it is redeemed

A settled winning position is outcome tokens, not collateral. Nothing converts
them automatically: the holder has to call `finalizeAndRedeem` on the settlement
contract.

The bots did not. They placed orders and never redeemed, so a bot could win
steadily while its wallet balance only fell — 448.92 tUSDC of won positions sat
unconverted across six markets, against a wallet of 463.56. It was hours from
being unable to fund a trade despite being ahead.

The runner now sweeps settled wins at the top of every cycle, before quoting, so
the collateral is available to trade with. It does this for **every bot holding
a key, running or paused**: pausing a bot stops it taking new positions, and
must not strand money it has already won.

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
The complete settled record of the AI bot at time of writing is a handful of
orders across a few settled windows. Nothing can be concluded from
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

### 6.3 Recommendation, and what shipped

**Keep the control; default it off.** This is what shipped: new bots carry no
floor, and raising it is a deliberate act.

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
legs, all six orders came out at exactly 50.00.

**Lesson: a wrong number that is merely plausible survives review. Find an
invariant it must satisfy and test that instead.**

That lesson holds. The specific invariant we chose did not, and section 8.5 is
about why.

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

### 8.5 The invariant that proved itself

The check in 8.3 — "every order's cost lands on the configured stake" — is
worthless. Quantity is *derived* as `stake / limitPrice`, so `quantity x
limitPrice == stake` is true by construction, for any price convention, whether
or not it describes reality. It was arithmetic restating its own premise.

It did confirm the YES/NO inversion, because only the correct complement makes
the identity hold in the leg's own terms. But it was then used to support a
second, false claim: that the limit price was the price paid.

It is not. A directional order takes, and takes at the resting price:

| Limit | Actually paid | Order |
|---|---|---|
| 97c | **76c** | ETH up |
| 94c | **58c** | BTC up |
| 55c | **32c** | BTC up |
| 50c | **2c** | ETH up |

Every result computed from the limit was therefore wrong in a consistent
direction: **losses overstated, wins understated.** One order reported as
winning 1.55 had actually made 12.52; one reported as losing 50.00 had lost
30.90. Across the settled record the sign flipped — a reported net of −47.07 was
in truth **+54.96**.

The fix is to price each order from its own fills. The venue's `Fill` records
carry `makerOrderId`, `takerOrderId` and the quote value, so cost is attributable
exactly rather than estimated:

```
cost  = sum over fills of (BUY_YES ? quoteValue : shares - quoteValue)
price = cost / shares
pnl   = won ? shares - cost : -cost
```

The limit price is still reported, and it is still the right number for the
escrow on an order that has not filled — that *is* what it would pay. It is
simply not what a filled order paid.

**Lesson: an invariant derived from the same expression it is testing proves
nothing.** A real check has to come from an independent source. Here that source
was the fill records, which are what the venue actually charged, and which we
had been reading all along for the portfolio without connecting them to the
order rows.

### 8.6 The scoreboard was measuring luck

The model scoreboard derived a call from the probability:

```ts
side = probability >= 0.5 ? "up" : "down"
```

A model answering **0.50** — "I have no view" — was therefore recorded as an
**up call**, and credited with a hit every time the market happened to rise.

That would be a rounding detail if such reads were rare. They are not. Across
64 reads on five-minute crypto windows:

| Distance from a coin flip | Reads |
|---|---|
| under 2c | 36 |
| 2–5c | 11 |
| 5–10c | 5 |
| 10–20c | 5 |
| 20–35c | 3 |
| over 35c | 4 |

**Only 27% of reads express a real view.** The scoreboard was mostly scoring
coin flips, and it flattered every model on the page. One model showed 85% over
twenty reads; excluding non-calls it has **two** real calls, one correct.

The ranking then consumed that number, so the corruption propagated from the
display into model selection.

A read within `MIN_VIEW` of 0.50 is now recorded as `side: "none"`, never
scored, and shown as "no call".

**Lesson: a default that turns missing data into a value will be counted as
data.** `>= 0.5` silently converted "don't know" into "up". The absence of an
answer needed its own representation.

### 8.7 A correct model and a losing trade are the same window

The obvious reading of an accuracy page is that a more accurate model earns more
money. On a value-trading bot that is false, and the two numbers can move in
opposite directions by design.

The scoreboard scores the model's **view of the outcome**. The bot trades the
**gap between that view and the price**, so whenever the other leg is the cheap
one it buys the side the model did not call. Measured over thirteen settled
trades, five took the opposite side to the model's call, and four of those five
were on windows the model called correctly:

```
model called   | bot bought | model scored | bot result
BTC DOWN 49%   | UP         | Hit          | lost -37.42
BTC UP 83%     | DOWN       | Hit          | lost  -6.84
ETH UP 50%     | DOWN       | Hit          | lost -41.00
BTC UP 50%     | DOWN       | Hit          | lost -42.10
```

Nothing here is malfunctioning. A value bettor *should* take the other side of
an overpriced favourite. The defect was presentational: two different questions
were being answered on two pages with no statement that they were different, so
"hit" naturally read as "made money".

The accuracy page now says so explicitly.

**Lesson: when two screens answer different questions about the same event, the
difference has to be written down.** Nobody infers it from the numbers, because
the numbers agree often enough to look like they always should.

### 8.8 Minted sets are not calls

Holding both legs of a market is break-even by construction. Scoring it as one
win and one loss inflated every trader's settled count and pushed every win rate
toward 50%, which made the leaderboard nearly uniform. Complete sets are now
excluded from the record and counted only toward volume.

### 8.9 Orders on settled markets read as "Open"

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

A platform fee of **1% per trade** is implemented, and the venue takes it
natively rather than the app deducting anything. Every order names a builder
address and a fee, the pool pays that builder out of the trade, and the trading
account must first have approved that builder for at least that much on that
pool. The fee cannot exceed what was approved, and nothing is taken from a bot's
balance by us.

```
approveBuilder(address builder, uint256 maxFeeBpsTimes1k)
placeBinaryOrder(..., address builder, uint96 builderFeeBpsTimes1k, ...)
```

Units are basis points times a thousand, so `100000` is 1%. Both were read off
an existing approval on chain rather than assumed. Approval is per pool, per
trader, per builder, and pools recycle across windows, so it costs a handful of
one-off transactions rather than one per trade. A failed approval sends the
order without a fee: trading without the cut beats not trading.

---

## 11. Venue counters

Volume, trade count and trader count accumulate in the backend and only ever
climb. Volume is computed from **fills**, not balances — a redeemed winner has a
zero balance, so summing balances undercounts exactly the positions that
mattered most.

---

## 11.1 Tuning on the right variable

Every rule in section 5 was arrived at by grouping settled trades and cutting
them by the price paid. That was always a proxy. Price correlates with
conviction - a cheap leg is usually one the model rates well above the market -
but it is not the same thing, which is why each cut only half worked and kept
needing revision.

The bot now records why it took each trade at the moment it took it: the model's
value, the price on offer, the gap between them, and how far into the window it
was. Cutting the record by that gap rather than by price gives a far cleaner
signal, monotonic in both accuracy and profit:

| Edge | Trades | Won | Rate | Net | Per trade |
|---|---|---|---|---|---|
| 8-12c | 11 | 3 | 27% | -89.81 | -8.16 |
| 12-18c | 22 | 10 | 45% | +13.28 | +0.60 |
| 18-25c | 4 | 3 | 75% | +57.24 | +14.31 |
| 25c+ | 5 | 4 | 80% | +93.36 | +18.67 |

Moving the minimum edge from 8c to 15c drops the bottom bucket outright and
takes the record from 48% and +74.07 to **63% and +182.40**: fewer trades, more
money. A one-cent gap is noise in the estimate; a twenty-cent one is a view.

**Lesson: a proxy that correlates will keep half-working, and keep needing
revision.** The fix was not a better threshold on price but recording the
variable the decision was actually made on.

## 12. Limitations

Stated plainly, because a paper that only lists strengths is not useful.

1. **No exit.** Positions cannot be closed, only held to settlement (2.3).
2. **AI coverage under 9% of windows** on a free allowance (7).
3. **The quant sits out early in a window.** Spot is minted at the strike, so
   the first minute of any window genuinely is a coin flip and there is nothing
   to price. Signal appears mid-window, which is also when a read is worth
   buying (section 7).
4. **The model rarely has a view.** Only about a quarter of reads on
   five-minute crypto sit more than 5c from a coin flip. When it does make a
   call it has been right 65% of the time over 17 scored calls, which is a real
   but modest edge on a small sample. An AI strategy on this instrument should
   be expected to sit out most windows.
5. **The strategy record is too small to evaluate.** Six settled orders. Every
   performance figure in this document is an illustration of the instrument, not
   evidence about the strategies.
6. **Server-side keys** are a real custody risk, mitigated but not eliminated.
7. **Cost basis is incomplete for minted positions**, where shares were acquired
   by minting rather than buying; a subset of historical rows remain unpriced.
8. **The strategies trade rarely by design.** Sampled across live windows the
   model has no view 60% of the time: on five minute crypto the price sits near
   the strike most of the time, which is the instrument rather than a setting.
   Long quiet stretches are the filters working, not a fault.
9. **Testnet only.** Liquidity, counterparties and faucet behaviour are not
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

1. An order's cost must come from its fills, never from its limit price. The
   limit bounds the cost; it does not state it. (See 8.5 — the version of this
   invariant that referenced the limit was circular and proved nothing.)
2. A claimed winner must still appear in the portfolio after its balance is zero.
3. A position holding both legs must score as neither a win nor a loss.
4. The daily trade counter must equal the number of orders the venue holds for
   that key, that day.
5. A finalized market with a null winner must produce no result, not a DOWN win.
6. An order on a finalized market must never report as open.
7. A read that expresses no view must not be scored as a directional call.
8. A model's accuracy and a bot's P&L are different measurements; neither may be
   presented as evidence for the other.

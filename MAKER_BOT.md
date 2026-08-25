# Seeding the order book with ec-maker

The testnet book is empty, so every card reads `--` and the edge indicator has
no market price to compare the model against. Running the sponsor's own maker
strategy fixes all of it at once.

Run this on your machine, not in this repo. The bot needs a private key and
that key must never touch AEGIRMART.

## 1. Clone the kit

    git clone https://github.com/somnia-chain/dreamdex-bot-kit
    cd dreamdex-bot-kit
    npm install

## 2. Write the config

Create `.env` in the `dreamdex-bot-kit` folder:

    NETWORK=testnet
    DRY_RUN=true
    STRATEGY=ec-maker
    PRIVATE_KEY=0xYOUR_KEY_FOR_0xbe61a15b91676d019090e63190dc49d73044e202

    # The venue id in the DreamDEX docs points at a dead venue that serves
    # rows with strike 0. This is the live one, confirmed against the indexer.
    VENUE_ID=0x1a1e6821cde7d0159c0d293177871e09677b4e42307c7db3ba94f8648a5a050f

    MM_SPREAD=0.02
    MM_QUOTE_SIZE=5
    MM_MAX_INVENTORY=20
    MM_REFRESH_MS=10000

    AUTO_CLAIM=true

`.env` is gitignored in that repo. Never commit it, never paste the key
anywhere, including into this chat.

## 3. Check the wiring before spending anything

    npm run ec:doctor

This verifies the module address actually has code on chain, so a stale
address fails loudly instead of silently.

## 4. Dry run first

`DRY_RUN=true` logs the orders it would place and sends nothing.

    npm start -w ec-maker

You want to see it discover live markets and print intended quotes on both
sides. If it reports no markets, the venue id is wrong.

## 5. Go live

Set `DRY_RUN=false` in `.env`, then run it again. Within a cycle or two,
AEGIRMART cards should show real cent prices instead of `--`.

## Things that will bite you

- **Do not run two bots on one key.** Both senders race the same nonce.
- **Keep `MM_QUOTE_SIZE` at or below the inventory cap.** The sell side escrows
  real outcome tokens. The README calls this `MM_INVENTORY`, the code reads
  `MM_MAX_INVENTORY`; set both if in doubt.
- **Leave `AUTO_CLAIM=true`.** Settled markets pay out only when asked. A bot
  that trades for hours without claiming has its balance spread across finished
  markets while the wallet reads near zero.
- **Venue ids move.** They changed three times in the first week of August. If
  the bot finds no markets, read the venue id off a live market row.
- **A reverted write does not throw.** The SDK skips simulation, so a failed
  order can look like a success in the logs.

## What good looks like

Leave it running while you record the demo. You want the AEGIRMART landing
page showing filled probability rings, real cent prices on Up and Down, a
non-zero trade counter, and an edge readout once the model has a market price
to disagree with.

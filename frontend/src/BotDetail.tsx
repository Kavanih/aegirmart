import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { FaBrain, FaCalculator, FaKey, FaPause, FaPen, FaPlay, FaRobot } from "react-icons/fa";
import { fetchBotActivity, saveBot, stamp, windowLabel, type Bot, type OrderRow } from "./api";
import { AssetMark } from "./AssetMark";
import { TableScroll, EmptyState } from "./Table";

type Props = { botId: string; onBack: () => void; onEdit: (bot: Bot) => void };

const DAY = 86_400;
const PERIODS = {
  "24h": { label: "24 hours", seconds: DAY },
  "7d": { label: "7 days", seconds: 7 * DAY },
  all: { label: "All time", seconds: 0 },
} as const;
type PeriodKey = keyof typeof PERIODS;

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone ?? ""}`}>{value}</span>
    </div>
  );
}

export function BotDetail({ botId, onBack, onEdit }: Props) {
  const { address } = useAccount();
  const [bot, setBot] = useState<Bot | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [keyChanged, setKeyChanged] = useState(false);
  const [funds, setFunds] = useState<{ balance: number | null; affordable: number | null }>({ balance: null, affordable: null });
  const [locked, setLocked] = useState<{ amount: number; markets: number }>({ amount: 0, markets: 0 });
  const [period, setPeriod] = useState<PeriodKey>("24h");
  const [missing, setMissing] = useState(false);
  const [stale, setStale] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!address) return;
    fetchBotActivity(address, botId).then((res) => {
      // A failed poll is not a deleted bot. Keep what is on screen and say the
      // refresh failed, rather than telling someone their running bot is gone.
      if (res.status === "error") return setStale(res.reason);
      if (res.status === "missing") return setMissing(true);
      const d = res.data;
      setStale(null);
      setBot(d.bot);
      setOrders(d.orders);
      setKeyChanged(d.keyChanged);
      setFunds({ balance: d.balance, affordable: d.affordable });
      setLocked(d.locked ?? { amount: 0, markets: 0 });
    });
  }, [address, botId]);

  useEffect(() => {
    load();
    const poll = window.setInterval(load, 10_000);
    return () => window.clearInterval(poll);
  }, [load]);

  const toggle = async () => {
    if (!address || !bot) return;
    await saveBot(address, { status: bot.status === "running" ? "paused" : "running" }, bot.id);
    load();
  };

  if (missing) return <EmptyState title="Bot not found" hint="It may have been deleted." />;
  if (!bot) return <p className="read-idle">Loading bot…</p>;

  // Everything on this page is scoped to the chosen period.
  //
  // Lifetime figures let one bad afternoon follow a bot for ever: a run made
  // against a stale price on the 28th was still setting the headline win rate
  // two days later, over trades the current rules would not have taken. A
  // period is what an operator actually wants to judge.
  const cutoff = period === "all" ? 0 : Math.floor(Date.now() / 1000) - PERIODS[period].seconds;
  const inPeriod = orders.filter((o) => o.placedAt >= cutoff);

  const decided = inPeriod.filter((o) => o.won !== null);
  const orderPnl = decided.reduce((sum, o) => sum + (o.pnl ?? 0), 0);
  const wonCount = decided.filter((o) => o.won).length;
  // Shown separately so the net can be reconciled on the page. Only the net and
  // the losses were displayed, which left the wins to be added up by hand and
  // the difference looking like an error.
  const wonTotal = decided.filter((o) => o.won).reduce((sum, o) => sum + (o.pnl ?? 0), 0);
  const lostTotal = decided.filter((o) => !o.won).reduce((sum, o) => sum + Math.abs(o.pnl ?? 0), 0);
  const filledCount = inPeriod.filter((o) => o.status === "Filled").length;
  const restingCount = inPeriod.filter((o) => o.status === "Open").length;
  const expiredCount = inPeriod.filter((o) => o.status === "Expired").length;

  const capped = bot.dailyTrades > 0;
  const left = capped ? Math.max(0, bot.dailyTrades - bot.tradesToday) : null;

  return (
    <div className="page">
      <div className="page-head">
        <div className="detail-title">
          <button className="back" onClick={onBack} aria-label="Back to bots">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            Bots
          </button>
          <span className={`bot-mark ${bot.kind}`}>
            {bot.kind === "ai" ? <FaBrain /> : bot.kind === "quant" ? <FaCalculator /> : <FaRobot />}
          </span>
          <div>
            <h2>{bot.name}</h2>
            <p>
              {bot.kind === "ai" ? "AI priced" : bot.kind === "quant" ? "Quant" : "Market maker"} ·{" "}
              {bot.asset === "BOTH" ? "BTC and ETH" : bot.asset}
              {bot.kind === "standard" && ` · ±${Math.round(bot.spread * 100)} cents`}
              {bot.kind === "ai" && " · five minute windows"} · {bot.stake} tUSDC a trade
            </p>
          </div>
        </div>

        <div className="bot-head-actions">
          <span className={bot.status === "running" ? "bot-state on" : "bot-state"}>
            {bot.status === "running" ? "Running" : "Paused"}
          </span>
          <button className="ghost-btn" onClick={toggle}>
            {bot.status === "running" ? <><FaPause /> Pause</> : <><FaPlay /> Run</>}
          </button>
          <button className="ghost-btn" onClick={() => onEdit(bot)}><FaPen /> Edit</button>
        </div>
      </div>

      {/* Which stretch every figure below is measured over. */}
      <div className="filter-row period-row">
        {(Object.keys(PERIODS) as PeriodKey[]).map((k) => (
          <button
            key={k}
            className={period === k ? "filter on" : "filter"}
            onClick={() => setPeriod(k)}
            aria-pressed={period === k}
          >
            {PERIODS[k].label}
          </button>
        ))}
      </div>

      <div className="stat-grid">
        <Stat
          label="Win rate"
          value={decided.length ? `${Math.round((wonCount / decided.length) * 100)}%` : "--"}
          tone={decided.length ? (wonCount / decided.length >= 0.5 ? "good" : "bad") : undefined}
        />
        <Stat
          label="Won"
          value={decided.length ? `+${wonTotal.toFixed(2)}` : "--"}
          tone={wonTotal > 0 ? "good" : undefined}
        />
        <Stat
          label="Lost"
          value={decided.length ? `-${lostTotal.toFixed(2)}` : "--"}
          tone={lostTotal > 0 ? "bad" : undefined}
        />
        <Stat
          label="Net P&L"
          value={decided.length ? `${orderPnl >= 0 ? "+" : ""}${orderPnl.toFixed(2)}` : "--"}
          tone={decided.length ? (orderPnl >= 0 ? "good" : "bad") : undefined}
        />
        <Stat label="Trades today" value={capped ? `${bot.tradesToday}/${bot.dailyTrades}` : String(bot.tradesToday)} />
        {/* Only an AI bot spends a model allowance. For the others the trade
            count above already carries the cap, and a second tile restating it
            as "allowance left" read as a separate AI budget they do not have. */}
        {bot.kind === "ai" && (
          <Stat
            label="Reads today"
            value={`${bot.readsToday}/${bot.dailyReads}`}
            tone={bot.dailyReads > 0 && bot.readsToday >= bot.dailyReads ? "bad" : undefined}
          />
        )}
        <Stat
          label="Trades left"
          value={
            funds.affordable !== null && (left === null || funds.affordable < left)
              ? `${funds.affordable} (funded)`
              : left === null
                ? "no cap"
                : String(left)
          }
          tone={funds.affordable === 0 || left === 0 ? "bad" : undefined}
        />
      </div>

      <div className="stat-grid">
        <Stat label="Filled" value={String(filledCount)} tone={filledCount > 0 ? "good" : undefined} />
        <Stat label="Settled orders" value={decided.length ? `${wonCount}/${decided.length} won` : "--"} />
        <Stat label="Resting" value={String(restingCount)} />
        <Stat label="Expired" value={String(expiredCount)} />
        <Stat
          label="Wallet"
          value={funds.balance === null ? "--" : `${funds.balance.toFixed(2)}`}
          tone={funds.balance !== null && funds.balance < bot.stake ? "bad" : undefined}
        />
      </div>

      {/* Neither a win nor a loss, so it never reaches P&L. Unsaid, the money
          just looks missing from the wallet. */}
      {locked.markets > 0 && (
        <p className="footnote">
          {locked.amount.toFixed(2)} tUSDC is stuck in {locked.markets}{" "}
          {locked.markets === 1 ? "market that expired" : "markets that expired"} without the venue naming a winner.
          It cannot be redeemed or counted as a result until the oracle resolves them.
        </p>
      )}

      {/* A bot that has run dry looks exactly like one with no view, so the
          binding limit is named rather than left to be inferred. */}
      {funds.affordable !== null && funds.affordable < 1 && (
        <p className="banner offline">
          Out of collateral. This bot holds {funds.balance?.toFixed(2)} tUSDC and stakes {bot.stake} a trade, so it
          cannot place another order until the wallet is topped up.
        </p>
      )}
      {funds.affordable !== null && funds.affordable >= 1 && capped && bot.dailyTrades - bot.tradesToday > funds.affordable && (
        <p className="footnote">
          Funding is the binding limit, not the daily cap: {funds.balance?.toFixed(2)} tUSDC covers {funds.affordable}{" "}
          more {funds.affordable === 1 ? "trade" : "trades"} at a {bot.stake} stake, while the cap allows{" "}
          {bot.dailyTrades - bot.tradesToday}.
        </p>
      )}

      <p className={bot.keyAddress ? "bot-signer set" : "bot-signer"}>
        <FaKey aria-hidden="true" />
        {bot.keyAddress
          ? `Signs as ${bot.keyAddress.slice(0, 10)}…${bot.keyAddress.slice(-6)}`
          : "No signing key stored — this bot cannot place an order"}
      </p>

      {bot.kind === "ai" && (
        <p className="footnote">
          <FaBrain aria-hidden="true" /> Prices from {bot.model ? bot.model.replace(/:free$/, "") : "the best available model"}.
          A window is only read while this bot is running and still has reads left, so switching it off is what
          saves the allowance. A window with no stored read is skipped rather than guessed at.
        </p>
      )}

      {stale && (
        <p className="banner offline">
          Could not refresh just now ({stale}). Showing the last figures loaded; this page retries every ten seconds.
        </p>
      )}

      {keyChanged && (
        <p className="banner offline">
          This bot has a record of trades, but none belong to the key it holds now. Orders stay with the key that
          signed them, so replacing a bot's key leaves its history behind.
        </p>
      )}

      <h3 className="section-head">Orders</h3>
      {/* The counter moves the moment an order is written; the table comes from
          the indexer, which is seconds behind. Saying so beats showing a count
          beside an empty table and letting it read as a contradiction. */}
      {period === "24h" && bot.tradesToday > inPeriod.length && (
        <p className="footnote">
          {bot.tradesToday - inPeriod.length} of today&rsquo;s {bot.tradesToday} orders have not reached the indexer yet.
          The count is written when an order is placed, the table when the venue reports it.
        </p>
      )}
      {inPeriod.length === 0 ? (
        <EmptyState
          title={bot.tradesToday > 0 ? "Waiting on the indexer" : "Nothing placed yet"}
          hint={
            bot.tradesToday > 0
              ? "Orders have been placed today but the venue has not reported them yet."
              : bot.status === "running"
                ? "The runner quotes on its next cycle."
                : "This bot is paused."
          }
        />
      ) : (
        <TableScroll label="Bot orders">
          <table className="table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th className="num">Price</th>
                <th className="num">Size</th>
                <th className="num">Filled</th>
                <th className="num">Status</th>
                <th className="num">Result</th>
                <th className="num">Placed</th>
              </tr>
            </thead>
            <tbody>
              {inPeriod.map((o) => (
                <tr key={o.orderId}>
                  <td>
                    <span className="asset-cell">
                      <AssetMark asset={o.asset} size={18} />
                      {o.asset} <span className="market-sub">{windowLabel(o.intervalSec)}</span>
                    </span>
                  </td>
                  <td>
                    <span className={`pos-side ${o.outcomeIndex === 0 ? "up" : "down"}`}>
                      {o.outcomeIndex === 0 ? "UP" : "DOWN"}
                    </span>
                  </td>
                  <td className="num">{Math.round(o.price * 100)}c</td>
                  <td className="num">{o.quantity.toFixed(2)}</td>
                  <td className={`num ${o.filled === 0 ? "muted-cell" : ""}`}>{o.filled.toFixed(2)}</td>
                  <td className="num">
                    {o.won === null ? (
                      <span className="muted-cell">--</span>
                    ) : (
                      <span className={o.won ? "pos-result win" : "pos-result loss"}>
                        {o.won ? "Won" : "Lost"} {o.pnl !== null && `${o.pnl >= 0 ? "+" : ""}${o.pnl.toFixed(2)}`}
                      </span>
                    )}
                  </td>
                  <td className="num muted-cell">{stamp(o.placedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      <p className="footnote">
        Result is what each fill is worth on its own: a winning share redeems at 1.00, so a buy filled at 44c makes 56c
        a share and a loser gives up the 44c it paid. Unfilled and still-open orders show no result. This counts what
        the window decided, whether or not the winnings have been claimed yet.
      </p>

      <p className="footnote">
        Orders are read from the venue against this bot's signing address, so anything else signed by that key appears
        here too. Give a bot its own key to keep its record clean.
      </p>
    </div>
  );
}

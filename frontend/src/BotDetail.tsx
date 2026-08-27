import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { FaBrain, FaCalculator, FaKey, FaPause, FaPen, FaPlay, FaRobot } from "react-icons/fa";
import { fetchBotActivity, saveBot, stamp, windowLabel, type Bot, type BotStats, type BotSummary, type OrderRow } from "./api";
import { AssetMark } from "./AssetMark";
import { TableScroll, EmptyState } from "./Table";

type Props = { botId: string; onBack: () => void; onEdit: (bot: Bot) => void };

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
  const [summary, setSummary] = useState<BotSummary | null>(null);
  const [stats, setStats] = useState<BotStats | null>(null);
  const [keyChanged, setKeyChanged] = useState(false);
  const [missing, setMissing] = useState(false);

  const load = useCallback(() => {
    if (!address) return;
    fetchBotActivity(address, botId).then((d) => {
      if (!d) return setMissing(true);
      setBot(d.bot);
      setOrders(d.orders);
      setSummary(d.summary);
      setStats(d.stats);
      setKeyChanged(d.keyChanged);
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

  // Orders whose window has closed and whose side we can price.
  const decided = orders.filter((o) => o.won !== null);
  const orderPnl = decided.reduce((sum, o) => sum + (o.pnl ?? 0), 0);

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

      <div className="stat-grid">
        <Stat
          label="Win rate"
          value={stats && stats.settled ? `${Math.round(stats.winRate * 100)}%` : "--"}
          tone={stats && stats.settled ? (stats.winRate >= 0.5 ? "good" : "bad") : undefined}
        />
        <Stat
          label="Realised P&L"
          value={stats ? `${stats.realised >= 0 ? "+" : ""}${stats.realised.toFixed(2)}` : "--"}
          tone={stats ? (stats.realised >= 0 ? "good" : "bad") : undefined}
        />
        <Stat
          label="Total loss"
          value={stats ? stats.lost.toFixed(2) : "--"}
          tone={stats && stats.lost > 0 ? "bad" : undefined}
        />
        <Stat label="Settled" value={stats ? String(stats.settled) : "--"} />
        <Stat label="Trades today" value={capped ? `${bot.tradesToday}/${bot.dailyTrades}` : String(bot.tradesToday)} />
        <Stat
          label="Allowance left"
          value={left === null ? "no cap" : String(left)}
          tone={left !== null && left === 0 ? "bad" : undefined}
        />
      </div>

      <div className="stat-grid">
        <Stat label="Filled" value={summary ? String(summary.filled) : "--"} tone={summary && summary.filled > 0 ? "good" : undefined} />
        <Stat
          label="Settled orders"
          value={decided.length ? `${decided.filter((o) => o.won).length}/${decided.length} won` : "--"}
        />
        <Stat
          label="From settled"
          value={decided.length ? `${orderPnl >= 0 ? "+" : ""}${orderPnl.toFixed(2)}` : "--"}
          tone={decided.length ? (orderPnl >= 0 ? "good" : "bad") : undefined}
        />
        <Stat label="Resting" value={summary ? String(summary.open) : "--"} />
        <Stat label="Expired" value={summary ? String(summary.expired) : "--"} />
        <Stat label="Volume filled" value={summary ? summary.volume.toFixed(2) : "--"} />
      </div>

      <p className={bot.keyAddress ? "bot-signer set" : "bot-signer"}>
        <FaKey aria-hidden="true" />
        {bot.keyAddress
          ? `Signs as ${bot.keyAddress.slice(0, 10)}…${bot.keyAddress.slice(-6)}`
          : "No signing key stored — this bot cannot place an order"}
      </p>

      {bot.kind === "ai" && (
        <p className="footnote">
          <FaBrain aria-hidden="true" /> Prices from {bot.model ? bot.model.replace(/:free$/, "") : "the best available model"}.
          A window with no stored read is skipped rather than asking the model on a timer.
        </p>
      )}

      {keyChanged && (
        <p className="banner offline">
          This bot has a record of trades, but none belong to the key it holds now. Orders stay with the key that
          signed them, so replacing a bot's key leaves its history behind.
        </p>
      )}

      <h3 className="section-head">Orders</h3>
      {orders.length === 0 ? (
        <EmptyState
          title="Nothing placed yet"
          hint={bot.status === "running" ? "The runner quotes on its next cycle." : "This bot is paused."}
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
              {orders.map((o) => (
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

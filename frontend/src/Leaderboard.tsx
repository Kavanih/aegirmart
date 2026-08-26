import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { FaChartLine, FaExchangeAlt, FaUsers } from "react-icons/fa";
import { fetchLeaderboard, fetchStats, shortAddress, type Trader, type VenueStats } from "./api";
import { TableScroll, TableSkeleton, EmptyState } from "./Table";

function VenueBanner({ venue }: { venue: VenueStats | null }) {
  const cells = [
    { icon: <FaChartLine />, label: "Volume traded", value: venue ? `${venue.volume.toFixed(2)} tUSDC` : "--" },
    { icon: <FaExchangeAlt />, label: "Trades", value: venue ? venue.trades.toLocaleString() : "--" },
    { icon: <FaUsers />, label: "Traders", value: venue ? venue.traders.toLocaleString() : "--" },
  ];

  return (
    <div className="venue-banner">
      {cells.map((c) => (
        <div key={c.label} className="venue-cell">
          <span className="venue-icon">{c.icon}</span>
          <div>
            <span className="venue-value">{c.value}</span>
            <span className="venue-label">{c.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Leaderboard() {
  const [traders, setTraders] = useState<Trader[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [venue, setVenue] = useState<VenueStats | null>(null);
  const { address } = useAccount();

  useEffect(() => {
    let alive = true;
    const load = () => fetchStats().then((d) => alive && d && setVenue(d.venue)).catch(() => undefined);
    load();
    const poll = window.setInterval(load, 20_000);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetchLeaderboard()
      .then((rows) => alive && setTraders(rows))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const frame = (body: JSX.Element) => (
    <div className="page">
      <div className="page-head">
        <h2>Leaderboard</h2>
      </div>
      <VenueBanner venue={venue} />
      {body}
    </div>
  );

  if (failed) return frame(<EmptyState title="Leaderboard unavailable" hint="The indexer did not respond." />);

  if (!traders) return frame(<TableSkeleton columns={["Trader", "Settled", "Wins", "Win rate", "Size"]} rows={6} />);
  if (traders.length === 0) {
    return frame(<EmptyState title="No settled positions yet" hint="Rankings appear once windows close." />);
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Leaderboard</h2>
        <p>Ranked by wins across settled windows</p>
      </div>

      <TableScroll label="Leaderboard">
      <table className="table">
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>Trader</th>
            <th className="num">Settled</th>
            <th className="num">Wins</th>
            <th className="num">Win rate</th>
            <th className="num">Size</th>
          </tr>
        </thead>
        <tbody>
          {traders.map((trader, i) => {
            const isYou = address?.toLowerCase() === trader.account.toLowerCase();
            return (
              <tr key={trader.account}>
                <td className="rank">{i + 1}</td>
                <td className={`addr-cell ${isYou ? "you" : ""}`}>
                  {shortAddress(trader.account)}
                  {isYou && " (you)"}
                </td>
                <td className="num">{trader.settled}</td>
                <td className="num">{trader.wins}</td>
                <td className={`num ${trader.winRate >= 0.5 ? "rate-good" : "rate-bad"}`}>
                  {Math.round(trader.winRate * 100)}%
                </td>
                <td className="num">{trader.volume.toFixed(0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </TableScroll>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { fetchLeaderboard, shortAddress, type Trader } from "./api";
import { TableScroll, TableSkeleton, EmptyState } from "./Table";

export function Leaderboard() {
  const [traders, setTraders] = useState<Trader[] | null>(null);
  const [failed, setFailed] = useState(false);
  const { address } = useAccount();

  useEffect(() => {
    let alive = true;
    fetchLeaderboard()
      .then((rows) => alive && setTraders(rows))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  if (failed) return <EmptyState title="Leaderboard unavailable" hint="The indexer did not respond." />;

  if (!traders) {
    return (
      <div className="page">
        <div className="page-head">
          <h2>Leaderboard</h2>
        </div>
        <TableSkeleton columns={["Trader", "Settled", "Wins", "Win rate", "Size"]} rows={6} />
      </div>
    );
  }

  if (traders.length === 0) {
    return <EmptyState title="No settled positions yet" hint="Rankings appear once windows close." />;
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

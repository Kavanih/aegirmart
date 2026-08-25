import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { fetchPositions, money, shortAddress, windowLabel, type Position } from "./api";
import { useClaim } from "./wallet/useClaim";
import { fmt, PAYOUT_PER_SHARE } from "./payout";
import { useToast } from "./Toast";
import { TableScroll, TableSkeleton, EmptyState } from "./Table";

const TABS = ["Positions", "History", "Activity"] as const;
type Tab = (typeof TABS)[number];
type AssetFilter = "All" | "BTC" | "ETH";

const EXPLORER = "https://shannon-explorer.somnia.network/tx";

/** Shares to price against: a redeemed win has no balance left to read. */
function sharesOf(position: Position): number {
  return position.size > 0 ? position.size : position.shares ?? 0;
}

function outcomeOf(position: Position) {
  if (!position.finalized || position.winningOutcome === null) return "open" as const;
  return position.outcomeIndex === position.winningOutcome ? ("won" as const) : ("lost" as const);
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone ?? ""}`}>{value}</span>
    </div>
  );
}

export function Portfolio() {
  const { address, isConnected } = useAccount();
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<Tab>("Positions");
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("All");
  const [claimed, setClaimed] = useState<Set<string>>(() => new Set());

  const { claim, claiming } = useClaim();
  const toast = useToast();

  const load = () => {
    if (!address) return;
    setPositions(null);
    setFailed(false);
    fetchPositions(address).then(setPositions).catch(() => setFailed(true));
  };

  useEffect(load, [address]);

  const stats = useMemo(() => {
    const rows = positions ?? [];
    const settled = rows.filter((p) => outcomeOf(p) !== "open");
    const won = settled.filter((p) => outcomeOf(p) === "won");
    // Already redeemed on chain, or redeemed in this session: not claimable.
    const claimable = won.filter((p) => !p.claimed && !claimed.has(p.outcomeId));
    return {
      open: rows.filter((p) => outcomeOf(p) === "open").length,
      settled: settled.length,
      winRate: settled.length ? won.length / settled.length : 0,
      claimable: claimable.reduce((sum, p) => sum + sharesOf(p) * PAYOUT_PER_SHARE, 0),
      realised: settled.reduce((sum, p) => sum + (p.pnl ?? 0), 0),
      staked: rows.reduce((sum, p) => sum + (p.cost ?? 0), 0),
      atRisk: rows.filter((p) => outcomeOf(p) === "open").reduce((sum, p) => sum + p.size * PAYOUT_PER_SHARE, 0),
    };
  }, [positions, claimed]);

  const filtered = useMemo(() => {
    const rows = positions ?? [];
    const byAsset = assetFilter === "All" ? rows : rows.filter((p) => p.asset === assetFilter);
    if (tab === "History") return byAsset.filter((p) => outcomeOf(p) !== "open");
    if (tab === "Positions") return byAsset.filter((p) => outcomeOf(p) === "open");
    return byAsset;
  }, [positions, assetFilter, tab]);

  const onClaim = (position: Position) => {
    const id = toast.push("pending", `Claiming ${position.asset} ${position.outcomeIndex === 0 ? "UP" : "DOWN"}`);
    claim(position.poolAddress, position.outcomeId, sharesOf(position), (phase, detail) => {
      if (phase === "sent") toast.update(id, "pending", "Waiting for confirmation", `${EXPLORER}/${detail}`);
      else if (phase === "done") {
        toast.update(id, "success", `Claimed ${sharesOf(position).toFixed(2)} ${position.asset}`, `${EXPLORER}/${detail}`);
        setClaimed((prev) => new Set(prev).add(position.outcomeId));
        load();
      } else toast.update(id, "error", detail);
    });
  };

  if (!isConnected) {
    return (
      <EmptyState title="Connect a wallet" hint="Your positions and settled history load from the chain once connected." />
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Profile</h2>
          <p>{address ? shortAddress(address) : ""} on Somnia testnet</p>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="Open positions" value={String(stats.open)} />
        <StatCard label="Settled" value={String(stats.settled)} />
        <StatCard
          label="Win rate"
          value={stats.settled ? `${Math.round(stats.winRate * 100)}%` : "--"}
          tone={stats.settled ? (stats.winRate >= 0.5 ? "good" : "bad") : undefined}
        />
        <StatCard
          label="Realised P&L"
          value={`${stats.realised >= 0 ? "+" : ""}${fmt(stats.realised)}`}
          tone={stats.realised >= 0 ? "good" : "bad"}
        />
        <StatCard label="Open payout" value={fmt(stats.atRisk)} />
        <StatCard
          label="Unclaimed"
          value={fmt(stats.claimable)}
          tone={stats.claimable > 0 ? "good" : undefined}
        />
      </div>

      <div className="filter-row">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? "filter on" : "filter"} aria-pressed={t === tab} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <span className="filter-divider" />
        {(["All", "BTC", "ETH"] as AssetFilter[]).map((f) => (
          <button key={f} className={f === assetFilter ? "filter on" : "filter"} aria-pressed={f === assetFilter} onClick={() => setAssetFilter(f)}>
            {f}
          </button>
        ))}
      </div>

      {failed && <EmptyState title="History unavailable" hint="The indexer did not respond." />}
      {!failed && !positions && (
        <TableSkeleton columns={["Market", "Side", "Shares", "Avg", "Cost", "Pays", "P&L"]} rows={4} />
      )}

      {positions && !failed && (
        filtered.length === 0 ? (
          <EmptyState
            title="Nothing here yet"
            hint={tab === "Positions" ? "Swipe a card to take your first side." : "Settled windows will appear here."}
          />
        ) : (
          <TableScroll label="Positions">
          <table className="table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th className="num">Target</th>
                <th className="num">Shares</th>
                <th className="num">Avg</th>
                <th className="num">Cost</th>
                <th className="num">Pays</th>
                <th className="num">P&L</th>
                <th className="num">Result</th>
                <th className="num">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((position) => {
                const outcome = outcomeOf(position);
                const isClaimed = position.claimed || claimed.has(position.outcomeId);
                const busy = claiming === position.outcomeId;
                return (
                  <tr key={`${position.marketId}-${position.outcomeIndex}`}>
                    <td>
                      {position.asset} <span className="market-sub">{windowLabel(position.intervalSec)}</span>
                    </td>
                    <td>
                      <span className={`pos-side ${position.outcomeIndex === 0 ? "up" : "down"}`}>
                        {position.outcomeIndex === 0 ? "UP" : "DOWN"}
                      </span>
                    </td>
                    <td className="num">${money(position.strike)}</td>
                    <td className="num">{fmt(sharesOf(position))}</td>
                    <td className="num muted-cell">
                      {position.averagePrice === null ? "--" : `${Math.round(position.averagePrice * 100)}c`}
                    </td>
                    <td className="num">{position.cost === null ? "--" : fmt(position.cost)}</td>
                    <td className={`num ${outcome === "lost" ? "muted-cell" : ""}`}>
                      {outcome === "lost" ? "0.00" : fmt(sharesOf(position) * PAYOUT_PER_SHARE)}
                    </td>
                    <td className={`num pnl ${position.pnl === null ? "" : position.pnl >= 0 ? "win" : "loss"}`}>
                      {position.pnl === null ? "--" : `${position.pnl >= 0 ? "+" : ""}${fmt(position.pnl)}`}
                    </td>
                    <td className={`num pos-result ${outcome === "won" ? "win" : outcome === "lost" ? "loss" : "open"}`}>
                      {outcome === "won" ? "Won" : outcome === "lost" ? "Lost" : "Open"}
                    </td>
                    <td className="num">
                      {outcome === "won" && !isClaimed ? (
                        <button className="claim" onClick={() => onClaim(position)} disabled={busy}>
                          {busy ? "Claiming" : "Claim"}
                        </button>
                      ) : (
                        <span className="muted-cell">{isClaimed ? "Claimed" : "-"}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </TableScroll>
        )
      )}
    </div>
  );
}

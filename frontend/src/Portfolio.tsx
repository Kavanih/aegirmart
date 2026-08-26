import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { fetchOrders, fetchPositions, money, shortAddress, stamp, windowLabel, type OrderRow, type Position } from "./api";
import { useClaim } from "./wallet/useClaim";
import { fmt, PAYOUT_PER_SHARE } from "./payout";
import { useToast } from "./Toast";
import { TableScroll, TableSkeleton, EmptyState } from "./Table";
import { AssetMark } from "./AssetMark";

const TABS = ["Positions", "Orders", "History"] as const;
type Tab = (typeof TABS)[number];
type AssetFilter = "All" | "BTC" | "ETH";

/**
 * Sort options differ per tab because the columns do: an order has no P&L, and
 * an open position has no result to rank by.
 */
const SORTS = {
  Positions: ["Newest", "Oldest", "Largest"],
  Orders: ["Newest", "Oldest", "Largest", "Filled first"],
  History: ["Newest", "Oldest", "Best result", "Worst result", "Unclaimed first"],
} as const;

type Sort = (typeof SORTS)[Tab][number];

const EXPLORER = "https://shannon-explorer.somnia.network/tx";

/** Shares to price against: a redeemed win has no balance left to read. */
function sharesOf(position: Position): number {
  return position.size > 0 ? position.size : position.shares ?? 0;
}

function outcomeOf(position: Position) {
  if (!position.finalized || position.winningOutcome === null) return "open" as const;
  return position.outcomeIndex === position.winningOutcome ? ("won" as const) : ("lost" as const);
}

/**
 * Orders, filled or not. A resting limit order leaves no outcome balance until
 * something crosses it, so this is the only place an unfilled order is visible.
 */
function OrdersTable({ orders }: { orders: OrderRow[] | null }) {
  if (!orders) return <TableSkeleton columns={["Market", "Side", "Price", "Size", "Filled", "Status", "Placed"]} rows={4} />;
  if (orders.length === 0) {
    return <EmptyState title="No orders yet" hint="Swiping a card places a resting limit order at the model's price." />;
  }

  return (
    <TableScroll label="Orders">
      <table className="table">
        <thead>
          <tr>
            <th>Market</th>
            <th>Side</th>
            <th className="num">Target</th>
            <th className="num">Price</th>
            <th className="num">Size</th>
            <th className="num">Filled</th>
            <th className="num">Status</th>
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
              <td className="num">${money(o.strike)}</td>
              <td className="num">{Math.round(o.price * 100)}c</td>
              <td className="num">{fmt(o.quantity)}</td>
              <td className={`num ${o.filled === 0 ? "muted-cell" : ""}`}>{fmt(o.filled)}</td>
              <td className={`num order-status ${o.status.toLowerCase()}`}>{o.status}</td>
              <td className="num muted-cell">{stamp(o.placedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function StatCard({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone ?? ""}`}>{value}</span>
    </>
  );

  if (!onClick) return <div className="stat-card">{body}</div>;
  return (
    <button className="stat-card as-action" onClick={onClick} title={`Show ${label.toLowerCase()}`}>
      {body}
    </button>
  );
}

export function Portfolio() {
  const { address, isConnected } = useAccount();
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<Tab>("Positions");
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("All");
  const [sort, setSort] = useState<Sort>("Newest");
  const [claimed, setClaimed] = useState<Set<string>>(() => new Set());
  const [orders, setOrders] = useState<OrderRow[] | null>(null);

  const { claim, claiming } = useClaim();
  const toast = useToast();

  const load = () => {
    if (!address) return;
    setPositions(null);
    setFailed(false);
    fetchPositions(address).then(setPositions).catch(() => setFailed(true));
    fetchOrders(address).then(setOrders).catch(() => setOrders([]));
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
      // What the settled book actually cost, as a positive figure. Realised P&L
      // already nets this off against the wins; this is the losing half alone.
      lost: settled.reduce((sum, p) => sum + Math.min(0, p.pnl ?? 0), 0) * -1,
    };
  }, [positions, claimed]);

  const filtered = useMemo(() => {
    const rows = positions ?? [];
    const byAsset = assetFilter === "All" ? rows : rows.filter((p) => p.asset === assetFilter);
    const rowsForTab =
      tab === "History"
        ? byAsset.filter((p) => outcomeOf(p) !== "open")
        : byAsset.filter((p) => outcomeOf(p) === "open");

    const pnl = (p: Position) => p.pnl ?? 0;
    // A win still sitting on chain: what the Unclaimed stat counts, and the
    // only rows with a Claim button.
    const owed = (p: Position) =>
      outcomeOf(p) === "won" && !p.claimed && !claimed.has(p.outcomeId) ? 1 : 0;

    return [...rowsForTab].sort((a, b) => {
      if (sort === "Oldest") return a.expiry - b.expiry;
      if (sort === "Largest") return sharesOf(b) - sharesOf(a);
      if (sort === "Best result") return pnl(b) - pnl(a);
      if (sort === "Worst result") return pnl(a) - pnl(b);
      if (sort === "Unclaimed first") return owed(b) - owed(a) || sharesOf(b) - sharesOf(a);
      return b.expiry - a.expiry;
    });
  }, [positions, assetFilter, tab, sort, claimed]);

  const sortedOrders = useMemo(() => {
    const rows = (orders ?? []).filter((o) => assetFilter === "All" || o.asset === assetFilter);
    return [...rows].sort((a, b) => {
      if (sort === "Oldest") return a.placedAt - b.placedAt;
      if (sort === "Largest") return b.quantity - a.quantity;
      if (sort === "Filled first") return b.filled - a.filled || b.placedAt - a.placedAt;
      return b.placedAt - a.placedAt;
    });
  }, [orders, assetFilter, sort]);

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
        <StatCard label="Total loss" value={fmt(stats.lost)} tone={stats.lost > 0 ? "bad" : undefined} />
        <StatCard
          label="Unclaimed"
          value={fmt(stats.claimable)}
          tone={stats.claimable > 0 ? "good" : undefined}
          onClick={
            stats.claimable > 0
              ? () => {
                  setTab("History");
                  setSort("Unclaimed first");
                }
              : undefined
          }
        />
      </div>

      <div className="filter-row">
        {TABS.map((t) => (
          <button
            key={t}
            className={t === tab ? "filter on" : "filter"}
            aria-pressed={t === tab}
            onClick={() => {
              setTab(t);
              if (!(SORTS[t] as readonly string[]).includes(sort)) setSort("Newest");
            }}
          >
            {t}
          </button>
        ))}
        <span className="filter-divider" />
        {(["All", "BTC", "ETH"] as AssetFilter[]).map((f) => (
          <button key={f} className={f === assetFilter ? "filter on" : "filter"} aria-pressed={f === assetFilter} onClick={() => setAssetFilter(f)}>
            {f}
          </button>
        ))}

        <label className="sort-control">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {SORTS[tab].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>

      {failed && <EmptyState title="History unavailable" hint="The indexer did not respond." />}
      {!failed && !positions && tab !== "Orders" && (
        <TableSkeleton columns={["Market", "Side", "Shares", "Avg", "Cost", "Pays", "P&L"]} rows={4} />
      )}

      {tab === "Orders" && <OrdersTable orders={orders && sortedOrders} />}

      {tab !== "Orders" && positions && !failed && (
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
                {tab === "History" && <th className="num">Settled</th>}
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
                      <span className="asset-cell">
                        <AssetMark asset={position.asset} size={18} />
                        {position.asset} <span className="market-sub">{windowLabel(position.intervalSec)}</span>
                      </span>
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
                    {tab === "History" && <td className="num muted-cell">{stamp(position.expiry)}</td>}
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

import { Logo } from "./Logo";

export type View = "markets" | "swipe" | "accuracy" | "leaderboard" | "portfolio" | "bot" | "pricing";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const Icon = {
  markets: () => (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><path d="M3 17l5-5 4 3 6-7" /><path d="M15 8h4v4" /></svg>
  ),
  swipe: () => (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="2.5" /><path d="M9.5 8.5L12 6l2.5 2.5" /></svg>
  ),
  accuracy: () => (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.6" /><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3" /></svg>
  ),
  leaderboard: () => (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><path d="M5 20V11M12 20V4M19 20v-6" /></svg>
  ),
  pricing: () => (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><path d="M12 3l2.4 5.3 5.6.6-4.2 3.9 1.2 5.7L12 15.8 6.9 18.5l1.2-5.7L4 8.9l5.6-.6z" /></svg>
  ),
  bot: () => (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><rect x="4" y="8" width="16" height="11" rx="2.5" /><path d="M12 8V4.5M9 13h.01M15 13h.01M9.5 16h5" /></svg>
  ),
  portfolio: () => (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7" /></svg>
  ),
};

const TRADE: { id: View; label: string }[] = [
  { id: "markets", label: "Markets" },
  { id: "swipe", label: "Swipe" },
  { id: "accuracy", label: "AI Scoreboard" },
  { id: "leaderboard", label: "Leaderboard" },
];

const ACCOUNT: { id: View; label: string }[] = [
  { id: "portfolio", label: "Positions" },
  { id: "bot", label: "Bots" },
  { id: "pricing", label: "Plans" },
];

type Props = { view: View; onSelect: (view: View) => void };

export function Sidebar({ view, onSelect }: Props) {
  const item = (entry: { id: View; label: string }) => {
    const Glyph = Icon[entry.id];
    return (
      <li key={entry.id}>
        <button
          className={view === entry.id ? "nav-item on" : "nav-item"}
          onClick={() => onSelect(entry.id)}
          aria-current={view === entry.id ? "page" : undefined}
        >
          <span className="nav-glyph"><Glyph /></span>
          <span className="nav-label">{entry.label}</span>
        </button>
      </li>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <Logo onClick={() => onSelect("markets")} />
      </div>

      <nav aria-label="Sections">
        <ul className="nav-list">{TRADE.map(item)}</ul>

        <p className="nav-section">Portfolio</p>
        <ul className="nav-list">{ACCOUNT.map(item)}</ul>
      </nav>

      <div className="sidebar-foot">
        <p className="sidebar-note">
          Somnia testnet. Model estimates have no verified track record. Market price is the real odd.
        </p>
      </div>
    </aside>
  );
}

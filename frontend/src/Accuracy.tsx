import { useEffect, useState } from "react";
import { fetchAccuracy, fetchHealth, money, windowLabel, type Health, type ModelLatency, type ModelScore, type PredictionRecord } from "./api";
import { fmt } from "./payout";
import { TableScroll, TableSkeleton, EmptyState } from "./Table";
import { AssetMark } from "./AssetMark";
import { FaBrain, FaCalculator, FaRobot } from "react-icons/fa";
import { fetchStats, type StrategyRow } from "./api";

const STRATEGY_META = {
  standard: { name: "Market maker", icon: <FaRobot /> },
  quant: { name: "Quant", icon: <FaCalculator /> },
  ai: { name: "AI", icon: <FaBrain /> },
} as const;

function shortModel(id: string): string {
  return id.replace(/:free$/, "").split("/").pop() ?? id;
}

function when(seconds: number): string {
  const delta = Math.floor(Date.now() / 1000) - seconds;
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

export function Accuracy() {
  const [data, setData] = useState<{ records: PredictionRecord[]; models: ModelScore[]; latency: ModelLatency[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [strategies, setStrategies] = useState<StrategyRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchHealth().then((h) => alive && setHealth(h)).catch(() => undefined);
      fetchStats().then((d) => alive && d && setStrategies(d.strategies)).catch(() => undefined);
      return fetchAccuracy().then((d) => alive && setData(d)).catch(() => alive && setFailed(true));
    };
    load();
    const poll = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, []);

  if (failed) return <EmptyState title="Scoreboard unavailable" hint="The service did not respond." />;

  if (!data) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <h2>Model scoreboard</h2>
            <p>Every prediction is made when the window opens and scored when it settles.</p>
          </div>
        </div>
        <TableSkeleton columns={["Model", "Scored", "Correct", "Accuracy", "Brier"]} />
      </div>
    );
  }

  const scored = data.records.filter((r) => r.correct !== null);
  const hits = scored.filter((r) => r.correct).length;

  // A model that has never been asked has no speed to report. Listing it puts
  // rows of zeroes above the models that actually have a record.
  const latency = data.latency ?? [];
  const called = latency.filter((l) => l.ok + l.fail > 0);
  const untried = latency.length - called.length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Model scoreboard</h2>
          <p>Every prediction is made when the window opens and scored when it settles. Last 100 kept.</p>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="Scored" value={String(scored.length)} />
        <StatCard label="Awaiting settlement" value={String(data.records.length - scored.length)} />
        <StatCard
          label="Overall accuracy"
          value={scored.length ? `${Math.round((hits / scored.length) * 100)}%` : "--"}
          tone={scored.length ? (hits / scored.length >= 0.5 ? "good" : "bad") : undefined}
        />
        <StatCard label="Models tried" value={String(data.models.length)} />
        {health && (
          <StatCard
            label="Free allowance"
            value={`${health.freeQuota.remaining}/${health.freeQuota.limit}`}
            tone={health.freeQuota.remaining === 0 ? "bad" : undefined}
          />
        )}
      </div>

      <h3 className="section-head">Strategy record</h3>
      <div className="strategy-grid">
        {(strategies ?? []).map((row) => {
          const meta = STRATEGY_META[row.kind];
          // A market maker holds both legs on purpose, so "was it right" is
          // not a question about it. Report the count, not a hollow rate.
          const rateless = row.kind === "standard";
          return (
            <article key={row.kind} className="strategy-card">
              <header>
                <span className={`bot-mark ${row.kind}`}>{meta.icon}</span>
                <h4>{meta.name}</h4>
              </header>
              {rateless ? (
                <span className="strategy-rate none">No direction taken</span>
              ) : (
                <span className={`strategy-rate ${(row.winRate ?? 0) >= 0.5 ? "good" : "bad"}`}>
                  {row.settled === 0 || row.winRate === null
                    ? "Not settled yet"
                    : `${Math.round(row.winRate * 100)}%`}
                </span>
              )}
              <span className="strategy-meta">
                {row.trades} trade{row.trades === 1 ? "" : "s"}
                {!rateless && row.settled > 0 && ` · ${row.won} of ${row.settled} settled correct`}
              </span>
            </article>
          );
        })}
      </div>
      <p className="footnote">
        Counted per strategy rather than per wallet, because several bots can share one signing key and look like a
        single trader on chain. A market maker quotes both sides deliberately, so it has no direction to be right about.
      </p>

      {data.models.length > 0 && (
        <>
          <h3 className="section-head">Ranked by accuracy</h3>
          <TableScroll label="Model rankings">
            <table className="table">
            <thead>
              <tr>
                <th className="rank">#</th>
                <th>Model</th>
                <th className="num">Scored</th>
                <th className="num">Correct</th>
                <th className="num">Accuracy</th>
                <th className="num">Brier</th>
                <th className="num">Pending</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((m, i) => (
                <tr key={m.model}>
                  <td className="rank">{i + 1}</td>
                  <td className="model-cell">{shortModel(m.model)}</td>
                  <td className="num">{m.scored}</td>
                  <td className="num">{m.correct}</td>
                  <td className={`num ${m.scored === 0 ? "muted-cell" : m.accuracy >= 0.5 ? "rate-good" : "rate-bad"}`}>
                    {m.scored ? `${Math.round(m.accuracy * 100)}%` : "--"}
                  </td>
                  <td className="num muted-cell">{m.scored ? fmt(m.brier, 3) : "--"}</td>
                  <td className="num muted-cell">{m.pending}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </TableScroll>
          <p className="footnote">
            Brier score is the mean squared error of the probability against the result. Lower is better; 0.25 is what
            you get by always saying fifty percent.
          </p>
        </>
      )}

      {called.length > 0 && (
        <>
          <h3 className="section-head">Provider speed</h3>
          <TableScroll label="Provider speed">
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="num">Answered</th>
                  <th className="num">Failed</th>
                  <th className="num">Avg latency</th>
                  <th className="num">State</th>
                </tr>
              </thead>
              <tbody>
                {called.map((l) => {
                  const cooling = l.rateLimitedUntil > Date.now();
                  return (
                    <tr key={l.model}>
                      <td className="model-cell">{shortModel(l.model)}</td>
                      <td className="num">{l.ok}</td>
                      <td className="num muted-cell">{l.fail}</td>
                      <td className="num">{l.ok ? `${(l.avgMs / 1000).toFixed(1)}s` : "--"}</td>
                      <td className={`num ${cooling ? "rate-bad" : l.ok ? "rate-good" : "muted-cell"}`}>
                        {cooling ? "cooling off" : l.ok ? "ready" : "untried"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
          <p className="footnote">
            Providers are asked fastest first. A model that rate limits is skipped for five minutes rather than
            demoted permanently, so the pool keeps exploring.
            {untried > 0 && ` ${untried} more ${untried === 1 ? "model has" : "models have"} not been called yet.`}
          </p>
        </>
      )}

      <h3 className="section-head">Recent predictions</h3>
      {data.records.length === 0 ? (
        <EmptyState
          title="No predictions yet"
          hint={
            health && health.freeQuota.remaining === 0
              ? "The day's free model allowance is spent, so the tracker is not reading new windows. It resumes when the allowance resets at 00:00 UTC."
              : health && !health.keyConfigured
                ? "No model key is configured, so the tracker cannot read a window."
                : "The tracker predicts each window as it opens. Check back in a minute."
          }
        />
      ) : (
        <TableScroll label="Recent predictions">
        <table className="table">
          <thead>
            <tr>
              <th>Market</th>
              <th>Called</th>
              <th className="num">Confidence</th>
              <th className="num">Outcome</th>
              <th className="num">Result</th>
              <th>Model</th>
              <th className="num">When</th>
            </tr>
          </thead>
          <tbody>
            {data.records.map((r) => (
              <tr key={r.marketId}>
                <td>
                  <span className="asset-cell">
                    <AssetMark asset={r.asset} size={18} />
                    {r.asset} <span className="market-sub">{windowLabel(r.intervalSec)}</span>
                    <span className="strike-cell">${money(r.strike)}</span>
                  </span>
                </td>
                <td>
                  {r.side === "none" ? (
                    <span className="muted-cell">no call</span>
                  ) : (
                    <span className={`pos-side ${r.side}`}>{r.side.toUpperCase()}</span>
                  )}
                  <span className="prob-cell">{Math.round(r.probability * 100)}%</span>
                </td>
                <td className="num muted-cell">{r.confidence}</td>
                <td className="num">
                  {r.outcome ? <span className={`pos-side ${r.outcome}`}>{r.outcome.toUpperCase()}</span> : <span className="muted-cell">pending</span>}
                </td>
                <td className={`num pos-result ${r.correct === null ? "open" : r.correct ? "win" : "loss"}`}>
                  {r.side === "none" ? "not scored" : r.correct === null ? "--" : r.correct ? "Hit" : "Miss"}
                </td>
                <td className="model-cell">{shortModel(r.model)}</td>
                <td className="num muted-cell">{when(r.predictedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </TableScroll>
      )}

      <p className="footnote">
        A read within five cents of a coin flip makes <strong>no call</strong> and is not scored. Counting those as an
        up call meant a model was credited with a hit every time the market happened to rise, which flattered every
        score on this page.
      </p>

      <p className="footnote">
        <strong>A hit here does not mean a bot made money.</strong> This table scores the model's view of the outcome.
        A bot trades the gap between that view and the price, so when the other leg is the cheap one it buys the side
        the model did not call — and then a correct model and a losing trade are the same window. Bot results live on
        the bot's own page.
      </p>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone ?? ""}`}>{value}</span>
    </div>
  );
}

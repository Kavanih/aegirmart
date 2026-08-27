import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import {
  FaBrain, FaCalculator, FaChartLine, FaCoins, FaCrown, FaKey, FaPause, FaPen, FaPlay, FaPlus, FaRobot,
  FaSlidersH, FaTrash,
} from "react-icons/fa";
import { fetchBooks, fetchBots, removeBot, saveBot, type Bot, type BotLimits, type MarketBook, type Plan } from "./api";
import { BotForm } from "./BotForm";
import { BotDetail } from "./BotDetail";
import { EmptyState } from "./Table";

const KIND_MARK = { standard: <FaRobot />, quant: <FaCalculator />, ai: <FaBrain /> } as const;
const KIND_NAME = { standard: "Market maker", quant: "Quant", ai: "AI priced" } as const;

function shortModel(id: string | null): string {
  if (!id) return "best available";
  return id.replace(/:free$/, "").split("/").pop() ?? id;
}

export function BotPage() {
  const [openBotId, setOpenBotId] = useState<string | null>(() => {
    const m = window.location.hash.match(/^#\/bot\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  });
  const { address } = useAccount();
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [limits, setLimits] = useState<BotLimits | null>(null);
  const [books, setBooks] = useState<MarketBook[]>([]);
  const [editing, setEditing] = useState<Bot | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    if (!address) return;
    fetchBots(address).then((d) => {
      if (!d) return;
      setBots(d.bots);
      setPlan(d.plan);
      setLimits(d.limits);
    });
  }, [address]);

  useEffect(load, [load]);

  useEffect(() => {
    let alive = true;
    const poll = () => fetchBooks().then((b) => alive && setBooks(b));
    poll();
    const id = window.setInterval(poll, 8_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const quoted = useMemo(() => books.filter((b) => b.bids.length && b.asks.length).length, [books]);

  const toggle = async (bot: Bot) => {
    if (!address) return;
    await saveBot(address, { status: bot.status === "running" ? "paused" : "running" }, bot.id);
    load();
  };

  const drop = async (bot: Bot) => {
    if (!address) return;
    await removeBot(address, bot.id);
    load();
  };

  if (!address) {
    return <EmptyState title="Connect a wallet" hint="Bots are stored against the account that owns them." />;
  }

  if (openBotId) {
    return (
      <BotDetail
        botId={openBotId}
        onBack={() => {
          setOpenBotId(null);
          window.history.replaceState(null, "", "#/bot");
          load();
        }}
        onEdit={(bot) => {
          setEditing(bot);
          setOpen(true);
        }}
      />
    );
  }

  // Starter is a paid tier too. Testing only for "pro" showed a paying
  // Starter account a Free badge and an upsell for what it had already bought.
  const tier = plan?.plan ?? "free";
  const paid = tier !== "free";
  const tierName = tier === "pro" ? "Pro" : tier === "starter" ? "Starter" : "Free plan";
  const atLimit = Boolean(bots && limits && bots.length >= limits.maxBots);
  const running = (bots ?? []).filter((b) => b.status === "running").length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Bots</h2>
          <p>
            Quoting strategies you own. {books.length > 0 && `${quoted}/${books.length} live contracts are quoted right now.`}
          </p>
        </div>

        <div className="bot-head-actions">
          <span className={paid ? "plan-pill pro" : "plan-pill"}>
            {paid ? <><FaCrown /> {tierName}</> : tierName}
          </span>
          <button
            className="cta"
            disabled={atLimit}
            title={atLimit && limits ? `A wallet can hold ${limits.maxBots} bots for now` : "Create a bot"}
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <FaPlus /> New bot
          </button>
        </div>
      </div>

      {!paid && (
        <div className="pro-banner">
          <FaCrown className="pro-mark" aria-hidden="true" />
          <div>
            <strong>Directional bots are a paid feature</strong>
            <p>
              A market maker quotes both sides and takes no view. A paid plan unlocks the two that pick a side: Quant
              prices the contract itself, AI backs a model's read. From 15 tUSDC a month.
            </p>
          </div>
          <button className="ghost-btn" onClick={() => { window.location.hash = "#/pricing"; }}>See plans</button>
        </div>
      )}

      {bots === null ? (
        <p className="read-idle">Loading bots…</p>
      ) : bots.length === 0 ? (
        <EmptyState title="No bots yet" hint="A bot holds the settings a strategy runs with: market, stake, spread and a daily cap." />
      ) : (
        <div className="bot-grid">
          {bots.map((bot) => (
            <article key={bot.id} className={`bot-card ${bot.status}`}>
              <button
                className="bot-open"
                onClick={() => {
                  setOpenBotId(bot.id);
                  window.history.replaceState(null, "", `#/bot/${bot.id}`);
                }}
                aria-label={`Open ${bot.name}`}
              />
              <header>
                <span className={`bot-mark ${bot.kind}`}>{KIND_MARK[bot.kind]}</span>
                <div className="bot-id">
                  <h4>{bot.name}</h4>
                  <span className="bot-kind">{KIND_NAME[bot.kind]}</span>
                </div>
                <span className={bot.status === "running" ? "bot-state on" : "bot-state"}>
                  {bot.status === "running" ? "Running" : "Paused"}
                </span>
              </header>

              <dl className="bot-config">
                <div>
                  <dt><FaChartLine aria-hidden="true" /> Market</dt>
                  <dd>{bot.asset === "BOTH" ? "BTC + ETH" : bot.asset}</dd>
                </div>
                <div>
                  <dt><FaCoins aria-hidden="true" /> Stake</dt>
                  <dd>{bot.stake} tUSDC</dd>
                </div>
                <div>
                  <dt><FaSlidersH aria-hidden="true" /> Spread</dt>
                  <dd>±{Math.round(bot.spread * 100)}c</dd>
                </div>
                <div>
                  <dt>Daily cap</dt>
                  <dd>{bot.dailyTrades === 0 ? "no cap" : `${bot.dailyTrades} trades`}</dd>
                </div>
                {bot.kind === "ai" && (
                  <div className="bot-config-wide">
                    <dt><FaBrain aria-hidden="true" /> Model</dt>
                    <dd>{shortModel(bot.model)}</dd>
                  </div>
                )}
              </dl>

              <p className={bot.keyAddress ? "bot-signer set" : "bot-signer"}>
                <FaKey aria-hidden="true" />
                {bot.keyAddress
                  ? `Signs as ${bot.keyAddress.slice(0, 6)}…${bot.keyAddress.slice(-4)}`
                  : "No signing key — cannot place an order"}
              </p>

              <footer>
                <button className="bot-btn" onClick={() => toggle(bot)}>
                  {bot.status === "running" ? <><FaPause /> Pause</> : <><FaPlay /> Run</>}
                </button>
                <button className="bot-btn" onClick={() => { setEditing(bot); setOpen(true); }}>
                  <FaPen /> Edit
                </button>
                <button className="bot-btn danger" onClick={() => drop(bot)} title={`Delete ${bot.name}`}>
                  <FaTrash />
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}

      {open && plan && limits && (
        <BotForm
          address={address}
          plan={plan}
          proPrice={limits.proPrice}
          keyStorage={limits.keyStorage}
          editing={editing}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            load();
          }}
        />
      )}

      {bots && limits && (
        <p className="footnote page-foot">
          {bots.length} of {limits.maxBots} bots used, {running} of {limits.maxRunning} running. A running bot places
          real orders with its stored key. That key is encrypted at rest, but the server decrypts it to sign, so treat
          it as a hot wallet and fund it with what that bot should risk.
        </p>
      )}
    </div>
  );
}

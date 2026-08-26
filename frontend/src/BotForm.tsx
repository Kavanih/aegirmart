import { useEffect, useState } from "react";
import { FaBolt, FaBrain, FaCalculator, FaCrown, FaKey, FaRobot, FaShieldAlt, FaTimes } from "react-icons/fa";
import { fetchModels, saveBot, storeBotKey, type Bot, type BotDraft, type BotKind, type Plan } from "./api";

type Props = {
  address: string;
  plan: Plan;
  proPrice: number;
  editing: Bot | null;
  keyStorage: boolean;
  onClose: () => void;
  onSaved: () => void;
};

const ASSETS = ["BTC", "ETH", "BOTH"] as const;

const KINDS: { id: BotKind; name: string; blurb: string; icon: JSX.Element }[] = [
  {
    id: "standard",
    name: "Market maker",
    blurb: "Quotes both sides and earns the gap. Takes no view on the outcome.",
    icon: <FaRobot />,
  },
  {
    id: "quant",
    name: "Quant",
    blurb: "Prices the contract from spot, time left and volatility, then backs one side when the book disagrees.",
    icon: <FaCalculator />,
  },
  {
    id: "ai",
    name: "AI",
    blurb: "Backs one side on a model's read. Five minute windows only, since a read takes too long for sixty seconds.",
    icon: <FaBrain />,
  },
];

/** The bot just created is the newest one this wallet owns. */
async function latestBotId(address: string): Promise<string | null> {
  const res = await fetch(`/api/bots?address=${address}`);
  if (!res.ok) return null;
  const { bots } = (await res.json()) as { bots: Bot[] };
  return bots.length ? bots[bots.length - 1].id : null;
}

export function BotForm({ address, plan, proPrice, editing, keyStorage, onClose, onSaved }: Props) {
  const [name, setName] = useState(editing?.name ?? "");
  const [kind, setKind] = useState<BotKind>(editing?.kind ?? "standard");
  const [asset, setAsset] = useState<(typeof ASSETS)[number]>(editing?.asset ?? "BOTH");
  const [stake, setStake] = useState(String(editing?.stake ?? 5));
  const [dailyTrades, setDailyTrades] = useState(String(editing?.dailyTrades ?? 50));
  const [spread, setSpread] = useState(String(Math.round((editing?.spread ?? 0.02) * 100)));
  const [model, setModel] = useState(editing?.model ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [privateKey, setPrivateKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Both directional strategies sit behind a paid plan.
  const isPro = plan.plan !== "free";

  useEffect(() => {
    // Only a pro bot names a model, so only fetch the catalogue when it can.
    if (kind === "ai" && models.length === 0) fetchModels().then(setModels).catch(() => undefined);
  }, [kind, models.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const draft: BotDraft = {
      name,
      kind,
      asset,
      stake: Number(stake),
      dailyTrades: Number(dailyTrades),
      spread: Number(spread) / 100,
      model: kind === "ai" ? model || null : null,
    };

    const message = await saveBot(address, draft, editing?.id);
    if (message) {
      setBusy(false);
      return setError(message);
    }

    // A new bot has no id until it exists, so the key is a second step. Only
    // sent when the operator actually typed one.
    if (privateKey.trim()) {
      const id = editing?.id ?? (await latestBotId(address));
      const keyError = id ? await storeBotKey(address, id, privateKey) : "Bot saved, but its key could not be stored";
      setPrivateKey("");
      if (keyError) {
        setBusy(false);
        return setError(keyError);
      }
    }

    setBusy(false);
    onSaved();
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal bot-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="modal-head">
          <h2>{editing ? "Edit bot" : "New bot"}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <FaTimes />
          </button>
        </header>

        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="BTC scalper" maxLength={40} autoFocus />
        </label>

        <fieldset className="field">
          <legend>Strategy</legend>
          <div className="kind-grid">
            {KINDS.map((k) => {
              const locked = k.id !== "standard" && !isPro;
              return (
                <button
                  key={k.id}
                  type="button"
                  className={kind === k.id ? "kind on" : "kind"}
                  onClick={() => !locked && setKind(k.id)}
                  aria-pressed={kind === k.id}
                  disabled={locked}
                  title={locked ? `Starter plan, from ${proPrice} tUSDC a month` : k.blurb}
                >
                  {k.icon}
                  <span className="kind-name">
                    {k.name} {locked && <FaCrown className="kind-lock" aria-label="paid plan only" />}
                  </span>
                  <span className="kind-sub">{locked ? `Paid plan · from ${proPrice} tUSDC a month` : k.blurb}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="field-row">
          <label className="field">
            <span>Market</span>
            <select value={asset} onChange={(e) => setAsset(e.target.value as (typeof ASSETS)[number])}>
              {ASSETS.map((a) => (
                <option key={a} value={a}>{a === "BOTH" ? "BTC and ETH" : a}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Stake per quote</span>
            <div className="input-unit">
              <input type="number" min="0" step="0.01" value={stake} onChange={(e) => setStake(e.target.value)} />
              <span>tUSDC</span>
            </div>
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>Trades per day</span>
            <div className="input-unit">
              <input type="number" min="0" step="1" value={dailyTrades} onChange={(e) => setDailyTrades(e.target.value)} />
              <span>max</span>
            </div>
          </label>

          <label className="field">
            <span>Half spread</span>
            <div className="input-unit">
              <input type="number" min="1" max="49" step="1" value={spread} onChange={(e) => setSpread(e.target.value)} />
              <span>cents</span>
            </div>
          </label>
        </div>

        {kind === "ai" && (
          <p className="field-note lane-note">
            <FaBolt aria-hidden="true" /> AI bots trade the five minute lane only. A model read takes tens of seconds,
            which a sixty second window cannot wait for.
          </p>
        )}

        {kind === "ai" && (
          <label className="field">
            <span>Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Best available, ranked by record</option>
              {models.map((m) => (
                <option key={m} value={m}>{m.replace(/:free$/, "")}</option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          <span><FaKey aria-hidden="true" /> Signing key {editing?.keyAddress && "(replace)"}</span>
          <input
            type="password"
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            placeholder={editing?.keyAddress ? "Leave blank to keep the current key" : "0x… 64 hex characters"}
            autoComplete="off"
            spellCheck={false}
            disabled={!keyStorage}
          />
          <span className="field-note">
            <FaShieldAlt aria-hidden="true" />
            {keyStorage ? (
              <>
                Encrypted before it is written and never shown again. The server must decrypt it to sign, so treat this
                as a hot wallet: fund it with what this bot should risk, not your main account.
              </>
            ) : (
              <>This server has no encryption secret set, so it will not accept a key.</>
            )}
          </span>
        </label>

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="cta" disabled={busy}>
            <FaBolt /> {busy ? "Saving" : editing ? "Save changes" : "Create bot"}
          </button>
        </div>
      </form>
    </div>
  );
}

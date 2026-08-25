import { useEffect, useState } from "react";
import { useAccount, useConnect } from "wagmi";
import { somniaTestnet } from "./config";
import { WALLETS, detectInstalled } from "./wallets";
import { WalletMark } from "./WalletMark";
import { ProfileMenu } from "./ProfileMenu";

type Props = { onNavigate: (view: "portfolio" | "leaderboard") => void };

export function ConnectWallet({ onNavigate }: Props) {
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState<Set<string>>(() => new Set());

  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();

  useEffect(() => {
    if (open) setInstalled(detectInstalled());
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (isConnected && address) return <ProfileMenu onNavigate={onNavigate} />;

  return (
    <>
      <button className="wallet-connect" onClick={() => setOpen(true)}>
        Connect
      </button>

      {open && (
        <div className="modal-scrim" onClick={() => setOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <h2>Connect a wallet</h2>
              <button className="modal-close" onClick={() => setOpen(false)} aria-label="Close">
                Close
              </button>
            </header>

            <p className="modal-sub">Somnia Testnet. You keep custody, and every trade is signed by you.</p>

            <ul className="wallet-list">
              {WALLETS.map((wallet) => {
                const ready = installed.has(wallet.id);
                const connector = connectors.find((c) => c.id === wallet.id) ?? connectors.find((c) => c.id === "injected");

                return (
                  <li key={wallet.id}>
                    {ready ? (
                      <button
                        className="wallet-option"
                        disabled={isPending || !connector}
                        onClick={() => connector && connect({ connector, chainId: somniaTestnet.id })}
                      >
                        <WalletMark id={wallet.id} />
                        <span className="wallet-name">{wallet.name}</span>
                        <span className="wallet-state">{isPending ? "Waiting" : "Detected"}</span>
                      </button>
                    ) : (
                      <a className="wallet-option ghost" href={wallet.installUrl} target="_blank" rel="noreferrer noopener">
                        <WalletMark id={wallet.id} />
                        <span className="wallet-name">{wallet.name}</span>
                        <span className="wallet-state">Install</span>
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>

            {error && <p className="modal-error">{error.message}</p>}
          </div>
        </div>
      )}
    </>
  );
}

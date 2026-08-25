import { useEffect, useState } from "react";
import { useAccount, useBalance, useConnect, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { erc20Abi, formatUnits } from "viem";
import { somniaTestnet, TUSDC } from "./config";
import { WALLETS, detectInstalled } from "./wallets";
import { WalletMark } from "./WalletMark";

function short(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function ConnectWallet() {
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState<Set<string>>(() => new Set());

  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const { data: gas } = useBalance({ address });
  const { data: collateral } = useReadContract({
    abi: erc20Abi,
    address: TUSDC.address,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  useEffect(() => {
    if (open) setInstalled(detectInstalled());
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const wrongChain = isConnected && chainId !== somniaTestnet.id;

  if (isConnected && address) {
    return (
      <div className="wallet-bar">
        {wrongChain ? (
          <button className="wallet-chip warn" onClick={() => switchChain({ chainId: somniaTestnet.id })}>
            Switch to Somnia
          </button>
        ) : (
          <span className="wallet-chip">
            {`${Number(formatUnits(collateral ?? 0n, TUSDC.decimals)).toFixed(2)} ${TUSDC.symbol}`}
            <span className="wallet-gas">
              {`${Number(formatUnits(gas?.value ?? 0n, 18)).toFixed(3)} STT`}
            </span>
          </span>
        )}
        <button className="wallet-chip addr" onClick={() => disconnect()} title="Disconnect">
          {short(address)}
        </button>
      </div>
    );
  }

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

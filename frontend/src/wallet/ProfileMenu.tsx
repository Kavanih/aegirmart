import { useEffect, useRef, useState } from "react";
import { useAccount, useBalance, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { erc20Abi, formatUnits } from "viem";
import { somniaTestnet, TUSDC } from "./config";
import { Avatar } from "../Avatar";

type Props = { onNavigate: (view: "portfolio" | "leaderboard") => void };

function short(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function ProfileMenu({ onNavigate }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const { address, chainId } = useAccount();
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

  // Close on outside click and on Escape, so the menu never traps the page.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!address) return null;

  const wrongChain = chainId !== somniaTestnet.id;
  const usdc = Number(formatUnits(collateral ?? 0n, TUSDC.decimals));
  const stt = Number(formatUnits(gas?.value ?? 0n, 18));

  const go = (view: "portfolio" | "leaderboard") => {
    onNavigate(view);
    setOpen(false);
  };

  return (
    <div className="profile" ref={wrap}>
      {wrongChain && (
        <button className="wallet-chip warn" onClick={() => switchChain({ chainId: somniaTestnet.id })}>
          Switch to Somnia
        </button>
      )}

      <button
        className={open ? "profile-btn on" : "profile-btn"}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <Avatar address={address} size={32} />
      </button>

      {open && (
        <div className="profile-menu" role="menu">
          <div className="profile-head">
            <Avatar address={address} size={38} />
            <div className="profile-id">
              <span className="profile-addr">{short(address)}</span>
              <span className="profile-net">Somnia testnet</span>
            </div>
          </div>

          <div className="profile-balances">
            <div>
              <span className="bal-key">Available</span>
              <span className="bal-val">{usdc.toFixed(2)} {TUSDC.symbol}</span>
            </div>
            <div>
              <span className="bal-key">Gas</span>
              <span className="bal-val">{stt.toFixed(3)} STT</span>
            </div>
          </div>

          <button className="profile-item" role="menuitem" onClick={() => go("portfolio")}>
            <PortfolioIcon /> Portfolio
          </button>
          <button className="profile-item" role="menuitem" onClick={() => go("leaderboard")}>
            <BoardIcon /> Leaderboard
          </button>
          <button
            className="profile-item"
            role="menuitem"
            onClick={() => navigator.clipboard?.writeText(address).catch(() => undefined)}
          >
            <CopyIcon /> Copy address
          </button>

          <div className="profile-sep" />

          <button className="profile-item danger" role="menuitem" onClick={() => { disconnect(); setOpen(false); }}>
            <ExitIcon /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function PortfolioIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" {...stroke} aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7" /></svg>;
}
function BoardIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" {...stroke} aria-hidden="true"><path d="M5 20V11M12 20V4M19 20v-6" /></svg>;
}
function CopyIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" {...stroke} aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M6 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" /></svg>;
}
function ExitIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" {...stroke} aria-hidden="true"><path d="M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6" /></svg>;
}

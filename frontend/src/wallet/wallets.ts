export type WalletOption = {
  id: string;
  name: string;
  // Probe on the injected provider so the modal only offers what is installed.
  detect: (p: Record<string, unknown> | undefined) => boolean;
  installUrl: string;
};

export const WALLETS: WalletOption[] = [
  { id: "metaMask", name: "MetaMask", detect: (p) => Boolean(p?.isMetaMask) && !p?.isRabby && !p?.isBraveWallet, installUrl: "https://metamask.io/download" },
  { id: "rabby", name: "Rabby", detect: (p) => Boolean(p?.isRabby), installUrl: "https://rabby.io" },
  { id: "okx", name: "OKX Wallet", detect: () => typeof window !== "undefined" && "okxwallet" in window, installUrl: "https://www.okx.com/web3" },
  { id: "coinbase", name: "Coinbase Wallet", detect: (p) => Boolean(p?.isCoinbaseWallet), installUrl: "https://www.coinbase.com/wallet" },
  { id: "brave", name: "Brave Wallet", detect: (p) => Boolean(p?.isBraveWallet), installUrl: "https://brave.com/wallet" },
  { id: "trust", name: "Trust Wallet", detect: (p) => Boolean(p?.isTrust), installUrl: "https://trustwallet.com" },
];

export function detectInstalled(): Set<string> {
  const provider = typeof window === "undefined" ? undefined : (window as { ethereum?: Record<string, unknown> }).ethereum;
  const found = new Set<string>();
  for (const wallet of WALLETS) {
    if (wallet.detect(provider)) found.add(wallet.id);
  }
  return found;
}

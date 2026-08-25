import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";

// Somnia testnet. Collateral is tUSDC at six decimals; gas is STT.
export const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
  blockExplorers: { default: { name: "Somnia Explorer", url: "https://shannon-explorer.somnia.network" } },
  testnet: true,
});

export const TUSDC = {
  address: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as const,
  decimals: 6,
  symbol: "tUSDC",
};

export const wagmiConfig = createConfig({
  chains: [somniaTestnet],
  connectors: [injected()],
  transports: { [somniaTestnet.id]: http() },
});

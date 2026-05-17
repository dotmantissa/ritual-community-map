import { createPublicClient, createWalletClient, custom, http, defineChain } from "viem";

export const ritualChain = defineChain({
  id: 1979,
  name: "Ritual",
  nativeCurrency: { name: "Ritual", symbol: "RITUAL", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.ritualfoundation.org"] } },
});

export const publicClient = createPublicClient({ chain: ritualChain, transport: http() });

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

export function getInjected() {
  if (typeof window === "undefined" || !window.ethereum) return null;
  return window.ethereum;
}

export async function connectWallet(): Promise<`0x${string}`> {
  const eth = getInjected();
  if (!eth) throw new Error("No wallet detected. Install MetaMask.");
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  await ensureChain();
  return accounts[0] as `0x${string}`;
}

export async function ensureChain() {
  const eth = getInjected();
  if (!eth) throw new Error("No wallet");
  const hex = "0x" + (1979).toString(16);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (error: unknown) {
    const chainError = error as { code?: number; message?: string };
    if (chainError?.code === 4902 || /Unrecognized chain/i.test(chainError?.message ?? "")) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hex,
            chainName: "Ritual",
            nativeCurrency: { name: "Ritual", symbol: "RITUAL", decimals: 18 },
            rpcUrls: ["https://rpc.ritualfoundation.org"],
            blockExplorerUrls: ["https://explorer.ritualfoundation.org"],
          },
        ],
      });
    } else {
      throw error;
    }
  }
}

export function getWalletClient(account: `0x${string}`) {
  const eth = getInjected();
  if (!eth) throw new Error("No wallet");
  return createWalletClient({ account, chain: ritualChain, transport: custom(eth) });
}

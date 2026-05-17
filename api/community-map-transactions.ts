const DEFAULT_RITUAL_MAP_ADDRESS = "0x61c4ab75fc3304a0c506a54596dfcdf18688d624";
const RITUAL_MAP_ADDRESS = (
  process.env.VITE_RITUAL_MAP_CONTRACT_ADDRESS ??
  process.env.RITUAL_MAP_CONTRACT_ADDRESS ??
  DEFAULT_RITUAL_MAP_ADDRESS
).toLowerCase();
const RITUAL_RPC_URL = process.env.RITUAL_RPC_URL ?? "https://rpc.ritualfoundation.org";
const INDEXER_TRANSACTIONS_URL = `https://explorer.ritualfoundation.org/api/indexer-proxy/api/v1/addresses/${RITUAL_MAP_ADDRESS}/transactions`;
const INDEXER_TRANSACTION_URL =
  "https://explorer.ritualfoundation.org/api/indexer-proxy/api/v1/transactions";
const JOIN_SELECTOR = "0x29803b21";
const RECENT_BLOCK_SCAN_DEPTH = Number(process.env.RITUAL_MAP_RECENT_BLOCK_SCAN_DEPTH ?? "80");

type IndexedTransaction = {
  tx_hash: string;
  block_number: number;
  block_timestamp: number;
  from_address: string;
  to_address?: string;
  status: number;
  tx_index: number;
  method_selector: string;
  input_data?: string;
};

type RpcTransaction = {
  hash: string;
  input?: string;
  from?: string;
  to?: string | null;
  transactionIndex?: string;
};

type RpcBlock = {
  number: string;
  timestamp: string;
  transactions: RpcTransaction[];
};

type RpcReceipt = {
  status?: string;
};

type QueryValue = string | string[] | undefined;

type VercelRequestLike = {
  query?: Record<string, QueryValue>;
  url?: string;
};

type VercelResponseLike = {
  status: (code: number) => VercelResponseLike;
  setHeader: (name: string, value: string) => void;
  send: (body: string) => void;
  json: (body: unknown) => void;
};

const blockCache = new Map<number, Promise<RpcBlock | null>>();
const receiptCache = new Map<string, Promise<RpcReceipt | null>>();
let recentScanCache: { expiresAt: number; transactions: IndexedTransaction[] } | null = null;

function readParam(request: VercelRequestLike, key: string): string | null {
  const queryValue = request.query?.[key];
  if (Array.isArray(queryValue)) return queryValue[0] ?? null;
  if (typeof queryValue === "string") return queryValue;

  if (!request.url) return null;
  const requestUrl = new URL(request.url, "https://ritual-community-map.vercel.app");
  return requestUrl.searchParams.get(key);
}

function toBlockHex(blockNumber: number) {
  return `0x${blockNumber.toString(16)}`;
}

function fromHexNumber(value?: string | null): number {
  if (!value) return 0;
  return Number.parseInt(value, 16);
}

async function rpcRequest<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const rpc = await fetch(RITUAL_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!rpc.ok) return null;
    const payload = (await rpc.json()) as { result?: T; error?: unknown };
    if (payload.error) return null;
    return payload.result ?? null;
  } catch {
    return null;
  }
}

function getRpcBlock(blockNumber: number): Promise<RpcBlock | null> {
  let block = blockCache.get(blockNumber);
  if (!block) {
    block = rpcRequest<RpcBlock>("eth_getBlockByNumber", [toBlockHex(blockNumber), true]);
    blockCache.set(blockNumber, block);
  }
  return block;
}

function getRpcReceipt(txHash: string): Promise<RpcReceipt | null> {
  const key = txHash.toLowerCase();
  let receipt = receiptCache.get(key);
  if (!receipt) {
    receipt = rpcRequest<RpcReceipt>("eth_getTransactionReceipt", [txHash]);
    receiptCache.set(key, receipt);
  }
  return receipt;
}

async function readInputFromRpcBlock(transaction: IndexedTransaction): Promise<string | null> {
  const block = await getRpcBlock(transaction.block_number);
  const rpcTransaction = block?.transactions.find(
    (tx) => tx.hash.toLowerCase() === transaction.tx_hash.toLowerCase(),
  );
  return rpcTransaction?.input ?? null;
}

async function readInputFromRpcTransaction(txHash: string): Promise<string | null> {
  const transaction = await rpcRequest<RpcTransaction>("eth_getTransactionByHash", [txHash]);
  return transaction?.input ?? null;
}

async function readInputFromExplorerDetail(txHash: string): Promise<string | null> {
  try {
    const details = await fetch(`${INDEXER_TRANSACTION_URL}/${txHash}`);
    if (!details.ok) return null;
    const detailData = (await details.json()) as { input_data?: string; input?: string };
    return detailData.input_data ?? detailData.input ?? null;
  } catch {
    return null;
  }
}

async function hydrateTransactionInput(
  transaction: IndexedTransaction,
): Promise<IndexedTransaction> {
  if (transaction.method_selector !== JOIN_SELECTOR || typeof transaction.input_data === "string") {
    return transaction;
  }

  const inputData =
    (await readInputFromRpcBlock(transaction)) ??
    (await readInputFromRpcTransaction(transaction.tx_hash)) ??
    (await readInputFromExplorerDetail(transaction.tx_hash));
  const receipt = transaction.status === 1 ? null : await getRpcReceipt(transaction.tx_hash);
  const status = receipt?.status === "0x1" ? 1 : transaction.status;

  return inputData ? { ...transaction, input_data: inputData, status } : { ...transaction, status };
}

async function scanRecentJoinTransactions(
  existingHashes: Set<string>,
): Promise<IndexedTransaction[]> {
  const now = Date.now();
  if (recentScanCache && recentScanCache.expiresAt > now) {
    return recentScanCache.transactions.filter(
      (tx) => !existingHashes.has(tx.tx_hash.toLowerCase()),
    );
  }

  const latestHex = await rpcRequest<string>("eth_blockNumber", []);
  const latest = fromHexNumber(latestHex);
  if (!latest) return [];

  const fromBlock = Math.max(0, latest - RECENT_BLOCK_SCAN_DEPTH);
  const blockNumbers = Array.from(
    { length: latest - fromBlock + 1 },
    (_, index) => fromBlock + index,
  );
  const blocks = await Promise.all(blockNumbers.map((blockNumber) => getRpcBlock(blockNumber)));
  const joinTransactions = blocks.flatMap((block) => {
    if (!block) return [];
    const blockNumber = fromHexNumber(block.number);
    const blockTimestampMs = fromHexNumber(block.timestamp) * 1000;
    return block.transactions
      .filter((tx) => {
        const input = tx.input ?? "";
        return (
          tx.to?.toLowerCase() === RITUAL_MAP_ADDRESS &&
          input.startsWith(JOIN_SELECTOR) &&
          !existingHashes.has(tx.hash.toLowerCase())
        );
      })
      .map((tx) => ({
        tx_hash: tx.hash,
        block_number: blockNumber,
        block_timestamp: blockTimestampMs,
        from_address: tx.from ?? "0x",
        to_address: tx.to ?? RITUAL_MAP_ADDRESS,
        status: 0,
        tx_index: fromHexNumber(tx.transactionIndex),
        method_selector: JOIN_SELECTOR,
        input_data: tx.input,
      }));
  });

  const confirmedTransactions = await Promise.all(
    joinTransactions.map(async (transaction) => {
      const receipt = await getRpcReceipt(transaction.tx_hash);
      return receipt?.status === "0x1" ? { ...transaction, status: 1 } : null;
    }),
  );
  const transactions: IndexedTransaction[] = confirmedTransactions.filter(
    (transaction): transaction is NonNullable<typeof transaction> => transaction !== null,
  );
  recentScanCache = { expiresAt: now + 4_000, transactions };
  return transactions;
}

function dedupeTransactions(transactions: IndexedTransaction[]): IndexedTransaction[] {
  const seen = new Set<string>();
  return transactions.filter((transaction) => {
    const key = transaction.tx_hash.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default async function handler(request: VercelRequestLike, response: VercelResponseLike) {
  const params = new URLSearchParams({
    limit: readParam(request, "limit") ?? "1000",
    offset: readParam(request, "offset") ?? "0",
    from_date: readParam(request, "from_date") ?? "2026-05-01",
    to_date: readParam(request, "to_date") ?? readParam(request, "from_date") ?? "2026-05-01",
  });

  const upstream = await fetch(`${INDEXER_TRANSACTIONS_URL}?${params}`);
  const upstreamText = await upstream.text();

  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");

  if (!upstream.ok) {
    response.status(upstream.status).send(upstreamText);
    return;
  }

  const data = JSON.parse(upstreamText) as { transactions?: IndexedTransaction[] };
  const transactions = Array.isArray(data.transactions) ? data.transactions : [];
  const hydratedTransactions = await Promise.all(transactions.map(hydrateTransactionInput));
  const recentTransactions = await scanRecentJoinTransactions(
    new Set(hydratedTransactions.map((tx) => tx.tx_hash.toLowerCase())),
  );

  data.transactions = dedupeTransactions([...hydratedTransactions, ...recentTransactions]);
  response.status(upstream.status).json(data);
}

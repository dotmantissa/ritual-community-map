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
const FIRST_JOIN_DATE = "2026-05-01";
const RECENT_BLOCK_SCAN_DEPTH = Number(process.env.RITUAL_MAP_RECENT_BLOCK_SCAN_DEPTH ?? "80");
const RESPONSE_CACHE_TTL_MS = Number(process.env.RITUAL_MAP_RESPONSE_CACHE_TTL_MS ?? "4000");

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

type IndexedMember = {
  address: string;
  handle: string;
  region: string;
  timestamp: number;
  blockNumber: number;
  transactionIndex: number;
  regionRank: number;
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
let responseCache: {
  key: string;
  expiresAt: number;
  payload: Record<string, unknown>;
  status: number;
} | null = null;

function readParam(request: VercelRequestLike, key: string): string | null {
  const queryValue = request.query?.[key];
  if (Array.isArray(queryValue)) return queryValue[0] ?? null;
  if (typeof queryValue === "string") return queryValue;

  if (!request.url) return null;
  const requestUrl = new URL(request.url, "https://ritual-community-map.vercel.app");
  return requestUrl.searchParams.get(key);
}

function readBooleanParam(request: VercelRequestLike, key: string) {
  const value = readParam(request, key);
  return value === "1" || value === "true" || value === "yes";
}

function cacheKeyForRequest(request: VercelRequestLike) {
  const params = new URLSearchParams();
  for (const key of ["all", "members", "limit", "offset", "from_date", "to_date"]) {
    const value = readParam(request, key);
    if (value) params.set(key, value);
  }
  return `${RITUAL_MAP_ADDRESS}:${params.toString()}`;
}

function dateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function parseDateParam(value: string | null, fallback: string) {
  const parsed = new Date(`${value ?? fallback}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? new Date(`${fallback}T00:00:00.000Z`) : parsed;
}

function toBlockHex(blockNumber: number) {
  return `0x${blockNumber.toString(16)}`;
}

function fromHexNumber(value?: string | null): number {
  if (!value) return 0;
  return Number.parseInt(value, 16);
}

function normalizeTimestamp(value: number) {
  return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
}

function decodeAbiString(args: string, index: number): string {
  const readWord = (offset: number) =>
    BigInt(`0x${args.slice(2 + offset * 2, 2 + (offset + 32) * 2)}`);
  const offset = Number(readWord(index * 32));
  const length = Number(readWord(offset));
  const hex = args.slice(2 + (offset + 32) * 2, 2 + (offset + 32 + length) * 2);
  const bytes = hex.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? [];
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeJoinInput(input: string): { handle: string; region: string } | null {
  if (!input.startsWith(JOIN_SELECTOR)) return null;
  try {
    const args = `0x${input.slice(10)}`;
    return {
      handle: decodeAbiString(args, 0),
      region: decodeAbiString(args, 1),
    };
  } catch {
    return null;
  }
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

function buildMembers(transactions: IndexedTransaction[]): IndexedMember[] {
  const seen = new Set<string>();
  const regionCounts = new Map<string, number>();

  return transactions
    .filter(
      (transaction): transaction is IndexedTransaction & { input_data: string } =>
        transaction.status === 1 &&
        transaction.method_selector === JOIN_SELECTOR &&
        typeof transaction.input_data === "string",
    )
    .sort((a, b) => a.block_number - b.block_number || a.tx_index - b.tx_index)
    .flatMap((transaction) => {
      const decoded = decodeJoinInput(transaction.input_data);
      if (!decoded) return [];
      const address = transaction.from_address.toLowerCase();
      if (seen.has(address)) return [];
      seen.add(address);
      const regionRank = (regionCounts.get(decoded.region) ?? 0) + 1;
      regionCounts.set(decoded.region, regionRank);
      return [
        {
          address: transaction.from_address,
          handle: decoded.handle,
          region: decoded.region,
          timestamp: normalizeTimestamp(Number(transaction.block_timestamp)),
          blockNumber: transaction.block_number,
          transactionIndex: transaction.tx_index,
          regionRank,
        },
      ];
    });
}

async function fetchIndexerWindow(params: URLSearchParams) {
  const upstream = await fetch(`${INDEXER_TRANSACTIONS_URL}?${params}`);
  const upstreamText = await upstream.text();
  const contentType = upstream.headers.get("content-type") ?? "application/json";

  if (!upstream.ok) {
    return { ok: false as const, status: upstream.status, body: upstreamText, contentType };
  }

  const data = JSON.parse(upstreamText) as {
    transactions?: IndexedTransaction[];
    hasMore?: boolean;
  };
  return { ok: true as const, status: upstream.status, data, contentType };
}

async function fetchIndexedTransactions(request: VercelRequestLike) {
  const limit = readParam(request, "limit") ?? "1000";
  const pageLimit = Math.max(1, Number(limit) || 1000);
  const offset = readParam(request, "offset") ?? "0";
  const fromDateParam = readParam(request, "from_date") ?? FIRST_JOIN_DATE;
  const toDateParam = readParam(request, "to_date") ?? dateString(addDays(new Date(), 1));

  if (!readBooleanParam(request, "all")) {
    return fetchIndexerWindow(
      new URLSearchParams({ limit, offset, from_date: fromDateParam, to_date: toDateParam }),
    );
  }

  const firstDate = parseDateParam(fromDateParam, FIRST_JOIN_DATE);
  const lastDate = parseDateParam(toDateParam, dateString(addDays(new Date(), 1)));
  const transactions: IndexedTransaction[] = [];

  for (let fromDate = firstDate; fromDate <= lastDate; fromDate = addDays(fromDate, 30)) {
    const windowEnd = addDays(fromDate, 29);
    const toDate = windowEnd > lastDate ? lastDate : windowEnd;
    for (let currentOffset = 0; ; currentOffset += pageLimit) {
      const result = await fetchIndexerWindow(
        new URLSearchParams({
          limit,
          offset: String(currentOffset),
          from_date: dateString(fromDate),
          to_date: dateString(toDate),
        }),
      );
      if (!result.ok) return result;
      const page = Array.isArray(result.data.transactions) ? result.data.transactions : [];
      transactions.push(...page);
      if (!result.data.hasMore || page.length === 0) break;
    }
  }

  return {
    ok: true as const,
    status: 200,
    data: { transactions, hasMore: false },
    contentType: "application/json",
  };
}

export default async function handler(request: VercelRequestLike, response: VercelResponseLike) {
  const forceFresh = readBooleanParam(request, "fresh");
  const cacheKey = cacheKeyForRequest(request);
  const now = Date.now();

  response.setHeader("content-type", "application/json");
  response.setHeader(
    "cache-control",
    forceFresh ? "no-store" : "public, max-age=0, s-maxage=2, stale-while-revalidate=15",
  );

  if (!forceFresh && responseCache?.key === cacheKey && responseCache.expiresAt > now) {
    response.status(responseCache.status).json(responseCache.payload);
    return;
  }

  if (forceFresh) recentScanCache = null;

  const indexerResult = await fetchIndexedTransactions(request);
  if (!indexerResult.ok) {
    response.setHeader("content-type", indexerResult.contentType);
    response.status(indexerResult.status).send(indexerResult.body);
    return;
  }

  const transactions = Array.isArray(indexerResult.data.transactions)
    ? indexerResult.data.transactions
    : [];
  const hydratedTransactions = await Promise.all(transactions.map(hydrateTransactionInput));
  const recentTransactions = await scanRecentJoinTransactions(
    new Set(hydratedTransactions.map((tx) => tx.tx_hash.toLowerCase())),
  );
  const allTransactions = dedupeTransactions([...hydratedTransactions, ...recentTransactions]);
  const members = buildMembers(allTransactions);
  const regionCounts = members.reduce<Record<string, number>>((counts, member) => {
    counts[member.region] = (counts[member.region] ?? 0) + 1;
    return counts;
  }, {});
  const payload: Record<string, unknown> = {
    ...indexerResult.data,
    transactions: allTransactions,
    members,
    regionCounts,
    totalMembers: members.length,
    generatedAt: new Date().toISOString(),
  };

  responseCache = {
    key: cacheKey,
    expiresAt: now + RESPONSE_CACHE_TTL_MS,
    payload,
    status: indexerResult.status,
  };

  response.status(indexerResult.status).json(payload);
}

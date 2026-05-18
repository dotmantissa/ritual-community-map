import { BlobPreconditionFailedError, get as getBlob, put as putBlob } from "@vercel/blob";

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
const RESPONSE_CACHE_TTL_MS = Number(process.env.RITUAL_MAP_RESPONSE_CACHE_TTL_MS ?? "1000");
const STORE_PATH = `community-map/${RITUAL_MAP_ADDRESS}/members.json`;
const STORE_VERSION = 1;

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
  transactionHash?: string;
};

type RpcTransaction = {
  hash: string;
  input?: string;
  from?: string;
  to?: string | null;
  blockNumber?: string;
  transactionIndex?: string;
};

type RpcBlock = {
  number: string;
  timestamp: string;
  transactions: RpcTransaction[];
};

type RpcReceipt = {
  status?: string;
  blockNumber?: string;
  transactionIndex?: string;
  from?: string;
  to?: string | null;
};

type StoreData = {
  version: number;
  contractAddress: string;
  members: IndexedMember[];
  transactions: IndexedTransaction[];
  regionCounts: Record<string, number>;
  totalMembers: number;
  generatedAt: string;
  updatedAt: string;
};

type StoreSnapshot = {
  data: StoreData | null;
  etag: string | null;
};

type QueryValue = string | string[] | undefined;

type VercelRequestLike = {
  method?: string;
  body?: unknown;
  query?: Record<string, QueryValue>;
  url?: string;
  [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | string>;
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
let memoryStore: StoreData | null = null;
let storeWriteLock: Promise<unknown> = Promise.resolve();

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
  for (const key of ["all", "members", "limit", "offset", "from_date", "to_date", "fresh"]) {
    const value = readParam(request, key);
    if (value) params.set(key, value);
  }
  return `${RITUAL_MAP_ADDRESS}:${params.toString()}`;
}

function hasBlobStore() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function emptyStore(): StoreData {
  const now = new Date().toISOString();
  return {
    version: STORE_VERSION,
    contractAddress: RITUAL_MAP_ADDRESS,
    members: [],
    transactions: [],
    regionCounts: {},
    totalMembers: 0,
    generatedAt: now,
    updatedAt: now,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function normalizeAddress(address: string) {
  return address.toLowerCase();
}

function sanitizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maxLength) return null;
  return text;
}

function normalizeTransaction(transaction: IndexedTransaction): IndexedTransaction {
  return {
    ...transaction,
    tx_hash: transaction.tx_hash.toLowerCase(),
    from_address: transaction.from_address.toLowerCase(),
    to_address: transaction.to_address?.toLowerCase(),
    block_timestamp: normalizeTimestamp(Number(transaction.block_timestamp)),
  };
}

function normalizeStoreData(data: Partial<StoreData> | null | undefined): StoreData {
  const base = emptyStore();
  const transactions = Array.isArray(data?.transactions)
    ? dedupeTransactions(data.transactions.map((tx) => normalizeTransaction(tx)))
    : [];
  const membersFromStore = Array.isArray(data?.members) ? data.members : [];
  const members =
    membersFromStore.length > 0
      ? normalizeMembers([...membersFromStore, ...buildMembers(transactions)])
      : buildMembers(transactions);
  const regionCounts = buildRegionCounts(members);
  const updatedAt = typeof data?.updatedAt === "string" ? data.updatedAt : base.updatedAt;
  const generatedAt = typeof data?.generatedAt === "string" ? data.generatedAt : updatedAt;

  return {
    version: STORE_VERSION,
    contractAddress: RITUAL_MAP_ADDRESS,
    members,
    transactions,
    regionCounts,
    totalMembers: members.length,
    generatedAt,
    updatedAt,
  };
}

function buildRegionCounts(members: IndexedMember[]): Record<string, number> {
  return members.reduce<Record<string, number>>((counts, member) => {
    counts[member.region] = (counts[member.region] ?? 0) + 1;
    return counts;
  }, {});
}

function normalizeMembers(members: IndexedMember[]): IndexedMember[] {
  const seen = new Set<string>();
  const regionCounts = new Map<string, number>();
  return [...members]
    .sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex)
    .flatMap((member) => {
      const address = normalizeAddress(member.address);
      if (!isAddress(address) || seen.has(address)) return [];
      const handle = sanitizeText(member.handle, 32);
      const region = sanitizeText(member.region, 16);
      if (!handle || !region) return [];
      seen.add(address);
      const regionRank = (regionCounts.get(region) ?? 0) + 1;
      regionCounts.set(region, regionRank);
      return [
        {
          address,
          handle,
          region,
          timestamp: normalizeTimestamp(Number(member.timestamp)),
          blockNumber: Number(member.blockNumber) || 0,
          transactionIndex: Number(member.transactionIndex) || 0,
          regionRank,
          transactionHash: member.transactionHash?.toLowerCase(),
        },
      ];
    });
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function readStore(): Promise<StoreSnapshot> {
  if (!hasBlobStore()) {
    return { data: memoryStore, etag: null };
  }

  try {
    const result = await getBlob(STORE_PATH, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return { data: memoryStore, etag: null };
    }

    const text = await streamToText(result.stream);
    const data = normalizeStoreData(JSON.parse(text) as Partial<StoreData>);
    memoryStore = data;
    return { data, etag: result.blob.etag };
  } catch (error) {
    console.error(error);
    return { data: memoryStore, etag: null };
  }
}

async function writeStore(data: StoreData, etag: string | null): Promise<void> {
  const normalized = normalizeStoreData({
    ...data,
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  memoryStore = normalized;
  responseCache = null;

  if (!hasBlobStore()) return;

  await putBlob(STORE_PATH, JSON.stringify(normalized), {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 60,
    contentType: "application/json",
    ...(etag ? { ifMatch: etag } : {}),
  });
}

async function updateStore(mutator: (current: StoreData) => StoreData): Promise<StoreData> {
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await readStore();
      const current = normalizeStoreData(snapshot.data);
      const next = normalizeStoreData(mutator(current));
      try {
        await writeStore(next, snapshot.etag);
        return next;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError && attempt < 2) continue;
        throw error;
      }
    }
    throw new Error("Could not update community map store");
  };

  const nextWrite = storeWriteLock.then(run, run);
  storeWriteLock = nextWrite.catch(() => undefined);
  return nextWrite;
}

function payloadFromStore(store: StoreData): Record<string, unknown> {
  return {
    transactions: store.transactions,
    hasMore: false,
    members: store.members,
    regionCounts: store.regionCounts,
    totalMembers: store.totalMembers,
    generatedAt: store.generatedAt,
    updatedAt: store.updatedAt,
    source: hasBlobStore() ? "blob" : "memory",
  };
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
          transactionHash: transaction.tx_hash.toLowerCase(),
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

async function buildStoreFromChain(): Promise<StoreData> {
  recentScanCache = null;
  const indexerResult = await fetchIndexedTransactions({
    query: {
      all: "1",
      members: "1",
      limit: "1000",
      from_date: FIRST_JOIN_DATE,
      to_date: dateString(addDays(new Date(), 1)),
    },
  });

  if (!indexerResult.ok) {
    throw new Error("Indexer fetch failed with status " + indexerResult.status);
  }

  const transactions = Array.isArray(indexerResult.data.transactions)
    ? indexerResult.data.transactions
    : [];
  const hydratedTransactions = await Promise.all(transactions.map(hydrateTransactionInput));
  const recentTransactions = await scanRecentJoinTransactions(
    new Set(hydratedTransactions.map((tx) => tx.tx_hash.toLowerCase())),
  );
  const chainTransactions = dedupeTransactions([
    ...hydratedTransactions.map(normalizeTransaction),
    ...recentTransactions.map(normalizeTransaction),
  ]);

  return updateStore((current) => {
    const allTransactions = dedupeTransactions([...current.transactions, ...chainTransactions]);
    return {
      ...current,
      transactions: allTransactions,
      members: normalizeMembers([...current.members, ...buildMembers(allTransactions)]),
    };
  });
}

async function readRequestBody(request: VercelRequestLike): Promise<unknown> {
  if (request.body !== undefined) return request.body;
  if (typeof request[Symbol.asyncIterator] !== "function") return null;

  let body = "";
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  if (!body.trim()) return null;
  return JSON.parse(body) as unknown;
}

function readBodyString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" ? value : null;
}

function isTransactionHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

async function verifiedTransactionFromHash(
  txHash: string,
  expectedAddress: string | null,
): Promise<IndexedTransaction> {
  const receipt = await getRpcReceipt(txHash);
  if (receipt?.status !== "0x1") {
    throw new Error("Transaction is not confirmed successfully");
  }

  const rpcTransaction = await rpcRequest<RpcTransaction>("eth_getTransactionByHash", [txHash]);
  if (!rpcTransaction) throw new Error("Transaction not found");

  const fromAddress = normalizeAddress(receipt.from ?? rpcTransaction.from ?? "");
  if (!isAddress(fromAddress)) throw new Error("Transaction sender not found");
  if (expectedAddress && normalizeAddress(expectedAddress) !== fromAddress) {
    throw new Error("Transaction sender does not match wallet");
  }

  const toAddress = normalizeAddress(receipt.to ?? rpcTransaction.to ?? "");
  if (toAddress !== RITUAL_MAP_ADDRESS) {
    throw new Error("Transaction was not sent to the community map contract");
  }

  const input = rpcTransaction.input;
  const decoded = input ? decodeJoinInput(input) : null;
  if (!input || !decoded) throw new Error("Transaction is not a join transaction");

  const blockNumber = fromHexNumber(receipt.blockNumber ?? rpcTransaction.blockNumber);
  const block = blockNumber ? await getRpcBlock(blockNumber) : null;
  const blockTimestamp = block ? fromHexNumber(block.timestamp) : Math.floor(Date.now() / 1000);

  return normalizeTransaction({
    tx_hash: txHash,
    block_number: blockNumber,
    block_timestamp: blockTimestamp,
    from_address: fromAddress,
    to_address: toAddress,
    status: 1,
    tx_index: fromHexNumber(receipt.transactionIndex ?? rpcTransaction.transactionIndex),
    method_selector: JOIN_SELECTOR,
    input_data: input,
  });
}

async function handlePost(request: VercelRequestLike, response: VercelResponseLike) {
  const rawBody = await readRequestBody(request);
  if (!isRecord(rawBody)) {
    response.status(400).json({ error: "Invalid request body" });
    return;
  }

  const txHash = readBodyString(rawBody, "txHash") ?? readBodyString(rawBody, "hash");
  if (!isTransactionHash(txHash)) {
    response.status(400).json({ error: "Invalid transaction hash" });
    return;
  }

  const expectedAddress = readBodyString(rawBody, "address");
  if (expectedAddress && !isAddress(expectedAddress)) {
    response.status(400).json({ error: "Invalid wallet address" });
    return;
  }

  const transaction = await verifiedTransactionFromHash(txHash.toLowerCase(), expectedAddress);
  const store = await updateStore((current) => {
    const transactions = dedupeTransactions([...current.transactions, transaction]);
    return {
      ...current,
      transactions,
      members: normalizeMembers([...current.members, ...buildMembers(transactions)]),
    };
  });

  response.status(200).json(payloadFromStore(store));
}

export default async function handler(request: VercelRequestLike, response: VercelResponseLike) {
  const method = (request.method ?? "GET").toUpperCase();
  const forceFresh = readBooleanParam(request, "fresh");
  const cacheKey = cacheKeyForRequest(request);
  const now = Date.now();

  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");

  try {
    if (method === "POST") {
      await handlePost(request, response);
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      response.status(405).json({ error: "Method not allowed" });
      return;
    }

    if (!forceFresh && responseCache?.key === cacheKey && responseCache.expiresAt > now) {
      response.status(responseCache.status).json(responseCache.payload);
      return;
    }

    const snapshot = forceFresh ? { data: null, etag: null } : await readStore();
    const store =
      snapshot.data && snapshot.data.members.length > 0
        ? normalizeStoreData(snapshot.data)
        : await buildStoreFromChain();
    const payload = payloadFromStore(store);

    responseCache = {
      key: cacheKey,
      expiresAt: now + RESPONSE_CACHE_TTL_MS,
      payload,
      status: 200,
    };

    response.status(200).json(payload);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: "Community map data unavailable" });
  }
}

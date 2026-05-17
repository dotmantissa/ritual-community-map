const DEFAULT_RITUAL_MAP_ADDRESS = "0x84725642453c2dcde42d075b5f3ab96b5922a44b";
const RITUAL_MAP_ADDRESS =
  process.env.VITE_RITUAL_MAP_CONTRACT_ADDRESS ??
  process.env.RITUAL_MAP_CONTRACT_ADDRESS ??
  DEFAULT_RITUAL_MAP_ADDRESS;
const INDEXER_TRANSACTIONS_URL = `https://explorer.ritualfoundation.org/api/indexer-proxy/api/v1/addresses/${RITUAL_MAP_ADDRESS}/transactions`;
const INDEXER_TRANSACTION_URL =
  "https://explorer.ritualfoundation.org/api/indexer-proxy/api/v1/transactions";
const JOIN_SELECTOR = "0x29803b21";
type IndexedTransaction = {
  tx_hash: string;
  method_selector: string;
  input_data?: string;
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

function readParam(request: VercelRequestLike, key: string): string | null {
  const queryValue = request.query?.[key];
  if (Array.isArray(queryValue)) return queryValue[0] ?? null;
  if (typeof queryValue === "string") return queryValue;

  if (!request.url) return null;
  const requestUrl = new URL(request.url, "https://ritual-community-map.vercel.app");
  return requestUrl.searchParams.get(key);
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

  data.transactions = await Promise.all(
    transactions.map(async (transaction) => {
      if (
        transaction.method_selector !== JOIN_SELECTOR ||
        typeof transaction.input_data === "string"
      ) {
        return transaction;
      }

      const details = await fetch(`${INDEXER_TRANSACTION_URL}/${transaction.tx_hash}`);
      if (!details.ok) return transaction;

      const detailData = (await details.json()) as { input_data?: string };
      return { ...transaction, input_data: detailData.input_data };
    }),
  );

  response.status(upstream.status).json(data);
}

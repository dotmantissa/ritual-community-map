import { RITUAL_MAP_ADDRESS } from "../src/lib/ritual-contract";

const INDEXER_TRANSACTIONS_URL = `https://explorer.ritualfoundation.org/api/indexer-proxy/api/v1/addresses/${RITUAL_MAP_ADDRESS}/transactions`;
const INDEXER_TRANSACTION_URL = "https://explorer.ritualfoundation.org/api/indexer-proxy/api/v1/transactions";
const JOIN_SELECTOR = "0x29803b21";

type IndexedTransaction = {
  tx_hash: string;
  method_selector: string;
  input_data?: string;
};

export default async function handler(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const params = new URLSearchParams({
    limit: requestUrl.searchParams.get("limit") ?? "1000",
    offset: requestUrl.searchParams.get("offset") ?? "0",
    from_date: requestUrl.searchParams.get("from_date") ?? "2026-05-01",
    to_date: requestUrl.searchParams.get("to_date") ?? requestUrl.searchParams.get("from_date") ?? "2026-05-01",
  });

  const response = await fetch(`${INDEXER_TRANSACTIONS_URL}?${params}`);
  if (!response.ok) {
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  }

  const data = await response.json();
  const transactions: IndexedTransaction[] = Array.isArray(data.transactions) ? data.transactions : [];
  data.transactions = await Promise.all(
    transactions.map(async (transaction) => {
      if (transaction.method_selector !== JOIN_SELECTOR || typeof transaction.input_data === "string") {
        return transaction;
      }

      const details = await fetch(`${INDEXER_TRANSACTION_URL}/${transaction.tx_hash}`);
      if (!details.ok) return transaction;
      const detailData = await details.json();
      return { ...transaction, input_data: detailData.input_data };
    }),
  );

  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

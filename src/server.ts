import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { RITUAL_MAP_ADDRESS } from "./lib/ritual-contract";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

type IndexedTransaction = {
  tx_hash: string;
  method_selector: string;
  input_data?: string;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

const INDEXER_TRANSACTIONS_URL = `https://explorer.ritualfoundation.org/api/indexer-proxy/api/v1/addresses/${RITUAL_MAP_ADDRESS}/transactions`;
const INDEXER_TRANSACTION_URL = "https://explorer.ritualfoundation.org/api/indexer-proxy/api/v1/transactions";
const JOIN_SELECTOR = "0x29803b21";

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => ((m as { default?: ServerEntry }).default ?? (m as unknown as ServerEntry)),
    );
  }
  return serverEntryPromise;
}

function brandedErrorResponse(): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isCatastrophicSsrErrorBody(body: string, responseStatus: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return false;
  }

  const fields = payload as Record<string, unknown>;
  const expectedKeys = new Set(["message", "status", "unhandled"]);
  if (!Object.keys(fields).every((key) => expectedKeys.has(key))) {
    return false;
  }

  return (
    fields.unhandled === true &&
    fields.message === "HTTPError" &&
    (fields.status === undefined || fields.status === responseStatus)
  );
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

async function communityMapTransactions(request: Request): Promise<Response> {
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
    status: response.status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/community-map-transactions") {
        return await communityMapTransactions(request);
      }

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return brandedErrorResponse();
    }
  },
};

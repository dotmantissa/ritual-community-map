import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ComposableMap, Geographies, Geography, Marker } from "react-simple-maps";
import { toPng } from "html-to-image";
import {
  publicClient,
  connectWallet,
  getWalletClient,
  getInjected,
  ensureChain,
} from "@/lib/wallet";
import { RITUAL_MAP_ABI, RITUAL_MAP_ADDRESS, RITUAL_MAP_DEPLOY_BLOCK } from "@/lib/ritual-contract";
import { COUNTRIES, getCountry } from "@/lib/countries";
import logo from "@/assets/ritual-logo.png";

const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
const JOIN_SELECTOR = "0x29803b21";
const LOG_BLOCK_RANGE = 49_999n;
const INDEXER_TRANSACTIONS_URL = "/api/community-map-transactions";

export type Member = {
  address: `0x${string}`;
  handle: string;
  region: string;
  timestamp: number;
  blockNumber?: number;
  transactionIndex?: number;
  regionRank?: number;
};

type SuccessInfo = {
  handle: string;
  region: string;
  rank: number;
  total: number;
  address: `0x${string}`;
};

type IndexedTransaction = {
  tx_hash: string;
  block_number: number;
  block_timestamp: number;
  from_address: string;
  status: number;
  tx_index: number;
  method_selector: string;
  input_data?: string;
};

type ApiMember = Member & {
  address: `0x${string}`;
};

function regionCoords(id: string): [number, number] {
  return getCountry(id)?.coords ?? [0, 0];
}
function jitter(seed: string): [number, number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const a = ((h & 0xffff) / 0xffff - 0.5) * 6;
  const b = (((h >> 16) & 0xffff) / 0xffff - 0.5) * 4;
  return [a, b];
}
function avatarUrl(handle: string) {
  const clean = handle.replace(/^@/, "").trim();
  return `https://unavatar.io/x/${encodeURIComponent(clean)}`;
}

function normalizeHandle(handle: string) {
  return handle.replace(/^@+/, "").trim().toLowerCase();
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

function dateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

async function getJoinedCount(): Promise<number> {
  const count = await publicClient.readContract({
    address: RITUAL_MAP_ADDRESS,
    abi: RITUAL_MAP_ABI,
    functionName: "count",
  });
  return Number(count);
}

async function fetchMembersFromContract(): Promise<Member[]> {
  const [addresses, handles, regions, timestamps] = await publicClient.readContract({
    address: RITUAL_MAP_ADDRESS,
    abi: RITUAL_MAP_ABI,
    functionName: "getAll",
  });

  const length = Math.min(addresses.length, handles.length, regions.length, timestamps.length);
  const members: Member[] = [];
  for (let index = 0; index < length; index++) {
    members.push({
      address: addresses[index] as `0x${string}`,
      handle: handles[index],
      region: regions[index],
      timestamp: Number(timestamps[index]),
    });
  }

  return normalizeMembers(members);
}

function dedupeMembersByAddress(members: Member[]): Member[] {
  const seen = new Set<string>();
  const list: Member[] = [];
  for (const member of members) {
    const key = member.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(member);
  }
  return list;
}

function orderValue(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function normalizeTimestamp(value: number) {
  return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
}

function sortMembersByJoinOrder(members: Member[]): Member[] {
  return [...members]
    .map((member, index) => ({ member, index }))
    .sort((a, b) => {
      const blockDiff = orderValue(a.member.blockNumber) - orderValue(b.member.blockNumber);
      if (blockDiff !== 0) return blockDiff;
      const txDiff = orderValue(a.member.transactionIndex) - orderValue(b.member.transactionIndex);
      if (txDiff !== 0) return txDiff;
      const timeDiff = a.member.timestamp - b.member.timestamp;
      if (timeDiff !== 0) return timeDiff;
      return a.index - b.index;
    })
    .map(({ member }) => member);
}

function normalizeMembers(members: Member[]): Member[] {
  const regionCounts = new Map<string, number>();
  return dedupeMembersByAddress(sortMembersByJoinOrder(members)).map((member) => {
    const regionRank = (regionCounts.get(member.region) ?? 0) + 1;
    regionCounts.set(member.region, regionRank);
    return { ...member, regionRank };
  });
}

function mergeMemberLists(current: Member[], incoming: Member[]): Member[] {
  const byAddress = new Map<string, Member>();
  for (const member of current) byAddress.set(member.address.toLowerCase(), member);
  for (const member of incoming) byAddress.set(member.address.toLowerCase(), member);
  return normalizeMembers([...byAddress.values()]);
}

function membersFromTransactions(transactions: IndexedTransaction[]): Member[] {
  const members = transactions
    .filter(
      (tx): tx is IndexedTransaction & { input_data: string } =>
        tx.status === 1 &&
        tx.method_selector === JOIN_SELECTOR &&
        typeof tx.input_data === "string",
    )
    .sort((a, b) => a.block_number - b.block_number || a.tx_index - b.tx_index)
    .flatMap((tx) => {
      const decoded = decodeJoinInput(tx.input_data);
      if (!decoded) return [];
      return [
        {
          address: tx.from_address as `0x${string}`,
          handle: decoded.handle,
          region: decoded.region,
          timestamp: normalizeTimestamp(Number(tx.block_timestamp)),
          blockNumber: tx.block_number,
          transactionIndex: tx.tx_index,
        },
      ];
    });
  return normalizeMembers(members);
}

async function fetchMembersFromEvents(): Promise<Member[]> {
  const latest = await publicClient.getBlockNumber();
  const members: Member[] = [];
  for (
    let fromBlock = RITUAL_MAP_DEPLOY_BLOCK;
    fromBlock <= latest;
    fromBlock += LOG_BLOCK_RANGE + 1n
  ) {
    const toBlock = fromBlock + LOG_BLOCK_RANGE > latest ? latest : fromBlock + LOG_BLOCK_RANGE;
    const chunk = await publicClient.getContractEvents({
      address: RITUAL_MAP_ADDRESS,
      abi: RITUAL_MAP_ABI,
      eventName: "Joined",
      fromBlock,
      toBlock,
    });
    members.push(
      ...chunk.map((log) => ({
        address: log.args.user as `0x${string}`,
        handle: log.args.handle as string,
        region: log.args.region as string,
        timestamp: Number(log.args.timestamp as bigint),
        blockNumber: Number(log.blockNumber),
        transactionIndex: Number(log.transactionIndex ?? log.logIndex ?? 0),
      })),
    );
  }

  return normalizeMembers(members);
}

async function fetchMembersFromIndexer(force = false): Promise<Member[]> {
  const params = new URLSearchParams({
    all: "1",
    members: "1",
    limit: "1000",
    from_date: "2026-05-01",
    to_date: dateString(addDays(new Date(), 1)),
  });
  if (force) {
    params.set("fresh", "1");
    params.set("t", String(Date.now()));
  }

  const response = await fetch(`${INDEXER_TRANSACTIONS_URL}?${params}`, {
    cache: force ? "no-store" : "default",
  });
  if (!response.ok) throw new Error("Indexer fetch failed");
  const data = await response.json();
  if (Array.isArray(data.members) && data.members.length > 0) {
    return normalizeMembers(
      data.members.map((member: ApiMember) => ({
        address: member.address,
        handle: member.handle,
        region: member.region,
        timestamp: Number(member.timestamp),
        blockNumber: member.blockNumber,
        transactionIndex: member.transactionIndex,
        regionRank: member.regionRank,
      })),
    );
  }

  const transactions: IndexedTransaction[] = Array.isArray(data.transactions)
    ? data.transactions
    : [];
  return membersFromTransactions(transactions);
}

async function fetchAllMembers(force = false): Promise<Member[]> {
  let indexerMembers: Member[] = [];
  try {
    indexerMembers = await fetchMembersFromIndexer(force);
    if (indexerMembers.length > 0) return indexerMembers;
  } catch (error) {
    console.error(error);
  }

  const expectedCount = await getJoinedCount();
  let contractMembers: Member[] = [];
  try {
    contractMembers = await fetchMembersFromContract();
  } catch (error) {
    console.error(error);
  }
  if (contractMembers.length >= expectedCount) return normalizeMembers(contractMembers);

  let eventMembers: Member[] = [];
  try {
    eventMembers = await fetchMembersFromEvents();
  } catch (error) {
    console.error(error);
  }
  if (eventMembers.length >= expectedCount) return normalizeMembers(eventMembers);

  const combinedMembers = normalizeMembers([
    ...indexerMembers,
    ...contractMembers,
    ...eventMembers,
  ]);
  if (combinedMembers.length > 0) return combinedMembers;
  throw new Error("Could not fetch every registered user");
}

export function CommunityMap() {
  const [members, setMembers] = useState<Member[]>([]);
  const membersRef = useRef<Member[]>([]);
  const refreshPromiseRef = useRef<Promise<Member[]> | null>(null);
  const autoShownAccountRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [handle, setHandle] = useState("");
  const [region, setRegion] = useState("us");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [hovered, setHovered] = useState<Member | null>(null);
  const [tick, setTick] = useState(0);
  const [success, setSuccess] = useState<SuccessInfo | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const myMember = useMemo(() => {
    if (!account) return null;
    return members.find((m) => m.address.toLowerCase() === account.toLowerCase()) ?? null;
  }, [account, members]);

  const showMemberCard = useCallback(
    (member: Member) => {
      const source = membersRef.current.length > 0 ? membersRef.current : members;
      const normalized = normalizeMembers(source);
      const current =
        normalized.find((m) => m.address.toLowerCase() === member.address.toLowerCase()) ?? member;
      const inRegion = normalized.filter((m) => m.region === current.region);
      const rank =
        current.regionRank ??
        inRegion.findIndex((m) => m.address.toLowerCase() === current.address.toLowerCase()) + 1;
      setSuccess({
        handle: current.handle,
        region: current.region,
        rank: Math.max(rank, 1),
        total: inRegion.length,
        address: current.address,
      });
    },
    [members],
  );

  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 700);
    return () => clearInterval(i);
  }, []);

  // Auto-detect already-connected wallet
  useEffect(() => {
    async function detect() {
      const eth = getInjected();
      if (!eth) return;
      try {
        const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
        if (accounts[0]) {
          setAccount(accounts[0] as `0x${string}`);
        }
      } catch (error) {
        console.error(error);
      }
    }
    detect();
  }, []);

  useEffect(() => {
    if (!account) return;
    const accountKey = account.toLowerCase();
    if (autoShownAccountRef.current === accountKey) return;
    const found = membersRef.current.find((m) => m.address.toLowerCase() === accountKey);
    if (!found) return;
    autoShownAccountRef.current = accountKey;
    showMemberCard(found);
  }, [account, showMemberCard]);

  async function refresh(force = false): Promise<Member[]> {
    if (!force && refreshPromiseRef.current) return refreshPromiseRef.current;

    refreshPromiseRef.current = (async () => {
      try {
        const list = await fetchAllMembers(force);
        const current = membersRef.current;
        const next = current.length > 0 ? mergeMemberLists(current, list) : normalizeMembers(list);
        membersRef.current = next;
        setMembers(next);
        return next;
      } catch (e) {
        console.error(e);
        return membersRef.current;
      } finally {
        setLoading(false);
        refreshPromiseRef.current = null;
      }
    })();

    return refreshPromiseRef.current;
  }

  useEffect(() => {
    refresh();
    let unwatch: (() => void) | undefined;
    try {
      unwatch = publicClient.watchContractEvent({
        address: RITUAL_MAP_ADDRESS,
        abi: RITUAL_MAP_ABI,
        eventName: "Joined",
        onLogs: () => refresh(true),
        poll: true,
        pollingInterval: 4000,
      });
    } catch (error) {
      console.error(error);
    }
    const i = setInterval(refresh, 8000);
    return () => {
      unwatch?.();
      clearInterval(i);
    };
  }, []);

  async function onConnect() {
    try {
      setStatus("");
      const a = await connectWallet();
      setAccount(a);
      const found = members.find((m) => m.address.toLowerCase() === a.toLowerCase());
      if (found) {
        autoShownAccountRef.current = a.toLowerCase();
        showMemberCard(found);
      }
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : "Connect failed");
    }
  }

  async function onJoin() {
    setStatus("");
    const cleanHandle = handle.replace(/^@+/, "").trim();
    if (!cleanHandle) return setStatus("Enter your X handle");
    if (!getCountry(region)) return setStatus("Select a country");
    let acct = account;
    if (!acct) {
      try {
        acct = await connectWallet();
        setAccount(acct);
      } catch (error: unknown) {
        return setStatus(error instanceof Error ? error.message : "Wallet required");
      }
    }
    setBusy(true);
    try {
      const list = await refresh();
      const expectedCount = await getJoinedCount();
      if (list.length < expectedCount) {
        setStatus("Syncing every registered user. Try again in a moment.");
        return;
      }
      const existingHandle = list.find(
        (m) => normalizeHandle(m.handle) === normalizeHandle(cleanHandle),
      );
      if (existingHandle && existingHandle.address.toLowerCase() !== acct!.toLowerCase()) {
        setStatus(`@${cleanHandle} is already on the map with another wallet`);
        return;
      }
      await ensureChain();
      const w = getWalletClient(acct!);
      setStatus("Awaiting signature…");
      // Use a tiny tip so total fee stays negligible on the Ritual testnet.
      const hash = await w.writeContract({
        address: RITUAL_MAP_ADDRESS,
        abi: RITUAL_MAP_ABI,
        functionName: "join",
        args: [cleanHandle, region],
        maxFeePerGas: 1_000_000_000n, // 1 gwei cap
        maxPriorityFeePerGas: 1n, // ~0 tip
      });
      setStatus("Transmitting → " + hash.slice(0, 10) + "…");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted");
      const confirmedMember: Member = {
        address: acct!,
        handle: cleanHandle,
        region,
        timestamp: Math.floor(Date.now() / 1000),
        blockNumber: Number(receipt.blockNumber),
        transactionIndex: Number(receipt.transactionIndex),
      };
      const nextList = mergeMemberLists(membersRef.current, [confirmedMember]);
      membersRef.current = nextList;
      setMembers(nextList);
      const mine =
        nextList.find((m) => m.address.toLowerCase() === acct!.toLowerCase()) ?? confirmedMember;
      const inRegion = nextList.filter((m) => m.region === region);
      const rank =
        mine.regionRank ??
        inRegion.findIndex((m) => m.address.toLowerCase() === mine.address.toLowerCase()) + 1;
      setSuccess({
        handle: cleanHandle,
        region,
        rank: Math.max(rank, 1),
        total: Math.max(inRegion.length, 1),
        address: acct!,
      });
      setBanner(`tx confirmed · ${hash.slice(0, 10)}…`);
      setStatus("Joined the lattice.");
      setTimeout(() => setBanner(null), 6000);
      void refresh(true);
    } catch (error: unknown) {
      if (error && typeof error === "object") {
        const richError = error as { shortMessage?: string; message?: string };
        setStatus(richError.shortMessage ?? richError.message ?? "Failed");
      } else {
        setStatus("Failed");
      }
    } finally {
      setBusy(false);
    }
  }

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of members) m.set(u.region, (m.get(u.region) ?? 0) + 1);
    return m;
  }, [members]);

  const placedMembers = useMemo(
    () =>
      members.map((m) => {
        const [lng, lat] = regionCoords(m.region);
        const [dx, dy] = jitter(m.address);
        return { ...m, lng: lng + dx, lat: lat + dy };
      }),
    [members],
  );

  return (
    <div className="scanlines relative min-h-screen">
      <Topbar account={account} onConnect={onConnect} count={members.length} />
      {banner && <SuccessBanner text={banner} onClose={() => setBanner(null)} />}
      <main className="relative mx-auto max-w-[1500px] px-4 pb-20 pt-6 lg:px-8">
        <Hero />
        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
          <MapPanel
            members={placedMembers}
            hovered={hovered}
            setHovered={setHovered}
            tick={tick}
            loading={loading}
          />
          <aside className="flex flex-col gap-6">
            {myMember ? (
              <MyCard member={myMember} onOpenCard={() => showMemberCard(myMember)} />
            ) : (
              <JoinCard
                handle={handle}
                setHandle={setHandle}
                region={region}
                setRegion={setRegion}
                account={account}
                busy={busy}
                status={status}
                onJoin={onJoin}
                onConnect={onConnect}
              />
            )}
            <RegionList
              counts={counts}
              active={region}
              setRegion={setRegion}
              total={members.length}
            />
          </aside>
        </div>
        <Marquee count={members.length} loading={loading} members={members} />
      </main>
      <Footer />
      {success && (
        <ShareCardModal
          info={success}
          regionTotal={counts.get(success.region) ?? success.total}
          onClose={() => setSuccess(null)}
        />
      )}
    </div>
  );
}

function SuccessBanner({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="sticky top-[57px] z-40 border-y border-[var(--ritual-green)] bg-[color-mix(in_oklab,var(--ritual-green)_22%,black)] backdrop-blur-md">
      <div className="mx-auto flex max-w-[1500px] items-center justify-between px-4 py-2 lg:px-8">
        <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.3em] text-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-[var(--ritual-green-bright)]" />
          <span className="font-bold text-[var(--ritual-green-bright)]">
            // transaction confirmed
          </span>
          <span className="hidden text-muted-foreground sm:inline">{text}</span>
        </div>
        <button
          onClick={onClose}
          className="text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
        >
          dismiss ✕
        </button>
      </div>
    </div>
  );
}

function Topbar({
  account,
  onConnect,
  count,
}: {
  account: string | null;
  onConnect: () => void;
  count: number;
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/70 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1500px] items-center justify-between px-4 py-3 lg:px-8">
        <div className="flex items-center gap-3">
          <img src={logo} alt="Ritual" className="h-9 w-9 rounded-sm flicker" />
          <div className="leading-tight">
            <div className="text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
              Ritual
            </div>
            <div className="text-sm font-bold tracking-wider text-foreground">COMMUNITY//MAP</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-2 rounded-sm border border-border bg-card/60 px-3 py-1.5 text-[11px] sm:flex">
            <span className="size-1.5 animate-pulse rounded-full bg-[var(--ritual-green-bright)]" />
            <span className="text-muted-foreground">chain</span>
            <span className="text-foreground">1979</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-foreground">{count} initiates</span>
          </div>
          <button
            onClick={onConnect}
            className="group relative overflow-hidden rounded-sm border border-[var(--ritual-green)] px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-foreground transition-colors hover:bg-[var(--ritual-green)] hover:text-primary-foreground"
          >
            {account ? account.slice(0, 6) + "…" + account.slice(-4) : "Connect Wallet"}
          </button>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden rounded-sm border border-border bg-card/40 px-6 py-10 lg:px-10 lg:py-14">
      <div className="ritual-grid absolute inset-0 opacity-60" />
      <div className="relative">
        <div className="text-[11px] uppercase tracking-[0.4em] text-[var(--ritual-green-bright)]">
          // the lattice is open
        </div>
        <h1
          className="glitch mt-3 text-4xl font-black uppercase leading-[0.95] tracking-tight text-foreground sm:text-6xl lg:text-7xl"
          data-text="Ritual Community Map"
        >
          Ritual Community Map
        </h1>
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground sm:text-base">
          Sign one transaction on Ritual testnet (chain 1979) and pin yourself to the
          autonomous-agent lattice. Every pulse on the map is an on-chain initiate.
        </p>
      </div>
    </section>
  );
}

function MapPanel({
  members,
  hovered,
  setHovered,
  tick,
  loading,
}: {
  members: (Member & { lng: number; lat: number })[];
  hovered: Member | null;
  setHovered: (m: Member | null) => void;
  tick: number;
  loading: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-sm border border-border bg-card/40">
      <div className="ritual-grid absolute inset-0 opacity-40" />
      <div className="relative">
        <div className="flex items-center justify-between border-b border-border px-4 py-2 text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
          <span>// global lattice {loading ? "· syncing" : ""}</span>
          <span className="text-[var(--ritual-green-bright)]">
            {tick % 2 === 0 ? "● live" : "○ live"}
          </span>
        </div>
        <div className="relative" onMouseLeave={() => setHovered(null)}>
          <ComposableMap
            projection="geoEqualEarth"
            projectionConfig={{ scale: 175 }}
            width={980}
            height={520}
            style={{ width: "100%", height: "auto" }}
          >
            <Geographies geography={GEO_URL}>
              {({ geographies }: { geographies: Array<{ rsmKey: string }> }) =>
                geographies.map((geo) => (
                  <Geography
                    key={geo.rsmKey}
                    geography={geo}
                    style={{
                      default: {
                        fill: "color-mix(in oklab, var(--ritual-green-deep) 38%, transparent)",
                        stroke: "color-mix(in oklab, var(--ritual-green) 60%, transparent)",
                        strokeWidth: 0.4,
                        outline: "none",
                      },
                      hover: {
                        fill: "color-mix(in oklab, var(--ritual-green) 45%, transparent)",
                        outline: "none",
                      },
                      pressed: { outline: "none" },
                    }}
                  />
                ))
              }
            </Geographies>
            {members.map((m) => (
              <Marker key={m.address} coordinates={[m.lng, m.lat]}>
                <g onMouseEnter={() => setHovered(m)} style={{ cursor: "pointer" }}>
                  <circle
                    r={8}
                    fill="var(--ritual-green-bright)"
                    opacity={0.18}
                    className="ritual-ping"
                    style={{ transformOrigin: "center" }}
                  />
                  <circle
                    r={3.2}
                    fill="var(--ritual-green-bright)"
                    stroke="white"
                    strokeWidth={0.6}
                  />
                </g>
              </Marker>
            ))}
          </ComposableMap>
          {hovered && (
            <div className="pointer-events-none absolute left-3 top-3 flex max-w-xs items-center gap-3 rounded-sm border border-[var(--ritual-green)] bg-background/90 p-2 backdrop-blur-md">
              <img
                src={avatarUrl(hovered.handle)}
                alt={hovered.handle}
                className="h-10 w-10 rounded-sm border border-border object-cover"
                onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
              />
              <div className="text-xs">
                <div className="font-bold text-foreground">@{hovered.handle}</div>
                <div className="text-muted-foreground">
                  {getCountry(hovered.region)?.flag}{" "}
                  {getCountry(hovered.region)?.name ?? hovered.region}
                </div>
                <a
                  href={`https://explorer.ritualfoundation.org/address/${hovered.address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="pointer-events-auto text-[10px] text-muted-foreground/80 hover:text-[var(--ritual-green-bright)]"
                >
                  {hovered.address.slice(0, 10)}…{hovered.address.slice(-6)}
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CountryCombobox({
  region,
  setRegion,
}: {
  region: string;
  setRegion: (s: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = getCountry(region);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const q = query.trim().toLowerCase();
  const matches = q
    ? COUNTRIES.filter((c) => c.name.toLowerCase().includes(q) || c.code.includes(q)).slice(0, 60)
    : COUNTRIES.slice(0, 60);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-1 flex w-full items-center justify-between rounded-sm border border-border bg-background/70 px-3 py-2.5 text-left text-sm text-foreground outline-none focus:border-[var(--ritual-green)]"
      >
        <span className="flex items-center gap-2">
          <span className="text-base">{selected?.flag ?? "🏳️"}</span>
          <span>{selected?.name ?? "Select country"}</span>
        </span>
        <span className="text-muted-foreground">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 rounded-sm border border-[var(--ritual-green)] bg-background/95 backdrop-blur-md shadow-2xl">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search country…"
            className="w-full border-b border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <ul className="max-h-64 overflow-y-auto">
            {matches.length === 0 && (
              <li className="px-3 py-3 text-xs text-muted-foreground">no matches</li>
            )}
            {matches.map((c) => (
              <li key={c.code}>
                <button
                  type="button"
                  onClick={() => {
                    setRegion(c.code);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[color-mix(in_oklab,var(--ritual-green)_18%,transparent)] ${
                    region === c.code
                      ? "bg-[color-mix(in_oklab,var(--ritual-green)_12%,transparent)] text-foreground"
                      : "text-foreground/90"
                  }`}
                >
                  <span className="text-base">{c.flag}</span>
                  <span className="flex-1">{c.name}</span>
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    {c.code}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MyCard({ member, onOpenCard }: { member: Member; onOpenCard: () => void }) {
  const country = getCountry(member.region);
  const inRegion = member.region;
  return (
    <section className="rounded-sm border border-border bg-card/60 p-5">
      <div className="text-[11px] uppercase tracking-[0.3em] text-[var(--ritual-green-bright)]">
        // initiated
      </div>
      <h2 className="mt-1 text-lg font-bold uppercase tracking-wider text-foreground">
        You are in the lattice
      </h2>

      <div className="mt-4 flex items-center gap-3">
        <img
          src={avatarUrl(member.handle)}
          alt={member.handle}
          className="h-12 w-12 rounded-sm border border-border object-cover"
          onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-foreground">@{member.handle}</div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="text-base">{country?.flag}</span>
            <span>{country?.name ?? inRegion}</span>
          </div>
        </div>
      </div>

      <button
        onClick={onOpenCard}
        className="mt-5 w-full rounded-sm bg-[var(--ritual-green)] px-4 py-3 text-xs font-black uppercase tracking-[0.25em] text-primary-foreground transition-colors hover:bg-[var(--ritual-green-bright)]"
      >
        View My Card
      </button>
    </section>
  );
}

function JoinCard({
  handle,
  setHandle,
  region,
  setRegion,
  account,
  busy,
  status,
  onJoin,
  onConnect,
}: {
  handle: string;
  setHandle: (s: string) => void;
  region: string;
  setRegion: (s: string) => void;
  account: string | null;
  busy: boolean;
  status: string;
  onJoin: () => void;
  onConnect: () => void;
}) {
  const cleanHandle = handle.replace(/^@/, "").trim();
  return (
    <section className="rounded-sm border border-border bg-card/60 p-5">
      <div className="text-[11px] uppercase tracking-[0.3em] text-[var(--ritual-green-bright)]">
        // initiate
      </div>
      <h2 className="mt-1 text-lg font-bold uppercase tracking-wider text-foreground">
        Join the lattice
      </h2>

      <label className="mt-4 block text-[11px] uppercase tracking-widest text-muted-foreground">
        X handle
      </label>
      <div className="mt-1 flex items-center rounded-sm border border-border bg-background/70 focus-within:border-[var(--ritual-green)]">
        <span className="px-3 text-muted-foreground">@</span>
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="vitalik"
          className="w-full bg-transparent py-2.5 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
          maxLength={32}
          spellCheck={false}
        />
        {cleanHandle && (
          <img
            src={avatarUrl(cleanHandle)}
            onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
            alt=""
            className="mr-2 h-7 w-7 rounded-sm border border-border object-cover"
          />
        )}
      </div>

      <label className="mt-4 block text-[11px] uppercase tracking-widest text-muted-foreground">
        Country
      </label>
      <CountryCombobox region={region} setRegion={setRegion} />

      <button
        onClick={onJoin}
        disabled={busy}
        className="mt-5 w-full rounded-sm bg-[var(--ritual-green)] px-4 py-3 text-xs font-black uppercase tracking-[0.25em] text-primary-foreground transition-colors hover:bg-[var(--ritual-green-bright)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "…signing…" : account ? "Sign & Join" : "Connect & Join"}
      </button>
      {!account && (
        <button
          onClick={onConnect}
          className="mt-2 w-full text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
        >
          or connect wallet first
        </button>
      )}
      {status && (
        <div className="mt-3 break-all rounded-sm border border-border bg-background/60 p-2 text-[11px] text-muted-foreground">
          <span className="text-[var(--ritual-green-bright)]">›</span> {status}
        </div>
      )}
      <div className="mt-3 text-[10px] uppercase tracking-widest text-muted-foreground/70">
        Need RITUAL?{" "}
        <a
          href="https://faucet.ritualfoundation.org"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--ritual-green-bright)] underline-offset-2 hover:underline"
        >
          faucet ↗
        </a>
      </div>
    </section>
  );
}

function RegionList({
  counts,
  active,
  setRegion,
  total,
}: {
  counts: Map<string, number>;
  active: string;
  setRegion: (id: string) => void;
  total: number;
}) {
  const entries = useMemo(() => {
    return Array.from(counts.entries())
      .filter(([code, c]) => c > 0 && getCountry(code))
      .sort((a, b) => b[1] - a[1]);
  }, [counts]);
  const max = Math.max(1, ...entries.map(([, c]) => c));
  return (
    <section className="rounded-sm border border-border bg-card/60 p-5">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.3em] text-[var(--ritual-green-bright)]">
            // regions
          </div>
          <h2 className="mt-1 text-lg font-bold uppercase tracking-wider text-foreground">
            Distribution
          </h2>
        </div>
        <div className="text-right">
          <div className="text-2xl font-black tabular-nums text-foreground">{total}</div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">total</div>
        </div>
      </div>
      {entries.length === 0 ? (
        <div className="mt-6 rounded-sm border border-dashed border-border p-4 text-center text-[11px] uppercase tracking-widest text-muted-foreground">
          // no countries yet · be the first
        </div>
      ) : (
        <ul className="mt-4 max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {entries.map(([code, c]) => {
            const country = getCountry(code)!;
            const pct = (c / max) * 100;
            const isActive = code === active;
            return (
              <li key={code}>
                <button
                  onClick={() => setRegion(code)}
                  className={`group block w-full rounded-sm border px-3 py-2 text-left transition-colors ${
                    isActive
                      ? "border-[var(--ritual-green)] bg-[color-mix(in_oklab,var(--ritual-green)_12%,transparent)]"
                      : "border-transparent hover:border-border"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span
                      className={`flex items-center gap-2 uppercase tracking-wider ${isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"}`}
                    >
                      <span className="text-base">{country.flag}</span>
                      {country.name}
                    </span>
                    <span className="font-bold tabular-nums text-foreground">{c}</span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-background/60">
                    <div
                      className="h-full bg-[var(--ritual-green-bright)] transition-all duration-700"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Marquee({
  count,
  loading,
  members,
}: {
  count: number;
  loading: boolean;
  members: Member[];
}) {
  const items = members.length
    ? members.slice(-12).map((m) => `@${m.handle}`)
    : ["awaiting initiates", "the lattice listens", "chain 1979", "ritual.foundation"];
  const doubled = [...items, ...items, ...items, ...items];
  return (
    <div className="mt-10 overflow-hidden rounded-sm border border-border bg-card/40 py-3">
      <div className="flex w-max gap-10 marquee-track text-[11px] uppercase tracking-[0.4em] text-muted-foreground">
        {doubled.map((t, i) => (
          <span key={i} className="flex items-center gap-3">
            <span className="size-1 rounded-full bg-[var(--ritual-green-bright)]" />
            {t}
          </span>
        ))}
      </div>
      {loading && (
        <div className="mt-2 px-4 text-[10px] uppercase tracking-widest text-muted-foreground">
          …syncing chain {count > 0 ? `· ${count} loaded` : ""}
        </div>
      )}
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border py-8 text-center text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
      built on{" "}
      <a
        href="https://ritualfoundation.org"
        target="_blank"
        rel="noreferrer"
        className="text-[var(--ritual-green-bright)] hover:underline"
      >
        ritual
      </a>{" "}
      · chain 1979 · testnet
    </footer>
  );
}

function ShareCardModal({
  info,
  regionTotal,
  onClose,
}: {
  info: SuccessInfo;
  regionTotal: number;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const country = getCountry(info.region);
  const displayTotal = Math.max(regionTotal, info.total);
  const shareText = `I just joined the @ritualnet community map.

${country?.flag ?? ""} ${country?.name ?? info.region} · #${info.rank} of ${displayTotal}
@${info.handle} pinned to the lattice ⛧

ritual-community-map.lovable.app`;

  async function download() {
    if (!cardRef.current) return;
    setDownloading(true);
    try {
      const dataUrl = await toPng(cardRef.current, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: "#000000",
      });
      const link = document.createElement("a");
      link.download = `ritual-${info.handle}-${info.region}.png`;
      link.href = dataUrl;
      link.click();
    } catch (e) {
      console.error(e);
    } finally {
      setDownloading(false);
    }
  }

  function shareToX() {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
        >
          close ✕
        </button>

        {/* The capturable card */}
        <div
          ref={cardRef}
          className="relative overflow-hidden rounded-sm border border-[var(--ritual-green)] bg-black p-6 text-white"
          style={{ aspectRatio: "1 / 1.15" }}
        >
          {/* grid bg */}
          <div
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
              backgroundImage:
                "linear-gradient(color-mix(in oklab, var(--ritual-green) 25%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in oklab, var(--ritual-green) 25%, transparent) 1px, transparent 1px)",
              backgroundSize: "32px 32px",
            }}
          />
          <div
            className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full opacity-50 blur-3xl"
            style={{ background: "var(--ritual-green-bright)" }}
          />

          <div className="relative flex h-full flex-col">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <img src={logo} alt="" crossOrigin="anonymous" className="h-7 w-7" />
                <div className="leading-tight">
                  <div className="text-[9px] uppercase tracking-[0.32em] text-white/60">Ritual</div>
                  <div className="text-[11px] font-bold tracking-wider">COMMUNITY//MAP</div>
                </div>
              </div>
              <div className="rounded-sm border border-[var(--ritual-green)] px-2 py-1 text-[9px] uppercase tracking-widest text-[var(--ritual-green-bright)]">
                ⛧ initiated
              </div>
            </div>

            <div className="mt-6 flex items-center gap-4">
              <div className="relative">
                <div className="absolute inset-0 -m-1 rounded-sm border border-[var(--ritual-green)]" />
                <img
                  src={avatarUrl(info.handle)}
                  alt={info.handle}
                  crossOrigin="anonymous"
                  className="relative h-20 w-20 rounded-sm border border-border object-cover"
                  onError={(e) =>
                    ((e.target as HTMLImageElement).src = "https://unavatar.io/fallback.png")
                  }
                />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.3em] text-white/60">x handle</div>
                <div className="truncate text-2xl font-black tracking-tight">@{info.handle}</div>
                <div className="mt-1 flex items-center gap-1 text-sm text-white/80">
                  <span className="text-lg">{country?.flag}</span>
                  <span>{country?.name ?? info.region}</span>
                </div>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="rounded-sm border border-[color-mix(in_oklab,var(--ritual-green)_45%,transparent)] bg-white/5 p-3">
                <div className="text-[9px] uppercase tracking-[0.3em] text-white/60">
                  // my rank
                </div>
                <div className="mt-1 text-3xl font-black tabular-nums text-[var(--ritual-green-bright)]">
                  #{info.rank}
                </div>
                <div className="text-[10px] uppercase tracking-widest text-white/60">
                  in {country?.code.toUpperCase() ?? info.region}
                </div>
              </div>
              <div className="rounded-sm border border-[color-mix(in_oklab,var(--ritual-green)_45%,transparent)] bg-white/5 p-3">
                <div className="text-[9px] uppercase tracking-[0.3em] text-white/60">
                  // region total
                </div>
                <div className="mt-1 text-3xl font-black tabular-nums">{displayTotal}</div>
                <div className="text-[10px] uppercase tracking-widest text-white/60">initiates</div>
              </div>
            </div>

            <div className="mt-auto pt-6">
              <div className="text-[9px] uppercase tracking-[0.3em] text-white/50">// wallet</div>
              <div className="mt-0.5 break-all font-mono text-[10px] text-white/70">
                {info.address}
              </div>
              <div className="mt-2 flex items-center justify-between text-[9px] uppercase tracking-[0.3em] text-white/40">
                <span>chain · 1979 · ritual testnet</span>
                <span>ritual-community-map</span>
              </div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button
            onClick={download}
            disabled={downloading}
            className="rounded-sm border border-border bg-card/60 px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest text-foreground transition-colors hover:border-[var(--ritual-green)] disabled:opacity-60"
          >
            {downloading ? "rendering…" : "↓ download"}
          </button>
          <button
            onClick={shareToX}
            className="rounded-sm bg-[var(--ritual-green)] px-4 py-2.5 text-[11px] font-black uppercase tracking-widest text-primary-foreground transition-colors hover:bg-[var(--ritual-green-bright)]"
          >
            share to 𝕏
          </button>
        </div>
        <p className="mt-3 text-center text-[10px] uppercase tracking-widest text-muted-foreground">
          // tx confirmed · welcome to the lattice
        </p>
      </div>
    </div>
  );
}

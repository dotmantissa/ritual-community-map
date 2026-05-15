import { useEffect, useMemo, useRef, useState } from "react";
import { ComposableMap, Geographies, Geography } from "react-simple-maps";
import { motion, AnimatePresence } from "motion/react";
import { publicClient, connectWallet, getWalletClient, getInjected, ensureChain } from "@/lib/wallet";
import { RITUAL_MAP_ABI, RITUAL_MAP_ADDRESS, REGIONS } from "@/lib/ritual-contract";
import logo from "@/assets/ritual-logo.png";

const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

export type Member = {
  address: `0x${string}`;
  handle: string;
  region: string;
  timestamp: number;
};

function regionCoords(id: string): [number, number] {
  return REGIONS.find((r) => r.id === id)?.coords ?? [0, 0];
}
function jitter(seed: string): [number, number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const a = ((h & 0xffff) / 0xffff - 0.5) * 18;
  const b = (((h >> 16) & 0xffff) / 0xffff - 0.5) * 12;
  return [a, b];
}

function avatarUrl(handle: string) {
  const clean = handle.replace(/^@/, "").trim();
  return `https://unavatar.io/x/${encodeURIComponent(clean)}?fallback=https://unavatar.io/${encodeURIComponent(clean)}`;
}

export function CommunityMap() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [handle, setHandle] = useState("");
  const [region, setRegion] = useState(REGIONS[0].id);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [hovered, setHovered] = useState<Member | null>(null);
  const [tick, setTick] = useState(0);

  // Animated heartbeat tick for cursor flicker
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 600);
    return () => clearInterval(i);
  }, []);

  async function refresh() {
    try {
      const res = (await publicClient.readContract({
        address: RITUAL_MAP_ADDRESS,
        abi: RITUAL_MAP_ABI,
        functionName: "getAll",
      })) as readonly [readonly `0x${string}`[], readonly string[], readonly string[], readonly bigint[]];
      const [addrs, handles, regions, ts] = res;
      const list: Member[] = addrs.map((a, i) => ({
        address: a,
        handle: handles[i],
        region: regions[i],
        timestamp: Number(ts[i]),
      }));
      setMembers(list);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const unwatch = publicClient.watchContractEvent({
      address: RITUAL_MAP_ADDRESS,
      abi: RITUAL_MAP_ABI,
      eventName: "Joined",
      onLogs: () => refresh(),
    });
    return () => unwatch();
  }, []);

  async function onConnect() {
    try {
      setStatus("");
      const a = await connectWallet();
      setAccount(a);
    } catch (e: any) {
      setStatus(e?.message ?? "Connect failed");
    }
  }

  async function onJoin() {
    setStatus("");
    if (!handle.trim()) return setStatus("Enter your X handle");
    if (!account) {
      try {
        const a = await connectWallet();
        setAccount(a);
      } catch (e: any) {
        return setStatus(e?.message ?? "Wallet required");
      }
    }
    setBusy(true);
    try {
      await ensureChain();
      const acct = (account ?? (getInjected() && (await getInjected().request({ method: "eth_accounts" }))[0])) as `0x${string}`;
      const w = getWalletClient(acct);
      setStatus("Awaiting signature…");
      const hash = await w.writeContract({
        address: RITUAL_MAP_ADDRESS,
        abi: RITUAL_MAP_ABI,
        functionName: "join",
        args: [handle.replace(/^@/, "").trim(), region],
      });
      setStatus("Transmitting → " + hash.slice(0, 10) + "…");
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus("Joined the lattice.");
      await refresh();
    } catch (e: any) {
      setStatus(e?.shortMessage ?? e?.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  }

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of REGIONS) m.set(r.id, 0);
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
    [members]
  );

  return (
    <div className="scanlines relative min-h-screen">
      <Topbar account={account} onConnect={onConnect} count={members.length} />
      <main className="relative mx-auto max-w-[1500px] px-4 pb-20 pt-6 lg:px-8">
        <Hero />
        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          <MapPanel
            members={placedMembers}
            hovered={hovered}
            setHovered={setHovered}
            tick={tick}
          />
          <aside className="flex flex-col gap-6">
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
            <RegionList counts={counts} active={region} setRegion={setRegion} total={members.length} />
          </aside>
        </div>
        <Marquee count={members.length} loading={loading} />
      </main>
      <Footer />
    </div>
  );
}

function Topbar({ account, onConnect, count }: { account: string | null; onConnect: () => void; count: number }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/70 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1500px] items-center justify-between px-4 py-3 lg:px-8">
        <div className="flex items-center gap-3">
          <img src={logo} alt="Ritual" className="h-9 w-9 rounded-sm flicker" />
          <div className="leading-tight">
            <div className="text-xs uppercase tracking-[0.32em] text-muted-foreground">Ritual</div>
            <div className="text-sm font-bold tracking-wider text-foreground">COMMUNITY//MAP</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-2 rounded-sm border border-border bg-card/60 px-3 py-1.5 text-xs sm:flex">
            <span className="size-1.5 animate-pulse rounded-full bg-[var(--ritual-green-bright)]" />
            <span className="text-muted-foreground">chain</span>
            <span className="text-foreground">1979</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-foreground">{count} initiates</span>
          </div>
          <button
            onClick={onConnect}
            className="group relative overflow-hidden rounded-sm border border-[var(--ritual-green)] px-4 py-2 text-xs font-bold uppercase tracking-widest text-foreground transition-colors hover:bg-[var(--ritual-green)] hover:text-primary-foreground"
          >
            <span className="relative">{account ? account.slice(0, 6) + "…" + account.slice(-4) : "Connect"}</span>
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
        <div className="text-xs uppercase tracking-[0.4em] text-[var(--ritual-green-bright)]">// the lattice is open</div>
        <h1
          className="glitch mt-3 text-4xl font-black uppercase leading-[0.95] tracking-tight text-foreground sm:text-6xl lg:text-7xl"
          data-text="Ritual Community Map"
        >
          Ritual Community Map
        </h1>
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground sm:text-base">
          Sign one transaction on Ritual testnet (chain 1979) and pin yourself to the autonomous-agent lattice.
          Every pulse on the map is an on-chain initiate.
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
}: {
  members: (Member & { lng: number; lat: number })[];
  hovered: Member | null;
  setHovered: (m: Member | null) => void;
  tick: number;
}) {
  return (
    <div className="relative overflow-hidden rounded-sm border border-border bg-card/40">
      <div className="ritual-grid absolute inset-0 opacity-40" />
      <div className="relative">
        <div className="flex items-center justify-between border-b border-border px-4 py-2 text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
          <span>// global lattice</span>
          <span className="text-[var(--ritual-green-bright)]">{tick % 2 === 0 ? "● live" : "○ live"}</span>
        </div>
        <ComposableMap
          projection="geoEqualEarth"
          projectionConfig={{ scale: 165 }}
          width={980}
          height={520}
          style={{ width: "100%", height: "auto" }}
        >
          <Geographies geography={GEO_URL}>
            {({ geographies }) =>
              geographies.map((geo) => (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  style={{
                    default: {
                      fill: "color-mix(in oklab, var(--ritual-green-deep) 35%, transparent)",
                      stroke: "color-mix(in oklab, var(--ritual-green) 60%, transparent)",
                      strokeWidth: 0.4,
                      outline: "none",
                    },
                    hover: { fill: "color-mix(in oklab, var(--ritual-green) 45%, transparent)", outline: "none" },
                    pressed: { outline: "none" },
                  }}
                />
              ))
            }
          </Geographies>
          {members.map((m) => (
            <MarkerDot key={m.address} m={m} setHovered={setHovered} />
          ))}
        </ComposableMap>
        {hovered && (
          <div className="pointer-events-none absolute left-3 top-12 flex max-w-xs items-center gap-3 rounded-sm border border-[var(--ritual-green)] bg-background/90 p-2 backdrop-blur-md">
            <img
              src={avatarUrl(hovered.handle)}
              alt={hovered.handle}
              className="h-10 w-10 rounded-sm border border-border object-cover"
              onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
            />
            <div className="text-xs">
              <div className="font-bold text-foreground">@{hovered.handle}</div>
              <div className="text-muted-foreground">{REGIONS.find((r) => r.id === hovered.region)?.name}</div>
              <div className="text-[10px] text-muted-foreground/70">{hovered.address.slice(0, 10)}…</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MarkerDot({
  m,
  setHovered,
}: {
  m: Member & { lng: number; lat: number };
  setHovered: (m: Member | null) => void;
}) {
  // We need projection inside ComposableMap; using <Marker> from react-simple-maps would be cleaner.
  return null as any;
}

// Replace MarkerDot with proper Marker import — re-exported approach

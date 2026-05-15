import { useEffect, useMemo, useState } from "react";
import { ComposableMap, Geographies, Geography, Marker } from "react-simple-maps";
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
  return `https://unavatar.io/x/${encodeURIComponent(clean)}`;
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

  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 700);
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
    let unwatch: (() => void) | undefined;
    try {
      unwatch = publicClient.watchContractEvent({
        address: RITUAL_MAP_ADDRESS,
        abi: RITUAL_MAP_ABI,
        eventName: "Joined",
        onLogs: () => refresh(),
        poll: true,
        pollingInterval: 4000,
      });
    } catch {}
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
    } catch (e: any) {
      setStatus(e?.message ?? "Connect failed");
    }
  }

  async function onJoin() {
    setStatus("");
    if (!handle.trim()) return setStatus("Enter your X handle");
    let acct = account;
    if (!acct) {
      try {
        acct = await connectWallet();
        setAccount(acct);
      } catch (e: any) {
        return setStatus(e?.message ?? "Wallet required");
      }
    }
    setBusy(true);
    try {
      await ensureChain();
      const w = getWalletClient(acct!);
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
        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
          <MapPanel members={placedMembers} hovered={hovered} setHovered={setHovered} tick={tick} loading={loading} />
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
        <Marquee count={members.length} loading={loading} members={members} />
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
            <div className="text-[10px] uppercase tracking-[0.32em] text-muted-foreground">Ritual</div>
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
        <div className="text-[11px] uppercase tracking-[0.4em] text-[var(--ritual-green-bright)]">// the lattice is open</div>
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
          <span className="text-[var(--ritual-green-bright)]">{tick % 2 === 0 ? "● live" : "○ live"}</span>
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
              {({ geographies }: { geographies: any[] }) =>
                geographies.map((geo: any) => (
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
                  <circle r={8} fill="var(--ritual-green-bright)" opacity={0.18} className="ritual-ping" style={{ transformOrigin: "center" }} />
                  <circle r={3.2} fill="var(--ritual-green-bright)" stroke="white" strokeWidth={0.6} />
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
                <div className="text-muted-foreground">{REGIONS.find((r) => r.id === hovered.region)?.name}</div>
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
      <div className="text-[11px] uppercase tracking-[0.3em] text-[var(--ritual-green-bright)]">// initiate</div>
      <h2 className="mt-1 text-lg font-bold uppercase tracking-wider text-foreground">Join the lattice</h2>

      <label className="mt-4 block text-[11px] uppercase tracking-widest text-muted-foreground">X handle</label>
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

      <label className="mt-4 block text-[11px] uppercase tracking-widest text-muted-foreground">Region</label>
      <select
        value={region}
        onChange={(e) => setRegion(e.target.value)}
        className="mt-1 w-full rounded-sm border border-border bg-background/70 px-3 py-2.5 text-sm text-foreground outline-none focus:border-[var(--ritual-green)]"
      >
        {REGIONS.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>

      <button
        onClick={onJoin}
        disabled={busy}
        className="mt-5 w-full rounded-sm bg-[var(--ritual-green)] px-4 py-3 text-xs font-black uppercase tracking-[0.25em] text-primary-foreground transition-colors hover:bg-[var(--ritual-green-bright)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "…signing…" : account ? "Sign & Join" : "Connect & Join"}
      </button>
      {!account && (
        <button onClick={onConnect} className="mt-2 w-full text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground">
          or connect wallet first
        </button>
      )}
      {status && (
        <div className="mt-3 break-all rounded-sm border border-border bg-background/60 p-2 text-[11px] text-muted-foreground">
          <span className="text-[var(--ritual-green-bright)]">›</span> {status}
        </div>
      )}
      <div className="mt-3 text-[10px] uppercase tracking-widest text-muted-foreground/70">
        Need RITUAL? <a href="https://faucet.ritualfoundation.org" target="_blank" rel="noreferrer" className="text-[var(--ritual-green-bright)] underline-offset-2 hover:underline">faucet ↗</a>
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
  const max = Math.max(1, ...Array.from(counts.values()));
  return (
    <section className="rounded-sm border border-border bg-card/60 p-5">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.3em] text-[var(--ritual-green-bright)]">// regions</div>
          <h2 className="mt-1 text-lg font-bold uppercase tracking-wider text-foreground">Distribution</h2>
        </div>
        <div className="text-right">
          <div className="text-2xl font-black tabular-nums text-foreground">{total}</div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">total</div>
        </div>
      </div>
      <ul className="mt-4 space-y-2">
        {REGIONS.map((r) => {
          const c = counts.get(r.id) ?? 0;
          const pct = (c / max) * 100;
          const isActive = r.id === active;
          return (
            <li key={r.id}>
              <button
                onClick={() => setRegion(r.id)}
                className={`group block w-full rounded-sm border px-3 py-2 text-left transition-colors ${
                  isActive ? "border-[var(--ritual-green)] bg-[color-mix(in_oklab,var(--ritual-green)_12%,transparent)]" : "border-transparent hover:border-border"
                }`}
              >
                <div className="flex items-center justify-between text-xs">
                  <span className={`uppercase tracking-wider ${isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"}`}>
                    {r.name}
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
    </section>
  );
}

function Marquee({ count, loading, members }: { count: number; loading: boolean; members: Member[] }) {
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
        <div className="mt-2 px-4 text-[10px] uppercase tracking-widest text-muted-foreground">…syncing chain {count > 0 ? `· ${count} loaded` : ""}</div>
      )}
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border py-8 text-center text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
      built on <a href="https://ritualfoundation.org" target="_blank" rel="noreferrer" className="text-[var(--ritual-green-bright)] hover:underline">ritual</a> · chain 1979 · testnet
    </footer>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { CommunityMap } from "@/components/community-map";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Ritual Community Map" },
      { name: "description", content: "Pin yourself to the Ritual lattice. Sign one transaction on Ritual testnet to add yourself to the live community map." },
      { property: "og:title", content: "Ritual Community Map" },
      { property: "og:description", content: "On-chain community map on Ritual testnet (chain 1979)." },
    ],
  }),
  component: Index,
});

function Index() {
  return <CommunityMap />;
}

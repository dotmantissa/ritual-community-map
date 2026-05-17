export const DEFAULT_RITUAL_MAP_ADDRESS = "0x84725642453c2dcde42d075b5f3ab96b5922a44b" as const;

export const RITUAL_MAP_ADDRESS = (import.meta.env.VITE_RITUAL_MAP_CONTRACT_ADDRESS ??
  DEFAULT_RITUAL_MAP_ADDRESS) as `0x${string}`;

// Safe lower-bound block for log queries on the deployed contract.
export const RITUAL_MAP_DEPLOY_BLOCK = 19603000n;

export const RITUAL_MAP_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "user", type: "address" },
      { indexed: false, name: "handle", type: "string" },
      { indexed: false, name: "region", type: "string" },
      { indexed: false, name: "timestamp", type: "uint256" },
    ],
    name: "Joined",
    type: "event",
  },
  {
    inputs: [
      { name: "handle", type: "string" },
      { name: "region", type: "string" },
    ],
    name: "join",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "count",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getAll",
    outputs: [
      { type: "address[]" },
      { type: "string[]" },
      { type: "string[]" },
      { type: "uint256[]" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ type: "address" }],
    name: "members",
    outputs: [{ type: "string" }, { type: "string" }, { type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ type: "uint256" }],
    name: "memberList",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ type: "address" }],
    name: "joined",
    outputs: [{ type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const REGIONS: { id: string; name: string; coords: [number, number] }[] = [
  { id: "north-america", name: "North America", coords: [-100, 45] },
  { id: "south-america", name: "South America", coords: [-60, -15] },
  { id: "europe", name: "Europe", coords: [15, 50] },
  { id: "africa", name: "Africa", coords: [20, 5] },
  { id: "middle-east", name: "Middle East", coords: [45, 28] },
  { id: "south-asia", name: "South Asia", coords: [78, 22] },
  { id: "east-asia", name: "East Asia", coords: [115, 35] },
  { id: "southeast-asia", name: "Southeast Asia", coords: [110, 5] },
  { id: "oceania", name: "Oceania", coords: [135, -25] },
];

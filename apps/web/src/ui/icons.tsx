import {
  Archive,
  Boxes,
  Cable,
  CloudCog,
  Database,
  DoorOpen,
  Globe,
  Inbox,
  KeyRound,
  Layers,
  type LucideIcon,
  MemoryStick,
  Network,
  Rows3,
  Server,
  Table2,
  Users,
  Vote,
  Waves,
  Zap,
} from "lucide-react";

const KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
  client: Users,
  "load-balancer": Network,
  "api-gateway": DoorOpen,
  cdn: CloudCog,
  service: Server,
  "websocket-gateway": Cable,
  "near-cache": MemoryStick,
  cache: Zap,
  "relational-db": Database,
  "key-value-db": Table2,
  "wide-column-db": Rows3,
  "object-store": Archive,
  queue: Inbox,
  "stream-processor": Waves,
  "id-generator": KeyRound,
  coordination: Vote,
  "external-api": Globe,
};

export function KindIcon({
  kind,
  className,
}: {
  readonly kind: string;
  readonly className?: string;
}) {
  const Icon = KIND_ICONS[kind] ?? Boxes;
  return <Icon className={className} aria-hidden="true" />;
}

export type Category =
  | "client"
  | "edge"
  | "compute"
  | "cache"
  | "storage"
  | "messaging"
  | "coordination"
  | "external";

const KIND_CATEGORIES: Readonly<Record<string, Category>> = {
  client: "client",
  "load-balancer": "edge",
  "api-gateway": "edge",
  cdn: "edge",
  service: "compute",
  "websocket-gateway": "compute",
  "near-cache": "cache",
  cache: "cache",
  "relational-db": "storage",
  "key-value-db": "storage",
  "wide-column-db": "storage",
  "object-store": "storage",
  queue: "messaging",
  "stream-processor": "messaging",
  "id-generator": "coordination",
  coordination: "coordination",
  "external-api": "external",
};

export const kindCategory = (kind: string): Category => KIND_CATEGORIES[kind] ?? "compute";

interface CategoryStyle {
  readonly label: string;
  /** Text and icon colour. */
  readonly text: string;
  /** A tinted background for icon chips. */
  readonly soft: string;
  /** A solid fill, for accent bars. */
  readonly solid: string;
  readonly icon: LucideIcon;
}

/** In palette order. Class names are spelled out so Tailwind generates them. */
export const CATEGORIES: Readonly<Record<Category, CategoryStyle>> = {
  client: {
    label: "Clients",
    text: "text-cat-client",
    soft: "bg-cat-client/14",
    solid: "bg-cat-client",
    icon: Users,
  },
  edge: {
    label: "Traffic and edge",
    text: "text-cat-edge",
    soft: "bg-cat-edge/14",
    solid: "bg-cat-edge",
    icon: Network,
  },
  compute: {
    label: "Compute",
    text: "text-cat-compute",
    soft: "bg-cat-compute/14",
    solid: "bg-cat-compute",
    icon: Server,
  },
  cache: {
    label: "Caching",
    text: "text-cat-cache",
    soft: "bg-cat-cache/16",
    solid: "bg-cat-cache",
    icon: Zap,
  },
  storage: {
    label: "Databases",
    text: "text-cat-storage",
    soft: "bg-cat-storage/14",
    solid: "bg-cat-storage",
    icon: Database,
  },
  messaging: {
    label: "Messaging and streams",
    text: "text-cat-messaging",
    soft: "bg-cat-messaging/14",
    solid: "bg-cat-messaging",
    icon: Layers,
  },
  coordination: {
    label: "Coordination",
    text: "text-cat-coordination",
    soft: "bg-cat-coordination/14",
    solid: "bg-cat-coordination",
    icon: Vote,
  },
  external: {
    label: "External services",
    text: "text-cat-external",
    soft: "bg-cat-external/14",
    solid: "bg-cat-external",
    icon: Globe,
  },
};

export const CATEGORY_ORDER = Object.keys(CATEGORIES) as Category[];

/** A kind's icon on a tinted square in its category colour. */
export function KindChip({
  kind,
  size = "md",
}: {
  readonly kind: string;
  readonly size?: "xs" | "sm" | "md";
}) {
  const style = CATEGORIES[kindCategory(kind)];
  const box = { xs: "h-5 w-5 rounded", sm: "h-6 w-6 rounded-md", md: "h-8 w-8 rounded-lg" }[size];
  const icon = { xs: "h-3 w-3", sm: "h-3.5 w-3.5", md: "h-4 w-4" }[size];
  return (
    <span className={`flex shrink-0 items-center justify-center ${box} ${style.soft}`}>
      <KindIcon kind={kind} className={`${icon} ${style.text}`} />
    </span>
  );
}

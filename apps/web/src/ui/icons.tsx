import {
  Boxes,
  Database,
  DoorOpen,
  KeyRound,
  type LucideIcon,
  MemoryStick,
  Network,
  Server,
  Table2,
  Users,
  Vote,
  Zap,
} from "lucide-react";

const KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
  client: Users,
  "load-balancer": Network,
  service: Server,
  cache: Zap,
  "near-cache": MemoryStick,
  "relational-db": Database,
  "key-value-db": Table2,
  "api-gateway": DoorOpen,
  "id-generator": KeyRound,
  coordination: Vote,
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

import {
  Boxes,
  Database,
  type LucideIcon,
  Network,
  Server,
  Table2,
  Users,
  Zap,
} from "lucide-react";

const KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
  client: Users,
  "load-balancer": Network,
  service: Server,
  cache: Zap,
  "relational-db": Database,
  "key-value-db": Table2,
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

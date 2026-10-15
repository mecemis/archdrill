import type { Source } from "@archdrill/model";
import { ExternalLink } from "lucide-react";

/** A cited source: its publisher, linked, with the title and read date on hover. */
export function SourceLink({ source }: { readonly source: Source }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-0.5 text-accent-fg underline decoration-accent-line underline-offset-2 hover:decoration-accent"
      title={`${source.title} (${source.publisher}, read ${source.retrieved}${source.via ? `, via ${source.via}` : ""})`}
    >
      {source.publisher}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );
}

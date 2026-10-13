/**
 * Renders authored text: blank lines separate blocks, single newlines are soft
 * wraps, and a block whose lines all start with "- " is a bulleted list.
 */
export function Prose({
  text,
  className = "",
}: {
  readonly text: string;
  readonly className?: string;
}) {
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <>
      {blocks.map((block) => {
        const lines = block.split("\n").map((line) => line.trim());
        if (lines.every((line) => line.startsWith("- "))) {
          return (
            <ul key={block} className={`list-disc pl-5 ${className}`}>
              {lines.map((line) => (
                <li key={line}>{line.slice(2)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={block} className={className}>
            {lines.join(" ")}
          </p>
        );
      })}
    </>
  );
}

/** Renders authored text: blank lines separate paragraphs, single newlines are soft wraps. */
export function Prose({
  text,
  className = "",
}: {
  readonly text: string;
  readonly className?: string;
}) {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " "));
  return (
    <>
      {paragraphs.map((paragraph) => (
        <p key={paragraph} className={className}>
          {paragraph}
        </p>
      ))}
    </>
  );
}

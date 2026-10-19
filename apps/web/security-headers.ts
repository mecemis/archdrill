/**
 * Headers `pnpm serve` sends with the production build, which also carries
 * the content security policy in the page. Everything comes from this origin:
 * scripts, the evaluation worker and styles. React Flow positions nodes with
 * inline style attributes, hence 'unsafe-inline' for styles only. Exports are
 * downloaded from blob: URLs.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

/**
 * The content security policy as a `<meta>` element carries it, for a host
 * that sends no headers of its own (GitHub Pages). Browsers ignore
 * frame-ancestors there, so it is left out rather than warned about.
 */
export function metaPolicy(headers: Readonly<Record<string, string>> = SECURITY_HEADERS): string {
  return (headers["Content-Security-Policy"] ?? "")
    .split("; ")
    .filter((directive) => !directive.startsWith("frame-ancestors"))
    .join("; ");
}

/**
 * Headers for the production build. Everything comes from this origin:
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
 * The same headers as a static host reads them (Cloudflare Pages' `_headers`),
 * so the public build and `pnpm serve` share one policy. Hashed assets are
 * cached for good.
 */
export function headersFile(headers: Readonly<Record<string, string>> = SECURITY_HEADERS): string {
  return [
    "# Generated from apps/web/security-headers.ts at build time; edit that file.",
    "/*",
    ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`),
    "",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ].join("\n");
}

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

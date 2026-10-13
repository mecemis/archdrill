import { yamlContent } from "@archdrill/content/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Headers for the production build. Everything comes from this origin:
 * scripts, the evaluation worker and styles. React Flow positions nodes with
 * inline style attributes, hence 'unsafe-inline' for styles only. Exports are
 * downloaded from blob: URLs.
 */
const SECURITY_HEADERS = {
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

export default defineConfig({
  plugins: [yamlContent(), react(), tailwindcss()],
  // `pnpm serve`: the production build on this machine only; Tailscale serves
  // it to the tailnet over HTTPS (see the README).
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    allowedHosts: [".ts.net"],
    headers: SECURITY_HEADERS,
  },
  // The evaluation worker bundles the content packs too.
  worker: { format: "es", plugins: () => [yamlContent()] },
  build: {
    rolldownOptions: {
      output: {
        // Libraries change rarely; separate chunks stay cached across releases.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "canvas", test: /node_modules[\\/]@xyflow[\\/]/ },
            { name: "vendor", test: /node_modules/ },
          ],
        },
      },
    },
  },
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});

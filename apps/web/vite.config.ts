import { yamlContent } from "@archdrill/content/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { headersFile, SECURITY_HEADERS } from "./security-headers";

/** Writes the security headers next to the build, for a static host (Cloudflare Pages). */
function headersForStaticHost(): Plugin {
  return {
    name: "archdrill:headers",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: headersFile() });
    },
  };
}

export default defineConfig({
  plugins: [yamlContent(), react(), tailwindcss(), headersForStaticHost()],
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

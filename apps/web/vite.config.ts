import { yamlContent } from "@archdrill/content/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [yamlContent(), react(), tailwindcss()],
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

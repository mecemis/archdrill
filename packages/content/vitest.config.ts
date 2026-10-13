import { defineConfig } from "vitest/config";
import { yamlContent } from "./vite-plugin.ts";

export default defineConfig({
  plugins: [yamlContent()],
  test: {
    name: "content",
    // Corpus tests simulate timelines; shared CI runners are slower than a laptop.
    testTimeout: 30_000,
  },
});

import { defineConfig } from "vitest/config";
import { yamlContent } from "./vite-plugin.ts";

/** Reports CI publishes: the corpus report and the evaluation-time budget. */
export default defineConfig({
  plugins: [yamlContent()],
  test: {
    name: "reports",
    include: ["report/**/*.run.ts"],
    testTimeout: 300_000,
  },
});

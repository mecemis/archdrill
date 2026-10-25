import { defineConfig } from "vitest/config";
import { yamlContent } from "./vite-plugin.ts";

/** Reports CI publishes: the corpus report and the evaluation-time budget. */
export default defineConfig({
  plugins: [yamlContent()],
  test: {
    name: "reports",
    include: ["report/**/*.run.ts"],
    // The time budget is each design's p95, checked by the report itself. Measuring every
    // golden padded to 30 components already took about 285 s of 300 on CI runners.
    testTimeout: 600_000,
  },
});

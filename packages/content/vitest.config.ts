import { defineConfig } from "vitest/config";
import { yamlContent } from "./vite-plugin.ts";

export default defineConfig({
  plugins: [yamlContent()],
  test: {
    name: "content",
  },
});

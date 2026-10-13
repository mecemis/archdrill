import { defineConfig } from "@playwright/test";

const DEV_PORT = 5198;
const PRODUCTION_PORT = 5197;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",
  use: {
    viewport: { width: 1440, height: 900 },
    // Locally use the installed Chrome; CI installs Playwright's Chromium.
    ...(process.env.CI ? {} : { channel: "chrome" }),
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "dev",
      testIgnore: /production\.spec\.ts/,
      use: { baseURL: `http://localhost:${DEV_PORT}` },
    },
    {
      // The production build, with the headers Cloudflare Pages will send.
      name: "production",
      testMatch: /production\.spec\.ts/,
      use: { baseURL: `http://localhost:${PRODUCTION_PORT}` },
    },
  ],
  webServer: [
    {
      command: `pnpm --filter @archdrill/web exec vite --port ${DEV_PORT} --strictPort`,
      url: `http://localhost:${DEV_PORT}`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `pnpm --filter @archdrill/web exec vite build --outDir dist-e2e --emptyOutDir && pnpm --filter @archdrill/web exec vite preview --outDir dist-e2e --port ${PRODUCTION_PORT} --strictPort`,
      url: `http://localhost:${PRODUCTION_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://localhost:4175",
    headless: true,
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: "node e2e/serve-playground.mjs 4175",
    url: "http://localhost:4175/",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    cwd: ".", // this package
  },
});
